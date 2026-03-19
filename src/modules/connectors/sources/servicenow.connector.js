import axios from 'axios';

export default class ServiceNowConnector {
  constructor({ instanceUrl, username, password }) {
    this.client = axios.create({
      baseURL: `${instanceUrl}/api/now`,
      auth: { username, password },
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
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
    return parseInt(
      res.data.result?.[0]?.['COUNT'] ?? res.headers?.['x-total-count'] ?? 0
    );
  }

  async countAll() {
    const strategy = await this._resolveAdminStrategy();
    let adminsCount;
    if (strategy.type === 'direct') {
      adminsCount = await this._getCount(
        '/table/sys_user',
        'active=true^rolesISNOTEMPTY'
      );
    } else {
      const ids = await this._fetchAllAgentSysIds();
      adminsCount = ids.length;
    }

    const [
      companies,
      users,
      incidents,
      changes,
      problems,
      kb_categories,
      kb_articles,
    ] = await Promise.all([
      this._getCount('/table/core_company'),
      this._getCount('/table/sys_user', 'active=true'),
      this._getCount('/table/incident', 'active=true'),
      this._getCount('/table/change_request'),
      this._getCount('/table/problem'),
      this._getCount('/table/kb_category'),
      this._getCount('/table/kb_knowledge'),
    ]);
    return {
      companies,
      users,
      admins: adminsCount,
      incidents,
      changes,
      problems,
      kb_categories,
      kb_articles,
    };
  }

  async _get(path, params = {}) {
    const res = await this.client.get(path, { params });
    return res.data.result;
  }

  async fetchUserById(sysId) {
    const results = await this._get('/table/sys_user', {
      sysparm_fields:
        'sys_id,first_name,last_name,email,phone,mobile_phone,department,active,title,location,time_zone,vip',
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

  // ── Users ──────────────────────────────────────────────────────────────────

  async fetchUsers(limit = 100, offset = 0) {
    return this._get('/table/sys_user', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: [
        'sys_id',
        'first_name',
        'last_name',
        'email',
        'phone',
        'mobile_phone',
        'department',
        'active',
        'title',
        'location',
        'time_zone',
        'vip',
        'company',
        'city',
        'state',
        'country',
        'zip',
      ].join(','),
      sysparm_query: 'active=true',
      sysparm_display_value: 'all',
    });
  }

  async _resolveAdminStrategy() {
    if (this._adminStrategy) return this._adminStrategy;

    const ADMIN_FIELDS = [
      'sys_id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'company',
      'roles',
      'department',
      'active',
      'title',
      'location',
    ].join(',');

    // Strategy 1: sys_user_has_role table with dot-walking (most accurate)
    try {
      const batch = await this._get('/table/sys_user_has_role', {
        sysparm_query: 'role.name=itil^ORrole.name=admin^user.active=true',
        sysparm_fields: 'user',
        sysparm_limit: 1,
      });
      if (batch?.length > 0) {
        console.log(
          '[SN] Admin strategy: sys_user_has_role (role.name dot-walk)'
        );
        this._adminStrategy = { type: 'role_table' };
        return this._adminStrategy;
      }
    } catch (err) {
      console.warn(`[SN] sys_user_has_role dot-walk failed: ${err.message}`);
    }

    // Strategy 2: sys_user_has_role with role sys_ids (avoids dot-walk)
    try {
      const roles = await this._get('/table/sys_user_role', {
        sysparm_query: 'nameINitil,admin',
        sysparm_fields: 'sys_id,name',
        sysparm_limit: 10,
      });
      if (roles?.length > 0) {
        const roleSysIds = roles
          .map((r) =>
            typeof r.sys_id === 'object' ? r.sys_id?.value : r.sys_id
          )
          .filter(Boolean);
        const testBatch = await this._get('/table/sys_user_has_role', {
          sysparm_query: `roleIN${roleSysIds.join(',')}`,
          sysparm_fields: 'user',
          sysparm_limit: 1,
        });
        if (testBatch?.length > 0) {
          console.log(
            '[SN] Admin strategy: sys_user_has_role (role sys_id IN)'
          );
          this._adminStrategy = { type: 'role_table_sysid', roleSysIds };
          return this._adminStrategy;
        }
      }
    } catch (err) {
      console.warn(
        `[SN] sys_user_has_role sysid approach failed: ${err.message}`
      );
    }

    // Strategy 3: Direct sys_user query (roles field populated on most instances)
    console.log('[SN] Admin strategy: direct sys_user query');
    this._adminStrategy = { type: 'direct' };
    return this._adminStrategy;
  }

  async _fetchAllAgentSysIds() {
    if (this._cachedAgentSysIds) return this._cachedAgentSysIds;

    const strategy = await this._resolveAdminStrategy();
    const allIds = new Set();
    let offset = 0;

    if (strategy.type === 'role_table') {
      while (true) {
        const batch = await this._get('/table/sys_user_has_role', {
          sysparm_query: 'role.name=itil^ORrole.name=admin^user.active=true',
          sysparm_fields: 'user',
          sysparm_limit: 500,
          sysparm_offset: offset,
        });
        if (!batch?.length) break;
        for (const r of batch) {
          const id = typeof r.user === 'object' ? r.user?.value : r.user;
          if (id) allIds.add(id);
        }
        offset += batch.length;
        if (batch.length < 500) break;
      }
    } else if (strategy.type === 'role_table_sysid') {
      while (true) {
        const batch = await this._get('/table/sys_user_has_role', {
          sysparm_query: `roleIN${strategy.roleSysIds.join(',')}`,
          sysparm_fields: 'user',
          sysparm_limit: 500,
          sysparm_offset: offset,
        });
        if (!batch?.length) break;
        for (const r of batch) {
          const id = typeof r.user === 'object' ? r.user?.value : r.user;
          if (id) allIds.add(id);
        }
        offset += batch.length;
        if (batch.length < 500) break;
      }
    }

    console.log(`[SN] Discovered ${allIds.size} agent/admin user IDs`);
    this._cachedAgentSysIds = [...allIds];
    return this._cachedAgentSysIds;
  }

  async fetchAdminUsers(limit = 100, offset = 0) {
    const strategy = await this._resolveAdminStrategy();
    const fields = [
      'sys_id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'company',
      'roles',
      'department',
      'active',
      'title',
      'location',
    ].join(',');

    if (strategy.type === 'direct') {
      return this._get('/table/sys_user', {
        sysparm_limit: limit,
        sysparm_offset: offset,
        sysparm_fields: fields,
        sysparm_query: 'active=true^rolesISNOTEMPTY^ORDERBYemail',
        sysparm_display_value: 'all',
      });
    }

    const allSysIds = await this._fetchAllAgentSysIds();
    const batch = allSysIds.slice(offset, offset + limit);
    if (!batch.length) return [];

    return this._get('/table/sys_user', {
      sysparm_limit: limit,
      sysparm_fields: fields,
      sysparm_query: `sys_idIN${batch.join(',')}`,
      sysparm_display_value: 'all',
    });
  }

  // ── Companies ──────────────────────────────────────────────────────────────

  async fetchCompanies(limit = 100, offset = 0) {
    return this._get('/table/core_company', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: 'sys_id,name,notes,city,state,country,phone,fax,website',
    });
  }

  // ── Incidents ──────────────────────────────────────────────────────────────

  async fetchIncidents(limit = 100, offset = 0) {
    return this._get('/table/incident', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: [
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
        'caller_id',
        'assigned_to',
        'assignment_group',
        'opened_at',
        'resolved_at',
        'closed_at',
        'due_date',
        'sys_updated_on',
        'close_notes',
        'comments_and_work_notes',
        'company',
        'business_service',
      ].join(','),
      sysparm_query: 'active=true^ORDERBYopened_at',
      sysparm_display_value: 'all',
    });
  }

  // ── Changes ────────────────────────────────────────────────────────────────

  async fetchChanges(limit = 100, offset = 0) {
    return this._get('/table/change_request', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: [
        'sys_id',
        'number',
        'short_description',
        'description',
        'priority',
        'state',
        'type',
        'impact',
        'risk',
        'category',
        'assignment_group',
        'assigned_to',
        'requested_by',
        'opened_by',
        'start_date',
        'end_date',
        'due_date',
        'opened_at',
        'closed_at',
        'sys_updated_on',
        'reason',
        'justification',
        'implementation_plan',
        'backout_plan',
        'test_plan',
        'close_code',
        'close_notes',
      ].join(','),
      sysparm_query: 'ORDERBYopened_at',
      sysparm_display_value: 'all',
    });
  }

  // ── Problems ───────────────────────────────────────────────────────────────

  async fetchProblems(limit = 100, offset = 0) {
    return this._get('/table/problem', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: [
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
        'assignment_group',
        'assigned_to',
        'opened_by',
        'opened_at',
        'closed_at',
        'sys_updated_on',
        'due_date',
        'resolution_code',
        'cause_notes',
        'fix_notes',
      ].join(','),
      sysparm_query: 'ORDERBYopened_at',
      sysparm_display_value: 'all',
    });
  }

  // ── Comments & Attachments ─────────────────────────────────────────────────

  async fetchComments(ticketSysId) {
    return this._get('/table/sys_journal_field', {
      sysparm_query: `element_id=${ticketSysId}^element=comments^ORDERBYsys_created_on`,
      sysparm_fields: 'sys_id,value,sys_created_by,sys_created_on,element_id',
    });
  }

  async fetchWorkNotes(ticketSysId) {
    return this._get('/table/sys_journal_field', {
      sysparm_query: `element_id=${ticketSysId}^element=work_notes^ORDERBYsys_created_on`,
      sysparm_fields: 'sys_id,value,sys_created_by,sys_created_on,element_id',
    });
  }

  // ── Knowledge Base ─────────────────────────────────────────────────────────

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
      sysparm_fields: [
        'sys_id',
        'short_description',
        'text',
        'kb_category',
        'workflow_state',
        'published',
        'author',
        'sys_tags',
      ].join(','),
      sysparm_query: 'ORDERBYsys_created_on',
      sysparm_display_value: 'all',
    });
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  async fetchAttachments(tableName, sysId) {
    return this._get('/attachment', {
      sysparm_query: `table_name=${tableName}^table_sys_id=${sysId}`,
      sysparm_fields: 'sys_id,file_name,content_type,size_bytes,download_link',
      sysparm_display_value: 'false',
    });
  }

  async downloadAttachment(downloadUrl) {
    // Ensure absolute URL — ServiceNow may return a relative path
    const url =
      downloadUrl.startsWith('http')
        ? downloadUrl
        : `${this.client.defaults.baseURL?.replace('/api/now', '')}${downloadUrl}`;
    const res = await this.client.get(url, {
      baseURL: '',
      responseType: 'arraybuffer',
    });
    return res.data;
  }

  // ── Assignment Groups ──────────────────────────────────────────────────────

  async fetchChangeTasks(changeId) {
    return this._get('/table/change_task', {
      sysparm_query: `change_request=${changeId}^ORDERBYorder`,
      sysparm_fields: 'sys_id,short_description,description,state,assigned_to,due_date,order',
      sysparm_display_value: 'all',
    });
  }

  async fetchProblemTasks(problemId) {
    return this._get('/table/problem_task', {
      sysparm_query: `problem=${problemId}^ORDERBYorder`,
      sysparm_fields: 'sys_id,short_description,description,state,assigned_to,due_date,order',
      sysparm_display_value: 'all',
    });
  }

  async fetchGroups(limit = 200, offset = 0) {
    const raw = await this._get('/table/sys_user_group', {
      sysparm_limit: limit,
      sysparm_offset: offset,
      sysparm_fields: 'sys_id,name,description,manager,email,type',
      sysparm_query: 'active=true',
      sysparm_display_value: 'all',
    });
    return (raw ?? []).map((g) => ({
      ...g,
      sys_id:
        typeof g.sys_id === 'object'
          ? g.sys_id?.value ?? g.sys_id?.display_value
          : g.sys_id,
      name:
        typeof g.name === 'object'
          ? g.name?.display_value ?? g.name?.value
          : g.name,
      description:
        typeof g.description === 'object'
          ? g.description?.display_value ?? g.description?.value
          : g.description,
      manager:
        typeof g.manager === 'object'
          ? g.manager?.display_value ?? g.manager?.value
          : g.manager,
      email:
        typeof g.email === 'object'
          ? g.email?.display_value ?? g.email?.value
          : g.email,
      type:
        typeof g.type === 'object'
          ? g.type?.display_value ?? g.type?.value
          : g.type,
    }));
  }

  async fetchAllGroups() {
    const groups = [];
    let offset = 0;
    while (true) {
      const batch = await this.fetchGroups(200, offset);
      if (!batch?.length) break;
      groups.push(...batch);
      offset += batch.length;
      if (batch.length < 200) break;
    }
    return groups;
  }

  // ── Categories ─────────────────────────────────────────────────────────────

  async fetchCategories(tableName = 'incident') {
    try {
      const results = await this._get('/table/sys_choice', {
        sysparm_query: `name=${tableName}^element=category^inactive=false`,
        sysparm_fields: 'value,label,sequence',
        sysparm_limit: 500,
      });
      return (results ?? []).map((r) => ({ value: r.value, label: r.label }));
    } catch {
      return [];
    }
  }

  // ── Field Schema Fetching ──────────────────────────────────────────────────

  async fetchTableFields(tableName) {
    const ALWAYS_INCLUDE = [
      { name: 'sys_created_on', label: 'Created Date', type: 'glide_date_time' },
      { name: 'sys_updated_on', label: 'Updated Date', type: 'glide_date_time' },
    ];

    // Tables that extend 'task' — need to also fetch task base fields
    const TASK_BASED = ['incident', 'change_request', 'problem'];

    try {
      const tableNames = TASK_BASED.includes(tableName)
        ? [tableName, 'task']
        : [tableName];

      const allResults = await Promise.all(
        tableNames.map((t) =>
          this._get(`/table/sys_dictionary`, {
            sysparm_query: `name=${t}^internal_type!=collection`,
            sysparm_fields:
              'element,column_label,internal_type,max_length,mandatory,reference',
            sysparm_limit: 500,
          })
        )
      );

      const seen = new Set();
      const mapped = [];

      for (const fields of allResults) {
        for (const f of fields ?? []) {
          if (!f.element) continue;
          if (seen.has(f.element)) continue;
          if (f.element.startsWith('sys_') && !['sys_updated_on', 'sys_created_on'].includes(f.element)) continue;
          seen.add(f.element);
          mapped.push({
            name: f.element,
            label: f.column_label || f.element,
            type: f.internal_type?.value ?? f.internal_type ?? 'string',
            maxLength: f.max_length ? Number(f.max_length) : null,
            mandatory: f.mandatory === 'true',
            reference: f.reference?.value ?? f.reference ?? null,
          });
        }
      }

      // Inject audit date fields if not already returned
      for (const field of ALWAYS_INCLUDE) {
        if (!mapped.some((f) => f.name === field.name)) {
          mapped.push(field);
        }
      }

      return mapped;
    } catch {
      return this._getFallbackFields(tableName);
    }
  }

  _getFallbackFields(tableName) {
    const KNOWN_FIELDS = {
      incident: [
        { name: 'number', label: 'Number', type: 'string' },
        { name: 'short_description', label: 'Short Description', type: 'string' },
        { name: 'description', label: 'Description', type: 'string' },
        { name: 'priority', label: 'Priority', type: 'integer' },
        { name: 'state', label: 'State', type: 'integer' },
        { name: 'caller_id', label: 'Caller', type: 'reference' },
        { name: 'opened_at', label: 'Opened At', type: 'glide_date_time' },
        { name: 'resolved_at', label: 'Resolved At', type: 'glide_date_time' },
        { name: 'closed_at', label: 'Closed At', type: 'glide_date_time' },
        { name: 'sys_created_on', label: 'Created Date', type: 'glide_date_time' },
        { name: 'sys_updated_on', label: 'Updated Date', type: 'glide_date_time' },
        { name: 'category', label: 'Category', type: 'string' },
        { name: 'subcategory', label: 'Subcategory', type: 'string' },
        { name: 'impact', label: 'Impact', type: 'integer' },
        { name: 'urgency', label: 'Urgency', type: 'integer' },
        { name: 'assigned_to', label: 'Assigned To', type: 'reference' },
        { name: 'assignment_group', label: 'Assignment Group', type: 'reference' },
        { name: 'contact_type', label: 'Contact Type', type: 'string' },
        { name: 'company', label: 'Company', type: 'reference' },
      ],
      change_request: [
        { name: 'number', label: 'Number', type: 'string' },
        {
          name: 'short_description',
          label: 'Short Description',
          type: 'string',
        },
        { name: 'description', label: 'Description', type: 'string' },
        { name: 'priority', label: 'Priority', type: 'integer' },
        { name: 'state', label: 'State', type: 'integer' },
        { name: 'type', label: 'Type', type: 'string' },
        { name: 'impact', label: 'Impact', type: 'integer' },
        { name: 'risk', label: 'Risk', type: 'integer' },
        { name: 'category', label: 'Category', type: 'string' },
        { name: 'start_date', label: 'Start Date', type: 'glide_date_time' },
        { name: 'end_date', label: 'End Date', type: 'glide_date_time' },
        { name: 'requested_by', label: 'Requested By', type: 'reference' },
        { name: 'opened_by', label: 'Opened By', type: 'reference' },
        { name: 'assigned_to', label: 'Assigned To', type: 'reference' },
        {
          name: 'assignment_group',
          label: 'Assignment Group',
          type: 'reference',
        },
        { name: 'reason', label: 'Reason', type: 'string' },
        { name: 'justification', label: 'Justification', type: 'string' },
        {
          name: 'implementation_plan',
          label: 'Implementation Plan',
          type: 'string',
        },
        { name: 'backout_plan', label: 'Backout Plan', type: 'string' },
      ],
      problem: [
        { name: 'number', label: 'Number', type: 'string' },
        {
          name: 'short_description',
          label: 'Short Description',
          type: 'string',
        },
        { name: 'description', label: 'Description', type: 'string' },
        { name: 'priority', label: 'Priority', type: 'integer' },
        { name: 'state', label: 'State', type: 'integer' },
        { name: 'impact', label: 'Impact', type: 'integer' },
        { name: 'urgency', label: 'Urgency', type: 'integer' },
        { name: 'category', label: 'Category', type: 'string' },
        { name: 'due_date', label: 'Due Date', type: 'glide_date_time' },
        { name: 'opened_by', label: 'Opened By', type: 'reference' },
        { name: 'assigned_to', label: 'Assigned To', type: 'reference' },
        {
          name: 'assignment_group',
          label: 'Assignment Group',
          type: 'reference',
        },
      ],
      sys_user: [
        { name: 'first_name', label: 'First Name', type: 'string' },
        { name: 'last_name', label: 'Last Name', type: 'string' },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'phone', label: 'Phone', type: 'phone_number' },
        { name: 'mobile_phone', label: 'Mobile Phone', type: 'phone_number' },
        { name: 'department', label: 'Department', type: 'reference' },
        { name: 'active', label: 'Active', type: 'boolean' },
        { name: 'roles', label: 'Roles', type: 'string' },
        { name: 'title', label: 'Title', type: 'string' },
        { name: 'location', label: 'Location', type: 'reference' },
        { name: 'vip', label: 'VIP', type: 'boolean' },
        { name: 'time_zone', label: 'Time Zone', type: 'string' },
        { name: 'company', label: 'Company', type: 'reference' },
      ],
      core_company: [
        { name: 'name', label: 'Name', type: 'string' },
        { name: 'notes', label: 'Notes', type: 'string' },
        { name: 'city', label: 'City', type: 'string' },
        { name: 'country', label: 'Country', type: 'string' },
        { name: 'phone', label: 'Phone', type: 'phone_number' },
        { name: 'website', label: 'Website', type: 'string' },
      ],
      kb_knowledge: [
        {
          name: 'short_description',
          label: 'Short Description',
          type: 'string',
        },
        { name: 'text', label: 'Text', type: 'html' },
        { name: 'kb_category', label: 'KB Category', type: 'reference' },
        { name: 'workflow_state', label: 'Workflow State', type: 'string' },
        { name: 'author', label: 'Author', type: 'reference' },
        { name: 'sys_tags', label: 'Tags', type: 'string' },
      ],
    };
    return KNOWN_FIELDS[tableName] ?? [];
  }

  async fetchAllFieldSchemas() {
    const tables = {
      incidents: 'incident',
      changes: 'change_request',
      problems: 'problem',
      users: 'sys_user',
      companies: 'core_company',
      kb_articles: 'kb_knowledge',
    };
    const schemas = {};
    for (const [objectName, tableName] of Object.entries(tables)) {
      schemas[objectName] = await this.fetchTableFields(tableName);
    }
    return schemas;
  }

  // ── Public generic methods (used by orchestrators and migrators) ───────────

  /**
   * Public generic GET — accepts a full URL and params object.
   * Used by orchestrators and sub-resource migrators.
   */
  async get(fullUrl, params = {}) {
    const url = new URL(fullUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    // _get prepends baseURL (instanceUrl/api/now) — strip that prefix from pathname
    // so we only pass the table-relative path e.g. /table/incident?...
    const base = new URL(this.client.defaults.baseURL);
    const relative = url.pathname.startsWith(base.pathname)
      ? url.pathname.slice(base.pathname.length) + url.search
      : url.pathname + url.search;
    const result = await this._get(relative);
    return { result: result ?? [] };
  }

  /**
   * Downloads a file from a full URL and returns a Buffer.
   * Used by attachment migrators instead of downloadAttachment().
   */
  async getBuffer(fullUrl) {
    return this.downloadAttachment(fullUrl);
  }

  // ── Metadata Fetching (for pre-migration workspace setup) ──────────────────

  async fetchMetadata() {
    const [groups, categories, changeCategories, problemCategories] =
      await Promise.all([
        this.fetchAllGroups(),
        this.fetchCategories('incident'),
        this.fetchCategories('change_request'),
        this.fetchCategories('problem'),
      ]);
    return {
      groups,
      incidentCategories: categories,
      changeCategories,
      problemCategories,
    };
  }
}
