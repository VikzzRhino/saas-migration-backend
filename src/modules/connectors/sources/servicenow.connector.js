import axios from 'axios';

export default class ServiceNowConnector {
  constructor({ instanceUrl, username, password }) {
    this.client = axios.create({
      baseURL: `${instanceUrl}/api/now`,
      auth: { username, password },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 30000,
    });
  }

  async _getCount(path, query = '') {
    const res = await this.client.get(path, {
      params: {
        sysparm_count: true,
        sysparm_query: query || undefined,
      },
    });
    return parseInt(res.data.result?.[0]?.['COUNT'] ?? res.headers?.['x-total-count'] ?? 0);
  }

  async countAll() {
    const [companies, users, admins, incidents, changes, problems, kb_categories, kb_articles] =
      await Promise.all([
        this._getCount('/table/core_company'),
        this._getCount('/table/sys_user', 'active=true'),
        this._getCount('/table/sys_user', 'active=true^roles=admin'),
        this._getCount('/table/incident', 'active=true'),
        this._getCount('/table/change_request'),
        this._getCount('/table/problem'),
        this._getCount('/table/kb_category'),
        this._getCount('/table/kb_knowledge', 'workflow_state=published'),
      ]);
    return { companies, users, admins, incidents, changes, problems, kb_categories, kb_articles };
  }

  async _get(path, params = {}) {
    const res = await this.client.get(path, { params });
    return res.data.result;
  }

  async fetchUserById(sysId) {
    const results = await this._get('/table/sys_user', {
      sysparm_fields: 'sys_id,first_name,last_name,email,phone,department,active',
      sysparm_query: `sys_id=${sysId}`,
      sysparm_limit: 1,
    });
    return results?.[0] ?? null;
  }

  async fetchById(table, sysId) {
    const results = await this._get(`/table/${table}`, {
      sysparm_query: `sys_id=${sysId}`,
      sysparm_limit: 1,
    });
    return results?.[0] ?? null;
  }

  async fetchUsers(limit = 100, offset = 0) {
    return this._get('/table/sys_user', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: 'sys_id,first_name,last_name,email,phone,department,active',
      sysparm_query: 'active=true',
    });
  }

  async fetchAdminUsers(limit = 100, offset = 0) {
    return this._get('/table/sys_user', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: 'sys_id,first_name,last_name,email,roles',
      sysparm_query: 'active=true^roles=admin',
    });
  }

  async fetchCompanies(limit = 100, offset = 0) {
    return this._get('/table/core_company', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: 'sys_id,name,notes',
    });
  }

  async fetchIncidents(limit = 100, offset = 0) {
    return this._get('/table/incident', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields:
        'sys_id,number,short_description,description,priority,state,caller_id.email,opened_at,resolved_at,category',
      sysparm_query: 'active=true^ORDERBYopened_at',
      sysparm_display_value: 'all',
    });
  }

  async fetchChanges(limit = 100, offset = 0) {
    return this._get('/table/change_request', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields:
        'sys_id,number,short_description,description,priority,state,start_date,end_date,opened_at,type,impact,risk,requested_by.email,opened_by.email',
      sysparm_query: 'ORDERBYopened_at',
      sysparm_display_value: 'all',
    });
  }

  async fetchProblems(limit = 100, offset = 0) {
    return this._get('/table/problem', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields:
        'sys_id,number,short_description,description,priority,state,due_date,opened_at,impact,opened_by.email,assigned_to.email',
      sysparm_query: 'ORDERBYopened_at',
      sysparm_display_value: 'all',
    });
  }

  async fetchComments(ticketSysId) {
    return this._get('/table/sys_journal_field', {
      sysparm_query: `element_id=${ticketSysId}^element=comments^ORDERBYsys_created_on`,
      sysparm_fields: 'sys_id,value,sys_created_by,sys_created_on,element_id',
    });
  }

  async fetchKBCategories(limit = 100, offset = 0) {
    return this._get('/table/kb_category', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: 'sys_id,label,description,parent_id',
    });
  }

  async fetchKBArticles(limit = 100, offset = 0) {
    return this._get('/table/kb_knowledge', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: 'sys_id,short_description,text,kb_category,workflow_state,published',
      sysparm_query: 'workflow_state=published',
    });
  }

  async fetchAttachments(tableName, sysId) {
    return this._get('/attachment', {
      sysparm_query: `table_name=${tableName}^table_sys_id=${sysId}`,
      sysparm_fields: 'sys_id,file_name,content_type,size_bytes,download_link',
    });
  }

  async downloadAttachment(downloadUrl) {
    const res = await this.client.get(downloadUrl, {
      baseURL: '',
      responseType: 'arraybuffer',
    });
    return res.data;
  }
}
