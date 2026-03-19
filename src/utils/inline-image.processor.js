// src/utils/inline-image.processor.js

import { throttle } from './throttled-request.js';

const SN_IMG_REGEX =
  /<img[^>]+src="(https?:\/\/[^"]*(?:service-now\.com|servicenow\.com)[^"]*)"[^>]*/gi;

const EXT_CONTENT_TYPE = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function detectFileMeta(srcUrl, index) {
  let fileName;
  try {
    const pathname = new URL(srcUrl).pathname;
    const segment = pathname.split('/').pop() ?? '';
    fileName = segment.split('?')[0] || '';
  } catch {
    fileName = '';
  }

  if (!fileName || !fileName.includes('.')) {
    fileName = `inline_image_${index}.jpg`;
  }

  const ext = fileName.split('.').pop().toLowerCase();
  const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';

  return { fileName, contentType };
}

/**
 * Finds all inline ServiceNow image URLs in an HTML string, downloads each image
 * via the ServiceNow client, uploads it to Freshservice, then fetches the stable
 * inline token URL and replaces the original src attribute value with it.
 *
 * Never throws — all errors are caught internally. If processing fails entirely,
 * the original HTML is returned unchanged.
 *
 * @param {string} html             - HTML string that may contain inline <img> tags
 * @param {string} fsPath           - Freshservice attachment upload endpoint path
 *                                    e.g. /api/v2/tickets/123/attachments
 * @param {string} inlineFetchPath  - Freshservice inline attachments fetch path
 *                                    e.g. /api/v2/tickets/123/inline_attachments
 * @param {object} context
 * @param {object} context.snowClient - ServiceNow client with getBuffer(url): Promise<Buffer>
 * @param {object} context.fsClient  - Freshservice client with postFile(path, fileName, buffer, contentType)
 *                                     and get(path): Promise<object>
 * @param {object} context.logger    - Logger with warn(), info() methods
 * @returns {Promise<string>} Processed HTML with SN image URLs replaced by stable FS inline token URLs,
 *                            or the original HTML if no SN images were found / all failed.
 */
export async function processInlineImages(
  html,
  fsPath,
  inlineFetchPath,
  context
) {
  if (!html || !html.includes('<img')) return html;

  SN_IMG_REGEX.lastIndex = 0;
  if (!SN_IMG_REGEX.test(html)) return html;

  const { snowClient, fsClient, logger } = context;

  let processedHtml = html;
  let index = 0;

  SN_IMG_REGEX.lastIndex = 0;
  let match;

  while ((match = SN_IMG_REGEX.exec(html)) !== null) {
    const srcUrl = match[1];

    // a) Download from ServiceNow
    let buffer;
    try {
      buffer = await snowClient.getBuffer(srcUrl);
    } catch (err) {
      logger.warn(
        `[inline-images] Failed to download image ${srcUrl}: ${err.message}`
      );
      index++;
      continue;
    }

    // b) Detect filename and content type
    const { fileName, contentType } = detectFileMeta(srcUrl, index);

    // c) Upload to Freshservice
    let attachmentId;
    try {
      await throttle();
      const uploadRes = await fsClient.postFile(
        fsPath,
        fileName,
        buffer,
        contentType
      );
      attachmentId =
        uploadRes?.attachment?.id ?? uploadRes?.attachments?.[0]?.id;

      if (!attachmentId) {
        logger.warn(
          `[inline-images] No attachment ID in upload response for ${fileName} (${fsPath})`
        );
        index++;
        continue;
      }
    } catch (err) {
      logger.warn(
        `[inline-images] Failed to upload image ${fileName} to ${fsPath}: ${err.message}`
      );
      index++;
      continue;
    }

    // d) Fetch stable inline token URL
    let newUrl;
    try {
      const inlineRes = await fsClient.get(inlineFetchPath);
      const attachments = inlineRes?.attachments ?? [];
      const matched = attachments.find((a) => a.id === attachmentId);
      newUrl = matched?.attachment_url;

      if (!newUrl) {
        logger.warn(
          `[inline-images] Attachment id=${attachmentId} not found in inline list at ${inlineFetchPath}`
        );
        index++;
        continue;
      }
    } catch (err) {
      logger.warn(
        `[inline-images] Failed to fetch inline attachments from ${inlineFetchPath}: ${err.message}`
      );
      index++;
      continue;
    }

    // e) Replace src URL in HTML with stable inline token URL
    processedHtml = processedHtml.replace(srcUrl, newUrl);
    logger.info(
      `[inline-images] Replaced inline image ${fileName} → ${newUrl}`
    );
    index++;
  }

  return processedHtml;
}
