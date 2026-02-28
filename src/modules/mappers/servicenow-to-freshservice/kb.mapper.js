// Freshservice article status: 1=Draft, 2=Published
const ARTICLE_STATUS_MAP = { published: 2, draft: 1 };

export function mapCategory(snow) {
  return {
    name: snow.label || 'Uncategorized',
    description: snow.description || null,
  };
}

export function mapFolder(snow, categoryId) {
  return {
    name: snow.label || 'General',
    description: snow.description || null,
    category_id: categoryId,
  };
}

export function mapArticle(snow, folderId) {
  return {
    title: snow.short_description || 'Untitled',
    description: snow.text || '-',
    status: ARTICLE_STATUS_MAP[snow.workflow_state] ?? 1,
    folder_id: folderId,
  };
}
