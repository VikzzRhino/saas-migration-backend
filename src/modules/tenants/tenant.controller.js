import Tenant from './tenant.model.js';

export async function createTenant(req, res) {
  const tenant = await Tenant.create({ name: req.body.name });
  res.status(201).json(tenant);
}

export async function getTenant(req, res) {
  res.json(req.tenant);
}
