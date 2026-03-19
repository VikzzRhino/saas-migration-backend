// src/modules/field-mapping/field-schema.js

// Freshservice target field definitions per object type.
// Used for auto-mapping, dropdown population, and value mapping in the frontend.

const CUSTOM_FIELD_WILDCARD = {
  name: 'custom_fields.*',
  label: 'Custom Field (dynamic)',
  type: 'custom',
  description:
    'Maps to a Freshservice custom field. Enter the exact FS custom field name after the dot.',
};

export const FRESHSERVICE_SCHEMAS = {
  incidents: {
    targetTable: 'tickets',
    fields: [
      { name: 'subject', label: 'Subject', type: 'string', required: true },
      {
        name: 'description',
        label: 'Description',
        type: 'html',
        required: true,
      },
      {
        name: 'priority',
        label: 'Priority',
        type: 'enum',
        required: true,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
          { value: 4, label: 'Urgent' },
        ],
      },
      {
        name: 'status',
        label: 'Status',
        type: 'enum',
        required: true,
        options: [
          { value: 2, label: 'Open' },
          { value: 3, label: 'Pending' },
          { value: 4, label: 'Resolved' },
          { value: 5, label: 'Closed' },
        ],
      },
      {
        name: 'source',
        label: 'Source',
        type: 'enum',
        required: false,
        options: [
          { value: 1, label: 'Email' },
          { value: 2, label: 'Portal' },
          { value: 3, label: 'Phone' },
          { value: 4, label: 'Chat' },
          { value: 5, label: 'Feedback Widget' },
          { value: 6, label: 'Yammer' },
          { value: 7, label: 'AWS Cloudwatch' },
          { value: 8, label: 'Pagerduty' },
          { value: 9, label: 'Walk-in' },
          { value: 10, label: 'Monitoring' },
        ],
      },
      {
        name: 'type',
        label: 'Type',
        type: 'enum',
        required: false,
        options: [
          { value: 'Incident', label: 'Incident' },
          { value: 'Service Request', label: 'Service Request' },
        ],
      },
      {
        name: 'impact',
        label: 'Impact',
        type: 'enum',
        required: false,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
        ],
      },
      {
        name: 'urgency',
        label: 'Urgency',
        type: 'enum',
        required: false,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
        ],
      },
      { name: 'category', label: 'Category', type: 'string', required: false },
      {
        name: 'subcategory',
        label: 'Subcategory',
        type: 'string',
        required: false,
      },
      {
        name: 'requester_id',
        label: 'Contact',
        type: 'reference',
        required: true,
      },
      {
        name: 'responder_id',
        label: 'Agent',
        type: 'reference',
        required: false,
      },
      { name: 'group_id', label: 'Group', type: 'reference', required: false },
      {
        name: 'department_id',
        label: 'Department',
        type: 'reference',
        required: false,
      },
      { name: 'tags', label: 'Tags', type: 'array', required: false },
      { name: 'cc_emails', label: 'CC', type: 'array', required: false },
      { name: 'due_by', label: 'Due By', type: 'datetime', required: false },
      {
        name: 'created_at',
        label: 'Created Date',
        type: 'datetime',
        required: false,
      },
      {
        name: 'updated_at',
        label: 'Updated Date',
        type: 'datetime',
        required: false,
      },
      {
        name: 'closed_at',
        label: 'Closed Date',
        type: 'datetime',
        required: false,
      },
      CUSTOM_FIELD_WILDCARD,
    ],
  },

  changes: {
    targetTable: 'changes',
    fields: [
      { name: 'subject', label: 'Subject', type: 'string', required: true },
      {
        name: 'description',
        label: 'Description',
        type: 'html',
        required: true,
      },
      {
        name: 'priority',
        label: 'Priority',
        type: 'enum',
        required: true,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
          { value: 4, label: 'Urgent' },
        ],
      },
      {
        name: 'status',
        label: 'Status',
        type: 'enum',
        required: true,
        options: [
          { value: 1, label: 'Open' },
          { value: 2, label: 'Planning' },
          { value: 3, label: 'Awaiting Approval' },
          { value: 4, label: 'Pending Release' },
          { value: 5, label: 'Closed' },
        ],
      },
      {
        name: 'change_type',
        label: 'Change Type',
        type: 'enum',
        required: true,
        options: [
          { value: 1, label: 'Minor' },
          { value: 2, label: 'Standard' },
          { value: 3, label: 'Major' },
          { value: 4, label: 'Emergency' },
        ],
      },
      {
        name: 'impact',
        label: 'Impact',
        type: 'enum',
        required: false,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
        ],
      },
      {
        name: 'risk',
        label: 'Risk',
        type: 'enum',
        required: false,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
          { value: 4, label: 'Very High' },
        ],
      },
      { name: 'category', label: 'Category', type: 'string', required: false },
      { name: 'group_id', label: 'Group', type: 'reference', required: false },
      {
        name: 'department_id',
        label: 'Department',
        type: 'reference',
        required: false,
      },
      { name: 'agent_id', label: 'Staff', type: 'reference', required: false },
      {
        name: 'requester_id',
        label: 'Requester',
        type: 'reference',
        required: false,
      },
      {
        name: 'planned_start_date',
        label: 'Planned Start Date',
        type: 'datetime',
        required: true,
      },
      {
        name: 'planned_end_date',
        label: 'Planned End Date',
        type: 'datetime',
        required: true,
      },
      {
        name: 'planning_reason',
        label: 'Planning Reason',
        type: 'string',
        required: false,
      },
      {
        name: 'planning_impact',
        label: 'Planning Impact',
        type: 'string',
        required: false,
      },
      {
        name: 'planning_rollout',
        label: 'Planning Rollout',
        type: 'string',
        required: false,
      },
      {
        name: 'planning_backout',
        label: 'Planning Backout',
        type: 'string',
        required: false,
      },
      {
        name: 'created_at',
        label: 'Created Date',
        type: 'datetime',
        required: false,
      },
      {
        name: 'updated_at',
        label: 'Updated Date',
        type: 'datetime',
        required: false,
      },
      {
        name: 'closed_at',
        label: 'Closed Date',
        type: 'datetime',
        required: false,
      },
      CUSTOM_FIELD_WILDCARD,
    ],
  },

  problems: {
    targetTable: 'problems',
    fields: [
      { name: 'subject', label: 'Subject', type: 'string', required: true },
      {
        name: 'description',
        label: 'Description',
        type: 'html',
        required: true,
      },
      {
        name: 'priority',
        label: 'Priority',
        type: 'enum',
        required: true,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
          { value: 4, label: 'Urgent' },
        ],
      },
      {
        name: 'status',
        label: 'Status',
        type: 'enum',
        required: true,
        options: [
          { value: 1, label: 'Open' },
          { value: 2, label: 'Change Requested' },
          { value: 3, label: 'Closed' },
        ],
      },
      {
        name: 'impact',
        label: 'Impact',
        type: 'enum',
        required: false,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
        ],
      },
      {
        name: 'urgency',
        label: 'Urgency',
        type: 'enum',
        required: false,
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'High' },
        ],
      },
      { name: 'category', label: 'Category', type: 'string', required: false },
      { name: 'group_id', label: 'Group', type: 'reference', required: false },
      {
        name: 'department_id',
        label: 'Department',
        type: 'reference',
        required: false,
      },
      { name: 'agent_id', label: 'Staff', type: 'reference', required: false },
      {
        name: 'requester_id',
        label: 'Requester',
        type: 'reference',
        required: false,
      },
      { name: 'due_by', label: 'Due Date', type: 'datetime', required: false },
      {
        name: 'created_at',
        label: 'Created Date',
        type: 'datetime',
        required: false,
      },
      {
        name: 'updated_at',
        label: 'Updated Date',
        type: 'datetime',
        required: false,
      },
      {
        name: 'closed_at',
        label: 'Closed Date',
        type: 'datetime',
        required: false,
      },
      CUSTOM_FIELD_WILDCARD,
    ],
  },

  users: {
    targetTable: 'requesters',
    fields: [
      { name: 'first_name', label: 'Name', type: 'string', required: true },
      {
        name: 'last_name',
        label: 'Last Name',
        type: 'string',
        required: false,
      },
      { name: 'primary_email', label: 'Email', type: 'email', required: true },
      {
        name: 'work_phone_number',
        label: 'Phone',
        type: 'phone',
        required: false,
      },
      {
        name: 'mobile_phone_number',
        label: 'Mobile Phone',
        type: 'phone',
        required: false,
      },
      {
        name: 'department_id',
        label: 'Company',
        type: 'reference',
        required: false,
      },
      { name: 'job_title', label: 'Title', type: 'string', required: false },
      { name: 'address', label: 'Address', type: 'string', required: false },
      {
        name: 'time_zone',
        label: 'Time Zone',
        type: 'string',
        required: false,
      },
      {
        name: 'time_format',
        label: 'Time Format',
        type: 'string',
        required: false,
      },
      { name: 'language', label: 'Language', type: 'string', required: false },
      {
        name: 'vip_user',
        label: 'Mark as VIP',
        type: 'boolean',
        required: false,
      },
      {
        name: 'location_id',
        label: 'Location',
        type: 'reference',
        required: false,
      },
      {
        name: 'background_information',
        label: 'Background Information',
        type: 'string',
        required: false,
      },
    ],
  },

  admins: {
    targetTable: 'agents',
    fields: [
      {
        name: 'first_name',
        label: 'First Name',
        type: 'string',
        required: true,
      },
      {
        name: 'last_name',
        label: 'Last Name',
        type: 'string',
        required: false,
      },
      { name: 'email', label: 'Email', type: 'email', required: true },
      {
        name: 'work_phone_number',
        label: 'Phone',
        type: 'phone',
        required: false,
      },
      { name: 'roles', label: 'Roles', type: 'array', required: false },
      {
        name: 'department_ids',
        label: 'Departments',
        type: 'array',
        required: false,
      },
      { name: 'group_ids', label: 'Groups', type: 'array', required: false },
      {
        name: 'occasional',
        label: 'Occasional Agent',
        type: 'boolean',
        required: false,
      },
    ],
  },

  companies: {
    targetTable: 'departments',
    fields: [
      { name: 'name', label: 'Name', type: 'string', required: true },
      {
        name: 'description',
        label: 'Description',
        type: 'string',
        required: false,
      },
      {
        name: 'head_user_id',
        label: 'Head',
        type: 'reference',
        required: false,
      },
      {
        name: 'prime_user_id',
        label: 'Prime User',
        type: 'reference',
        required: false,
      },
      { name: 'domains', label: 'Domains', type: 'array', required: false },
    ],
  },

  kb_articles: {
    targetTable: 'solutions/articles',
    fields: [
      { name: 'title', label: 'Title', type: 'string', required: true },
      { name: 'description', label: 'Body', type: 'html', required: true },
      {
        name: 'status',
        label: 'Status',
        type: 'enum',
        required: false,
        options: [
          { value: 1, label: 'Draft' },
          { value: 2, label: 'Published' },
        ],
      },
      { name: 'folder_id', label: 'Folder', type: 'reference', required: true },
      { name: 'tags', label: 'Tags', type: 'array', required: false },
      { name: 'seo_data', label: 'SEO Data', type: 'object', required: false },
      CUSTOM_FIELD_WILDCARD,
    ],
  },
};

// ServiceNow table name lookup for each object type
export const SERVICENOW_TABLE_MAP = {
  incidents: 'incident',
  changes: 'change_request',
  problems: 'problem',
  users: 'sys_user',
  admins: 'sys_user',
  companies: 'core_company',
  kb_articles: 'kb_knowledge',
  kb_categories: 'kb_category',
};
