// src/modules/admin/admin.routes.js
import { Router } from 'express';
import apiKeyMiddleware from '../../middleware/apiKey.middleware.js';
import { cleanupFreshservice } from './admin.controller.js';

const router = Router();

router.post('/cleanup-freshservice', apiKeyMiddleware, cleanupFreshservice);

export default router;
