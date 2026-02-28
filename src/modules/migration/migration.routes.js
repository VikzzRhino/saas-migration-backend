import { Router } from 'express';
import {
  createMigration,
  getMigrations,
  getMigration,
  verifySource,
  verifyTarget,
  preflightEstimate,
  startMigration,
  pauseMigration,
  getMigrationStatus,
  retryFailed,
  postflightCheck,
  rollbackMigration,
  sampleData,
} from './migration.controller.js';
import apiKeyMiddleware from '../../middleware/apiKey.middleware.js';

const router = Router();

router.post('/', apiKeyMiddleware, createMigration);
router.get('/', apiKeyMiddleware, getMigrations);
router.get('/:id', apiKeyMiddleware, getMigration);
router.post('/:id/verify-source', apiKeyMiddleware, verifySource);
router.post('/:id/verify-target', apiKeyMiddleware, verifyTarget);
router.get('/:id/preflight', apiKeyMiddleware, preflightEstimate);
router.post('/:id/start', apiKeyMiddleware, startMigration);
router.post('/:id/pause', apiKeyMiddleware, pauseMigration);
router.get('/:id/status', apiKeyMiddleware, getMigrationStatus);
router.post('/:id/retry-failed', apiKeyMiddleware, retryFailed);
router.post('/:id/rollback', apiKeyMiddleware, rollbackMigration);
router.get('/:id/postflight', apiKeyMiddleware, postflightCheck);
router.get('/:id/sample', apiKeyMiddleware, sampleData);

export default router;
