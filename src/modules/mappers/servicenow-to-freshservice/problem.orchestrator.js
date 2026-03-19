// src/modules/mappers/servicenow-to-freshservice/problem.orchestrator.js

import { mapProblem } from './problem.mapper.js';
import { migrateProblemNotes } from './problems/problem-notes.migrator.js';
import { migrateProblemAttachments } from './problems/problem-attachments.migrator.js';
import { migrateProblemTasks } from './problems/problem-tasks.migrator.js';
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
  'impact',
  'urgency',
  'category',
  'subcategory',
  'due_date',
  'known_error',
  'assigned_to',
  'assignment_group',
  'opened_by',
  'opened_by.email',
  'opened_at',
  'sys_updated_on',
  'closed_at',
  'cause_notes',
  'symptoms',
  'fix_notes',
  'workaround',
  'resolution_code',
].join(',');

function val(field) {
  if (!field) return null;
  return typeof field === 'object'
    ? field.value ?? field.display_value ?? null
    : field;
}

function initStats() {
  return {
    problems: { total: 0, migrated: 0, failed: 0 },
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

const REQUIRED_CUSTOM_FIELDS = ['snow_number', 'resolution_code', 'workaround'];

/**
 * Validates that the required custom fields exist in Freshservice problem form fields.
 * Missing fields will cause custom_fields data to be silently dropped on create.
 *
 * @param {object} fsClient - Freshservice HTTP client with get(path) method
 * @param {object} logger   - Logger with warn(), error() methods
 * @returns {Promise<{ valid: boolean, missing: string[] }>}
 */
export async function validateCustomFields(fsClient, logger) {
  const missing = [];

  try {
    const response = await fsClient.get('/api/v2/problem_fields');
    const fields = response?.problem_fields ?? [];
    const fieldNames = new Set(fields.map((f) => f.name));

    for (const required of REQUIRED_CUSTOM_FIELDS) {
      if (!fieldNames.has(required)) {
        missing.push(required);
        logger.warn(
          `[problems] Custom field '${required}' not found in Freshservice. ` +
            `Create it in Freshservice Admin → Admin → Field Manager → Problem Fields`
        );
      }
    }
  } catch (err) {
    logger.error(
      `[problems] Could not fetch problem form fields for validation: ${err.message}`
    );
    missing.push(...REQUIRED_CUSTOM_FIELDS);
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Orchestrates the full paginated migration of all ServiceNow problems to Freshservice.
 * Fetches all problem records in pages, maps and creates each in Freshservice,
 * then sequentially migrates notes, attachments, and tasks per problem.
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
 *   problems:    { total: number, migrated: number, failed: number },
 *   notes:       { total: number, migrated: number, failed: number, skipped: number },
 *   attachments: { total: number, migrated: number, failed: number, skipped: number },
 *   tasks:       { total: number, migrated: number, failed: number, skipped: number },
 * }>}
 * @throws {Error} if any page fetch from ServiceNow fails
 */
export async function migrateProblems(context) {
  const { snowClient, fsClient, snowBaseUrl, logger, onProgress } = context;

  const stats = initStats();

  // Preflight — validate custom fields exist in Freshservice
  const { valid } = await validateCustomFields(fsClient, logger);
  if (!valid) {
    logger.warn(
      '[problems] Some custom fields missing — data will be silently dropped'
    );
  }

  // Step 1 — Paginated fetch
  const allProblems = [];
  let offset = 0;

  while (true) {
    let result;
    try {
      const response = await snowClient.get(
        `${snowBaseUrl}/api/now/table/problem`,
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
        `[problems] Failed to fetch page at offset ${offset}: ${err.message}`
      );
      throw new Error(
        `Problems migration aborted — page fetch failed at offset ${offset}: ${err.message}`
      );
    }

    if (!result.length) break;
    allProblems.push(...result);
    if (result.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const total = allProblems.length;
  logger.info(`[problems] Fetched ${total} problems from ServiceNow`);
  stats.problems.total = total;

  // Step 2 — Process each problem
  let logged = 0;
  for (let i = 0; i < allProblems.length; i++) {
    const snow = allProblems[i];
    const snowSysId = val(snow.sys_id);
    const snowNumber = val(snow.number) ?? snowSysId;

    // a) Map
    const payload = mapProblem(snow, context);

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
      applyValueMappings(snow, payload, 'problems', context.valueMappings, {
        agentMatching: { entries: [] },
        groupMapping: [],
      });
    }

    if (!valid) delete payload.custom_fields;

    // Requester fallback — Freshservice requires requester_id or email
    if (payload.requester_id === undefined) {
      const obEmail = snow['opened_by.email'];
      const emailStr =
        typeof obEmail === 'object'
          ? obEmail?.display_value ?? obEmail?.value
          : obEmail;
      if (emailStr && emailStr.includes('@')) {
        payload.email = emailStr;
      }
    }

    // Date sanity — updated_at must be >= created_at
    if (payload.created_at && payload.updated_at) {
      if (new Date(payload.updated_at) < new Date(payload.created_at)) {
        payload.updated_at = payload.created_at;
      }
    }

    // b) Create in Freshservice
    let freshProblemId;
    try {
      if (logged < 1) {
        console.log(
          '[problems] PAYLOAD for',
          snowNumber,
          ':',
          JSON.stringify(payload, null, 2)
        );
        logged++;
      }
      const response = await throttledPost(
        fsClient,
        '/api/v2/problems',
        payload,
        { tag: 'problems' }
      );
      freshProblemId = response?.problem?.id ?? response?.id;
      if (!freshProblemId)
        throw new Error('No problem ID returned in response');
      logger.info(
        `[problems] Created FS problem id=${freshProblemId} ← SN ${snowNumber}`
      );
      stats.problems.migrated++;
    } catch (err) {
      const errors = err.response?.data?.errors ?? [];
      const badFields = errors.map((e) => e.field);
      const retryable = badFields.some((f) =>
        ['requester_id', 'category', 'sub_category'].includes(f)
      );

      if (retryable) {
        if (badFields.includes('requester_id')) delete payload.requester_id;
        if (badFields.includes('category')) delete payload.category;
        if (badFields.includes('sub_category')) delete payload.sub_category;
        try {
          const retryRes = await throttledPost(
            fsClient,
            '/api/v2/problems',
            payload,
            { tag: 'problems' }
          );
          freshProblemId = retryRes?.problem?.id ?? retryRes?.id;
          if (!freshProblemId)
            throw new Error('No problem ID returned on retry');
          logger.info(
            `[problems] Created FS problem id=${freshProblemId} ← SN ${snowNumber} (dropped ${badFields.join(
              ', '
            )})`
          );
          stats.problems.migrated++;
        } catch (retryErr) {
          console.error(
            '[problems] FULL ERROR (retry):',
            JSON.stringify(retryErr.response?.data, null, 2)
          );
          logger.error(
            `[problems] Failed to create problem SN ${snowNumber} (retry): ${retryErr.message}`
          );
          stats.problems.failed++;
          if (typeof onProgress === 'function') onProgress(i + 1, total);
          continue;
        }
      } else {
        console.error(
          '[problems] FULL ERROR:',
          JSON.stringify(err.response?.data, null, 2)
        );
        logger.error(
          `[problems] Failed to create problem SN ${snowNumber}: ${err.message}`
        );
        stats.problems.failed++;
        if (typeof onProgress === 'function') onProgress(i + 1, total);
        continue;
      }
    }

    // c) Process inline images in description
    if (payload.description?.includes('<img')) {
      try {
        const fixedDescription = await processInlineImages(
          payload.description,
          `/api/v2/problems/${freshProblemId}/attachments`,
          `/api/v2/problems/${freshProblemId}/inline_attachments`,
          context
        );
        if (fixedDescription !== payload.description) {
          await throttledPost(
            fsClient,
            `/api/v2/problems/${freshProblemId}`,
            {
              description: fixedDescription,
            },
            { tag: 'problems' }
          );
          logger.info(
            `[problems] Updated inline images in problem ${freshProblemId}`
          );
        }
      } catch (err) {
        logger.warn(
          `[problems] Failed to process inline images for problem ${freshProblemId}: ${err.message}`
        );
      }
    }

    // d) Sub-resources — sequential, never throw
    const notesSummary = await migrateProblemNotes(
      snowSysId,
      freshProblemId,
      context
    );
    const attachSummary = await migrateProblemAttachments(
      snowSysId,
      freshProblemId,
      context
    );
    const tasksSummary = await migrateProblemTasks(
      snowSysId,
      freshProblemId,
      context
    );

    // e) Accumulate sub-resource stats
    accumulateSummary('notes', stats, notesSummary);
    accumulateSummary('attachments', stats, attachSummary);
    accumulateSummary('tasks', stats, tasksSummary);

    // f) Progress callback
    if (typeof onProgress === 'function') onProgress(i + 1, total);
  }

  // Step 3 — Final summary
  logger.info('[problems] Migration complete', stats);

  // Step 4 — Return stats
  return stats;
}
