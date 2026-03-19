// src/modules/connections/connections.routes.js
import { Router } from 'express';
import apiKeyMiddleware from '../../middleware/apiKey.middleware.js';
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
} from './connections.controller.js';

const router = Router();

router.get('/', apiKeyMiddleware, listConnections);
router.post('/', apiKeyMiddleware, createConnection);
router.put('/:id', apiKeyMiddleware, updateConnection);
router.delete('/:id', apiKeyMiddleware, deleteConnection);
router.post('/:id/test', apiKeyMiddleware, testConnection);

export default router;
