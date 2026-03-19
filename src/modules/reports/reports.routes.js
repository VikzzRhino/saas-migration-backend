// src/modules/reports/reports.routes.js
import { Router } from 'express';
import apiKeyMiddleware from '../../middleware/apiKey.middleware.js';
import { listReports, getReport, exportReport } from './reports.controller.js';

const router = Router();

router.get('/',           apiKeyMiddleware, listReports);
router.get('/:id/export', apiKeyMiddleware, exportReport);
router.get('/:id',        apiKeyMiddleware, getReport);

export default router;
