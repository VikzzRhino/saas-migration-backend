// src/modules/mappers/servicenow-to-freshservice/incident.orchestrator.js

import { mapIncident, getCallerEmail } from './incident.mapper.js';
import { migrateIncidentNotes } from './incidents/incident-notes.migrator.js';
import { migrateIncidentAttachments } from './incidents/incident-attachments.migrator.js';
import { migrateIncidentTasks } from './incidents/incident-tasks.migrator.js';
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
  'contact_type',
  'type',
  'caller_id',
  'caller_id.email',
  'assigned_to',
  'assignment_group',
  'company',
  'business_service',
  'opened_at',
  'sys_updated_on',
  'due_date',
  'resolved_at',
  'closed_at',
  'close_notes',
].join(',');

function val(field) {
  if (!field) return null;
  return typeof field === 'object'
    ? field.value ?? field.display_value ?? null
    : field;
}

function initStats() {
  return {
    incidents: { total: 0, migrated: 0, failed: 0 },
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

const VALID_TICKET_FIELDS = new Set([
  'subject',
  'description',
  'priority',
  'status',
  'source',
  'impact',
  'urgency',
  'category',
  'sub_category',
  'requester_id',
  'email',
  'responder_id',
  'group_id',
  'department_id',
  'due_by',
  'fr_due_by',
  'created_at',
  'updated_at',
  'custom_fields',
  'type',
  'tags',
  'assets',
  'workspace_id',
  'cc_emails',
  'name',
  'phone',
  'email_config_id',
  'item_category',
]);

const VALID_SOURCE_VALUES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

function sanitizePayload(payload) {
  for (const key of Object.keys(payload)) {
    if (!VALID_TICKET_FIELDS.has(key)) {
      delete payload[key];
    }
  }

  if (!payload.description || !payload.description.trim()) {
    payload.description = payload.subject || '-';
  }

  if (
    payload.source !== undefined &&
    !VALID_SOURCE_VALUES.has(Number(payload.source))
  ) {
    delete payload.source;
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

  return payload;
}

const REQUIRED_CUSTOM_FIELDS = [
  'snow_number',
  'close_notes',
  'business_service',
];

/**
 * Validates that the required custom fields exist in Freshservice ticket form fields.
 * Missing fields will cause custom_fields data to be silently dropped on create.
 *
 * @param {object} fsClient - Freshservice HTTP client with get(path) method
 * @param {object} logger   - Logger with warn(), error() methods
 * @returns {Promise<{ valid: boolean, missing: string[] }>}
 */
export async function validateIncidentCustomFields(fsClient, logger) {
  const missing = [];

  try {
    const response = await fsClient.get('/api/v2/ticket_fields');
    const fields = response?.ticket_fields ?? [];
    const fieldNames = new Set(fields.map((f) => f.name));

    for (const required of REQUIRED_CUSTOM_FIELDS) {
      if (!fieldNames.has(required)) {
        missing.push(required);
        logger.warn(
          `[incidents] Custom field '${required}' not found in Freshservice. ` +
            `Create it in Freshservice Admin → Admin → Field Manager → Ticket Fields`
        );
      }
    }
  } catch (err) {
    logger.error(
      `[incidents] Could not fetch ticket form fields for validation: ${err.message}`
    );
    missing.push(...REQUIRED_CUSTOM_FIELDS);
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Orchestrates the full paginated migration of all ServiceNow incidents to Freshservice.
 * Fetches all incident records in pages, maps and creates each in Freshservice,
 * then sequentially migrates notes, attachments, and tasks per incident.
 *
 * @param {object} context
 * @param {object} context.snowClient                      - SN HTTP client with get(url, params)
 * @param {object} context.fsClient                        - FS HTTP client with post(path, body) and get(path, params)
 * @param {Map<string, number>} context.agentEmailToId     - SN agent display name/email → FS agent ID
 * @param {Map<string, number>} context.groupNameToId      - SN group display name → FS group ID
 * @param {Map<string, number>} context.requesterEmailToId - SN requester display name/email → FS requester ID
 * @param {Map<string, number>} context.deptIdMap          - SN company sys_id → FS department ID
 * @param {string} context.snowBaseUrl                     - ServiceNow base URL
 * @param {object} context.logger                          - Logger with info(), warn(), error()
 * @param {Function} [context.onProgress]                  - Optional callback(current, total) called after each record
 * @returns {Promise<{
 *   incidents:   { total: number, migrated: number, failed: number },
 *   notes:       { total: number, migrated: number, failed: number, skipped: number },
 *   attachments: { total: number, migrated: number, failed: number, skipped: number },
 *   tasks:       { total: number, migrated: number, failed: number, skipped: number },
 * }>}
 * @throws {Error} if any page fetch from ServiceNow fails
 */
export async function migrateIncidents(context) {
  const {
    snowClient,
    fsClient,
    snowBaseUrl,
    logger,
    onProgress,
    requesterEmailToId,
  } = context;

  const stats = initStats();

  // Step 1 — Preflight: validate custom fields exist in Freshservice
  const { valid } = await validateIncidentCustomFields(fsClient, logger);
  if (!valid) {
    logger.warn(
      '[incidents] Some custom fields missing — data will be silently dropped'
    );
  }

  // Step 2 — Paginated fetch
  const allIncidents = [];
  let offset = 0;

  while (true) {
    let result;
    try {
      const response = await snowClient.get(
        `${snowBaseUrl}/api/now/table/incident`,
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
        `[incidents] Failed to fetch page at offset ${offset}: ${err.message}`
      );
      throw new Error(
        `Incidents migration aborted — page fetch failed at offset ${offset}: ${err.message}`
      );
    }

    if (!result.length) break;
    allIncidents.push(...result);
    if (result.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const total = allIncidents.length;
  logger.info(`[incidents] Fetched ${total} incidents from ServiceNow`);
  stats.incidents.total = total;

  // Step 3 — Process each incident
  let logged = 0;
  for (let i = 0; i < allIncidents.length; i++) {
    const snow = allIncidents[i];
    const snowSysId = val(snow.sys_id);
    const snowNumber = val(snow.number) ?? snowSysId;

    // a) Map the record
    const payload = mapIncident(snow, context);

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
      applyValueMappings(snow, payload, 'incidents', context.valueMappings, {
        agentMatching: { entries: [] },
        groupMapping: [],
      });
    }

    // b) Requester resolution — 3-step fallback
    if (payload.requester_id === undefined) {
      // Step A — extract caller email
      const email = getCallerEmail(snow);

      if (email) {
        // Step B — look up in requesterEmailToId map
        const mappedId = requesterEmailToId?.get(email);

        if (mappedId !== undefined) {
          payload.requester_id = mappedId;
        } else {
          // Step C — look up or create requester in Freshservice
          try {
            const lookupRes = await fsClient.get('/api/v2/requesters', {
              email,
            });
            const existing = lookupRes?.requesters?.[0];

            if (existing?.id) {
              payload.requester_id = existing.id;
              requesterEmailToId?.set(email, existing.id);
            } else {
              const createRes = await throttledPost(
                fsClient,
                '/api/v2/requesters',
                {
                  primary_email: email,
                  first_name: 'Migrated',
                },
                { tag: 'incidents' }
              );
              const newId = createRes?.requester?.id ?? createRes?.id;
              if (newId) {
                payload.requester_id = newId;
                requesterEmailToId?.set(email, newId);
              }
            }
          } catch (err) {
            logger.warn(
              `[incidents] Could not resolve/create requester for ${snowNumber} (${email}): ${err.message}`
            );
          }
        }
      } else {
        logger.warn(
          `[incidents] No caller email found for incident ${snowNumber} — ticket will be created without requester_id`
        );
      }
    }

    if (!payload.requester_id && !payload.email) {
      const callerEmail = getCallerEmail(snow);
      if (callerEmail) {
        payload.email = callerEmail;
      }
    }

    if (!valid) delete payload.custom_fields;

    sanitizePayload(payload);

    // c) POST to Freshservice — flat payload, not wrapped
    let freshTicketId;
    try {
      if (logged < 1) {
        console.log(
          '[incidents] PAYLOAD for',
          snowNumber,
          ':',
          JSON.stringify(payload, null, 2)
        );
        logged++;
      }
      const response = await throttledPost(
        fsClient,
        '/api/v2/tickets',
        payload,
        { tag: 'incidents' }
      );
      freshTicketId = response?.ticket?.id ?? response?.id;
      if (!freshTicketId) throw new Error('No ticket ID returned in response');
      logger.info(
        `[incidents] Created FS ticket id=${freshTicketId} ← SN ${snowNumber}`
      );
      stats.incidents.migrated++;
    } catch (err) {
      const fsError = err?.response?.data;
      const errors = fsError?.errors ?? [];
      const badFields = errors.map((e) => e.field);
      const retryable = badFields.some((f) =>
        ['requester_id', 'category', 'sub_category'].includes(f)
      );

      if (retryable) {
        if (badFields.includes('requester_id')) delete payload.requester_id;
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
            '/api/v2/tickets',
            payload,
            { tag: 'incidents' }
          );
          freshTicketId = retryRes?.ticket?.id ?? retryRes?.id;
          if (!freshTicketId) throw new Error('No ticket ID returned on retry');
          logger.info(
            `[incidents] Created FS ticket id=${freshTicketId} ← SN ${snowNumber} (dropped ${badFields.join(
              ', '
            )})`
          );
          stats.incidents.migrated++;
        } catch (retryErr) {
          const retryFsError = retryErr?.response?.data;
          logger.error(
            `[incidents] Failed to create ticket SN ${snowNumber} (retry): ${
              retryErr.message
            } | FS response: ${JSON.stringify(retryFsError)}`
          );
          stats.incidents.failed++;
          if (typeof onProgress === 'function') onProgress(i + 1, total);
          continue;
        }
      } else {
        logger.error(
          `[incidents] Failed to create ticket SN ${snowNumber}: ${
            err.message
          } | FS response: ${JSON.stringify(fsError)}`
        );
        stats.incidents.failed++;
        if (typeof onProgress === 'function') onProgress(i + 1, total);
        continue;
      }
    }

    // d) Process inline images in description
    if (payload.description?.includes('<img')) {
      try {
        const fixedDescription = await processInlineImages(
          payload.description,
          `/api/v2/tickets/${freshTicketId}/attachments`,
          `/api/v2/tickets/${freshTicketId}/inline_attachments`,
          context
        );
        if (fixedDescription !== payload.description) {
          await throttledPost(
            fsClient,
            `/api/v2/tickets/${freshTicketId}`,
            {
              description: fixedDescription,
            },
            { tag: 'incidents' }
          );
          logger.info(
            `[incidents] Updated inline images in ticket ${freshTicketId}`
          );
        }
      } catch (err) {
        logger.warn(
          `[incidents] Failed to process inline images for ticket ${freshTicketId}: ${err.message}`
        );
      }
    }

    // e) Sub-resources — sequential, never throw
    const notesSummary = await migrateIncidentNotes(
      snowSysId,
      freshTicketId,
      context
    );
    const attachSummary = await migrateIncidentAttachments(
      snowSysId,
      freshTicketId,
      context
    );
    const tasksSummary = await migrateIncidentTasks(
      snowSysId,
      freshTicketId,
      context
    );

    // f) Accumulate sub-resource stats
    accumulateSummary('notes', stats, notesSummary);
    accumulateSummary('attachments', stats, attachSummary);
    accumulateSummary('tasks', stats, tasksSummary);

    // g) Progress callback
    if (typeof onProgress === 'function') onProgress(i + 1, total);
  }

  // Step 4 — Final summary
  logger.info('[incidents] Migration complete', stats);

  // Step 5 — Return stats
  return stats;
}
