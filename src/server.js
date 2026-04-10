import 'dotenv/config';
import mongoService from '../db-services/mongo-service.js';
import redisService from '../db-services/redis-service.js';
import Migration from './modules/migration/migration.model.js';
import app from './app.js';

const PORT = process.env.PORT || 7070;

await mongoService.connect();
await Migration.updateMany({ status: 'running' }, { status: 'paused' });

try {
  await redisService.connect();
} catch (err) {
  console.warn('⚠️ Redis unavailable, continuing without it:', err.message);
}

app.listen(PORT, () => {
  console.log('API is running');
  console.log('SaaS migration backend is all set and ready.');
});
