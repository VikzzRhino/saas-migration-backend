import { z } from 'zod';
import Migration from './migration.model.js';
import {
  createSourceConnector,
  createTargetConnector,
} from '../connectors/connector.factory.js';
import { addMigrationJob, addObjectJob, getMigrationQueue } from './queue/migration.queue.js';
import {
  generateAutoMapping,
  getTargetFields,
  getSourceTable,
} from '../field-mapping/auto-mapper.js';
import { FRESHSERVICE_SCHEMAS } from '../field-mapping/field-schema.js';
import { DEFAULT_VALUE_MAPPINGS } from '../field-mapping/value-mapping-defaults.js';
import * as stagingService from '../staging/staging.service.js';

const createMigrationSchema = z.object({
  name: z.string().optional(),
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
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  const migration = await Migration.create({
    tenantId: req.tenant._id,
    name: parsed.data.name || '',
    source: parsed.data.source,
    target: parsed.data.target,
  });

  res.status(201).json(migration);
}

export async function getMigrations(req, res) {
  const {
    status,
    search,
    page = 1,
    limit = 10,
    sort = '-createdAt',
  } = req.query;
  const filter = { tenantId: req.tenant._id };

  if (status && status !== 'all') filter.status = status;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { 'source.system': { $regex: search, $options: 'i' } },
      { 'target.system': { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [migrations, total] = await Promise.all([
    Migration.find(
      filter,
      'name source.system target.system status stats startedAt completedAt createdAt objectConfig'
    )
      .sort(sort)
      .skip(skip)
      .limit(Number(limit)),
    Migration.countDocuments(filter),
  ]);

  const withProgress = migrations.map((m) => {
    const doc = m.toObject();
    const statsObj = doc.stats ?? {};
    const totalRecords = Object.values(statsObj).reduce(
      (a, b) => a + (b.total || 0),
      0
    );
    const totalSuccess = Object.values(statsObj).reduce(
      (a, b) => a + (b.success || 0),
      0
    );
    const totalFailed = Object.values(statsObj).reduce(
      (a, b) => a + (b.failed || 0),
      0
    );
    doc.progress =
      totalRecords > 0 ? Math.round((totalSuccess / totalRecords) * 100) : 0;
    doc.summary = { totalRecords, totalSuccess, totalFailed };
    return doc;
  });

  res.json({
    migrations: withProgress,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.ceil(total / Number(limit)),
    },
  });
}

export async function getMigration(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  res.json(migration);
}

export async function updateMigration(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const allowedFields = ['name', 'objectConfig', 'source', 'target', 'workspaceId'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  const updated = await Migration.findByIdAndUpdate(req.params.id, updates, {
    new: true,
  });
  res.json(updated);
}

export async function deleteMigration(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (migration.status === 'running') {
    return res
      .status(409)
      .json({ error: 'Cannot delete a running migration. Pause it first.' });
  }

  await stagingService.purgeStaged(migration._id);
  await Migration.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Migration deleted' });
}

export async function getDashboardStats(req, res) {
  const tenantId = req.tenant._id;
  const [total, running, completed, failed, paused, pending] =
    await Promise.all([
      Migration.countDocuments({ tenantId }),
      Migration.countDocuments({ tenantId, status: 'running' }),
      Migration.countDocuments({ tenantId, status: 'completed' }),
      Migration.countDocuments({ tenantId, status: 'failed' }),
      Migration.countDocuments({ tenantId, status: 'paused' }),
      Migration.countDocuments({ tenantId, status: 'pending' }),
    ]);

  const recentMigrations = await Migration.find(
    { tenantId },
    'name source.system target.system status stats startedAt completedAt createdAt'
  )
    .sort({ createdAt: -1 })
    .limit(5);

  const withProgress = recentMigrations.map((m) => {
    const doc = m.toObject();
    const statsObj = doc.stats ?? {};
    const totalRecords = Object.values(statsObj).reduce(
      (a, b) => a + (b.total || 0),
      0
    );
    const totalSuccess = Object.values(statsObj).reduce(
      (a, b) => a + (b.success || 0),
      0
    );
    doc.progress =
      totalRecords > 0 ? Math.round((totalSuccess / totalRecords) * 100) : 0;
    return doc;
  });

  res.json({
    stats: { total, running, completed, failed, paused, pending },
    recentMigrations: withProgress,
  });
}

export async function fetchFreshserviceWorkspaces(req, res) {
  const { domain, apiKey } = req.body;
  if (!domain || !apiKey)
    return res.status(400).json({ error: 'domain and apiKey are required' });

  const connector = createTargetConnector('freshservice', { domain, apiKey });
  const workspaces = await connector.fetchWorkspaces();
  res.json({ success: true, workspaces });
}

export async function verifySource(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const connector = createSourceConnector(
    migration.source.system,
    migration.source.credentials
  );
  const data = await connector.fetchIncidents(5);

  res.json({ success: true, sample: data });
}

export async function verifyTarget(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const connector = createTargetConnector(
    migration.target.system,
    migration.target.credentials
  );

  const verifyEmail = 'migration-verify@tool.com';
  let requesterId;
  const existing = await connector.getRequesterByEmail(verifyEmail);
  requesterId = existing?.requesters?.[0]?.id;
  if (!requesterId) {
    const created = await connector.createRequester({
      primary_email: verifyEmail,
      first_name: 'Migration',
      last_name: 'Verify',
    });
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
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const WEIGHTS = {
    incidents:     6,
    changes:       5,
    problems:      5,
    users:         1,
    admins:        1,
    companies:     1,
    kb_categories: 2,
    kb_articles:   3,
  };

  // objectConfig from query params (frontend toggles) or fall back to saved migration config
  const cfg = req.query.objectConfig
    ? JSON.parse(req.query.objectConfig)
    : migration.objectConfig?.toObject?.() ?? migration.objectConfig ?? {};

  const warnings = [];
  const connections = {
    serviceNow:   { valid: false },
    freshservice: { valid: false, rateLimit: null },
  };

  // SN connection check
  let allCounts;
  try {
    const source = createSourceConnector(
      migration.source.system,
      migration.source.credentials
    );
    allCounts = await source.countAll();
    connections.serviceNow.valid = true;
  } catch {
    return res.json({
      valid: false,
      error: 'SN connection failed',
      connections,
      warnings,
    });
  }

  // FS connection check + rate limit
  let effectiveRpm = 70;
  try {
    const target = createTargetConnector(
      migration.target.system,
      migration.target.credentials
    );
    const { total } = await target.getRateLimitInfo();
    connections.freshservice.valid = true;
    if (total != null) {
      connections.freshservice.rateLimit = total;
      effectiveRpm = Math.floor(total / 2);
    }
  } catch {
    return res.json({
      valid: false,
      error: 'FS connection failed',
      connections,
      warnings,
    });
  }

  // Map SN count keys to objectConfig keys
  const COUNT_TO_CONFIG = {
    incidents:     'incidents',
    changes:       'changes',
    problems:      'problems',
    users:         'users',
    admins:        'admins',
    companies:     'companies',
    kb_categories: 'kb_categories',
    kb_articles:   'kb_articles',
  };

  // Filter counts to only enabled objects
  const counts = Object.fromEntries(
    Object.entries(allCounts).map(([key, count]) => [
      key,
      cfg[COUNT_TO_CONFIG[key]] === false ? 0 : count,
    ])
  );

  if (Object.values(allCounts).every((c) => c === 0)) {
    warnings.push('No records found in ServiceNow');
  }

  const estimatedRequests = Object.entries(counts).reduce(
    (sum, [key, count]) => sum + count * (WEIGHTS[key] ?? 1),
    0
  );
  const estimatedMinutes = Math.ceil(estimatedRequests / effectiveRpm);
  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);

  res.json({
    counts,
    totalRecords,
    estimatedRequests,
    estimatedMinutes,
    breakdown: Object.entries(allCounts).map(([key, count]) => ({
      object: key,
      count,
      enabled: cfg[COUNT_TO_CONFIG[key]] !== false,
      estimatedRequests: (cfg[COUNT_TO_CONFIG[key]] !== false ? count : 0) * (WEIGHTS[key] ?? 1),
    })),
    connections,
    warnings,
  });
}

export async function startMigration(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (migration.status === 'running')
    return res.status(409).json({ error: 'Migration already running' });

  const objectConfig = {
    ...migration.objectConfig.toObject(),
    ...req.body.objectConfig,
  };

  await Migration.findByIdAndUpdate(req.params.id, {
    objectConfig,
    status: 'pending',
  });
  await addMigrationJob(req.params.id, objectConfig);

  res.json({ success: true, message: 'Migration job queued' });
}

export async function pauseMigration(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (migration.status !== 'running')
    return res.status(409).json({ error: 'Migration is not running' });

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

  const totalSuccess = Object.values(migration.stats).reduce(
    (a, b) => a + b.success,
    0
  );
  const totalFailed = Object.values(migration.stats).reduce(
    (a, b) => a + b.failed,
    0
  );
  const totalSkipped = Object.values(migration.stats).reduce(
    (a, b) => a + b.skipped,
    0
  );
  const totalPushed = totalSuccess + totalFailed + totalSkipped;

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
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const objectFilter = req.body.object;
  const failedEntries = migration.errorLog.filter(
    (e) => e.status === 'failed' && (!objectFilter || e.object === objectFilter)
  );
  if (!failedEntries.length)
    return res.json({ message: 'No failed records to retry', retried: 0 });

  const source = createSourceConnector(
    migration.source.system,
    migration.source.credentials
  );
  const target = createTargetConnector(
    migration.target.system,
    migration.target.credentials
  );
  const { getMappers } = await import('../mappers/index.js');
  const mappers = getMappers(migration.source.system, migration.target.system);

  let retried = 0,
    succeeded = 0,
    stillFailed = 0;

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
          const deactivated = await target.getDeactivatedRequesterByEmail(
            email
          );
          const deactivatedId = deactivated?.requesters?.[0]?.id;
          if (deactivatedId) {
            const reactivated = await target.reactivateRequester(deactivatedId);
            requesterId = reactivated?.requester?.id ?? deactivatedId;
          } else {
            const created = await target.createRequester({
              primary_email: email,
              first_name: 'Migrated',
            });
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

      await Migration.updateOne(
        { _id: migration._id, 'errorLog._id': entry._id },
        { $set: { 'errorLog.$.status': 'retried_success' } }
      );
      await Migration.findByIdAndUpdate(migration._id, {
        $inc: {
          [`stats.${entry.object}.success`]: 1,
          [`stats.${entry.object}.failed`]: -1,
        },
      });
      succeeded++;
    } catch (err) {
      await Migration.updateOne(
        { _id: migration._id, 'errorLog._id': entry._id },
        {
          $set: {
            'errorLog.$.error': err.message,
            'errorLog.$.timestamp': new Date(),
          },
        }
      );
      stillFailed++;
    }
    retried++;
  }

  res.json({ retried, succeeded, stillFailed });
}

export async function rollbackMigration(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (migration.status === 'running')
    return res
      .status(409)
      .json({ error: 'Cannot rollback a running migration' });

  const target = createTargetConnector(
    migration.target.system,
    migration.target.credentials
  );

  const { getMigrationQueue } = await import('./queue/migration.queue.js');
  const queue = getMigrationQueue();
  const job = await queue.getJob(`migration-${req.params.id}`);
  if (job) await job.remove();

  const deleted = await target.rollbackAll();

  // Purge staged data on rollback
  await stagingService.purgeStaged(migration._id);

  await Migration.findByIdAndUpdate(req.params.id, {
    status: 'rolled_back',
    stats: Object.fromEntries(
      Object.keys(migration.stats.toObject()).map((k) => [
        k,
        { total: 0, success: 0, failed: 0, skipped: 0 },
      ])
    ),
    errorLog: [],
    checkpoint: { currentObject: null, offset: 0, lastProcessedId: null },
  });

  res.json({ success: true, deleted });
}

export async function sampleData(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { object = 'incidents', limit = 2 } = req.query;
  const source = createSourceConnector(
    migration.source.system,
    migration.source.credentials
  );
  const { getMappers } = await import('../mappers/index.js');
  const mappers = getMappers(migration.source.system, migration.target.system);

  const FETCH_MAP = {
    incidents: () => source.fetchIncidents(Number(limit)),
    users: () => source.fetchUsers(Number(limit)),
    admins: () => source.fetchAdminUsers(Number(limit)),
    companies: () => source.fetchCompanies(Number(limit)),
    changes: () => source.fetchChanges(Number(limit)),
    problems: () => source.fetchProblems(Number(limit)),
    kb_categories: () => source.fetchKBCategories(Number(limit)),
    kb_articles: () => source.fetchKBArticles(Number(limit)),
  };

  const MAP_FN = {
    incidents: (r) => mappers.incident.mapIncident(r),
    users: (r) => mappers.user.mapRequester(r, new Map()),
    admins: (r) => mappers.user.mapAgent(r),
    companies: (r) => mappers.company.mapDepartment(r),
    changes: (r) => mappers.change.mapChange(r),
    problems: (r) => mappers.problem.mapProblem(r),
    kb_categories: (r) => mappers.kb.mapCategory(r),
    kb_articles: (r) => mappers.kb.mapArticle(r, null),
  };

  if (!FETCH_MAP[object])
    return res.status(400).json({ error: `Unknown object: ${object}` });

  const raw = await FETCH_MAP[object]();
  const mapped = (raw ?? []).map((r) => ({
    raw: r,
    mapped: MAP_FN[object](r),
  }));

  res.json({ object, count: mapped.length, records: mapped });
}

export async function postflightCheck(req, res) {
  const migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'source stats target'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const target = createTargetConnector(
    migration.target.system,
    migration.target.credentials
  );
  const live = await target.countAll();

  res.json({
    source: {
      companies: migration.stats.companies.success,
      users: migration.stats.users.success,
      admins: migration.stats.admins.success,
      incidents: migration.stats.incidents.success,
      changes: migration.stats.changes.success,
      problems: migration.stats.problems.success,
      kb_categories: migration.stats.kb_categories.success,
      kb_articles: migration.stats.kb_articles.success,
    },
    target: live,
  });
}

// ── Workspace ────────────────────────────────────────────────────────────────

export async function fetchWorkspace(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const target = createTargetConnector(
    migration.target.system,
    migration.target.credentials
  );
  const workspace = await target.fetchWorkspace();
  workspace.fetchedAt = new Date();

  // Also fetch KB categories and folders
  try {
    workspace.kbCategories = await target.fetchKBCategories();
    workspace.kbFolders = await target.fetchKBFolders();
  } catch {
    workspace.kbCategories = [];
    workspace.kbFolders = [];
  }

  await Migration.findByIdAndUpdate(req.params.id, { workspace });

  res.json({
    success: true,
    workspace: {
      agents: workspace.agents.map((a) => ({
        id: a.id,
        email: a.email,
        first_name: a.first_name,
        last_name: a.last_name,
        active: a.active,
        role_ids: a.role_ids,
      })),
      departments: workspace.departments.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
      })),
      groups: workspace.groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        agent_ids: g.agent_ids,
        auto_ticket_assign: g.auto_ticket_assign,
      })),
      roles: workspace.roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
      })),
      kbCategories: workspace.kbCategories,
      kbFolders: workspace.kbFolders,
      ticketFields: workspace.ticketFields,
      changeFields: workspace.changeFields,
      problemFields: workspace.problemFields,
      requesterFields: workspace.requesterFields,
      fetchedAt: workspace.fetchedAt,
    },
  });
}

export async function getWorkspace(req, res) {
  const migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'workspace'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (!migration.workspace?.fetchedAt) {
    return res.status(400).json({
      error: 'Workspace not fetched yet. Call POST /fetch-workspace first.',
    });
  }

  res.json({ workspace: migration.workspace });
}

// ── Source Metadata (groups, categories) ─────────────────────────────────────

export async function fetchSourceMetadata(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const source = createSourceConnector(
    migration.source.system,
    migration.source.credentials
  );
  const metadata = await source.fetchMetadata();
  metadata.fetchedAt = new Date();

  await Migration.findByIdAndUpdate(req.params.id, {
    'sourceMetadata.groups': metadata.groups,
    'sourceMetadata.incidentCategories': metadata.incidentCategories,
    'sourceMetadata.changeCategories': metadata.changeCategories,
    'sourceMetadata.problemCategories': metadata.problemCategories,
    'sourceMetadata.fetchedAt': metadata.fetchedAt,
  });

  res.json({
    success: true,
    sourceMetadata: {
      groups: metadata.groups.map((g) => ({
        sys_id: g.sys_id,
        name: g.name,
        description: g.description,
        manager: g.manager,
        email: g.email,
        type: g.type,
      })),
      incidentCategories: metadata.incidentCategories,
      changeCategories: metadata.changeCategories,
      problemCategories: metadata.problemCategories,
      fetchedAt: metadata.fetchedAt,
    },
  });
}

export async function getSourceMetadata(req, res) {
  const migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'sourceMetadata'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  if (!migration.sourceMetadata?.fetchedAt) {
    return res.status(400).json({
      error:
        'Source metadata not fetched yet. Call POST /fetch-source-metadata first.',
    });
  }

  res.json({ sourceMetadata: migration.sourceMetadata });
}

// ── Field Schemas ────────────────────────────────────────────────────────────

export async function fetchSourceSchemas(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const source = createSourceConnector(
    migration.source.system,
    migration.source.credentials
  );
  const schemas = await source.fetchAllFieldSchemas();

  await Migration.findByIdAndUpdate(req.params.id, { sourceSchemas: schemas });

  res.json({ success: true, schemas });
}

export async function getFieldSchemas(req, res) {
  const projection = [
    'sourceSchemas',
    'source',
    'target',
    'workspace.groups',
    'workspace.ticketFields',
    'workspace.changeFields',
    'workspace.problemFields',
    'sourceMetadata',
  ].join(' ');
  let migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    projection
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const source = createSourceConnector(
    migration.source.system,
    migration.source.credentials
  );

  // Auto-fetch source schemas if not yet fetched
  if (
    !migration.sourceSchemas ||
    Object.keys(migration.sourceSchemas).length === 0
  ) {
    const schemas = await source.fetchAllFieldSchemas();
    await Migration.findByIdAndUpdate(req.params.id, {
      sourceSchemas: schemas,
    });
    migration = await Migration.findById(req.params.id, projection);
  }

  const { object } = req.query;
  const ENRICHABLE_OBJECTS = ['incidents', 'changes', 'problems'];

  // Auto-fetch source metadata (groups, categories) if not yet fetched
  if (
    ENRICHABLE_OBJECTS.includes(object) &&
    (!migration.sourceMetadata?.groups ||
      migration.sourceMetadata.groups.length === 0)
  ) {
    try {
      const metadata = await source.fetchMetadata();
      await Migration.findByIdAndUpdate(req.params.id, {
        'sourceMetadata.groups': metadata.groups,
        'sourceMetadata.incidentCategories': metadata.incidentCategories,
        'sourceMetadata.changeCategories': metadata.changeCategories,
        'sourceMetadata.problemCategories': metadata.problemCategories,
        'sourceMetadata.fetchedAt': new Date(),
      });
      migration = await Migration.findById(req.params.id, projection);
    } catch (err) {
      console.warn(
        `[getFieldSchemas] Auto-fetch source metadata failed: ${err.message}`
      );
    }
  }

  // ── Fetch live FS custom fields per object type ──────────────────────────
  const FS_CUSTOM_FIELD_ENDPOINTS = {
    incidents:   '/api/v2/ticket_form_fields',
    changes:     '/api/v2/change_form_fields',
    problems:    '/api/v2/problem_form_fields',
    kb_articles: '/api/v2/solution_article_form_fields',
  };
  const FS_CUSTOM_FIELD_KEYS = {
    incidents:   'ticket_fields',
    changes:     'change_fields',
    problems:    'problem_fields',
    kb_articles: 'article_fields',
  };

  async function fetchLiveCustomFields(objectType) {
    const endpoint = FS_CUSTOM_FIELD_ENDPOINTS[objectType];
    if (!endpoint) return [];
    try {
      const targetConnector = createTargetConnector(
        migration.target.system,
        migration.target.credentials
      );
      const response = await targetConnector.get(endpoint);
      const key = FS_CUSTOM_FIELD_KEYS[objectType];
      const fields = response?.[key] ?? response?.fields ?? [];
      return fields
        .filter((f) => f.custom === true || f.type === 'custom')
        .map((f) => ({
          name: `custom_fields.${f.name}`,
          label: f.label ?? f.name,
          type: 'custom',
          custom: true,
        }));
    } catch (err) {
      console.warn(
        `[getFieldSchemas] Could not fetch FS custom fields for ${objectType}: ${err.message}`
      );
      return [];
    }
  }

  if (object) {
    const rawSourceFields = migration.sourceSchemas?.[object] ?? [];
    const baseTargetFields = getTargetFields(object);

    // Resolve SN groups + categories for enrichment
    const snGroups = migration.sourceMetadata?.groups ?? [];
    const SN_CATEGORY_MAP = {
      incidents: migration.sourceMetadata?.incidentCategories ?? [],
      changes: migration.sourceMetadata?.changeCategories ?? [],
      problems: migration.sourceMetadata?.problemCategories ?? [],
    };
    const snCategories = SN_CATEGORY_MAP[object] ?? [];

    // Resolve FS category choices from workspace form fields
    const FS_FORM_FIELDS_MAP = {
      incidents: migration.workspace?.ticketFields ?? [],
      changes: migration.workspace?.changeFields ?? [],
      problems: migration.workspace?.problemFields ?? [],
    };
    const fsFormFields = FS_FORM_FIELDS_MAP[object] ?? [];
    const fsCategoryField = fsFormFields.find(
      (f) => f.name === 'category' || f.label === 'Category'
    );
    const fsCategoryChoices = (fsCategoryField?.choices ?? []).map((c) => ({
      value: c.value ?? c.label ?? c.name ?? c,
      label: c.label ?? c.name ?? c.value ?? c,
    }));

    // Enrich source fields (assignment_group + category)
    const sourceFields = rawSourceFields.map((f) => {
      const plain = typeof f.toObject === 'function' ? f.toObject() : { ...f };
      if (!ENRICHABLE_OBJECTS.includes(object)) return plain;

      if (plain.name === 'assignment_group' && snGroups.length > 0) {
        return {
          ...plain,
          type: 'select',
          choices: snGroups.map((g) => ({
            value: g.sys_id,
            label: g.name,
          })),
        };
      }
      if (plain.name === 'category' && snCategories.length > 0) {
        return {
          ...plain,
          type: 'select',
          choices: snCategories.map((c) => ({
            value: c.value ?? c.label,
            label: c.label ?? c.value,
          })),
        };
      }
      return plain;
    });

    // Fetch live FS custom fields and merge into target fields
    const liveCustomFields = await fetchLiveCustomFields(object);
    const fsGroups = migration.workspace?.groups ?? [];

    // Build target fields: replace wildcard with live custom fields, enrich references
    const targetFields = baseTargetFields
      .filter((f) => f.name !== 'custom_fields.*')
      .map((f) => {
        if (!ENRICHABLE_OBJECTS.includes(object)) return f;
        if (f.name === 'group_id' && fsGroups.length > 0) {
          return {
            ...f,
            type: 'select',
            choices: fsGroups.map((g) => ({ value: g.id, label: g.name })),
          };
        }
        if (f.name === 'category' && fsCategoryChoices.length > 0) {
          return { ...f, type: 'select', choices: fsCategoryChoices };
        }
        return f;
      })
      .concat(liveCustomFields);

    return res.json({ object, sourceFields, targetFields });
  }

  // Full schema response — enrich each object type with live custom fields
  const enrichedTargetSchemas = {};
  for (const [objType, schema] of Object.entries(FRESHSERVICE_SCHEMAS)) {
    const liveCustomFields = await fetchLiveCustomFields(objType);
    enrichedTargetSchemas[objType] = {
      ...schema,
      fields: [
        ...schema.fields.filter((f) => f.name !== 'custom_fields.*'),
        ...liveCustomFields,
      ],
    };
  }

  res.json({
    sourceSchemas: migration.sourceSchemas ?? {},
    targetSchemas: enrichedTargetSchemas,
  });
}

// ── Field Mappings (Auto-map + Custom) ───────────────────────────────────────

export async function generateMappings(req, res) {
  let migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { object, refresh } = req.query;
  const objects = object
    ? [object]
    : [
        'incidents',
        'changes',
        'problems',
        'users',
        'admins',
        'companies',
        'kb_articles',
      ];

  // Auto-fetch source schemas if not yet fetched
  if (
    !migration.sourceSchemas ||
    Object.keys(migration.sourceSchemas).length === 0
  ) {
    const source = createSourceConnector(
      migration.source.system,
      migration.source.credentials
    );
    const schemas = await source.fetchAllFieldSchemas();
    await Migration.findByIdAndUpdate(req.params.id, {
      sourceSchemas: schemas,
    });
    migration = await Migration.findById(req.params.id);
  }

  const result = {};
  const updates = {};

  for (const obj of objects) {
    const sourceFields = migration.sourceSchemas[obj] ?? [];
    const existing = migration.fieldMappings?.[obj];
    if (existing && existing.length > 0 && refresh !== 'true') {
      result[obj] = existing;
      continue;
    }
    const mappings = generateAutoMapping(obj, sourceFields);
    result[obj] = mappings;
    updates[`fieldMappings.${obj}`] = mappings;
  }

  if (Object.keys(updates).length > 0) {
    await Migration.findByIdAndUpdate(req.params.id, updates);
  }

  res.json({ success: true, mappings: result });
}

export async function getFieldMappings(req, res) {
  const migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'fieldMappings'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { object } = req.query;
  if (object) {
    return res.json({
      object,
      mappings: migration.fieldMappings?.[object] ?? [],
    });
  }
  res.json({ mappings: migration.fieldMappings });
}

const updateMappingsSchema = z.object({
  object: z.string(),
  mappings: z.array(
    z.object({
      sourceField: z.string().nullable(),
      sourceLabel: z.string().nullable().optional(),
      targetField: z.string().nullable(),
      targetLabel: z.string().nullable().optional(),
      transform: z.string().nullable().optional(),
      confidence: z.number().optional(),
      autoMapped: z.boolean().optional(),
    })
  ),
});

export async function updateFieldMappings(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const parsed = updateMappingsSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  const { object, mappings } = parsed.data;

  const validObjects = [
    'incidents',
    'changes',
    'problems',
    'users',
    'admins',
    'companies',
    'kb_articles',
  ];
  if (!validObjects.includes(object)) {
    return res.status(400).json({ error: `Invalid object type: ${object}` });
  }

  const targetFields = getTargetFields(object);
  const enriched = mappings.map((m) => {
    const tgt = targetFields.find((f) => f.name === m.targetField);
    return {
      ...m,
      targetLabel: m.targetLabel ?? tgt?.label ?? null,
      transform: m.transform ?? 'direct',
      autoMapped: false,
    };
  });

  await Migration.findByIdAndUpdate(req.params.id, {
    [`fieldMappings.${object}`]: enriched,
  });

  res.json({ success: true, object, mappings: enriched });
}

// ── Value Mappings (configurable enum/select field value transforms) ─────────

export async function getValueMappings(req, res) {
  const vmProjection = [
    'valueMappings',
    'sourceMetadata',
    'workspace.groups',
    'workspace.ticketFields',
    'workspace.changeFields',
    'workspace.problemFields',
    'groupMapping',
    'source',
  ].join(' ');
  let migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    vmProjection
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  // Auto-fetch source metadata (groups, categories) if not yet available
  if (
    !migration.sourceMetadata?.groups ||
    migration.sourceMetadata.groups.length === 0
  ) {
    try {
      const source = createSourceConnector(
        migration.source.system,
        migration.source.credentials
      );
      const metadata = await source.fetchMetadata();
      await Migration.findByIdAndUpdate(req.params.id, {
        'sourceMetadata.groups': metadata.groups,
        'sourceMetadata.incidentCategories': metadata.incidentCategories,
        'sourceMetadata.changeCategories': metadata.changeCategories,
        'sourceMetadata.problemCategories': metadata.problemCategories,
        'sourceMetadata.fetchedAt': new Date(),
      });
      migration = await Migration.findOne({ _id: req.params.id }, vmProjection);
    } catch (err) {
      console.warn(
        `[getValueMappings] Auto-fetch source metadata failed: ${err.message}`
      );
    }
  }

  const sourceGroups = (migration.sourceMetadata?.groups ?? []).map((g) => ({
    sys_id: g.sys_id,
    name: g.name,
  }));
  const targetGroups = (migration.workspace?.groups ?? []).map((g) => ({
    id: g.id,
    name: g.name,
  }));
  const groupMapping = migration.groupMapping ?? [];

  const ENRICHABLE_OBJECTS = ['incidents', 'changes', 'problems'];

  // Build group_id value mapping from groupMapping entries
  function buildGroupValueMapping() {
    if (sourceGroups.length === 0 && targetGroups.length === 0) return null;
    return {
      defaultValue: null,
      map: Object.fromEntries(
        groupMapping
          .filter((g) => g.fsGroupId)
          .map((g) => [g.snGroupName, g.fsGroupId])
      ),
      sourceValues: sourceGroups.map((g) => ({
        value: g.sys_id,
        label: g.name,
      })),
      targetValues: targetGroups.map((g) => ({
        value: g.id,
        label: g.name,
      })),
      type: 'group',
    };
  }

  // Enrich category value mapping with source + target choices
  function enrichCategoryMapping(obj, categoryDefaults) {
    const SN_CAT_MAP = {
      incidents: migration.sourceMetadata?.incidentCategories ?? [],
      changes: migration.sourceMetadata?.changeCategories ?? [],
      problems: migration.sourceMetadata?.problemCategories ?? [],
    };
    const FS_FORM_MAP = {
      incidents: migration.workspace?.ticketFields ?? [],
      changes: migration.workspace?.changeFields ?? [],
      problems: migration.workspace?.problemFields ?? [],
    };
    const snCats = SN_CAT_MAP[obj] ?? [];
    const fsFormFields = FS_FORM_MAP[obj] ?? [];
    const fsCatField = fsFormFields.find(
      (f) => f.name === 'category' || f.label === 'Category'
    );
    const fsCatChoices = (fsCatField?.choices ?? []).map((c) => ({
      value: c.value ?? c.label ?? c.name ?? c,
      label: c.label ?? c.name ?? c.value ?? c,
    }));

    if (snCats.length === 0 && fsCatChoices.length === 0)
      return categoryDefaults;

    return {
      ...(categoryDefaults ?? { defaultValue: null, map: {} }),
      sourceValues: snCats.map((c) => ({
        value: c.value ?? c.label,
        label: c.label ?? c.value,
      })),
      targetValues: fsCatChoices,
      type: 'category',
    };
  }

  // Enrich all enum value mappings with sourceValues/targetValues arrays
  function enrichEnumDefaults(obj, defaults) {
    const schema = FRESHSERVICE_SCHEMAS[obj];
    if (!schema) return defaults;

    for (const [fieldName, fieldConfig] of Object.entries(defaults)) {
      if (
        fieldConfig.sourceValues ||
        fieldConfig.type === 'group' ||
        fieldConfig.type === 'category'
      )
        continue;
      if (!fieldConfig.map || typeof fieldConfig.map !== 'object') continue;

      const targetField = schema.fields.find((f) => f.name === fieldName);
      const targetOptions = targetField?.options ?? [];

      defaults[fieldName] = {
        ...fieldConfig,
        sourceValues: Object.keys(fieldConfig.map).map((k) => ({
          value: k,
          label: k,
        })),
        targetValues: targetOptions.map((o) => ({
          value: o.value,
          label: o.label,
        })),
      };
    }
    return defaults;
  }

  const { object } = req.query;
  if (object) {
    const custom = migration.valueMappings?.[object];
    const defaults = { ...(DEFAULT_VALUE_MAPPINGS[object] ?? {}) };
    const customObj =
      custom instanceof Map ? Object.fromEntries(custom) : custom ?? {};

    if (ENRICHABLE_OBJECTS.includes(object)) {
      const groupVM = buildGroupValueMapping();
      if (groupVM) defaults.group_id = groupVM;
      defaults.category = enrichCategoryMapping(object, defaults.category);
    }

    enrichEnumDefaults(object, defaults);

    return res.json({
      object,
      defaults,
      custom: customObj,
      sourceGroups,
      targetGroups,
      groupMapping,
    });
  }

  const allMappings = {};
  const validObjects = [
    'incidents',
    'changes',
    'problems',
    'users',
    'admins',
    'companies',
    'kb_articles',
  ];
  for (const obj of validObjects) {
    const custom = migration.valueMappings?.[obj];
    const defaults = { ...(DEFAULT_VALUE_MAPPINGS[obj] ?? {}) };
    if (ENRICHABLE_OBJECTS.includes(obj)) {
      const groupVM = buildGroupValueMapping();
      if (groupVM) defaults.group_id = groupVM;
      defaults.category = enrichCategoryMapping(obj, defaults.category);
    }
    enrichEnumDefaults(obj, defaults);
    allMappings[obj] = {
      defaults,
      custom: custom instanceof Map ? Object.fromEntries(custom) : custom ?? {},
    };
  }

  res.json({
    valueMappings: allMappings,
    sourceGroups,
    targetGroups,
    groupMapping,
  });
}

export async function updateValueMappings(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { object, fieldName, defaultValue, map } = req.body;

  const validObjects = [
    'incidents',
    'changes',
    'problems',
    'users',
    'admins',
    'companies',
    'kb_articles',
  ];
  if (!validObjects.includes(object)) {
    return res.status(400).json({ error: `Invalid object type: ${object}` });
  }
  if (!fieldName)
    return res.status(400).json({ error: 'fieldName is required' });

  await Migration.findByIdAndUpdate(req.params.id, {
    [`valueMappings.${object}.${fieldName}`]: {
      defaultValue: defaultValue ?? null,
      map: map ?? {},
    },
  });

  res.json({ success: true, object, fieldName });
}

export async function updateBulkValueMappings(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { object, mappings } = req.body;

  const validObjects = [
    'incidents',
    'changes',
    'problems',
    'users',
    'admins',
    'companies',
    'kb_articles',
  ];
  if (!validObjects.includes(object)) {
    return res.status(400).json({ error: `Invalid object type: ${object}` });
  }
  if (!mappings || typeof mappings !== 'object') {
    return res.status(400).json({ error: 'mappings object is required' });
  }

  const updates = {};
  for (const [fieldName, config] of Object.entries(mappings)) {
    updates[`valueMappings.${object}.${fieldName}`] = {
      defaultValue: config.defaultValue ?? null,
      map: config.map ?? {},
    };
  }

  await Migration.findByIdAndUpdate(req.params.id, updates);

  res.json({ success: true, object, fields: Object.keys(mappings) });
}

// ── Agent Matching ───────────────────────────────────────────────────────────

export async function getAgentMatching(req, res) {
  const migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'agentMatching workspace.agents source'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  if (!migration.agentMatching?.entries?.length) {
    const source = createSourceConnector(
      migration.source.system,
      migration.source.credentials
    );

    const allAdmins = [];
    let offset = 0;
    while (true) {
      const batch = await source.fetchAdminUsers(200, offset);
      if (!batch?.length) break;
      allAdmins.push(...batch);
      offset += batch.length;
      if (batch.length < 200) break;
    }

    const snVal = (f) =>
      typeof f === 'object' ? f?.display_value ?? f?.value ?? '' : f ?? '';

    const fsAgents = (migration.workspace?.agents ?? []).filter(
      (a) => a.active === true
    );
    const fsAgentByEmail = new Map(
      fsAgents.map((a) => [a.email?.toLowerCase(), a])
    );

    const entries = allAdmins.map((admin) => {
      const email = snVal(admin.email).toLowerCase();
      const fsAgent = fsAgentByEmail.get(email);
      return {
        snEmail: snVal(admin.email),
        snName:
          `${snVal(admin.first_name)} ${snVal(admin.last_name)}`.trim() ||
          email,
        snSysId:
          typeof admin.sys_id === 'object' ? admin.sys_id?.value : admin.sys_id,
        fsAgentId: fsAgent?.id ?? null,
        fsAgentEmail: fsAgent?.email ?? null,
        fsAgentName: fsAgent
          ? `${fsAgent.first_name ?? ''} ${fsAgent.last_name ?? ''}`.trim()
          : null,
        matched: !!fsAgent,
      };
    });

    await Migration.findByIdAndUpdate(req.params.id, {
      'agentMatching.entries': entries,
    });

    migration.agentMatching = {
      ...(migration.agentMatching?.toObject?.() ?? {}),
      entries,
    };
  }

  res.json({
    agentMatching: migration.agentMatching,
    availableFsAgents: (migration.workspace?.agents ?? [])
      .filter((a) => a.active === true)
      .map((a) => ({
        id: a.id,
        email: a.email,
        name: `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim(),
        active: a.active,
      })),
  });
}

export async function fetchAndAutoMatchAgents(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const source = createSourceConnector(
    migration.source.system,
    migration.source.credentials
  );

  // Fetch all SN admins
  const allAdmins = [];
  let offset = 0;
  while (true) {
    const batch = await source.fetchAdminUsers(200, offset);
    if (!batch?.length) break;
    allAdmins.push(...batch);
    offset += batch.length;
    if (batch.length < 200) break;
  }

  // Freshservice agents from workspace (must be fetched first) — only active agents
  const fsAgents = (migration.workspace?.agents ?? []).filter(
    (a) => a.active === true
  );
  const fsAgentByEmail = new Map(
    fsAgents.map((a) => [a.email?.toLowerCase(), a])
  );

  const snVal = (field) =>
    typeof field === 'object'
      ? field?.display_value ?? field?.value ?? ''
      : field ?? '';

  // Auto-match by email
  const entries = allAdmins.map((admin) => {
    const email = snVal(admin.email).toLowerCase();
    const fsAgent = fsAgentByEmail.get(email);
    return {
      snEmail: snVal(admin.email),
      snName:
        `${snVal(admin.first_name)} ${snVal(admin.last_name)}`.trim() || email,
      snSysId:
        typeof admin.sys_id === 'object' ? admin.sys_id?.value : admin.sys_id,
      fsAgentId: fsAgent?.id ?? null,
      fsAgentEmail: fsAgent?.email ?? null,
      fsAgentName: fsAgent
        ? `${fsAgent.first_name ?? ''} ${fsAgent.last_name ?? ''}`.trim()
        : null,
      matched: !!fsAgent,
    };
  });

  const matched = entries.filter((e) => e.matched).length;
  const unmatched = entries.filter((e) => !e.matched).length;

  // Use first FS agent as default if available
  const defaultAgent = fsAgents[0] ?? null;

  await Migration.findByIdAndUpdate(req.params.id, {
    'agentMatching.entries': entries,
    'agentMatching.defaultAgentId': defaultAgent?.id ?? null,
    'agentMatching.defaultAgentEmail': defaultAgent?.email ?? null,
  });

  res.json({
    success: true,
    totalAdmins: allAdmins.length,
    matched,
    unmatched,
    defaultAgent: defaultAgent
      ? { id: defaultAgent.id, email: defaultAgent.email }
      : null,
    entries,
  });
}

export async function updateAgentMatching(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { defaultAgentId, defaultAgentEmail, entries } = req.body;

  const updates = {};
  if (defaultAgentId !== undefined)
    updates['agentMatching.defaultAgentId'] = defaultAgentId;
  if (defaultAgentEmail !== undefined)
    updates['agentMatching.defaultAgentEmail'] = defaultAgentEmail;
  if (entries) updates['agentMatching.entries'] = entries;

  await Migration.findByIdAndUpdate(req.params.id, updates);

  res.json({ success: true });
}

// ── Group Mapping ────────────────────────────────────────────────────────────

export async function getGroupMapping(req, res) {
  let migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'groupMapping sourceMetadata workspace.groups source'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  // Auto-fetch source metadata (groups) if not yet available
  if (
    !migration.sourceMetadata?.groups ||
    migration.sourceMetadata.groups.length === 0
  ) {
    try {
      const source = createSourceConnector(
        migration.source.system,
        migration.source.credentials
      );
      const metadata = await source.fetchMetadata();
      await Migration.findByIdAndUpdate(req.params.id, {
        'sourceMetadata.groups': metadata.groups,
        'sourceMetadata.incidentCategories': metadata.incidentCategories,
        'sourceMetadata.changeCategories': metadata.changeCategories,
        'sourceMetadata.problemCategories': metadata.problemCategories,
        'sourceMetadata.fetchedAt': new Date(),
      });
      migration = await Migration.findOne(
        { _id: req.params.id },
        'groupMapping sourceMetadata workspace.groups source'
      );
    } catch (err) {
      console.warn(
        `[getGroupMapping] Auto-fetch source metadata failed: ${err.message}`
      );
    }
  }

  res.json({
    groupMapping: migration.groupMapping ?? [],
    sourceGroups: (migration.sourceMetadata?.groups ?? []).map((g) => ({
      sys_id: g.sys_id,
      name: g.name,
    })),
    targetGroups: (migration.workspace?.groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
    })),
  });
}

export async function autoMatchGroups(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const snGroups = migration.sourceMetadata?.groups ?? [];
  const fsGroups = migration.workspace?.groups ?? [];
  const fsGroupByName = new Map(
    fsGroups.map((g) => [g.name?.toLowerCase(), g])
  );

  const entries = snGroups.map((sg) => {
    const fsGroup = fsGroupByName.get(sg.name?.toLowerCase());
    return {
      snGroupId: sg.sys_id,
      snGroupName: sg.name,
      fsGroupId: fsGroup?.id ?? null,
      fsGroupName: fsGroup?.name ?? null,
    };
  });

  await Migration.findByIdAndUpdate(req.params.id, { groupMapping: entries });

  const matched = entries.filter((e) => e.fsGroupId).length;
  res.json({
    success: true,
    total: entries.length,
    matched,
    unmatched: entries.length - matched,
    entries,
  });
}

export async function updateGroupMapping(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { entries } = req.body;
  if (!Array.isArray(entries))
    return res.status(400).json({ error: 'entries array is required' });

  await Migration.findByIdAndUpdate(req.params.id, { groupMapping: entries });

  res.json({ success: true, count: entries.length });
}

// ── Staging / Data Retention ─────────────────────────────────────────────────

export async function getStagingStats(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const stats = await stagingService.getStagingStats(migration._id);
  res.json({ migrationId: migration._id, stats });
}

export async function getStagedRecords(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { object, status = 'fetched', limit = 50, skip = 0 } = req.query;
  if (!object)
    return res.status(400).json({ error: 'object query param is required' });

  const records = await stagingService.getByStatus(
    migration._id,
    object,
    status,
    { limit: Number(limit), skip: Number(skip) }
  );

  res.json({ object, status, count: records.length, records });
}

export async function updateRetentionPolicy(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const { retentionDays, purgeOnComplete } = req.body;

  const updates = {};
  if (retentionDays !== undefined)
    updates['retentionPolicy.retentionDays'] = retentionDays;
  if (purgeOnComplete !== undefined)
    updates['retentionPolicy.purgeOnComplete'] = purgeOnComplete;

  await Migration.findByIdAndUpdate(req.params.id, updates);

  if (retentionDays) {
    await stagingService.updateRetention(migration._id, retentionDays);
  }

  res.json({
    success: true,
    retentionPolicy: {
      ...(migration.retentionPolicy?.toObject?.() ?? {}),
      ...updates,
    },
  });
}

// ── Migration Readiness Summary ─────────────────────────────────────────────

export async function getMigrationReadiness(req, res) {
  const migration = await Migration.findOne(
    { _id: req.params.id, tenantId: req.tenant._id },
    'fieldMappings objectConfig sourceSchemas'
  );
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const cfg = migration.objectConfig?.toObject?.() ?? migration.objectConfig ?? {};

  const REQUIRED_FIELDS = {
    incidents:     ['subject', 'description', 'priority', 'status'],
    changes:       ['subject', 'description', 'priority', 'status', 'change_type', 'planned_start_date', 'planned_end_date'],
    problems:      ['subject', 'description', 'priority', 'status'],
    users:         ['first_name', 'primary_email'],
    // admins: first_name/email are always hardcoded in mapAgent() — no source schema to map from
    admins:        [],
    companies:     ['name'],
    // kb_articles: folder_id is runtime-resolved by the KB orchestrator, not field-mapped
    kb_articles:   ['title', 'description'],
  };

  const summary = {};

  for (const [object, required] of Object.entries(REQUIRED_FIELDS)) {
    if (cfg[object] === false) continue;

    const mappings = migration.fieldMappings?.[object] ?? [];
    const sourceFields = migration.sourceSchemas?.[object] ?? [];

    const mappedFields    = mappings.filter((m) => m.sourceField && m.targetField);
    const unmappedFields  = mappings.filter((m) => !m.sourceField && m.targetField);
    const coveredTargets  = new Set(mappedFields.map((m) => m.targetField));

    const missingRequired = required.filter((f) => !coveredTargets.has(f));
    const resolveFields   = mappedFields.filter((m) =>
      ['resolve_requester', 'resolve_agent', 'resolve_group', 'resolve_department'].includes(m.transform)
    );

    summary[object] = {
      enabled:          true,
      totalSourceFields: sourceFields.length,
      mappedCount:      mappedFields.length,
      unmappedCount:    unmappedFields.length,
      requiredFields:   required,
      missingRequired,
      ready:            missingRequired.length === 0,
      resolveFields:    resolveFields.map((m) => ({ source: m.sourceField, target: m.targetField, transform: m.transform })),
      willMigrate: {
        coreFields:       mappedFields.filter((m) => !['resolve_requester','resolve_agent','resolve_group','resolve_department'].includes(m.transform)).length,
        referenceFields:  resolveFields.length,
        customFields:     mappedFields.filter((m) => m.targetField?.startsWith('custom_fields.')).length,
      },
    };
  }

  const allReady   = Object.values(summary).every((s) => s.ready);
  const totalMapped = Object.values(summary).reduce((a, s) => a + s.mappedCount, 0);
  const totalMissing = Object.values(summary).reduce((a, s) => a + s.missingRequired.length, 0);

  res.json({ allReady, totalMapped, totalMissing, objects: summary });
}


const VALID_OBJECTS = ['companies', 'users', 'admins', 'incidents', 'changes', 'problems', 'kb_categories', 'kb_articles'];

const DEPENDENCIES = {
  users:       ['companies'],
  admins:      ['users'],
  incidents:   ['users'],
  changes:     ['users'],
  problems:    ['users'],
  kb_articles: ['kb_categories'],
};

export async function runObject(req, res) {
  const { object } = req.body;

  if (!object || !VALID_OBJECTS.includes(object)) {
    return res.status(400).json({ error: `Invalid object. Must be one of: ${VALID_OBJECTS.join(', ')}` });
  }

  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  // Check dependencies
  const deps = DEPENDENCIES[object] ?? [];
  for (const dep of deps) {
    const depStats = migration.stats?.[dep];
    if (!depStats || (depStats.success === 0 && depStats.failed === 0)) {
      return res.status(409).json({
        error: `Cannot run ${object} before ${dep} are completed`,
      });
    }
  }

  await Migration.findByIdAndUpdate(req.params.id, {
    [`objectStatuses.${object}`]: 'running',
    status: 'running',
  });

  await addObjectJob(req.params.id, object);

  res.status(202).json({ success: true, message: `${object} migration queued` });
}
