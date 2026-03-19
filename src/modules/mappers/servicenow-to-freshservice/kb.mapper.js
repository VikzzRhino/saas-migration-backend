// status: 1 = draft, 2 = published
const ARTICLE_STATUS_MAP = { published: 2, draft: 1, review: 1, retired: 1 };

function val(field) {
  return typeof field === 'object'
    ? field?.value ?? field?.display_value
    : field;
}

function displayVal(field) {
  return typeof field === 'object'
    ? field?.display_value ?? field?.value
    : field;
}

export function mapCategory(snow) {
  return {
    name: displayVal(snow.label) ?? displayVal(snow.title) ?? 'Uncategorized',
    description: val(snow.description) || null,
  };
}

export function mapFolder(snow, categoryId) {
  return {
    name: displayVal(snow.label) ?? displayVal(snow.title) ?? 'General',
    description: val(snow.description) || null,
    visibility: 1,
    category_id: Number(categoryId),
  };
}

/**
 * Maps a ServiceNow KB article to a Freshservice solution article payload.
 *
 * Only the 4 fields Freshservice requires are sent: title, description,
 * folder_id, status. agent_id is included only when resolved.
 * No SN-specific fields (tags, created_at, updated_at, custom_fields, etc.).
 *
 * @param {object} snow - Raw ServiceNow kb_knowledge record
 * @param {number|string} folderId - Freshservice folder ID (cast to Number)
 * @param {object} [context={}]
 * @param {Map<string, number>} [context.agentEmailToId]
 * @returns {object} Freshservice solution article creation payload
 */
export function mapArticle(snow, folderId, context = {}) {
  const { agentEmailToId = new Map() } = context;

  const rawDescription = val(snow.text);
  const description =
    rawDescription && rawDescription.trim() ? rawDescription : '<p> </p>';

  const mapped = {
    title: val(snow.short_description) || 'Untitled',
    description,
    status: ARTICLE_STATUS_MAP[val(snow.workflow_state)] ?? 1,
    folder_id: Number(folderId),
  };

  // agent_id — only include when resolved; never send null/undefined
  const authorKey = displayVal(snow.author);
  if (authorKey) {
    const agentId = agentEmailToId.get(authorKey);
    if (agentId !== undefined) mapped.agent_id = agentId;
  }

  return mapped;
}
