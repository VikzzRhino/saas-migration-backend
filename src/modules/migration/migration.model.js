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

const migrationSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, index: true },
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
      enum: ['pending', 'running', 'paused', 'completed', 'failed'],
      default: 'pending',
    },

    startedAt:   { type: Date, default: null },
    completedAt: { type: Date, default: null },

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
    },

    errorLog: [
      {
        object:    { type: String },
        snowId:    { type: String },
        status:    { type: String, enum: ['failed', 'skipped'], default: 'failed' },
        error:     { type: String },
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model('Migration', migrationSchema);
