import 'dotenv/config';
import mongoService from '../db-services/mongo-service.js';
import redisService from '../db-services/redis-service.js';
import app from './app.js';

const PORT = process.env.PORT || 7070;

await mongoService.connect();

try {
  await redisService.connect();
  await redisService.connectBullWorker();
} catch (err) {
  console.warn('⚠️ Redis unavailable, continuing without it:', err.message);
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
