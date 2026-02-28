import axios from 'axios';
import FormData from 'form-data';

const ALLOWED_DOMAIN_REGEX = /^[a-zA-Z0-9-]+$/;

export default class FreshserviceConnector {
  constructor({ domain, apiKey }) {
    if (!ALLOWED_DOMAIN_REGEX.test(domain)) throw new Error(`Invalid Freshservice domain: ${domain}`);

    // Freshservice requires apiKey as username and a static placeholder as password (per their API spec)
    const apiPassword = process.env.FRESHSERVICE_API_PASSWORD ?? 'X';

    this.client = axios.create({
      baseURL: `https://${domain}.freshservice.com/api/v2`,
      auth: { username: apiKey, password: apiPassword },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
  }

  async _post(path, data) {
    const res = await this.client.post(path, data);
    return res.data;
  }

  async _get(path, params = {}) {
    const res = await this.client.get(path, { params });
    return res.data;
  }

  async _delete(path) {
    try {
      await this.client.delete(path);
      return true;
    } catch {
      return false;
    }
  }

  async _listAll(path, key, params = {}) {
    const items = [];
    let page = 1;
    while (true) {
      const res = await this._get(path, { ...params, per_page: 100, page });
      const batch = res[key] ?? [];
      items.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return items;
  }

  async _deleteAll(items, pathFn) {
    let count = 0;
    for (const item of items) {
      const ok = await this._delete(pathFn(item));
      if (ok) count++;
      await new Promise((r) => setTimeout(r, 100));
    }
    return count;
  }

  async rollbackAll() {
    const results = {};
    const tickets = await this._listAll('/tickets', 'tickets', { updated_since: '2000-01-01T00:00:00Z' });
    console.log(`[rollback] found ${tickets.length} tickets to delete`);
    results.tickets = await this._deleteAll(tickets, (t) => `/tickets/${t.id}`);
    const changes = await this._listAll('/changes', 'changes');
    results.changes = await this._deleteAll(changes, (c) => `/changes/${c.id}`);
    const problems = await this._listAll('/problems', 'problems');
    results.problems = await this._deleteAll(problems, (p) => `/problems/${p.id}`);
    const categories = await this._listAll('/solutions/categories', 'categories');
    results.kb_categories = await this._deleteAll(categories, (c) => `/solutions/categories/${c.id}`);
    const requesters = await this._listAll('/requesters', 'requesters');
    console.log(`[rollback] found ${requesters.length} requesters to delete`);
    results.requesters = await this._deleteAll(requesters, (r) => `/requesters/${r.id}`);
    const departments = await this._listAll('/departments', 'departments');
    results.departments = await this._deleteAll(departments, (d) => `/departments/${d.id}`);
    return results;
  }

  async createAgent(data) {
    return this._post('/agents', data);
  }

  async createRequester(data) {
    return this._post('/requesters', data);
  }

  async createDepartment(data) {
    return this._post('/departments', data);
  }

  async createTicket(data) {
    const res = await this._post('/tickets', data);
    console.log(`[FS] createTicket id=${res.ticket?.id} spam=${res.ticket?.spam}`);
    return res;
  }

  async unspamTicket(id) {
    const res = await this.client.put(`/tickets/${id}/unspam`);
    return res.data;
  }

  async createChange(data) {
    return this._post('/changes', data);
  }

  async createProblem(data) {
    return this._post('/problems', data);
  }

  async createNote(ticketId, data) {
    return this._post(`/tickets/${ticketId}/notes`, data);
  }

  async createKBCategory(data) {
    return this._post('/solutions/categories', data);
  }

  async createKBFolder(categoryId, data) {
    return this._post('/solutions/folders', { ...data, category_id: categoryId });
  }

  async createKBArticle(folderId, data) {
    return this._post('/solutions/articles', { ...data, folder_id: folderId });
  }

  async uploadAttachment(ticketId, fileBuffer, fileName, contentType) {
    const form = new FormData();
    form.append('attachments[]', fileBuffer, { filename: fileName, contentType });

    const res = await this.client.post(`/tickets/${ticketId}/attachments`, form, {
      headers: form.getHeaders(),
      timeout: 60000,
    });
    return res.data;
  }

  async getRequesterByEmail(email) {
    try {
      return await this._get('/requesters', { email });
    } catch {
      return null;
    }
  }

  async reactivateRequester(id) {
    try {
      const res = await this.client.put(`/requesters/${id}/reactivate`);
      return res.data;
    } catch {
      return null;
    }
  }

  async getDeactivatedRequesterByEmail(email) {
    try {
      const res = await this._get('/requesters', { email, filter: 'deactivated' });
      return res?.requesters?.length ? res : null;
    } catch {
      return null;
    }
  }

  async getDeactivatedRequesterMap() {
    try {
      const all = await this._listAll('/requesters', 'requesters', { filter: 'deactivated' });
      return new Map(all.map((r) => [r.primary_email, r.id]));
    } catch {
      return new Map();
    }
  }

  async _count(path, params = {}) {
    const res = await this._get(path, { ...params, per_page: 1, page: 1 });
    const key = Object.keys(res).find((k) => Array.isArray(res[k]));
    return res.meta?.total_count ?? 0;
  }

  async _safeCount(path, params = {}) {
    try {
      return await this._count(path, params);
    } catch {
      return 0;
    }
  }

  async _countKBArticles() {
    try {
      const { categories } = await this._get('/solutions/categories');
      if (!categories?.length) return 0;
      const folderRes = await Promise.all(
        categories.map((c) => this._get(`/solutions/folders`, { category_id: c.id }))
      );
      const folderIds = folderRes.flatMap((r) => r.folders ?? []).map((f) => f.id);
      if (!folderIds.length) return 0;
      const counts = await Promise.all(
        folderIds.map((id) => this._safeCount('/solutions/articles', { folder_id: id }))
      );
      return counts.reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  }

  async countAll() {
    const [departments, requesters, agents, tickets, changes, problems, categories, articles] =
      await Promise.all([
        this._listAll('/departments', 'departments').then((r) => r.length),
        this._listAll('/requesters', 'requesters').then((r) => r.length),
        this._listAll('/agents', 'agents').then((r) => r.length),
        this._listAll('/tickets', 'tickets', { updated_since: '2000-01-01T00:00:00Z' }).then((r) => r.length),
        this._listAll('/changes', 'changes').then((r) => r.length),
        this._listAll('/problems', 'problems').then((r) => r.length),
        this._listAll('/solutions/categories', 'categories').then((r) => r.length),
        this._countKBArticles(),
      ]);
    return { departments, requesters, agents, tickets, changes, problems, categories, articles };
  }
}
