// src/modules/mappers/servicenow-to-freshservice/kb.orchestrator.js

import { mapCategory, mapFolder, mapArticle } from './kb.mapper.js';
import { migrateKbAttachments } from './kb/kb-attachments.migrator.js';
import { processInlineImages } from '../../../utils/inline-image.processor.js';
import { throttledPost } from '../../../utils/throttled-request.js';

const PAGE_SIZE = 100;

const CATEGORY_FIELDS = 'sys_id,label,description,parent_id';

const ARTICLE_FIELDS = [
  'sys_id',
  'number',
  'short_description',
  'text',
  'workflow_state',
  'sys_tags',
  'kb_category',
  'author',
  'sys_created_on',
  'sys_updated_on',
  'valid_to',
].join(',');

function val(field) {
  if (!field) return null;
  return typeof field === 'object'
    ? field.value ?? field.display_value ?? null
    : field;
}

function initStats() {
  return {
    categories: { total: 0, migrated: 0, failed: 0 },
    folders: { total: 0, migrated: 0, failed: 0 },
    articles: { total: 0, migrated: 0, failed: 0, skipped: 0 },
    attachments: { total: 0, migrated: 0, failed: 0, skipped: 0 },
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

const REQUIRED_CUSTOM_FIELDS = ['snow_number', 'expiry_date'];

/**
 * Validates that the required custom fields exist in Freshservice solution article form fields.
 * Missing fields will cause custom_fields data to be silently dropped on create.
 *
 * @param {object} fsClient - Freshservice HTTP client with get(path) method
 * @param {object} logger   - Logger with warn(), error() methods
 * @returns {Promise<{ valid: boolean, missing: string[] }>}
 */
export async function validateKbCustomFields(fsClient, logger) {
  const missing = [];

  try {
    const response = await fsClient.get('/api/v2/solution_article_fields');
    const fields = response?.solution_article_fields ?? [];
    const fieldNames = new Set(fields.map((f) => f.name));

    for (const required of REQUIRED_CUSTOM_FIELDS) {
      if (!fieldNames.has(required)) {
        missing.push(required);
        logger.warn(
          `[kb] Custom field '${required}' not found in Freshservice. ` +
            `Create it in Freshservice Admin → Admin → Field Manager → Solution Article Fields`
        );
      }
    }
  } catch (err) {
    logger.error(
      `[kb] Could not fetch solution article form fields for validation: ${err.message}`
    );
    missing.push(...REQUIRED_CUSTOM_FIELDS);
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Orchestrates the full migration of ServiceNow KB content to Freshservice.
 * Migrates in strict order: categories → folders (one per category) → articles → attachments.
 *
 * @param {object} context
 * @param {object} context.snowClient                  - SN HTTP client with get(url, params) → { result: [] }
 * @param {object} context.fsClient                    - FS HTTP client with post(path, body) → response
 * @param {Map<string, number>} context.agentEmailToId - SN author display name → FS agent ID
 * @param {string} context.snowBaseUrl                 - ServiceNow base URL
 * @param {object} context.logger                      - Logger with info(), warn(), error()
 * @param {Function} [context.onProgress]              - Optional callback(current, total) fired per article
 * @returns {Promise<{
 *   categories:  { total: number, migrated: number, failed: number },
 *   folders:     { total: number, migrated: number, failed: number },
 *   articles:    { total: number, migrated: number, failed: number, skipped: number },
 *   attachments: { total: number, migrated: number, failed: number, skipped: number },
 * }>}
 * @throws {Error} if any page fetch from ServiceNow fails
 */
export async function migrateKb(context) {
  const {
    snowClient,
    fsClient,
    agentEmailToId,
    snowBaseUrl,
    logger,
    onProgress,
  } = context;

  const stats = initStats();

  // Step 1 — Preflight
  const { valid } = await validateKbCustomFields(fsClient, logger);
  if (!valid) {
    logger.warn(
      '[kb] Some custom fields missing — data will be silently dropped'
    );
  }

  // Step 2 — Fetch all categories (paginated)
  const allCategories = [];
  let offset = 0;

  while (true) {
    let result;
    try {
      const response = await snowClient.get(
        `${snowBaseUrl}/api/now/table/kb_category`,
        {
          sysparm_fields: CATEGORY_FIELDS,
          sysparm_display_value: 'all',
          sysparm_limit: PAGE_SIZE,
          sysparm_offset: offset,
        }
      );
      result = response?.result ?? [];
    } catch (err) {
      logger.error(
        `[kb] Failed to fetch categories page at offset ${offset}: ${err.message}`
      );
      throw new Error(
        `KB migration aborted — category page fetch failed at offset ${offset}: ${err.message}`
      );
    }

    if (!result.length) break;
    allCategories.push(...result);
    if (result.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  logger.info(
    `[kb] Fetched ${allCategories.length} categories from ServiceNow`
  );
  stats.categories.total = allCategories.length;
  stats.folders.total = allCategories.length;

  // Step 3 — Create categories and folders in Freshservice
  const categoryIdMap = new Map();
  const folderIdMap = new Map();

  for (const snow of allCategories) {
    const snowSysId = val(snow.sys_id);

    // Create category
    let fsCategoryId;
    try {
      const catPayload = mapCategory(snow);
      const response = await throttledPost(
        fsClient,
        '/api/v2/solutions/categories',
        catPayload,
        { tag: 'kb' }
      );
      fsCategoryId = response?.category?.id ?? response?.id;
      if (!fsCategoryId) throw new Error('No category ID returned in response');
      categoryIdMap.set(snowSysId, fsCategoryId);
      logger.info(
        `[kb] Created FS category id=${fsCategoryId} ← SN ${snowSysId}`
      );
      stats.categories.migrated++;
    } catch (err) {
      const status = err.response?.status;
      if (status === 409) {
        // Duplicate — look up existing category by name
        try {
          const catName = mapCategory(snow).name;
          const existing = await fsClient.get('/api/v2/solutions/categories');
          const cats = existing?.categories ?? [];
          const match = cats.find((c) => c.name === catName);
          if (match?.id) {
            fsCategoryId = match.id;
            categoryIdMap.set(snowSysId, fsCategoryId);
            logger.info(
              `[kb] Reusing existing FS category id=${fsCategoryId} (name="${catName}") ← SN ${snowSysId}`
            );
            stats.categories.migrated++;
          } else {
            logger.error(
              `[kb] Category "${catName}" reported as duplicate but could not find it`
            );
            stats.categories.failed++;
            continue;
          }
        } catch (lookupErr) {
          logger.error(
            `[kb] Failed to look up existing category for SN ${snowSysId}: ${lookupErr.message}`
          );
          stats.categories.failed++;
          continue;
        }
      } else {
        logger.error(
          `[kb] Failed to create category SN ${snowSysId}: ${err.message} | FS response: ${JSON.stringify(err.response?.data)}`
        );
        stats.categories.failed++;
        continue;
      }
    }

    // Create folder for this category
    try {
      const response = await throttledPost(
        fsClient,
        '/api/v2/solutions/folders',
        mapFolder(snow, fsCategoryId),
        { tag: 'kb' }
      );
      const fsFolderId = response?.folder?.id ?? response?.id;
      if (!fsFolderId) throw new Error('No folder ID returned in response');
      folderIdMap.set(snowSysId, fsFolderId);
      logger.info(
        `[kb] Created FS folder id=${fsFolderId} ← SN category ${snowSysId}`
      );
      stats.folders.migrated++;
    } catch (err) {
      const folderStatus = err.response?.status;
      if (folderStatus === 409) {
        // Duplicate folder — look up existing folder under this category
        try {
          const existing = await fsClient.get('/api/v2/solutions/folders', {
            category_id: fsCategoryId,
          });
          const folders = existing?.folders ?? [];
          const folderName = mapFolder(snow, fsCategoryId).name;
          const match =
            folders.find((f) => f.name === folderName) ?? folders[0];
          if (match?.id) {
            folderIdMap.set(snowSysId, match.id);
            logger.info(
              `[kb] Reusing existing FS folder id=${match.id} ← SN category ${snowSysId}`
            );
            stats.folders.migrated++;
          } else {
            logger.error(
              `[kb] Folder reported as duplicate but could not find it for SN category ${snowSysId}`
            );
            stats.folders.failed++;
          }
        } catch (lookupErr) {
          logger.error(
            `[kb] Failed to look up existing folder for SN category ${snowSysId}: ${lookupErr.message}`
          );
          stats.folders.failed++;
        }
      } else {
        logger.error(
          `[kb] Failed to create folder for SN category ${snowSysId}: ${err.message} | FS response: ${JSON.stringify(err.response?.data)}`
        );
        stats.folders.failed++;
      }
    }
  }

  // Step 4 — Fetch all articles (paginated)
  const allArticles = [];
  offset = 0;

  while (true) {
    let result;
    try {
      const response = await snowClient.get(
        `${snowBaseUrl}/api/now/table/kb_knowledge`,
        {
          sysparm_fields: ARTICLE_FIELDS,
          sysparm_display_value: 'all',
          sysparm_limit: PAGE_SIZE,
          sysparm_offset: offset,
        }
      );
      result = response?.result ?? [];
    } catch (err) {
      logger.error(
        `[kb] Failed to fetch articles page at offset ${offset}: ${err.message}`
      );
      throw new Error(
        `KB migration aborted — article page fetch failed at offset ${offset}: ${err.message}`
      );
    }

    if (!result.length) break;
    allArticles.push(...result);
    if (result.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const total = allArticles.length;
  logger.info(`[kb] Fetched ${total} articles from ServiceNow`);
  stats.articles.total = total;

  // Step 5 — Process each article
  for (let i = 0; i < allArticles.length; i++) {
    const snow = allArticles[i];
    const snowSysId = val(snow.sys_id);
    const snowNum = val(snow.number) ?? snowSysId;

    // a) Resolve folder via category sys_id; fall back to first available folder
    const catRef = val(snow.kb_category);
    let folderId = folderIdMap.get(catRef) || null;

    if (!folderId) {
      // Fall back to the first folder in the map rather than skipping
      const firstFolder = folderIdMap.size > 0 ? folderIdMap.values().next().value : null;
      if (firstFolder) {
        logger.warn(
          `[kb] No folder for article ${snowNum} (category sys_id=${catRef}) — falling back to folder id=${firstFolder}`
        );
        folderId = firstFolder;
      } else {
        logger.warn(
          `[kb] No folders exist at all — skipping article ${snowNum}`
        );
        stats.articles.skipped++;
        if (typeof onProgress === 'function') onProgress(i + 1, total);
        continue;
      }
    }

    // b) Map — only title, description, folder_id, status (+ agent_id if resolved)
    const payload = mapArticle(snow, folderId, { agentEmailToId });

    // c) POST article to Freshservice
    let freshArticleId;
    try {
      const response = await throttledPost(
        fsClient,
        '/api/v2/solutions/articles',
        payload,
        { tag: 'kb' }
      );
      freshArticleId = response?.article?.id ?? response?.id;
      if (!freshArticleId)
        throw new Error('No article ID returned in response');
      logger.info(
        `[kb] Created FS article id=${freshArticleId} ← SN ${snowNum}`
      );
      stats.articles.migrated++;
    } catch (err) {
      const fsError = err?.response?.data;
      logger.error(
        `[kb] Failed to create article SN ${snowNum}: ${err.message} | FS response: ${JSON.stringify(fsError)}`
      );
      stats.articles.failed++;
      if (typeof onProgress === 'function') onProgress(i + 1, total);
      continue;
    }

    // d) Process inline images in description
    if (payload.description?.includes('<img')) {
      try {
        const fixedDescription = await processInlineImages(
          payload.description,
          `/api/v2/solutions/articles/${freshArticleId}/attachments`,
          `/api/v2/solutions/articles/${freshArticleId}/inline_attachments`,
          context
        );
        if (fixedDescription !== payload.description) {
          await throttledPost(
            fsClient,
            `/api/v2/solutions/articles/${freshArticleId}`,
            {
              description: fixedDescription,
            },
            { tag: 'kb' }
          );
          logger.info(
            `[kb] Updated inline images in article ${freshArticleId}`
          );
        }
      } catch (err) {
        logger.warn(
          `[kb] Failed to process inline images for article ${freshArticleId}: ${err.message}`
        );
      }
    }

    // e) Migrate attachments
    const attachSummary = await migrateKbAttachments(
      snowSysId,
      freshArticleId,
      context
    );
    accumulateSummary('attachments', stats, attachSummary);

    // f) Progress callback
    if (typeof onProgress === 'function') onProgress(i + 1, total);
  }

  // Step 6 — Final summary
  logger.info('[kb] Migration complete', stats);

  // Step 7 — Return stats
  return stats;
}
