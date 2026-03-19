import { Worker } from 'bullmq';
import redisService from '../../../../db-services/redis-service.js';
import Migration from '../migration.model.js';
import { createMigrationLogger } from '../../../utils/migration-logger.js';
import {
  createSourceConnector,
  createTargetConnector,
} from '../../connectors/connector.factory.js';
import { getMappers } from '../../mappers/index.js';
import {
  applyMappings,
  applyValueMappings,
} from '../../field-mapping/value-transforms.js';
import * as staging from '../../staging/staging.service.js';
import { migrateChanges } from '../../mappers/servicenow-to-freshservice/change.orchestrator.js';
import { migrateProblems } from '../../mappers/servicenow-to-freshservice/problem.orchestrator.js';
import { migrateIncidents } from '../../mappers/servicenow-to-freshservice/incident.orchestrator.js';
import { migrateKb } from '../../mappers/servicenow-to-freshservice/kb.orchestrator.js';

const PAGE_SIZE = 100;

// ── Dynamic Rate Limit State ──────────────────────────────────────────────────
const rateLimitState = {
  total: null,
  remaining: null,
  windowStart: Date.now(),
  windowMs: 60_000,
  fallbackTotal: 50,
};

// Module-level fallback logger (before per-migration logger is created)
const fallbackLogger = console;

function updateRateLimitFromHeaders(headers) {
  if (!headers) return;
  const total = parseInt(
    headers['x-ratelimit-total'] ?? headers['X-Ratelimit-Total'],
    10
  );
  const remaining = parseInt(
    headers['x-ratelimit-remaining'] ?? headers['X-Ratelimit-Remaining'],
    10
  );
  if (!isNaN(total)) rateLimitState.total = total;
  if (!isNaN(remaining)) rateLimitState.remaining = remaining;
}

// ── Rate Limiter ─────────────────────────────────────────────────────────────
async function rateLimiter(responseHeaders, logger = fallbackLogger) {
  if (responseHeaders) updateRateLimitFromHeaders(responseHeaders);

  const limit = rateLimitState.total ?? rateLimitState.fallbackTotal;
  const elapsed = Date.now() - rateLimitState.windowStart;

  if (elapsed >= rateLimitState.windowMs) {
    rateLimitState.windowStart = Date.now();
    rateLimitState.remaining = limit;
    return;
  }

  const remaining = rateLimitState.remaining ?? limit;

  if (remaining <= 5) {
    const waitMs = rateLimitState.windowMs - elapsed;
    logger.warn(
      `[rate-limiter] Only ${remaining} requests remaining — waiting ${Math.round(
        waitMs / 1000
      )}s`
    );
    await new Promise((r) => setTimeout(r, waitMs + 500));
    rateLimitState.windowStart = Date.now();
    rateLimitState.remaining = limit;
    return;
  }

  if (rateLimitState.remaining !== null) rateLimitState.remaining--;
}

// ── Retry with Backoff ────────────────────────────────────────────────────────
async function retryWithBackoff(fn, retries = 3, logger = fallbackLogger) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await rateLimiter(null, logger);
      const result = await fn();
      const headers = result?._headers ?? result?.headers ?? null;
      if (headers) updateRateLimitFromHeaders(headers);
      return result;
    } catch (err) {
      const status = err.response?.status;
      const headers = err.response?.headers;

      if (headers) updateRateLimitFromHeaders(headers);

      if (status === 429) {
        const retryAfter = parseInt(
          headers?.['retry-after'] ?? headers?.['Retry-After'] ?? '60',
          10
        );
        logger.warn(
          `[rate-limiter] 429 received — waiting ${retryAfter}s (Retry-After header)`
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        attempt--;
        continue;
      }

      if (attempt === retries || (status >= 400 && status < 500)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

// ── Checkpoint ────────────────────────────────────────────────────────────────
async function saveCheckpoint(
  migrationId,
  currentObject,
  offset,
  lastProcessedId = null
) {
  const id =
    typeof lastProcessedId === 'object'
      ? lastProcessedId?.value ?? lastProcessedId?.display_value ?? null
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

async function logError(migrationId, object, snowId, error, logger = fallbackLogger) {
  const id =
    typeof snowId === 'object'
      ? snowId?.value ?? snowId?.display_value ?? String(snowId)
      : snowId;
  const msg =
    typeof error === 'string' ? error : error.message ?? JSON.stringify(error);
  const details = error.details ? ` | ${JSON.stringify(error.details)}` : '';
  logger.error(`[${migrationId}] ${object} FAILED record ${id}: ${msg}${details}`);
  await Migration.findByIdAndUpdate(migrationId, {
    $push: {
      errorLog: {
        object,
        snowId: id,
        status: 'failed',
        error: msg + details,
        timestamp: new Date(),
      },
    },
  });
}

async function logSkip(migrationId, object, snowId, reason, logger = fallbackLogger) {
  logger.warn(`[${migrationId}] ${object} SKIPPED ${snowId}: ${reason}`);
  await Migration.findByIdAndUpdate(migrationId, {
    $inc: { [`stats.${object}.skipped`]: 1, [`stats.${object}.total`]: 1 },
    $push: {
      errorLog: {
        object,
        snowId,
        status: 'skipped',
        error: reason,
        timestamp: new Date(),
      },
    },
  });
}

function extractSysId(record) {
  const sid = record?.sys_id;
  if (!sid) return null;
  return typeof sid === 'object'
    ? sid.value ?? sid.display_value ?? String(sid)
    : String(sid);
}

// ── Orchestrator Stats Persistence ──────────────────────────────────────────
async function persistOrchestratorStats(migrationId, statsMap) {
  const inc = {};
  for (const [dbKey, statObj] of Object.entries(statsMap)) {
    if (!statObj) continue;
    inc[`stats.${dbKey}.total`] = statObj.total ?? 0;
    inc[`stats.${dbKey}.success`] = statObj.migrated ?? 0;
    inc[`stats.${dbKey}.failed`] = statObj.failed ?? 0;
    if (statObj.skipped != null) {
      inc[`stats.${dbKey}.skipped`] = statObj.skipped;
    }
  }
  if (Object.keys(inc).length > 0) {
    await Migration.findByIdAndUpdate(migrationId, { $inc: inc });
  }
}

// ── Page Processor with Staging ──────────────────────────────────────────────
async function processPages(
  migrationId,
  objectName,
  fetchFn,
  processFn,
  startOffset = 0,
  retentionDays = 90,
  logger = fallbackLogger
) {
  let offset = startOffset;

  while (true) {
    const records = await retryWithBackoff(() => fetchFn(PAGE_SIZE, offset), 3, logger);
    if (!records || records.length === 0) {
      logger.info(`[${migrationId}] ${objectName}: no more records at offset ${offset}`);
      break;
    }

    logger.info(`[${migrationId}] ${objectName}: processing ${records.length} records (offset ${offset})`);

    // Stage fetched records to MongoDB for data retention
    await staging.stageRecords(migrationId, objectName, records, retentionDays);

    let success = 0;
    let failed = 0;

    for (const record of records) {
      const sourceId = extractSysId(record);
      try {
        const result = await retryWithBackoff(() => processFn(record), 3, logger);
        if (result === 'skipped') {
          if (sourceId)
            await staging.markSkipped(
              migrationId,
              objectName,
              sourceId,
              'Skipped by processor'
            );
        } else {
          success++;
          if (sourceId) {
            const targetId = typeof result === 'object' ? result?.id : result;
            await staging.markPushed(
              migrationId,
              objectName,
              sourceId,
              targetId
            );
          }
        }
      } catch (err) {
        if (err.response?.status === 409) {
          success++;
          if (sourceId)
            await staging.markPushed(
              migrationId,
              objectName,
              sourceId,
              'duplicate'
            );
        } else {
          failed++;
          const errDetail = err.response?.data ?? err.message;
          if (err.response?.status === 400 && err.response?.data?.errors) {
            logger.error(
              `[${migrationId}] VALIDATION DETAILS for ${objectName} ${sourceId}: ${JSON.stringify(err.response.data.errors)}`
            );
          }
          await logError(migrationId, objectName, sourceId, {
            message: err.message,
            details: errDetail,
          }, logger);
          if (sourceId)
            await staging.markFailed(
              migrationId,
              objectName,
              sourceId,
              err.message
            );
        }
      }
    }

    logger.info(`[${migrationId}] ${objectName}: page done — success=${success} failed=${failed}`);
    await updateStats(migrationId, objectName, success, failed);
    offset += records.length;
    await saveCheckpoint(
      migrationId,
      objectName,
      offset,
      records.at(-1)?.sys_id
    );

    if (records.length < PAGE_SIZE) break;
  }
}

// ── Compute object status from stats ────────────────────────────────────────
function computeObjectStatus(stats) {
  const { total, success, failed } = stats;
  if (total === 0) return 'failed';
  if (failed === total) return 'failed';
  if (success > 0 && failed === 0) return 'completed';
  if (success > 0 && failed > 0) return 'partial';
  return 'failed';
}

// ── Build per-object stage runner ────────────────────────────────────────────
function buildObjectStage(object, migration, source, target, mappers, deps) {
  const { migrationId, fm, valueMappings, agentMatching, groupMapping, retentionDays, logger } = deps;
  const { deptIdMap, requesterIdMap } = deps;

  function mapRecord(objectType, record, fallbackFn) {
    const objectMappings = fm[objectType];
    let mapped = objectMappings?.length > 0
      ? applyMappings(record, objectMappings)
      : fallbackFn(record);
    const objValueMappings = valueMappings[objectType];
    if (objValueMappings || groupMapping.length > 0 || agentMatching.entries?.length > 0) {
      mapped = applyValueMappings(record, mapped, objectType, objValueMappings, { agentMatching, groupMapping });
    }
    return mapped;
  }

  const agentEmailToId = new Map(
    (agentMatching.entries ?? []).filter((e) => e.fsAgentId).map((e) => [e.snName, e.fsAgentId])
  );
  const groupNameToId = new Map(
    (groupMapping ?? []).filter((g) => g.fsGroupId).map((g) => [g.snGroupName, g.fsGroupId])
  );
  const requesterEmailToId = new Map([
    ...Array.from(requesterIdMap.entries()),
    ...(agentMatching.entries ?? []).filter((e) => e.fsAgentId).map((e) => [e.snName, e.fsAgentId]),
  ]);

  const stages = {
    companies: async () => {
      await processPages(
        migrationId, 'companies',
        (limit, offset) => source.fetchCompanies(limit, offset),
        async (record) => {
          const mapped = mapRecord('companies', record, (r) => mappers.company.mapDepartment(r));
          if (!mapped.name) {
            const rawName = typeof record.name === 'object' ? record.name?.value ?? record.name?.display_value : record.name;
            mapped.name = rawName || null;
          }
          if (!mapped.name) { return 'skipped'; }
          const res = await target.createDepartment(mapped);
          const sysId = extractSysId(record);
          if (sysId) deptIdMap.set(sysId, res.department?.id);
          return res.department?.id;
        },
        0, retentionDays, logger
      );
    },
    users: async () => {
      await processPages(
        migrationId, 'users',
        (limit, offset) => source.fetchUsers(limit, offset),
        async (record) => {
          const mapped = mapRecord('users', record, (r) => mappers.user.mapRequester(r, deptIdMap));
          if (!mapped || !mapped.primary_email) {
            await logSkip(migrationId, 'users', extractSysId(record), 'Missing primary_email', logger);
            return 'skipped';
          }
          const deptRef = record.department;
          const deptId = deptIdMap?.get(typeof deptRef === 'object' ? deptRef?.value : deptRef);
          if (deptId && !mapped.department_id) mapped.department_id = deptId;
          const res = await target.createRequester(mapped);
          const fullName = `${val(record.first_name)} ${val(record.last_name)}`.trim();
          if (fullName) requesterIdMap.set(fullName, res.requester?.id);
          if (mapped.primary_email) requesterIdMap.set(mapped.primary_email, res.requester?.id);
          return res.requester?.id;
        },
        0, retentionDays, logger
      );
    },
    admins: async () => {
      await processPages(
        migrationId, 'admins',
        (limit, offset) => source.fetchAdminUsers(limit, offset),
        async (record) => {
          try {
            const mapped = mapRecord('admins', record, (r) => mappers.user.mapAgent(r));
            if (!mapped.email || !mapped.email.includes('@')) {
              await logSkip(migrationId, 'admins', extractSysId(record), 'Missing or invalid email', logger);
              return 'skipped';
            }
            const res = await target.createAgent(mapped);
            return res.agent?.id;
          } catch (err) {
            if (err.response?.status === 400 && err.response?.data?.errors?.[0]?.field === 'occasional') {
              await logSkip(migrationId, 'admins', extractSysId(record), 'Agent license limit reached', logger);
              return 'skipped';
            }
            throw err;
          }
        },
        0, retentionDays, logger
      );
    },
    incidents: async () => {
      await saveCheckpoint(migrationId, 'incidents', 0, null);
      const incidentStats = await migrateIncidents({
        snowClient: source, fsClient: target,
        agentEmailToId, groupNameToId, requesterEmailToId, deptIdMap,
        snowBaseUrl: migration.source.credentials.instanceUrl,
        logger, fieldMappings: fm.incidents ?? [], valueMappings: valueMappings.incidents ?? {},
        onProgress: (current, total) => logger.info(`[${migrationId}] incidents: ${current}/${total}`),
      });
      await persistOrchestratorStats(migrationId, {
        incidents: incidentStats.incidents,
        notes: incidentStats.notes,
        attachments: incidentStats.attachments,
        tasks: incidentStats.tasks,
      });
      await saveCheckpoint(migrationId, 'incidents_done', 0, null);
    },
    changes: async () => {
      await saveCheckpoint(migrationId, 'changes', 0, null);
      const changeStats = await migrateChanges({
        snowClient: source, fsClient: target,
        agentEmailToId, groupNameToId, requesterEmailToId,
        snowBaseUrl: migration.source.credentials.instanceUrl,
        logger, fieldMappings: fm.changes ?? [], valueMappings: valueMappings.changes ?? {},
        onProgress: (current, total) => logger.info(`[${migrationId}] changes: ${current}/${total}`),
      });
      await persistOrchestratorStats(migrationId, {
        changes: changeStats.changes,
        notes: changeStats.notes,
        attachments: changeStats.attachments,
        tasks: changeStats.tasks,
      });
      await saveCheckpoint(migrationId, 'changes_done', 0, null);
    },
    problems: async () => {
      await saveCheckpoint(migrationId, 'problems', 0, null);
      const problemStats = await migrateProblems({
        snowClient: source, fsClient: target,
        agentEmailToId, groupNameToId, requesterEmailToId,
        snowBaseUrl: migration.source.credentials.instanceUrl,
        logger, fieldMappings: fm.problems ?? [], valueMappings: valueMappings.problems ?? {},
        onProgress: (current, total) => logger.info(`[${migrationId}] problems: ${current}/${total}`),
      });
      await persistOrchestratorStats(migrationId, {
        problems: problemStats.problems,
        notes: problemStats.notes,
        attachments: problemStats.attachments,
        tasks: problemStats.tasks,
      });
      await saveCheckpoint(migrationId, 'problems_done', 0, null);
    },
    kb_categories: async () => {
      // kb_categories and kb_articles are run together via the kb orchestrator
      await saveCheckpoint(migrationId, 'kb', 0, null);
      const kbStats = await migrateKb({
        snowClient: source, fsClient: target,
        agentEmailToId,
        snowBaseUrl: migration.source.credentials.instanceUrl,
        logger, fieldMappings: fm.kb_articles ?? [], valueMappings: valueMappings.kb_articles ?? {},
        onProgress: (current, total) => logger.info(`[${migrationId}] kb: ${current}/${total}`),
      });
      await persistOrchestratorStats(migrationId, {
        kb_categories: kbStats.categories,
        kb_folders: kbStats.folders,
        kb_articles: kbStats.articles,
        attachments: kbStats.attachments,
      });
      await saveCheckpoint(migrationId, 'kb_done', 0, null);
    },
    kb_articles: async () => stages.kb_categories(),
  };

  return stages[object] ?? null;
}

// ── Single-object Job Processor ───────────────────────────────────────────────
async function processObjectJob(job) {
  const { migrationId, object } = job.data;
  const logger = createMigrationLogger(migrationId);

  const migration = await Migration.findById(migrationId);
  if (!migration) throw new Error(`Migration ${migrationId} not found`);

  const source = createSourceConnector(migration.source.system, migration.source.credentials);
  const target = createTargetConnector(migration.target.system, migration.target.credentials);

  try {
    const { total } = await target.getRateLimitInfo();
    if (total) { rateLimitState.total = total; rateLimitState.remaining = total; }
  } catch { /* use fallback */ }

  const mappers = getMappers(migration.source.system, migration.target.system);
  const fm = migration.fieldMappings ?? {};
  const valueMappings = migration.valueMappings ?? {};
  const agentMatching = migration.agentMatching ?? {};
  const groupMapping = migration.groupMapping ?? [];
  const retentionDays = migration.retentionPolicy?.retentionDays ?? 90;
  const deptIdMap = new Map();
  const requesterIdMap = new Map();

  const deps = { migrationId, fm, valueMappings, agentMatching, groupMapping, retentionDays, logger, deptIdMap, requesterIdMap };
  const stageFn = buildObjectStage(object, migration, source, target, mappers, deps);
  if (!stageFn) throw new Error(`Unknown object: ${object}`);

  await Migration.findByIdAndUpdate(migrationId, {
    [`objectStatuses.${object}`]: 'running',
    status: 'running',
  });

  logger.info(`[${migrationId}] Running single-object stage: ${object}`);
  await stageFn();
  logger.info(`[${migrationId}] Finished single-object stage: ${object}`);

  // Determine final object status from stats
  const fresh = await Migration.findById(migrationId, 'stats').lean();
  const objStats = fresh?.stats?.[object] ?? { total: 0, success: 0, failed: 0 };
  const objectStatus = computeObjectStatus(objStats);

  await Migration.findByIdAndUpdate(migrationId, {
    [`objectStatuses.${object}`]: objectStatus,
  });
  logger.info(`[${migrationId}] ${object} status: ${objectStatus}`);
}

// ── Main Job Processor ────────────────────────────────────────────────────────
async function processMigrationJob(job) {
  const { migrationId } = job.data;

  const logger = createMigrationLogger(migrationId);
  logger.info(`[${migrationId}] Log file: ${logger.logFile}`);

  const migration = await Migration.findById(migrationId);
  if (!migration) throw new Error(`Migration ${migrationId} not found`);

  const emptyStats = Object.fromEntries(
    [
      'companies', 'users', 'admins', 'incidents', 'changes', 'problems',
      'notes', 'kb_categories', 'kb_folders', 'kb_articles', 'comments',
      'attachments', 'tasks',
    ].map((k) => [k, { total: 0, success: 0, failed: 0, skipped: 0 }])
  );

  const isFreshStart = !migration.checkpoint?.currentObject && !migration.startedAt;

  const resetFields = isFreshStart
    ? {
        status: 'running',
        startedAt: new Date(),
        completedAt: null,
        stats: emptyStats,
        errorLog: [],
        'checkpoint.currentObject': null,
        'checkpoint.offset': 0,
      }
    : {
        status: 'running',
        completedAt: null,
      };

  await Migration.findByIdAndUpdate(migrationId, resetFields);
  logger.info(`[${migrationId}] Migration ${ isFreshStart ? 'started' : 'resumed from checkpoint: ' + (migration.checkpoint?.currentObject ?? 'none') }`);

  const source = createSourceConnector(
    migration.source.system,
    migration.source.credentials
  );
  const target = createTargetConnector(
    migration.target.system,
    migration.target.credentials
  );

  // Discover actual rate limit for this FS account
  try {
    const { total } = await target.getRateLimitInfo();
    if (total) {
      rateLimitState.total = total;
      rateLimitState.remaining = total;
      logger.info(`[${migrationId}] FS rate limit: ${total} req/min`);
    }
  } catch {
    logger.warn(
      `[${migrationId}] Could not discover rate limit — using conservative fallback (${rateLimitState.fallbackTotal} req/min)`
    );
  }
  const mappers = getMappers(migration.source.system, migration.target.system);
  const cfg = migration.objectConfig;
  const fm = migration.fieldMappings ?? {};
  const retentionDays = migration.retentionPolicy?.retentionDays ?? 90;

  // Load value mappings, agent matching, group mapping
  const valueMappings = migration.valueMappings ?? {};
  const agentMatching = migration.agentMatching ?? {};
  const groupMapping = migration.groupMapping ?? [];
  const mappingContext = { agentMatching, groupMapping };

  function mapRecord(objectType, record, fallbackFn) {
    const objectMappings = fm[objectType];
    let mapped;
    if (objectMappings && objectMappings.length > 0) {
      mapped = applyMappings(record, objectMappings);
    } else {
      mapped = fallbackFn(record);
    }

    // Apply configurable value mappings (priority, status, category, group, agent)
    const objValueMappings = valueMappings[objectType];
    if (
      objValueMappings ||
      groupMapping.length > 0 ||
      agentMatching.entries?.length > 0
    ) {
      mapped = applyValueMappings(
        record,
        mapped,
        objectType,
        objValueMappings,
        mappingContext
      );
    }

    return mapped;
  }

  // ID maps for cross-referencing created records
  const deptIdMap = new Map();
  const requesterIdMap = new Map();
  const ticketIdMap = new Map();

  const resumeFrom = migration.checkpoint?.currentObject;
  const resumeOffset = migration.checkpoint?.offset ?? 0;

  const PIPELINE = [
    {
      name: 'companies',
      enabled: cfg.companies,
      run: async () => {
        await processPages(
          migrationId,
          'companies',
          (limit, offset) => source.fetchCompanies(limit, offset),
          async (record) => {
            const mapped = mapRecord('companies', record, (r) =>
              mappers.company.mapDepartment(r)
            );
            if (!mapped.name) {
              const rawName =
                typeof record.name === 'object'
                  ? record.name?.value ?? record.name?.display_value
                  : record.name;
              mapped.name = rawName || null;
            }
            if (!mapped.name) {
              const sysId = extractSysId(record);
              console.log(
                `[${migrationId}] companies SKIPPED ${sysId}: Missing company name`
              );
              return 'skipped';
            }
            const res = await target.createDepartment(mapped);
            const sysId = extractSysId(record);
            if (sysId) deptIdMap.set(sysId, res.department?.id);
            return res.department?.id;
          },
          resumeFrom === 'companies' ? resumeOffset : 0,
          retentionDays,
          logger
        );
      },
    },
    {
      name: 'users',
      enabled: cfg.users,
      run: async () => {
        await processPages(
          migrationId,
          'users',
          (limit, offset) => source.fetchUsers(limit, offset),
          async (record) => {
            const mapped = mapRecord('users', record, (r) =>
              mappers.user.mapRequester(r, deptIdMap)
            );
            if (!mapped || !mapped.primary_email) {
              const sid = extractSysId(record);
              await logSkip(migrationId, 'users', sid, 'Missing primary_email', logger);
              return 'skipped';
            }
            const deptRef = record.department;
            const deptId = deptIdMap?.get(
              typeof deptRef === 'object' ? deptRef?.value : deptRef
            );
            if (deptId && !mapped.department_id) mapped.department_id = deptId;
            const res = await target.createRequester(mapped);
            const fullName = `${val(record.first_name)} ${val(
              record.last_name
            )}`.trim();
            if (fullName) requesterIdMap.set(fullName, res.requester?.id);
            if (mapped.primary_email)
              requesterIdMap.set(mapped.primary_email, res.requester?.id);
            return res.requester?.id;
          },
          resumeFrom === 'users' ? resumeOffset : 0,
          retentionDays,
          logger
        );
      },
    },
    {
      name: 'admins',
      enabled: cfg.admins,
      run: async () => {
        await processPages(
          migrationId,
          'admins',
          (limit, offset) => source.fetchAdminUsers(limit, offset),
          async (record) => {
            const err400 = (e) => e.response?.status === 400;
            try {
              const mapped = mapRecord('admins', record, (r) =>
                mappers.user.mapAgent(r)
              );
              if (!mapped.email || !mapped.email.includes('@')) {
                const sid = extractSysId(record);
                await logSkip(
                  migrationId,
                  'admins',
                  sid,
                  'Missing or invalid email',
                  logger
                );
                return 'skipped';
              }
              const res = await target.createAgent(mapped);
              return res.agent?.id;
            } catch (err) {
              if (
                err400(err) &&
                err.response?.data?.errors?.[0]?.field === 'occasional'
              ) {
                const sid = extractSysId(record);
                await logSkip(
                  migrationId,
                  'admins',
                  sid,
                  'Agent license limit reached',
                  logger
                );
                return 'skipped';
              }
              throw err;
            }
          },
          resumeFrom === 'admins' ? resumeOffset : 0,
          retentionDays,
          logger
        );
      },
    },
    {
      name: 'incidents',
      enabled: cfg.incidents,
      run: async () => {
        const fresh = await Migration.findById(
          migrationId,
          'checkpoint'
        ).lean();
        if (fresh?.checkpoint?.currentObject === 'incidents_done') {
          logger.info(`[${migrationId}] incidents: already completed, skipping`);
          return;
        }
        await saveCheckpoint(migrationId, 'incidents', 0, null);

        const agentEmailToId = new Map(
          (agentMatching.entries ?? [])
            .filter((e) => e.fsAgentId)
            .map((e) => [e.snName, e.fsAgentId])
        );

        const groupNameToId = new Map(
          (groupMapping ?? [])
            .filter((g) => g.fsGroupId)
            .map((g) => [g.snGroupName, g.fsGroupId])
        );

        const requesterEmailToId = new Map([
          ...Array.from(requesterIdMap.entries()),
          ...(agentMatching.entries ?? [])
            .filter((e) => e.fsAgentId)
            .map((e) => [e.snName, e.fsAgentId]),
        ]);

        const incidentStats = await migrateIncidents({
          snowClient: source,
          fsClient: target,
          agentEmailToId,
          groupNameToId,
          requesterEmailToId,
          deptIdMap,
          snowBaseUrl: migration.source.credentials.instanceUrl,
          logger,
          fieldMappings: fm.incidents ?? [],
          valueMappings: valueMappings.incidents ?? {},
          onProgress: (current, total) =>
            logger.info(`[${migrationId}] incidents: ${current}/${total}`),
        });
        await persistOrchestratorStats(migrationId, {
          incidents: incidentStats.incidents,
          notes: incidentStats.notes,
          attachments: incidentStats.attachments,
          tasks: incidentStats.tasks,
        });
        await saveCheckpoint(migrationId, 'incidents_done', 0, null);
      },
    },
    {
      name: 'changes',
      enabled: cfg.changes,
      run: async () => {
        const fresh = await Migration.findById(
          migrationId,
          'checkpoint'
        ).lean();
        if (fresh?.checkpoint?.currentObject === 'changes_done') {
          logger.info(`[${migrationId}] changes: already completed, skipping`);
          return;
        }
        await saveCheckpoint(migrationId, 'changes', 0, null);

        const agentEmailToId = new Map(
          (agentMatching.entries ?? [])
            .filter((e) => e.fsAgentId)
            .map((e) => [e.snName, e.fsAgentId])
        );
        const groupNameToId = new Map(
          (groupMapping ?? [])
            .filter((g) => g.fsGroupId)
            .map((g) => [g.snGroupName, g.fsGroupId])
        );
        const requesterEmailToId = new Map([
          ...Array.from(requesterIdMap.entries()),
          ...(agentMatching.entries ?? [])
            .filter((e) => e.fsAgentId)
            .map((e) => [e.snName, e.fsAgentId]),
        ]);

        const changeStats = await migrateChanges({
          snowClient: source,
          fsClient: target,
          agentEmailToId,
          groupNameToId,
          requesterEmailToId,
          snowBaseUrl: migration.source.credentials.instanceUrl,
          logger,
          fieldMappings: fm.changes ?? [],
          valueMappings: valueMappings.changes ?? {},
          onProgress: (current, total) =>
            logger.info(`[${migrationId}] changes: ${current}/${total}`),
        });
        await persistOrchestratorStats(migrationId, {
          changes: changeStats.changes,
          notes: changeStats.notes,
          attachments: changeStats.attachments,
          tasks: changeStats.tasks,
        });
        await saveCheckpoint(migrationId, 'changes_done', 0, null);
      },
    },
    {
      name: 'problems',
      enabled: cfg.problems,
      run: async () => {
        const fresh = await Migration.findById(
          migrationId,
          'checkpoint'
        ).lean();
        if (fresh?.checkpoint?.currentObject === 'problems_done') {
          logger.info(`[${migrationId}] problems: already completed, skipping`);
          return;
        }
        await saveCheckpoint(migrationId, 'problems', 0, null);

        const agentEmailToId = new Map(
          (agentMatching.entries ?? [])
            .filter((e) => e.fsAgentId)
            .map((e) => [e.snName, e.fsAgentId])
        );
        const groupNameToId = new Map(
          (groupMapping ?? [])
            .filter((g) => g.fsGroupId)
            .map((g) => [g.snGroupName, g.fsGroupId])
        );
        const requesterEmailToId = new Map([
          ...Array.from(requesterIdMap.entries()),
          ...(agentMatching.entries ?? [])
            .filter((e) => e.fsAgentId)
            .map((e) => [e.snName, e.fsAgentId]),
        ]);

        const problemStats = await migrateProblems({
          snowClient: source,
          fsClient: target,
          agentEmailToId,
          groupNameToId,
          requesterEmailToId,
          snowBaseUrl: migration.source.credentials.instanceUrl,
          logger,
          fieldMappings: fm.problems ?? [],
          valueMappings: valueMappings.problems ?? {},
          onProgress: (current, total) =>
            logger.info(`[${migrationId}] problems: ${current}/${total}`),
        });
        await persistOrchestratorStats(migrationId, {
          problems: problemStats.problems,
          notes: problemStats.notes,
          attachments: problemStats.attachments,
          tasks: problemStats.tasks,
        });
        await saveCheckpoint(migrationId, 'problems_done', 0, null);
      },
    },
    {
      name: 'kb',
      enabled: cfg.kb_categories || cfg.kb_articles,
      run: async () => {
        const fresh = await Migration.findById(
          migrationId,
          'checkpoint'
        ).lean();
        if (fresh?.checkpoint?.currentObject === 'kb_done') {
          logger.info(`[${migrationId}] kb: already completed, skipping`);
          return;
        }
        await saveCheckpoint(migrationId, 'kb', 0, null);

        const agentEmailToId = new Map(
          (agentMatching.entries ?? [])
            .filter((e) => e.fsAgentId)
            .map((e) => [e.snName, e.fsAgentId])
        );

        const kbStats = await migrateKb({
          snowClient: source,
          fsClient: target,
          agentEmailToId,
          snowBaseUrl: migration.source.credentials.instanceUrl,
          logger,
          fieldMappings: fm.kb_articles ?? [],
          valueMappings: valueMappings.kb_articles ?? {},
          onProgress: (current, total) =>
            logger.info(`[${migrationId}] kb: ${current}/${total}`),
        });
        await persistOrchestratorStats(migrationId, {
          kb_categories: kbStats.categories,
          kb_folders: kbStats.folders,
          kb_articles: kbStats.articles,
          attachments: kbStats.attachments,
        });
        await saveCheckpoint(migrationId, 'kb_done', 0, null);
      },
    },
  ];

  // Skip already-completed stages when resuming.
  // Strip '_done' suffix so 'incidents_done' resolves to the 'incidents' stage.
  const baseResume = resumeFrom?.replace(/_done$/, '') ?? null;
  const startIndex = baseResume
    ? Math.max(
        0,
        PIPELINE.findIndex((s) => s.name === baseResume)
      )
    : 0;

  for (let i = startIndex; i < PIPELINE.length; i++) {
    const stage = PIPELINE[i];
    if (!stage.enabled) {
      logger.info(`[${migrationId}] Skipping ${stage.name} (disabled)`);
      continue;
    }
    logger.info(`[${migrationId}] Starting stage: ${stage.name}`);
    await stage.run();
    logger.info(`[${migrationId}] Finished stage: ${stage.name}`);
  }

  await Migration.findByIdAndUpdate(migrationId, {
    status: 'completed',
    completedAt: new Date(),
    'checkpoint.currentObject': null,
    'checkpoint.offset': 0,
  });
  logger.info(`[${migrationId}] Migration completed`);
}

// ── Worker Bootstrap ──────────────────────────────────────────────────────────
export function startMigrationWorker() {
  const worker = new Worker(
    'migration',
    (job) => job.name === 'process-object' ? processObjectJob(job) : processMigrationJob(job),
    {
      connection: redisService.getBullWorkerClient(),
      concurrency: 5,
    }
  );

  worker.on('completed', (job) =>
    fallbackLogger.log(`Migration job ${job.id} completed`)
  );
  worker.on('failed', async (job, err) => {
    fallbackLogger.error(`Migration job ${job.id} failed: ${err.message}`);
    if (job.name === 'process-object') {
      await Migration.findByIdAndUpdate(job.data.migrationId, {
        [`objectStatuses.${job.data.object}`]: 'failed',
      });
    } else {
      await Migration.findByIdAndUpdate(job.data.migrationId, { status: 'failed' });
    }
  });

  return worker;
}
