import mongoose from 'mongoose';

const stagedRecordSchema = new mongoose.Schema(
  {
    migrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Migration',
      required: true,
      index: true,
    },
    objectType: {
      type: String,
      enum: [
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
      ],
      required: true,
      index: true,
    },
    sourceId: { type: String, required: true, index: true },
    sourceData: { type: mongoose.Schema.Types.Mixed, required: true },
    transformedData: { type: mongoose.Schema.Types.Mixed, default: null },
    targetId: { type: mongoose.Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: ['fetched', 'transformed', 'pushed', 'failed', 'skipped'],
      default: 'fetched',
      index: true,
    },
    errorMessage: { type: String, default: null },
    retryCount: { type: Number, default: 0 },
    parentSourceId: { type: String, default: null },
    expiresAt: { type: Date, index: true },
  },
  { timestamps: true }
);

stagedRecordSchema.index(
  { migrationId: 1, objectType: 1, sourceId: 1 },
  { unique: true }
);
stagedRecordSchema.index({ migrationId: 1, objectType: 1, status: 1 });
stagedRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('StagedRecord', stagedRecordSchema);
