import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '../../logs/migrations');

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp }) => {
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
});

/**
 * Creates a dedicated winston logger for a migration run.
 * Writes to: logs/migrations/<migrationId>_<YYYY-MM-DD_HH-mm-ss>.log
 * Also streams to console.
 *
 * @param {string} migrationId
 * @returns {winston.Logger}
 */
export function createMigrationLogger(migrationId) {
  const now = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  const logFile = path.join(LOGS_DIR, `${migrationId}_${now}.log`);

  const logger = winston.createLogger({
    level: 'debug',
    format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
    transports: [
      new winston.transports.File({ filename: logFile }),
      new winston.transports.Console({
        format: combine(
          colorize(),
          timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          logFormat
        ),
      }),
    ],
  });

  logger.logFile = logFile;
  return logger;
}
