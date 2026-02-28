import { Worker } from 'bullmq';
import redisService from '../../../../db-services/redis-service.js';
import Migration from '../migration.model.js';
import { createSourceConnector, createTargetConnector } from '../../connectors/connector.factory.js';
import { getMappers } from '../../mappers/index.js';

const PAGE_SIZE = 100;
const RATE_LIMIT = 140; // max requests per minute
const RATE_WINDOW_MS = 60_000;

// ── Rate Limiter ─────────────────────────────────────────────────────────────
let requestCount = 0;
let windowStart = Date.now();

async function rateLimiter() {
  requestCount++;
  const elapsed = Date.now() - windowStart;

  if (elapsed >= RATE_WINDOW_MS) {
    requestCount = 1;
    windowStart = Date.now();
    return;
  }

  if (requestCount >= RATE_LIMIT) {
    const waitMs = RATE_WINDOW_MS - elapsed;
    await new Promise((r) => setTimeout(r, waitMs));
    requestCount = 1;
    windowStart = Date.now();
  }
}

// ── Retry with Backoff ────────────────────────────────────────────────────────
async function retryWithBackoff(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await rateLimiter();
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (attempt === retries || (status >= 400 && status < 500)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

// ── Checkpoint ────────────────────────────────────────────────────────────────
async function saveCheckpoint(migrationId, currentObject, offset, lastProcessedId = null) {
  const id = typeof lastProcessedId === 'object'
    ? (lastProcessedId?.value ?? lastProcessedId?.display_value ?? null)
    : lastProcessedId;
  await Migration.findByIdAndUpdate(migrationId, {
    'checkpoint.currentObject': currentObject,
    'checkpoint.offset': offset,
    'checkpoint.lastProcessedId': id,
  });
}

async function updateStats(migrationId, object, success, failed) {
  await Migration.findByIdAndUpdate(migrationId, {
    $inc: {
      [`stats.${object}.success`]: success,
      [`stats.${object}.failed`]: failed,
      [`stats.${object}.total`]: success + failed,
    },
  });
}

async function logError(migrationId, object, snowId, error) {
  const id = typeof snowId === 'object' ? (snowId?.value ?? snowId?.display_value ?? String(snowId)) : snowId;
  const msg = typeof error === 'string' ? error : (error.message ?? JSON.stringify(error));
  const details = error.details ? ` | ${JSON.stringify(error.details)}` : '';
  await Migration.findByIdAndUpdate(migrationId, {
    $push: { errorLog: { object, snowId: id, status: 'failed', error: msg + details, timestamp: new Date() } },
  });
}

async function logSkip(migrationId, object, snowId, reason) {
  console.warn(`[${migrationId}] ${object} SKIPPED ${snowId}: ${reason}`);
  await Migration.findByIdAndUpdate(migrationId, {
    $inc: { [`stats.${object}.skipped`]: 1, [`stats.${object}.total`]: 1 },
    $push: { errorLog: { object, snowId, status: 'skipped', error: reason, timestamp: new Date() } },
  });
}

// ── Page Processor ────────────────────────────────────────────────────────────
async function processPages(migrationId, objectName, fetchFn, processFn, startOffset = 0) {
  let offset = startOffset;

  while (true) {
    const records = await retryWithBackoff(() => fetchFn(PAGE_SIZE, offset));
    if (!records || records.length === 0) {
      console.log(`[${migrationId}] ${objectName}: no more records at offset ${offset}`);
      break;
    }

    console.log(`[${migrationId}] ${objectName}: processing ${records.length} records (offset ${offset})`);

    let success = 0;
    let failed = 0;

    for (const record of records) {
      try {
        const result = await retryWithBackoff(() => processFn(record));
        if (result !== 'skipped') success++;
      } catch (err) {
        // 409 = already exists in target, treat as success
        if (err.response?.status === 409) {
          success++;
        } else {
          failed++;
          const errDetail = err.response?.data ?? err.message;
          const sid = typeof record.sys_id === 'object' ? (record.sys_id?.value ?? record.sys_id?.display_value) : record.sys_id;
          console.error(`[${migrationId}] ${objectName} FAILED record ${sid}:`, JSON.stringify(errDetail));
          await logError(migrationId, objectName, sid, { message: err.message, details: errDetail });
        }
      }
    }

    console.log(`[${migrationId}] ${objectName}: page done — success=${success} failed=${failed}`);
    await updateStats(migrationId, objectName, success, failed);
    offset += records.length;
    await saveCheckpoint(migrationId, objectName, offset, records.at(-1)?.sys_id);

    if (records.length < PAGE_SIZE) break;
  }
}

// ── Main Job Processor ────────────────────────────────────────────────────────
async function processMigrationJob(job) {
  const { migrationId } = job.data;

  const migration = await Migration.findById(migrationId);
  if (!migration) throw new Error(`Migration ${migrationId} not found`);

  const emptyStats = Object.fromEntries(
    ['companies','users','admins','incidents','changes','problems','kb_categories','kb_folders','kb_articles','comments','attachments']
      .map((k) => [k, { total: 0, success: 0, failed: 0, skipped: 0 }])
  );
  await Migration.findByIdAndUpdate(migrationId, {
    status: 'running',
    startedAt: new Date(),
    completedAt: null,
    stats: emptyStats,
    errorLog: [],
    'checkpoint.currentObject': null,
    'checkpoint.offset': 0,
  });
  console.log(`[${migrationId}] Migration started`);

  const source = createSourceConnector(migration.source.system, migration.source.credentials);
  const target = createTargetConnector(migration.target.system, migration.target.credentials);
  const mappers = getMappers(migration.source.system, migration.target.system);
  const cfg = migration.objectConfig;

  // ID maps for cross-referencing created records
  const deptIdMap = new Map();   // snowId → fsDeptId
  const requesterIdMap = new Map(); // email → fsRequesterId
  const ticketIdMap = new Map();  // snowId → fsTicketId

  const resumeFrom = migration.checkpoint?.currentObject;
  const resumeOffset = migration.checkpoint?.offset ?? 0;

  const PIPELINE = [
    {
      name: 'companies',
      enabled: cfg.companies,
      run: async () => {
        await processPages(migrationId, 'companies',
          (limit, offset) => source.fetchCompanies(limit, offset),
          async (record) => {
            const res = await target.createDepartment(mappers.company.mapDepartment(record));
            deptIdMap.set(record.sys_id, res.department?.id);
          },
          resumeFrom === 'companies' ? resumeOffset : 0
        );
      },
    },
    {
      name: 'users',
      enabled: cfg.users,
      run: async () => {
        await processPages(migrationId, 'users',
          (limit, offset) => source.fetchUsers(limit, offset),
          async (record) => {
            const mapped = mappers.user.mapRequester(record, deptIdMap);
            if (!mapped) {
              await logSkip(migrationId, 'users', record.sys_id, 'Missing primary_email');
              return 'skipped';
            }
            const res = await target.createRequester(mapped);
            if (record.email) requesterIdMap.set(record.email, res.requester?.id);
          },
          resumeFrom === 'users' ? resumeOffset : 0
        );
      },
    },
    {
      name: 'admins',
      enabled: cfg.admins,
      run: async () => {
        await processPages(migrationId, 'admins',
          (limit, offset) => source.fetchAdminUsers(limit, offset),
          async (record) => {
            const err400 = (e) => e.response?.status === 400;
            try {
              await target.createAgent(mappers.user.mapAgent(record));
            } catch (err) {
              if (err400(err) && err.response?.data?.errors?.[0]?.field === 'occasional') {
                await logSkip(migrationId, 'admins', record.sys_id, 'Agent license limit reached');
                return 'skipped';
              }
              throw err;
            }
          },
          resumeFrom === 'admins' ? resumeOffset : 0
        );
      },
    },
    {
      name: 'incidents',
      enabled: cfg.incidents,
      run: async () => {
        // Pre-load deactivated requesters once to avoid per-record API calls
        const deactivatedMap = await target.getDeactivatedRequesterMap();

        await processPages(migrationId, 'incidents',
          (limit, offset) => source.fetchIncidents(limit, offset),
          async (record) => {
            const mapped = mappers.incident.mapIncident(record);
            const callerEmail = mappers.incident.getCallerEmail(record);
            const rawEmail = callerEmail || 'migration@migration.com';
            // Freshservice auto-spams @example.com — remap to a real domain
            const email = rawEmail.endsWith('@example.com')
              ? rawEmail.replace('@example.com', '@migrated.local')
              : rawEmail;
            const existing = await retryWithBackoff(() => target.getRequesterByEmail(email));
            let requesterId = existing?.requesters?.[0]?.id;
            if (!requesterId) {
              const deactivatedId = deactivatedMap.get(email);
              if (deactivatedId) {
                const reactivated = await retryWithBackoff(() => target.reactivateRequester(deactivatedId));
                requesterId = reactivated?.requester?.id ?? deactivatedId;
                deactivatedMap.delete(email); // now active, remove from map
              } else {
                const created = await retryWithBackoff(() =>
                  target.createRequester({ primary_email: email, first_name: 'Migrated' })
                ).catch(async (err) => {
                  if (err.response?.status === 409) {
                    const existing2 = await retryWithBackoff(() => target.getRequesterByEmail(email));
                    return existing2;
                  }
                  throw err;
                });
                requesterId = created?.requester?.id ?? created?.requesters?.[0]?.id;
              }
            }
            if (requesterId) mapped.requester_id = requesterId;
            else throw new Error(`Could not resolve requester for email: ${email}`);
            const res = await target.createTicket(mapped);
            const fsTicketId = res.ticket?.id;
            ticketIdMap.set(record.sys_id, fsTicketId);

            // comments
            if (cfg.comments && fsTicketId) {
              const comments = await retryWithBackoff(() => source.fetchComments(record.sys_id));
              for (const comment of comments ?? []) {
                await retryWithBackoff(() =>
                  target.createNote(fsTicketId, mappers.comment.mapNote(comment))
                );
              }
            }

            // attachments
            if (cfg.attachments && fsTicketId) {
              const attachments = await retryWithBackoff(() =>
                source.fetchAttachments('incident', record.sys_id)
              );
              for (const att of attachments ?? []) {
                try {
                  const buffer = await retryWithBackoff(() =>
                    source.downloadAttachment(att.download_link)
                  );
                  await retryWithBackoff(() =>
                    target.uploadAttachment(fsTicketId, Buffer.from(buffer), att.file_name, att.content_type)
                  );
                } catch (err) {
                  await logError(migrationId, 'attachments', att.sys_id, err);
                }
              }
            }
          },
          resumeFrom === 'incidents' ? resumeOffset : 0
        );
      },
    },
    {
      name: 'changes',
      enabled: cfg.changes,
      run: async () => {
        await processPages(migrationId, 'changes',
          (limit, offset) => source.fetchChanges(limit, offset),
          async (record) => {
            await target.createChange(mappers.change.mapChange(record));
          },
          resumeFrom === 'changes' ? resumeOffset : 0
        );
      },
    },
    {
      name: 'problems',
      enabled: cfg.problems,
      run: async () => {
        await processPages(migrationId, 'problems',
          (limit, offset) => source.fetchProblems(limit, offset),
          async (record) => {
            await target.createProblem(mappers.problem.mapProblem(record));
          },
          resumeFrom === 'problems' ? resumeOffset : 0
        );
      },
    },
    {
      name: 'kb',
      enabled: cfg.kb_categories || cfg.kb_articles,
      run: async () => {
        const categoryIdMap = new Map(); // snowId → fsCategoryId
        const folderIdMap = new Map();   // snowId → fsFolderId

        if (cfg.kb_categories) {
          await processPages(migrationId, 'kb_categories',
            (limit, offset) => source.fetchKBCategories(limit, offset),
            async (record) => {
              const cat = await target.createKBCategory(mappers.kb.mapCategory(record));
              const fsCatId = cat.category?.id;
              categoryIdMap.set(record.sys_id, fsCatId);

              // create folder under this category
              const folder = await retryWithBackoff(() =>
                target.createKBFolder(fsCatId, mappers.kb.mapFolder(record, fsCatId))
              );
              folderIdMap.set(record.sys_id, folder.folder?.id);
            },
            resumeFrom === 'kb_categories' ? resumeOffset : 0
          );
        }

        if (cfg.kb_articles) {
          await processPages(migrationId, 'kb_articles',
            (limit, offset) => source.fetchKBArticles(limit, offset),
            async (record) => {
              const folderId = folderIdMap.get(record.kb_category?.value);
              if (!folderId) return 'skipped';
              await target.createKBArticle(folderId, mappers.kb.mapArticle(record, folderId));
            },
            resumeFrom === 'kb_articles' ? resumeOffset : 0
          );
        }
      },
    },
  ];

  // skip already-completed stages when resuming
  const startIndex = resumeFrom
    ? PIPELINE.findIndex((s) => s.name === resumeFrom)
    : 0;

  for (let i = startIndex; i < PIPELINE.length; i++) {
    const stage = PIPELINE[i];
    if (!stage.enabled) { console.log(`[${migrationId}] Skipping ${stage.name} (disabled)`); continue; }
    console.log(`[${migrationId}] Starting stage: ${stage.name}`);
    await stage.run();
    console.log(`[${migrationId}] Finished stage: ${stage.name}`);
  }

  await Migration.findByIdAndUpdate(migrationId, {
    status: 'completed',
    completedAt: new Date(),
    'checkpoint.currentObject': null,
    'checkpoint.offset': 0,
  });
  console.log(`[${migrationId}] ✅ Migration completed`);
}

// ── Worker Bootstrap ──────────────────────────────────────────────────────────
export function startMigrationWorker() {
  const worker = new Worker('migration', processMigrationJob, {
    connection: redisService.getBullWorkerClient(),
    concurrency: 5,
  });

  worker.on('completed', (job) => console.log(`✅ Migration job ${job.id} completed`));
  worker.on('failed', async (job, err) => {
    console.error(`❌ Migration job ${job.id} failed:`, err.message);
    await Migration.findByIdAndUpdate(job.data.migrationId, { status: 'failed' });
  });

  return worker;
}
