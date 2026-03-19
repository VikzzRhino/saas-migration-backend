import mongoose from 'mongoose';
import StagedRecord from './staged-record.model.js';

const DEFAULT_RETENTION_DAYS = 90;

function computeExpiry(retentionDays) {
  const d = new Date();
  d.setDate(d.getDate() + (retentionDays || DEFAULT_RETENTION_DAYS));
  return d;
}

function extractSourceId(record) {
  const sid = record.sys_id;
  if (!sid) return null;
  return typeof sid === 'object'
    ? sid.value ?? sid.display_value ?? String(sid)
    : String(sid);
}

/**
 * Bulk-stage fetched records from source, using unordered inserts to skip duplicates.
 */
export async function stageRecords(
  migrationId,
  objectType,
  records,
  retentionDays
) {
  if (!records?.length) return [];

  const docs = records.map((r) => ({
    migrationId,
    objectType,
    sourceId: extractSourceId(r),
    sourceData: r,
    status: 'fetched',
    expiresAt: computeExpiry(retentionDays),
  }));

  try {
    await StagedRecord.insertMany(docs, { ordered: false });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  return docs.map((d) => d.sourceId);
}

/**
 * Update a staged record after transformation.
 */
export async function markTransformed(
  migrationId,
  objectType,
  sourceId,
  transformedData
) {
  return StagedRecord.findOneAndUpdate(
    { migrationId, objectType, sourceId },
    { transformedData, status: 'transformed' },
    { new: true }
  );
}

/**
 * Update a staged record after successful push to target.
 */
export async function markPushed(migrationId, objectType, sourceId, targetId) {
  return StagedRecord.findOneAndUpdate(
    { migrationId, objectType, sourceId },
    { targetId, status: 'pushed' },
    { new: true }
  );
}

/**
 * Mark a staged record as failed.
 */
export async function markFailed(
  migrationId,
  objectType,
  sourceId,
  errorMessage
) {
  return StagedRecord.findOneAndUpdate(
    { migrationId, objectType, sourceId },
    { status: 'failed', errorMessage, $inc: { retryCount: 1 } },
    { new: true, upsert: false }
  );
}

/**
 * Mark a staged record as skipped.
 */
export async function markSkipped(migrationId, objectType, sourceId, reason) {
  return StagedRecord.findOneAndUpdate(
    { migrationId, objectType, sourceId },
    { status: 'skipped', errorMessage: reason },
    { new: true, upsert: false }
  );
}

/**
 * Get all staged records for a migration+object with a given status.
 */
export async function getByStatus(
  migrationId,
  objectType,
  status,
  { limit = 100, skip = 0 } = {}
) {
  return StagedRecord.find({ migrationId, objectType, status })
    .sort({ createdAt: 1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

/**
 * Get staging stats for a migration.
 */
export async function getStagingStats(migrationId) {
  const pipeline = [
    { $match: { migrationId: new mongoose.Types.ObjectId(migrationId) } },
    {
      $group: {
        _id: { objectType: '$objectType', status: '$status' },
        count: { $sum: 1 },
      },
    },
  ];
  const results = await StagedRecord.aggregate(pipeline);
  const stats = {};
  for (const row of results) {
    const { objectType, status } = row._id;
    if (!stats[objectType]) stats[objectType] = {};
    stats[objectType][status] = row.count;
  }
  return stats;
}

/**
 * Count staged records for a migration and object type.
 */
export async function countStaged(migrationId, objectType) {
  return StagedRecord.countDocuments({ migrationId, objectType });
}

/**
 * Get failed records for retry.
 */
export async function getFailedRecords(migrationId, objectType, limit = 100) {
  return StagedRecord.find({
    migrationId,
    objectType,
    status: 'failed',
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
}

/**
 * Purge staged data for a migration (for rollback or manual cleanup).
 */
export async function purgeStaged(migrationId) {
  return StagedRecord.deleteMany({ migrationId });
}

/**
 * Update retention expiry for all records in a migration.
 */
export async function updateRetention(migrationId, retentionDays) {
  const expiresAt = computeExpiry(retentionDays);
  return StagedRecord.updateMany({ migrationId }, { expiresAt });
}
