import { throttle } from '../../../../utils/throttled-request.js';

export const MAX_ATTACHMENT_BYTES = 20971520; // 20MB — Freshservice hard limit

/**
 * Migrates all attachments from a ServiceNow problem to a Freshservice problem.
 *
 * @param {string} snowProblemId - ServiceNow problem sys_id
 * @param {number} freshProblemId - Freshservice problem ID
 * @param {object} context
 * @param {object} context.snowClient - ServiceNow HTTP client
 *   - get(url, params): fetches JSON metadata
 *   - getBuffer(url): fetches raw binary, returns Buffer
 * @param {object} context.fsClient - Freshservice HTTP client
 *   - postFile(path, fileName, buffer, contentType): multipart upload, returns response
 * @param {string} context.snowBaseUrl - ServiceNow base URL e.g. https://instance.service-now.com
 * @param {object} context.logger - Logger with info(), warn(), error() methods
 * @returns {Promise<{ total: number, migrated: number, failed: number, skipped: number }>}
 */
export async function migrateProblemAttachments(
  snowProblemId,
  freshProblemId,
  context
) {
  const { snowClient, fsClient, snowBaseUrl, logger } = context;

  const summary = { total: 0, migrated: 0, failed: 0, skipped: 0 };

  // Step 1 — Fetch attachment metadata from ServiceNow
  let attachments = [];
  try {
    const response = await snowClient.get(`${snowBaseUrl}/api/now/attachment`, {
      table_name: 'problem',
      table_sys_id: snowProblemId,
      sysparm_limit: 100,
    });
    attachments = response?.result ?? [];
  } catch (err) {
    logger.error(
      `[problem-attachments] Failed to fetch attachments for SN problem ${snowProblemId}: ${err.message}`
    );
    return summary;
  }

  summary.total = attachments.length;

  // Steps 2 & 3 — Process and upload sequentially
  for (const attachment of attachments) {
    const { sys_id, file_name, content_type, size_bytes, download_link } =
      attachment;

    // Skip if file_name is empty
    if (!file_name || !file_name.trim()) {
      summary.skipped++;
      continue;
    }

    // Skip if over 20MB
    const sizeNum = Number(size_bytes);
    if (sizeNum > MAX_ATTACHMENT_BYTES) {
      logger.warn(
        `[problem-attachments] Skipping ${file_name} (${sizeNum} bytes) — exceeds 20MB limit (snow_sys_id=${sys_id})`
      );
      summary.skipped++;
      continue;
    }

    // Download binary from ServiceNow
    let buffer;
    try {
      buffer = await snowClient.getBuffer(download_link);
    } catch (err) {
      logger.error(
        `[problem-attachments] Failed to download ${file_name} (snow_sys_id=${sys_id}): ${err.message}`
      );
      summary.failed++;
      continue;
    }

    // POST to Freshservice
    try {
      await throttle();
      await fsClient.postFile(
        `/api/v2/problems/${freshProblemId}/attachments`,
        file_name,
        buffer,
        content_type || 'application/octet-stream'
      );
      logger.info(
        `[problem-attachments] Migrated ${file_name} (snow_sys_id=${sys_id}) → fresh_problem_id=${freshProblemId}`
      );
      summary.migrated++;
    } catch (err) {
      logger.error(
        `[problem-attachments] Failed to upload ${file_name} (snow_sys_id=${sys_id}): ${err.message}`
      );
      summary.failed++;
    }
  }

  return summary;
}
