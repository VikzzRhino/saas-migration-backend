// src/modules/mappers/servicenow-to-freshservice/problems/problem-notes.migrator.js

import { processInlineImages } from '../../../../utils/inline-image.processor.js';
import { throttledPost } from '../../../../utils/throttled-request.js';

function isHtml(str) {
  return /<[a-z][\s\S]*>/i.test(str);
}

/** Strip all HTML tags and decode basic entities to get plain text content. */
function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function buildBody(value, createdBy, createdOn) {
  const content = isHtml(value) ? value : `<p>${value}</p>`;
  const footer = `<p><em>Migrated from ServiceNow — originally posted by ${createdBy} on ${createdOn}</em></p>`;
  return `${content}${footer}`;
}

function extractDisplay(field) {
  if (!field) return '';
  return typeof field === 'object'
    ? field.display_value ?? field.value ?? ''
    : field;
}

/**
 * Migrates all notes/comments from a ServiceNow problem to a Freshservice problem.
 *
 * @param {string} snowProblemId - ServiceNow problem sys_id
 * @param {number} freshProblemId - Freshservice problem ID
 * @param {object} context
 * @param {object} context.snowClient - ServiceNow HTTP client with get(url, params) method
 * @param {object} context.fsClient - Freshservice HTTP client with post(path, body) method
 * @param {Map<string, number>} context.agentEmailToId - Snow agent email/name → FS agent ID
 * @param {string} context.snowBaseUrl - ServiceNow base URL e.g. https://instance.service-now.com
 * @param {object} context.logger - Logger with info(), warn(), error() methods
 * @returns {Promise<{ total: number, migrated: number, failed: number, skipped: number }>}
 */
export async function migrateProblemNotes(
  snowProblemId,
  freshProblemId,
  context
) {
  const { snowClient, fsClient, agentEmailToId, snowBaseUrl, logger } = context;

  const summary = { total: 0, migrated: 0, failed: 0, skipped: 0 };

  let notes = [];

  // Step 1 — Fetch notes from ServiceNow
  try {
    const response = await snowClient.get(
      `${snowBaseUrl}/api/now/table/sys_journal_field`,
      {
        sysparm_query: `element_id=${snowProblemId}^element=work_notes^ORelement=comments`,
        sysparm_fields: 'sys_id,element,value,sys_created_on,sys_created_by',
        sysparm_display_value: 'all',
        sysparm_order_by: 'sys_created_on',
        sysparm_limit: 1000,
      }
    );
    notes = response?.result ?? [];
  } catch (err) {
    logger.error(
      `[problem-notes] Failed to fetch notes for SN problem ${snowProblemId}: ${err.message}`
    );
    return summary;
  }

  summary.total = notes.length;

  // Steps 2 & 3 — Build payload and post sequentially
  for (const note of notes) {
    const snowSysId =
      typeof note.sys_id === 'object'
        ? note.sys_id?.value ?? note.sys_id?.display_value
        : note.sys_id;

    const rawValue = extractDisplay(note.value);

    // Skip empty notes (including HTML-only empty like <p></p>)
    if (!rawValue || !rawValue.trim() || !stripHtml(rawValue)) {
      logger.warn(
        `[problem-notes] Skipping empty note snow_sys_id=${snowSysId} for problem ${freshProblemId}`
      );
      summary.skipped++;
      continue;
    }

    const createdBy = extractDisplay(note.sys_created_by);
    const createdOn = extractDisplay(note.sys_created_on);
    const element = extractDisplay(note.element);

    let body = buildBody(
      rawValue.trim(),
      createdBy || 'Unknown',
      createdOn || 'Unknown'
    );
    const isPrivate = element === 'work_notes';

    // Process inline images in note body
    if (body.includes('<img')) {
      body = await processInlineImages(
        body,
        `/api/v2/problems/${freshProblemId}/attachments`,
        `/api/v2/problems/${freshProblemId}/inline_attachments`,
        context
      );
    }

    // Guard: ensure body has actual text content after building
    if (!stripHtml(body)) {
      logger.warn(
        `[problem-notes] Skipping note snow_sys_id=${snowSysId}: body is empty after processing`
      );
      summary.skipped++;
      continue;
    }

    // Flat payload — only body and private (boolean). No extra fields.
    const notePayload = {
      body,
      private: Boolean(isPrivate),
    };

    // POST to /problems/{id}/notes
    try {
      const result = await throttledPost(
        fsClient,
        `/api/v2/problems/${freshProblemId}/notes`,
        notePayload,
        { tag: 'problem-notes' }
      );
      const freshNoteId = result?.note?.id ?? result?.id ?? 'unknown';
      logger.info(
        `[problem-notes] Migrated note snow_sys_id=${snowSysId} → fresh_note_id=${freshNoteId}`
      );
      summary.migrated++;
    } catch (err) {
      const fsError = err?.response?.data;
      logger.error(
        `[problem-notes] Failed to post note snow_sys_id=${snowSysId} to problem ${freshProblemId}: ${err.message} | FS response: ${JSON.stringify(fsError)}`
      );
      summary.failed++;
    }
  }

  return summary;
}
