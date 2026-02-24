import { z } from 'zod';
import Migration from './migration.model.js';
import { createConnector } from '../connectors/connector.factory.js';

const createMigrationSchema = z.object({
  source: z.object({
    system: z.string(),
    credentials: z.record(z.string(), z.any()),
  }),
  target: z.object({
    system: z.string(),
    credentials: z.record(z.string(), z.any()),
  }),
});

export async function createMigration(req, res) {
  const parsed = createMigrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const migration = await Migration.create({
    tenantId: req.tenant._id,
    source: parsed.data.source,
    target: parsed.data.target,
  });

  res.status(201).json(migration);
}

export async function getMigrations(req, res) {
  const migrations = await Migration.find({ tenantId: req.tenant._id }).sort({ createdAt: -1 });
  res.json(migrations);
}

export async function getMigration(req, res) {
  const migration = await Migration.findOne({ _id: req.params.id, tenantId: req.tenant._id });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });
  res.json(migration);
}

export async function verifySource(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const connector = createConnector(migration.source.system, migration.source.credentials);
  const data = await connector.fetchIncidents(5);

  res.json({ success: true, sample: data });
}

export async function verifyTarget(req, res) {
  const migration = await Migration.findOne({
    _id: req.params.id,
    tenantId: req.tenant._id,
  });
  if (!migration) return res.status(404).json({ error: 'Migration not found' });

  const connector = createConnector(migration.target.system, migration.target.credentials);
  const ticket = await connector.createTicket({
    subject: 'Connectivity Verification',
    description: 'Verifying target connection from migration tool',
  });

  res.json({ success: true, ticket });
}
