import Tenant from '../modules/tenants/tenant.model.js';

export default async function apiKeyMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey)
    return res.status(401).json({ error: 'Missing x-api-key header' });

  const tenant = await Tenant.findOne({ apiKey });

  if (!tenant) return res.status(401).json({ error: 'Invalid API key' });

  req.tenant = tenant;
  next();
}
