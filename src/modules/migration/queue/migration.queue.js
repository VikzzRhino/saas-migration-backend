import { Queue } from 'bullmq';
import redisService from '../../../../db-services/redis-service.js';

let migrationQueue;

export function getMigrationQueue() {
  if (!migrationQueue) {
    migrationQueue = new Queue('migration', {
      connection: redisService.getBullWorkerClient(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return migrationQueue;
}

export async function addMigrationJob(migrationId, objectConfig) {
  const queue = getMigrationQueue();
  const existing = await queue.getJob(`migration-${migrationId}`);
  if (existing) await existing.remove();
  return queue.add(
    'process-migration',
    { migrationId, objectConfig },
    { jobId: `migration-${migrationId}` }
  );
}

export async function addObjectJob(migrationId, object) {
  const queue = getMigrationQueue();
  const jobId = `migration-${migrationId}-${object}`;
  const existing = await queue.getJob(jobId);
  if (existing) await existing.remove();
  return queue.add(
    'process-object',
    { migrationId, object },
    { jobId }
  );
}
