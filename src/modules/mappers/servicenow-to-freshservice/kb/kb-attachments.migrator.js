import { throttle } from '../../../../utils/throttled-request.js';

export const MAX_ATTACHMENT_BYTES = 20971520; // 20MB — Freshservice hard limit

/**
 * Migrates all attachments from a ServiceNow KB article to a Freshservice solution article.
 *
 * @param {string} snowArticleId - ServiceNow kb_knowledge sys_id
 * @param {number} freshArticleId - Freshservice solution article ID
 * @param {object} context
 * @param {object} context.snowClient - ServiceNow HTTP client
 *   - get(url, params): fetches JSON metadata, returns { result: [] }
 *   - getBuffer(url): fetches raw binary, returns Buffer
 * @param {object} context.fsClient - Freshservice HTTP client
 *   - postFile(path, fileName, buffer, contentType): multipart upload, returns response
 * @param {string} context.snowBaseUrl - ServiceNow base URL e.g. https://instance.service-now.com
 * @param {object} context.logger - Logger with info(), warn(), error() methods
 * @returns {Promise<{ total: number, migrated: number, failed: number, skipped: number }>}
 */
export async function migrateKbAttachments(
  snowArticleId,
  freshArticleId,
  context
) {
  const { snowClient, fsClient, snowBaseUrl, logger } = context;

  const summary = { total: 0, migrated: 0, failed: 0, skipped: 0 };

  // Step 1 — Fetch attachment metadata from ServiceNow
  let attachments = [];
  try {
    const response = await snowClient.get(`${snowBaseUrl}/api/now/attachment`, {
      table_name: 'kb_knowledge',
      table_sys_id: snowArticleId,
      sysparm_limit: 100,
    });
    attachments = response?.result ?? [];
  } catch (err) {
    logger.error(
      `[kb-attachments] Failed to fetch attachments for SN article ${snowArticleId}: ${err.message}`
    );
    return summary;
  }

  summary.total = attachments.length;

  // Step 2 — Process and upload sequentially
  for (const attachment of attachments) {
    const { sys_id, file_name, content_type, size_bytes, download_link } =
      attachment;

    // a) Skip if file_name is empty
    if (!file_name || !String(file_name).trim()) {
      summary.skipped++;
      continue;
    }

    // b) Skip if over 20MB
    const sizeNum = Number(size_bytes);
    if (sizeNum > MAX_ATTACHMENT_BYTES) {
      logger.warn(
        `[kb-attachments] Skipping ${file_name} (${sizeNum} bytes) — exceeds 20MB limit (snow_sys_id=${sys_id})`
      );
      summary.skipped++;
      continue;
    }

    // c) Download binary from ServiceNow
    let buffer;
    try {
      buffer = await snowClient.getBuffer(download_link);
    } catch (err) {
      logger.error(
        `[kb-attachments] Failed to download ${file_name} (snow_sys_id=${sys_id}): ${err.message}`
      );
      summary.failed++;
      continue;
    }

    // d) POST to Freshservice
    try {
      await throttle();
      await fsClient.postFile(
        `/api/v2/solutions/articles/${freshArticleId}/attachments`,
        file_name,
        buffer,
        content_type || 'application/octet-stream'
      );
      logger.info(
        `[kb-attachments] Migrated ${file_name} (snow_sys_id=${sys_id}) → fresh_article_id=${freshArticleId}`
      );
      summary.migrated++;
    } catch (err) {
      logger.error(
        `[kb-attachments] Failed to upload ${file_name} (snow_sys_id=${sys_id}): ${err.message}`
      );
      summary.failed++;
    }
  }

  // Step 3 — Return summary
  return summary;
}
