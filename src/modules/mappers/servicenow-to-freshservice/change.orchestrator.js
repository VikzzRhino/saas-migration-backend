// src/modules/mappers/servicenow-to-freshservice/change.orchestrator.js

import { mapChange } from './change.mapper.js';
import { migrateChangeNotes } from './changes/change-notes.migrator.js';
import { migrateChangeAttachments } from './changes/change-attachments.migrator.js';
import { migrateChangeTasks } from './changes/change-tasks.migrator.js';
import {
  applyMappings,
  applyValueMappings,
} from '../../field-mapping/value-transforms.js';
import { processInlineImages } from '../../../utils/inline-image.processor.js';
import { throttledPost } from '../../../utils/throttled-request.js';

const PAGE_SIZE = 100;

const SNOW_FIELDS = [
  'sys_id',
  'number',
  'short_description',
  'description',
  'priority',
  'state',
  'type',
  'impact',
  'risk',
  'category',
  'subcategory',
  'start_date',
  'end_date',
  'due_date',
  'assigned_to',
  'assignment_group',
  'requested_by',
  'requested_by.email',
  'opened_by',
  'opened_by.email',
  'opened_at',
  'sys_updated_on',
  'closed_at',
  'close_date',
  'reason',
  'justification',
  'implementation_plan',
  'backout_plan',
  'test_plan',
  'close_code',
  'close_notes',
  'cab_required',
  'cab_date',
].join(',');

function val(field) {
  if (!field) return null;
  return typeof field === 'object'
    ? field.value ?? field.display_value ?? null
    : field;
}

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmailString(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const angle = s.match(/<([^>]+@[^>]+)>/);
  const candidate = (angle ? angle[1] : s).trim();
  return EMAIL_LIKE.test(candidate) ? candidate : null;
}

function extractEmail(field) {
  if (!field) return null;
  const str =
    typeof field === 'object' ? field.display_value ?? field.value : field;
  return normalizeEmailString(String(str ?? ''));
}

function findRequesterEmail(snow) {
  return (
    extractEmail(snow['requested_by.email']) ||
    extractEmail(snow['opened_by.email']) ||
    extractEmail(snow.requested_by) ||
    extractEmail(snow.opened_by)
  );
}

function initStats() {
  return {
    changes: { total: 0, migrated: 0, failed: 0 },
    notes: { total: 0, migrated: 0, failed: 0, skipped: 0 },
    attachments: { total: 0, migrated: 0, failed: 0, skipped: 0 },
    tasks: { total: 0, migrated: 0, failed: 0, skipped: 0 },
  };
}

function accumulateSummary(statsKey, stats, summary) {
  if (!summary) return;
  stats[statsKey].total += summary.total ?? 0;
  stats[statsKey].migrated += summary.migrated ?? 0;
  stats[statsKey].failed += summary.failed ?? 0;
  if ('skipped' in stats[statsKey]) {
    stats[statsKey].skipped += summary.skipped ?? 0;
  }
}

const VALID_CHANGE_FIELDS = new Set([
  'agent_id',
  'description',
  'requester_id',
  'email',
  'group_id',
  'priority',
  'impact',
  'status',
  'risk',
  'change_type',
  'approval_status',
  'planned_start_date',
  'planned_end_date',
  'subject',
  'department_id',
  'category',
  'sub_category',
  'item_category',
  'custom_fields',
  'maintenance_window',
  'assets',
  'impacted_services',
  'attachments',
  'created_at',
  'updated_at',
  'tags',
]);

function sanitizePayload(payload) {
  for (const key of Object.keys(payload)) {
    if (!VALID_CHANGE_FIELDS.has(key)) {
      delete payload[key];
    }
  }

  if (
    !payload.description ||
    !payload.description.trim() ||
    payload.description === '<p> </p>'
  ) {
    payload.description = payload.subject || '<p>No description provided</p>';
  }

  const fallbackStart = new Date(Date.now() + 86400000).toISOString();
  const fallbackEnd = new Date(Date.now() + 172800000).toISOString();
  if (!payload.planned_start_date) payload.planned_start_date = fallbackStart;
  if (!payload.planned_end_date) payload.planned_end_date = fallbackEnd;

  if (
    new Date(payload.planned_end_date) <= new Date(payload.planned_start_date)
  ) {
    payload.planned_end_date = new Date(
      new Date(payload.planned_start_date).getTime() + 86400000
    ).toISOString();
  }

  const now = new Date();
  if (payload.created_at && new Date(payload.created_at) > now) {
    delete payload.created_at;
  }
  if (payload.updated_at && new Date(payload.updated_at) > now) {
    delete payload.updated_at;
  }

  if (payload.created_at && payload.updated_at) {
    if (new Date(payload.updated_at) < new Date(payload.created_at)) {
      payload.updated_at = payload.created_at;
    }
  }

  if (payload.sub_category && !payload.category) {
    delete payload.sub_category;
  }

  if (payload.requester_id !== undefined) {
    const rid = payload.requester_id;
    const isValidNumber = typeof rid === 'number' && rid > 0;
    const normalized =
      typeof rid === 'string' ? normalizeEmailString(rid) : null;
    if (isValidNumber) {
      /* keep numeric FS requester id */
    } else if (normalized) {
      payload.requester_id = normalized;
    } else {
      delete payload.requester_id;
    }
  }

  if (payload.email !== undefined) {
    const norm = normalizeEmailString(String(payload.email));
    if (norm) payload.email = norm;
    else delete payload.email;
  }

  return payload;
}

const REQUIRED_CUSTOM_FIELDS = [
  'snow_number',
  'close_code',
  'close_notes',
  'cab_required',
  'cab_date',
];

/**
 * Validates that the required custom fields exist in Freshservice change form fields.
 * Missing fields will cause custom_fields data to be silently dropped on create.
 *
 * @param {object} fsClient - Freshservice HTTP client with get(path) method
 * @param {object} logger   - Logger with warn(), error() methods
 * @returns {Promise<{ valid: boolean, missing: string[] }>}
 */
export async function validateChangeCustomFields(fsClient, logger) {
  const missing = [];

  try {
    const response = await fsClient.get('/api/v2/change_fields');
    const fields = response?.change_fields ?? [];
    const fieldNames = new Set(fields.map((f) => f.name));

    for (const required of REQUIRED_CUSTOM_FIELDS) {
      if (!fieldNames.has(required)) {
        missing.push(required);
        logger.warn(
          `[changes] Custom field '${required}' not found in Freshservice. ` +
            `Create it in Freshservice Admin → Admin → Field Manager → Change Fields`
        );
      }
    }
  } catch (err) {
    logger.error(
      `[changes] Could not fetch change form fields for validation: ${err.message}`
    );
    missing.push(...REQUIRED_CUSTOM_FIELDS);
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Orchestrates the full paginated migration of all ServiceNow changes to Freshservice.
 * Fetches all change_request records in pages, maps and creates each in Freshservice,
 * then sequentially migrates notes, attachments, and tasks per change.
 *
 * @param {object} context
 * @param {object} context.snowClient              - SN HTTP client with get(url, params)
 * @param {object} context.fsClient               - FS HTTP client with post(path, body)
 * @param {Map<string, number>} context.agentEmailToId     - SN agent display name/email → FS agent ID
 * @param {Map<string, number>} context.groupNameToId      - SN group display name → FS group ID
 * @param {Map<string, number>} context.requesterEmailToId - SN requester display name/email → FS requester ID
 * @param {string} context.snowBaseUrl             - ServiceNow base URL
 * @param {object} context.logger                  - Logger with info(), warn(), error()
 * @param {Function} [context.onProgress]          - Optional callback(current, total) called after each record
 * @returns {Promise<{
 *   changes:     { total: number, migrated: number, failed: number },
 *   notes:       { total: number, migrated: number, failed: number, skipped: number },
 *   attachments: { total: number, migrated: number, failed: number, skipped: number },
 *   tasks:       { total: number, migrated: number, failed: number, skipped: number },
 * }>}
 * @throws {Error} if any page fetch from ServiceNow fails
 */
export async function migrateChanges(context) {
  const { snowClient, fsClient, snowBaseUrl, logger, onProgress } = context;

  const stats = initStats();

  // Preflight — validate custom fields exist in Freshservice
  const { valid } = await validateChangeCustomFields(fsClient, logger);
  if (!valid) {
    logger.warn(
      '[changes] Some custom fields missing — data will be silently dropped'
    );
  }

  // Step 2 — Paginated fetch
  const allChanges = [];
  let offset = 0;

  while (true) {
    let result;
    try {
      const response = await snowClient.get(
        `${snowBaseUrl}/api/now/table/change_request`,
        {
          sysparm_fields: SNOW_FIELDS,
          sysparm_display_value: 'all',
          sysparm_limit: PAGE_SIZE,
          sysparm_offset: offset,
        }
      );
      result = response?.result ?? [];
    } catch (err) {
      logger.error(
        `[changes] Failed to fetch page at offset ${offset}: ${err.message}`
      );
      throw new Error(
        `Changes migration aborted — page fetch failed at offset ${offset}: ${err.message}`
      );
    }

    if (!result.length) break;
    allChanges.push(...result);
    if (result.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const total = allChanges.length;
  logger.info(`[changes] Fetched ${total} changes from ServiceNow`);
  stats.changes.total = total;

  // Step 3 — Process each change
  for (let i = 0; i < allChanges.length; i++) {
    const snow = allChanges[i];
    const snowSysId = val(snow.sys_id);
    const snowNumber = val(snow.number) ?? snowSysId;

    // a) Map
    const payload = mapChange(snow, context);

    // Apply dynamic field mappings from migration config
    if (context.fieldMappings?.length > 0) {
      const dynamicMapped = applyMappings(snow, context.fieldMappings);
      if (dynamicMapped.custom_fields) {
        payload.custom_fields = {
          ...payload.custom_fields,
          ...dynamicMapped.custom_fields,
        };
        delete dynamicMapped.custom_fields;
      }
      Object.assign(payload, dynamicMapped);
    }

    // Apply value mappings (enum translation)
    if (
      context.valueMappings &&
      Object.keys(context.valueMappings).length > 0
    ) {
      applyValueMappings(snow, payload, 'changes', context.valueMappings, {
        agentMatching: { entries: [] },
        groupMapping: [],
      });
    }

    if (!valid) delete payload.custom_fields;

    sanitizePayload(payload);

    // Requester fallback — ensure requester_id or email is present after sanitization
    if (!payload.requester_id && !payload.email) {
      const fallbackEmail = findRequesterEmail(snow);
      if (fallbackEmail) payload.email = fallbackEmail;
    }

    // b) Create in Freshservice
    let freshChangeId;
    try {
      const response = await throttledPost(
        fsClient,
        '/api/v2/changes',
        payload,
        { tag: 'changes' }
      );
      freshChangeId = response?.change?.id ?? response?.id;
      if (!freshChangeId) throw new Error('No change ID returned in response');
      logger.info(
        `[changes] Created FS change id=${freshChangeId} ← SN ${snowNumber}`
      );
      stats.changes.migrated++;
    } catch (err) {
      const fsError = err?.response?.data;
      const errors = fsError?.errors ?? [];
      const badFields = errors.map((e) => e.field);
      const retryable = badFields.some((f) =>
        ['requester_id', 'category', 'sub_category'].includes(f)
      );

      if (retryable) {
        if (badFields.includes('requester_id')) {
          delete payload.requester_id;
          delete payload.email;
          const fallbackEmail = findRequesterEmail(snow);
          if (fallbackEmail) payload.email = fallbackEmail;
        }
        if (
          badFields.includes('category') ||
          badFields.includes('sub_category')
        ) {
          delete payload.category;
          delete payload.sub_category;
        }
        try {
          const retryRes = await throttledPost(
            fsClient,
            '/api/v2/changes',
            payload,
            { tag: 'changes' }
          );
          freshChangeId = retryRes?.change?.id ?? retryRes?.id;
          if (!freshChangeId) throw new Error('No change ID returned on retry');
          logger.info(
            `[changes] Created FS change id=${freshChangeId} ← SN ${snowNumber} (dropped ${badFields.join(
              ', '
            )})`
          );
          stats.changes.migrated++;
        } catch (retryErr) {
          const retryFsError = retryErr?.response?.data;
          const retryErrors = retryFsError?.errors ?? [];
          const retryBad = retryErrors.map((e) => e.field);
          const onlyRequester =
            retryBad.length > 0 && retryBad.every((f) => f === 'requester_id');
          if (onlyRequester) {
            delete payload.requester_id;
            delete payload.email;
            try {
              const lastRes = await throttledPost(
                fsClient,
                '/api/v2/changes',
                payload,
                { tag: 'changes' }
              );
              freshChangeId = lastRes?.change?.id ?? lastRes?.id;
              if (!freshChangeId) {
                throw new Error('No change ID returned on last-chance retry');
              }
              logger.info(
                `[changes] Created FS change id=${freshChangeId} ← SN ${snowNumber} (no requester — FS default)`
              );
              stats.changes.migrated++;
            } catch (lastErr) {
              const lastFs = lastErr?.response?.data;
              logger.error(
                `[changes] Failed to create change SN ${snowNumber} (retry): ${
                  retryErr.message
                } | FS response: ${JSON.stringify(retryFsError)}`
              );
              logger.error(
                `[changes] Last-chance retry (no requester) also failed: ${
                  lastErr.message
                } | FS response: ${JSON.stringify(lastFs)}`
              );
              stats.changes.failed++;
              if (typeof onProgress === 'function') onProgress(i + 1, total);
              continue;
            }
          } else {
            logger.error(
              `[changes] Failed to create change SN ${snowNumber} (retry): ${
                retryErr.message
              } | FS response: ${JSON.stringify(retryFsError)}`
            );
            stats.changes.failed++;
            if (typeof onProgress === 'function') onProgress(i + 1, total);
            continue;
          }
        }
      } else {
        logger.error(
          `[changes] Failed to create change SN ${snowNumber}: ${
            err.message
          } | FS response: ${JSON.stringify(fsError)}`
        );
        stats.changes.failed++;
        if (typeof onProgress === 'function') onProgress(i + 1, total);
        continue;
      }
    }

    // c) Process inline images in description
    if (payload.description?.includes('<img')) {
      try {
        const fixedDescription = await processInlineImages(
          payload.description,
          `/api/v2/changes/${freshChangeId}/attachments`,
          `/api/v2/changes/${freshChangeId}/inline_attachments`,
          context
        );
        if (fixedDescription !== payload.description) {
          await throttledPost(
            fsClient,
            `/api/v2/changes/${freshChangeId}`,
            {
              description: fixedDescription,
            },
            { tag: 'changes' }
          );
          logger.info(
            `[changes] Updated inline images in change ${freshChangeId}`
          );
        }
      } catch (err) {
        logger.warn(
          `[changes] Failed to process inline images for change ${freshChangeId}: ${err.message}`
        );
      }
    }

    // d) Sub-resources — sequential, never throw
    const notesSummary = await migrateChangeNotes(
      snowSysId,
      freshChangeId,
      context
    );
    const attachSummary = await migrateChangeAttachments(
      snowSysId,
      freshChangeId,
      context
    );
    const tasksSummary = await migrateChangeTasks(
      snowSysId,
      freshChangeId,
      context
    );

    // e) Accumulate sub-resource stats
    accumulateSummary('notes', stats, notesSummary);
    accumulateSummary('attachments', stats, attachSummary);
    accumulateSummary('tasks', stats, tasksSummary);

    // f) Progress callback
    if (typeof onProgress === 'function') onProgress(i + 1, total);
  }

  // Step 4 — Final summary
  logger.info('[changes] Migration complete', stats);

  // Step 5 — Return stats
  return stats;
}
