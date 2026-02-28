import 'dotenv/config';
import mongoService from '../db-services/mongo-service.js';
import redisService from '../db-services/redis-service.js';
import { startMigrationWorker } from './modules/migration/worker/migration.worker.js';

await mongoService.connect();
await redisService.connect();
await redisService.connectBullWorker();

startMigrationWorker();
console.log('⚙️  Worker process running');
