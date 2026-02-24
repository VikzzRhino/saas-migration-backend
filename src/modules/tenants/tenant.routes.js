import { Router } from 'express';
import { createTenant, getTenant } from './tenant.controller.js';
import apiKeyMiddleware from '../../middleware/apiKey.middleware.js';

const router = Router();

router.post('/', createTenant);
router.get('/current', apiKeyMiddleware, getTenant);

export default router;
