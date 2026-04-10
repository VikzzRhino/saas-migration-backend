import { Router } from 'express';
import {
  createMigration,
  getMigrations,
  getMigration,
  updateMigration,
  deleteMigration,
  getDashboardStats,
  fetchFreshserviceWorkspaces,
  verifySource,
  verifyTarget,
  preflightEstimate,
  startMigration,
  pauseMigration,
  getMigrationStatus,
  retryFailed,
  postflightCheck,
  rollbackMigration,
  runObject,
  sampleData,
  fetchWorkspace,
  getWorkspace,
  fetchSourceMetadata,
  getSourceMetadata,
  fetchSourceSchemas,
  getFieldSchemas,
  generateMappings,
  getFieldMappings,
  updateFieldMappings,
  getValueMappings,
  updateValueMappings,
  updateBulkValueMappings,
  getAgentMatching,
  fetchAndAutoMatchAgents,
  updateAgentMatching,
  getGroupMapping,
  autoMatchGroups,
  updateGroupMapping,
  getStagingStats,
  getStagedRecords,
  updateRetentionPolicy,
  getMigrationReadiness,
} from './migration.controller.js';
import apiKeyMiddleware from '../../middleware/apiKey.middleware.js';

const router = Router();

// Dashboard
router.get('/dashboard', apiKeyMiddleware, getDashboardStats);

// Freshservice workspaces (before creating a migration)
router.post('/workspaces', apiKeyMiddleware, fetchFreshserviceWorkspaces);

// CRUD
router.post('/', apiKeyMiddleware, createMigration);
router.get('/', apiKeyMiddleware, getMigrations);
router.get('/:id', apiKeyMiddleware, getMigration);
router.put('/:id', apiKeyMiddleware, updateMigration);
router.delete('/:id', apiKeyMiddleware, deleteMigration);

// Connection verification
router.post('/:id/verify-source', apiKeyMiddleware, verifySource);
router.post('/:id/verify-target', apiKeyMiddleware, verifyTarget);

// Workspace — fetch target platform metadata before mapping
router.post('/:id/fetch-workspace', apiKeyMiddleware, fetchWorkspace);
router.get('/:id/workspace', apiKeyMiddleware, getWorkspace);

// Source metadata — fetch SN groups, categories before mapping
router.post(
  '/:id/fetch-source-metadata',
  apiKeyMiddleware,
  fetchSourceMetadata
);
router.get('/:id/source-metadata', apiKeyMiddleware, getSourceMetadata);

// Field schemas — pull source fields and view target schemas
router.post('/:id/fetch-source-schemas', apiKeyMiddleware, fetchSourceSchemas);
router.get('/:id/field-schemas', apiKeyMiddleware, getFieldSchemas);

// Field mappings — auto-generate and customize per object
router.post('/:id/generate-mappings', apiKeyMiddleware, generateMappings);
router.get('/:id/field-mappings', apiKeyMiddleware, getFieldMappings);
router.put('/:id/field-mappings', apiKeyMiddleware, updateFieldMappings);

// Value mappings — configurable enum/select value transforms
router.get('/:id/value-mappings', apiKeyMiddleware, getValueMappings);
router.put('/:id/value-mappings', apiKeyMiddleware, updateValueMappings);
router.put(
  '/:id/value-mappings/bulk',
  apiKeyMiddleware,
  updateBulkValueMappings
);

// Agent matching — SN admins ↔ FS agents
router.get('/:id/agent-matching', apiKeyMiddleware, getAgentMatching);
router.post(
  '/:id/agent-matching/auto',
  apiKeyMiddleware,
  fetchAndAutoMatchAgents
);
router.put('/:id/agent-matching', apiKeyMiddleware, updateAgentMatching);

// Group mapping — SN assignment groups ↔ FS groups
router.get('/:id/group-mapping', apiKeyMiddleware, getGroupMapping);
router.post('/:id/group-mapping/auto', apiKeyMiddleware, autoMatchGroups);
router.put('/:id/group-mapping', apiKeyMiddleware, updateGroupMapping);

// Staging / data retention
router.get('/:id/staging/stats', apiKeyMiddleware, getStagingStats);
router.get('/:id/staging/records', apiKeyMiddleware, getStagedRecords);
router.put('/:id/retention-policy', apiKeyMiddleware, updateRetentionPolicy);

// Migration lifecycle
router.get('/:id/preflight', apiKeyMiddleware, preflightEstimate);
router.get('/:id/readiness', apiKeyMiddleware, getMigrationReadiness);
router.post('/:id/start', apiKeyMiddleware, startMigration);
router.post('/:id/run-object', apiKeyMiddleware, runObject);
router.post('/:id/pause', apiKeyMiddleware, pauseMigration);
router.get('/:id/status', apiKeyMiddleware, getMigrationStatus);
router.post('/:id/retry-failed', apiKeyMiddleware, retryFailed);
router.post('/:id/rollback', apiKeyMiddleware, rollbackMigration);
router.get('/:id/postflight', apiKeyMiddleware, postflightCheck);
router.get('/:id/sample', apiKeyMiddleware, sampleData);

export default router;
