import mongoose from 'mongoose';

const OBJECTS = [
  'companies',
  'users',
  'admins',
  'incidents',
  'changes',
  'problems',
  'kb_categories',
  'kb_folders',
  'kb_articles',
  'comments',
  'attachments',
  'tasks',
  // stage-completion sentinels written by the worker
  'companies_done',
  'users_done',
  'admins_done',
  'incidents_done',
  'changes_done',
  'problems_done',
  'kb_done',
];

const statsSchema = new mongoose.Schema(
  {
    total: { type: Number, default: 0 },
    success: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
  },
  { _id: false }
);

const fieldMappingEntrySchema = new mongoose.Schema(
  {
    sourceField: { type: String, default: null },
    sourceLabel: { type: String, default: null },
    targetField: { type: String, default: null },
    targetLabel: { type: String, default: null },
    transform: { type: String, default: 'direct' },
    confidence: { type: Number, default: 0 },
    autoMapped: { type: Boolean, default: false },
  },
  { _id: false }
);

// Value-level mapping for enum/select fields (e.g. priority, status, category)
const valueMappingEntrySchema = new mongoose.Schema(
  {
    defaultValue: { type: mongoose.Schema.Types.Mixed, default: null },
    map: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

// Agent matching: SN admin email → FS agent id
const agentMatchEntrySchema = new mongoose.Schema(
  {
    snEmail: { type: String, required: true },
    snName: { type: String, default: null },
    snSysId: { type: String, default: null },
    fsAgentId: { type: Number, default: null },
    fsAgentEmail: { type: String, default: null },
    fsAgentName: { type: String, default: null },
    matched: { type: Boolean, default: false },
  },
  { _id: false }
);

// Group mapping: SN group sys_id → FS group id
const groupMappingEntrySchema = new mongoose.Schema(
  {
    snGroupId: { type: String, required: true },
    snGroupName: { type: String, default: null },
    fsGroupId: { type: Number, default: null },
    fsGroupName: { type: String, default: null },
  },
  { _id: false }
);

const migrationSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, index: true },
    name: { type: String, default: '' },
    source: {
      system: { type: String },
      credentials: { type: mongoose.Schema.Types.Mixed },
    },
    target: {
      system: { type: String },
      credentials: { type: mongoose.Schema.Types.Mixed },
    },
    status: {
      type: String,
      enum: [
        'pending',
        'running',
        'paused',
        'completed',
        'failed',
        'rolled_back',
      ],
      default: 'pending',
    },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // Cached workspace data fetched from Freshservice before migration
    workspace: {
      agents: { type: [mongoose.Schema.Types.Mixed], default: [] },
      departments: { type: [mongoose.Schema.Types.Mixed], default: [] },
      groups: { type: [mongoose.Schema.Types.Mixed], default: [] },
      roles: { type: [mongoose.Schema.Types.Mixed], default: [] },
      requesters: { type: [mongoose.Schema.Types.Mixed], default: [] },
      requesterFields: { type: [mongoose.Schema.Types.Mixed], default: [] },
      ticketFields: { type: [mongoose.Schema.Types.Mixed], default: [] },
      changeFields: { type: [mongoose.Schema.Types.Mixed], default: [] },
      problemFields: { type: [mongoose.Schema.Types.Mixed], default: [] },
      kbCategories: { type: [mongoose.Schema.Types.Mixed], default: [] },
      kbFolders: { type: [mongoose.Schema.Types.Mixed], default: [] },
      fetchedAt: { type: Date, default: null },
    },

    // Source metadata (groups, categories from ServiceNow)
    sourceMetadata: {
      groups: { type: [mongoose.Schema.Types.Mixed], default: [] },
      incidentCategories: { type: [mongoose.Schema.Types.Mixed], default: [] },
      changeCategories: { type: [mongoose.Schema.Types.Mixed], default: [] },
      problemCategories: { type: [mongoose.Schema.Types.Mixed], default: [] },
      fetchedAt: { type: Date, default: null },
    },

    // Source field schemas (cached from ServiceNow)
    sourceSchemas: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Custom field mappings per object type (overrides auto-mapping)
    fieldMappings: {
      incidents: { type: [fieldMappingEntrySchema], default: [] },
      changes: { type: [fieldMappingEntrySchema], default: [] },
      problems: { type: [fieldMappingEntrySchema], default: [] },
      users: { type: [fieldMappingEntrySchema], default: [] },
      admins: { type: [fieldMappingEntrySchema], default: [] },
      companies: { type: [fieldMappingEntrySchema], default: [] },
      kb_articles: { type: [fieldMappingEntrySchema], default: [] },
    },

    // Configurable value-level mappings per object per field
    // e.g. valueMappings.incidents.priority = { defaultValue: 1, map: { '1 - Critical': 4, ... } }
    valueMappings: {
      incidents: { type: Map, of: valueMappingEntrySchema, default: {} },
      changes: { type: Map, of: valueMappingEntrySchema, default: {} },
      problems: { type: Map, of: valueMappingEntrySchema, default: {} },
      users: { type: Map, of: valueMappingEntrySchema, default: {} },
      admins: { type: Map, of: valueMappingEntrySchema, default: {} },
      companies: { type: Map, of: valueMappingEntrySchema, default: {} },
      kb_articles: { type: Map, of: valueMappingEntrySchema, default: {} },
    },

    // Agent matching (ServiceNow admins ↔ Freshservice agents)
    agentMatching: {
      defaultAgentId: { type: Number, default: null },
      defaultAgentEmail: { type: String, default: null },
      entries: { type: [agentMatchEntrySchema], default: [] },
    },

    // Group mapping (ServiceNow groups ↔ Freshservice groups)
    groupMapping: { type: [groupMappingEntrySchema], default: [] },

    objectConfig: {
      companies: { type: Boolean, default: true },
      users: { type: Boolean, default: true },
      admins: { type: Boolean, default: true },
      incidents: { type: Boolean, default: true },
      changes: { type: Boolean, default: true },
      problems: { type: Boolean, default: true },
      kb_categories: { type: Boolean, default: true },
      kb_folders: { type: Boolean, default: true },
      kb_articles: { type: Boolean, default: true },
      comments: { type: Boolean, default: true },
      attachments: { type: Boolean, default: true },
      tasks: { type: Boolean, default: true },
    },

    objectStatuses: {
      companies:     { type: String, enum: ['pending', 'running', 'completed', 'failed', 'partial'], default: 'pending' },
      users:         { type: String, enum: ['pending', 'running', 'completed', 'failed', 'partial'], default: 'pending' },
      admins:        { type: String, enum: ['pending', 'running', 'completed', 'failed', 'partial'], default: 'pending' },
      incidents:     { type: String, enum: ['pending', 'running', 'completed', 'failed', 'partial'], default: 'pending' },
      changes:       { type: String, enum: ['pending', 'running', 'completed', 'failed', 'partial'], default: 'pending' },
      problems:      { type: String, enum: ['pending', 'running', 'completed', 'failed', 'partial'], default: 'pending' },
      kb_categories: { type: String, enum: ['pending', 'running', 'completed', 'failed', 'partial'], default: 'pending' },
      kb_articles:   { type: String, enum: ['pending', 'running', 'completed', 'failed', 'partial'], default: 'pending' },
    },

    checkpoint: {
      currentObject: { type: String, enum: OBJECTS, default: null },
      offset: { type: Number, default: 0 },
      lastProcessedId: { type: String, default: null },
    },

    stats: {
      companies: { type: statsSchema, default: () => ({}) },
      users: { type: statsSchema, default: () => ({}) },
      admins: { type: statsSchema, default: () => ({}) },
      incidents: { type: statsSchema, default: () => ({}) },
      changes: { type: statsSchema, default: () => ({}) },
      problems: { type: statsSchema, default: () => ({}) },
      kb_categories: { type: statsSchema, default: () => ({}) },
      kb_folders: { type: statsSchema, default: () => ({}) },
      kb_articles: { type: statsSchema, default: () => ({}) },
      comments: { type: statsSchema, default: () => ({}) },
      attachments: { type: statsSchema, default: () => ({}) },
      tasks: { type: statsSchema, default: () => ({}) },
    },

    errorLog: [
      {
        object: { type: String },
        snowId: { type: String },
        status: {
          type: String,
          enum: ['failed', 'skipped', 'retried_success'],
          default: 'failed',
        },
        error: { type: String },
        timestamp: { type: Date, default: Date.now },
      },
    ],

    // Data retention policy
    retentionPolicy: {
      retentionDays: { type: Number, default: 90 },
      purgeOnComplete: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

export default mongoose.model('Migration', migrationSchema);
