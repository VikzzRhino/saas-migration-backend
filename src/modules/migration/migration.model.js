import mongoose from 'mongoose';

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
    status: { type: String, default: 'pending' },
    totalRecords: { type: Number, default: 0 },
    processedRecords: { type: Number, default: 0 },
    failedRecords: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model('Migration', migrationSchema);
