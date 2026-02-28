import { z } from 'zod';
import Migration from './migration.model.js';
import { createSourceConnector, createTargetConnector } from '../connectors/connector.factory.js';
import { addMigrationJob, getMigrationQueue } from './queue/migration.queue.js';

const createMigrationSchema = z.object({
  source: z.object({
    system: z.string(),
    credentials: z.record(z.string(), z.any()),
  }),
  target: z.object({
    system: z.string(),
    credentials: z.record(z.string(), z.any()),
  }),
});

export async function createMigration(req, res) {
  const parsed = createMigrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const migration = await Migration.create({
    tenantId: req.tenant._id,
    source: parsed.data.source,
    target: parsed.data.target,
  });

  res.status(201).json(migration);
}

export async function getMigrations(req, res) {
  const migrations = await Migration.find({ tenantId: req.tenant._id }).sort({ createdAt: -1 });
  res.json(migrations);
}

export async function getMigration(req, res) {
  const migration = await Migration.findOne({ _id: req.params.id, tenantId: req.tenant._id });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  res.json(migration);
}

export async function verifySource(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const connector = createSourceConnector(migration.source.system, migration.source.credentials);
  const data = await connector.fetchIncidents(5);

  res.json({ success: true, sample: data });
}

export async function verifyTarget(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const connector = createTargetConnector(migration.target.system, migration.target.credentials);

  // Resolve or create a requester for the verification ticket
  const verifyEmail = 'migration-verify@tool.com';
  let requesterId;
  const existing = await connector.getRequesterByEmail(verifyEmail);
  requesterId = existing?.requesters?.[0]?.id;
  if (!requesterId) {
    const created = await connector.createRequester({ primary_email: verifyEmail, first_name: 'Migration', last_name: 'Verify' });
    requesterId = created?.requester?.id;
  }

  const ticket = await connector.createTicket({
    subject: 'Connectivity Verification',
    description: 'Verifying target connection from migration tool',
    requester_id: requesterId,
    priority: 1,
    status: 2,
  });

  res.json({ success: true, ticket });
}

export async function preflightEstimate(req, res) {
  const migration = await Migration.findOne({ _id: req.params.id, tenantId: req.tenant._id });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const source = createSourceConnector(migration.source.system, migration.source.credentials);
  const counts = await source.countAll();

  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);
  // each record = ~1.5 requests avg (fetch + create + occasional comment)
  const estimatedRequests = Math.ceil(totalRecords * 1.5);
  const estimatedMinutes = Math.ceil(estimatedRequests / 140);

  res.json({ counts, totalRecords, estimatedRequests, estimatedMinutes });
}

export async function startMigration(req, res) {
  const migration = await Migration.findOne({ _id: req.params.id, tenantId: req.tenant._id });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (migration.status === 'running') return res.status(409).json({ error: 'Migration already running' });

  const objectConfig = { ...migration.objectConfig.toObject(), ...req.body.objectConfig };

  await Migration.findByIdAndUpdate(req.params.id, { objectConfig, status: 'pending' });
  await addMigrationJob(req.params.id, objectConfig);

  res.json({ success: true, message: 'Migration job queued' });
}

export async function pauseMigration(req, res) {
  const migration = await Migration.findOne({ _id: req.params.id, tenantId: req.tenant._id });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (migration.status !== 'running') return res.status(409).json({ error: 'Migration is not running' });

  const queue = getMigrationQueue();
  const job = await queue.getJob(`migration-${req.params.id}`);
  if (job) await job.remove();

  await Migration.findByIdAndUpdate(req.params.id, { status: 'paused' });
  res.json({ success: true, message: 'Migration paused' });
}

export async function getMigrationStatus(req, res) {
  const migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'status checkpoint stats errorLog startedAt completedAt'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const totalSuccess = Object.values(migration.stats).reduce((a, b) => a + b.success, 0);
  const totalFailed  = Object.values(migration.stats).reduce((a, b) => a + b.failed, 0);
  const totalSkipped = Object.values(migration.stats).reduce((a, b) => a + b.skipped, 0);
  const totalPushed  = totalSuccess + totalFailed + totalSkipped;

  const timeTakenMs = migration.startedAt
    ? (migration.completedAt ?? new Date()) - migration.startedAt
    : null;

  res.json({
    status: migration.status,
    startedAt: migration.startedAt,
    completedAt: migration.completedAt ?? null,
    timeTakenMinutes: timeTakenMs ? +(timeTakenMs / 60000).toFixed(2) : null,
    summary: { totalPushed, totalSuccess, totalFailed, totalSkipped },
    stats: migration.stats,
    checkpoint: migration.checkpoint,
    errorLog: migration.errorLog,
  });
}

export async function retryFailed(req, res) {
  const migration = await Migration.findOne({ _id: req.params.id, tenantId: req.tenant._id });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const objectFilter = req.body.object; // optional: filter by object type
  const failedEntries = migration.errorLog.filter(
    (e) => e.status === 'failed' && (!objectFilter || e.object === objectFilter)
  );
  if (!failedEntries.length) return res.json({ message: 'No failed records to retry', retried: 0 });

  const source = createSourceConnector(migration.source.system, migration.source.credentials);
  const target = createTargetConnector(migration.target.system, migration.target.credentials);
  const { getMappers } = await import('../mappers/index.js');
  const mappers = getMappers(migration.source.system, migration.target.system);

  let retried = 0, succeeded = 0, stillFailed = 0;

  for (const entry of failedEntries) {
    try {
      if (entry.object === 'users') {
        const record = await source.fetchUserById(entry.snowId);
        if (!record) throw new Error('Record not found in source');
        const mapped = mappers.user.mapRequester(record);
        if (!mapped) throw new Error('Missing primary_email');
        await target.createRequester(mapped);
      } else if (entry.object === 'incidents') {
        const record = await source.fetchById('incident', entry.snowId);
        if (!record) throw new Error('Record not found in source');
        const mapped = mappers.incident.mapIncident(record);
        const callerEmail = mappers.incident.getCallerEmail(record);
        const email = callerEmail || 'migration@migration.com';
        const existing = await target.getRequesterByEmail(email);
        let requesterId = existing?.requesters?.[0]?.id;
        if (!requesterId) {
          const deactivated = await target.getDeactivatedRequesterByEmail(email);
          const deactivatedId = deactivated?.requesters?.[0]?.id;
          if (deactivatedId) {
            const reactivated = await target.reactivateRequester(deactivatedId);
            requesterId = reactivated?.requester?.id ?? deactivatedId;
          } else {
            const created = await target.createRequester({ primary_email: email, first_name: 'Migrated' });
            requesterId = created?.requester?.id;
          }
        }
        if (requesterId) mapped.requester_id = requesterId;
        await target.createTicket(mapped);
      } else if (entry.object === 'changes') {
        const record = await source.fetchById('change_request', entry.snowId);
        if (!record) throw new Error('Record not found in source');
        await target.createChange(mappers.change.mapChange(record));
      } else if (entry.object === 'problems') {
        const record = await source.fetchById('problem', entry.snowId);
        if (!record) throw new Error('Record not found in source');
        await target.createProblem(mappers.problem.mapProblem(record));
      } else {
        throw new Error(`Retry not implemented for object: ${entry.object}`);
      }

      // mark as resolved in errorLog
      await Migration.updateOne(
        { _id: migration._id, 'errorLog._id': entry._id },
        { $set: { 'errorLog.$.status': 'retried_success' } }
      );
      await Migration.findByIdAndUpdate(migration._id, {
        $inc: { [`stats.${entry.object}.success`]: 1, [`stats.${entry.object}.failed`]: -1 },
      });
      succeeded++;
    } catch (err) {
      await Migration.updateOne(
        { _id: migration._id, 'errorLog._id': entry._id },
        { $set: { 'errorLog.$.error': err.message, 'errorLog.$.timestamp': new Date() } }
      );
      stillFailed++;
    }
    retried++;
  }

  res.json({ retried, succeeded, stillFailed });
}

export async function rollbackMigration(req, res) {
  const migration = await Migration.findOne({ _id: req.params.id, tenantId: req.tenant._id });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (migration.status === 'running') return res.status(409).json({ error: 'Cannot rollback a running migration' });

  const target = createTargetConnector(migration.target.system, migration.target.credentials);

  // Remove any queued/active job for this migration before rollback
  const { getMigrationQueue } = await import('./queue/migration.queue.js');
  const queue = getMigrationQueue();
  const job = await queue.getJob(`migration-${req.params.id}`);
  if (job) await job.remove();

  const deleted = await target.rollbackAll();

  await Migration.findByIdAndUpdate(req.params.id, {
    status: 'rolled_back',
    stats: Object.fromEntries(
      Object.keys(migration.stats.toObject()).map((k) => [k, { total: 0, success: 0, failed: 0, skipped: 0 }])
    ),
    errorLog: [],
    checkpoint: { currentObject: null, offset: 0, lastProcessedId: null },
  });

  res.json({ success: true, deleted });
}

export async function sampleData(req, res) {
  const migration = await Migration.findOne({ _id: req.params.id, tenantId: req.tenant._id });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { object = 'incidents', limit = 2 } = req.query;
  const source = createSourceConnector(migration.source.system, migration.source.credentials);
  const { getMappers } = await import('../mappers/index.js');
  const mappers = getMappers(migration.source.system, migration.target.system);

  const FETCH_MAP = {
    incidents:     () => source.fetchIncidents(Number(limit)),
    users:         () => source.fetchUsers(Number(limit)),
    admins:        () => source.fetchAdminUsers(Number(limit)),
    companies:     () => source.fetchCompanies(Number(limit)),
    changes:       () => source.fetchChanges(Number(limit)),
    problems:      () => source.fetchProblems(Number(limit)),
    kb_categories: () => source.fetchKBCategories(Number(limit)),
    kb_articles:   () => source.fetchKBArticles(Number(limit)),
  };

  const MAP_FN = {
    incidents:     (r) => mappers.incident.mapIncident(r),
    users:         (r) => mappers.user.mapRequester(r, new Map()),
    admins:        (r) => mappers.user.mapAgent(r),
    companies:     (r) => mappers.company.mapDepartment(r),
    changes:       (r) => mappers.change.mapChange(r),
    problems:      (r) => mappers.problem.mapProblem(r),
    kb_categories: (r) => mappers.kb.mapCategory(r),
    kb_articles:   (r) => mappers.kb.mapArticle(r, null),
  };

  if (!FETCH_MAP[object]) return res.status(400).json({ error: `Unknown object: ${object}` });

  const raw = await FETCH_MAP[object]();
  const mapped = (raw ?? []).map((r) => ({ raw: r, mapped: MAP_FN[object](r) }));

  res.json({ object, count: mapped.length, records: mapped });
}

export async function postflightCheck(req, res) {
  const migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'source stats target'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const target = createTargetConnector(migration.target.system, migration.target.credentials);
  const live = await target.countAll();

  res.json({
    source: {
      companies: migration.stats.companies.success,
      users:     migration.stats.users.success,
      admins:    migration.stats.admins.success,
      incidents: migration.stats.incidents.success,
      changes:   migration.stats.changes.success,
      problems:  migration.stats.problems.success,
      kb_categories: migration.stats.kb_categories.success,
      kb_articles:   migration.stats.kb_articles.success,
    },
    target: live,
  });
}
