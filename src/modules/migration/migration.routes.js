import { Router } from 'express';
import {
  createMigration,
  getMigrations,
  getMigration,
  verifySource,
  verifyTarget,
} from './migration.controller.js';
import apiKeyMiddleware from '../../middleware/apiKey.middleware.js';

const router = Router();

router.post('/', apiKeyMiddleware, createMigration);
router.get('/', apiKeyMiddleware, getMigrations);
router.get('/:id', apiKeyMiddleware, getMigration);
router.post('/:id/verify-source', apiKeyMiddleware, verifySource);
router.post('/:id/verify-target', apiKeyMiddleware, verifyTarget);

export default router;
