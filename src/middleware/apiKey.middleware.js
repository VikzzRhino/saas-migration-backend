import jwt from 'jsonwebtoken';
import Tenant from '../modules/tenants/tenant.model.js';
import User from '../modules/auth/user.model.js';

export default async function apiKeyMiddleware(req, res, next) {
  // Option 1: x-api-key header (for programmatic / Postman access)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const tenant = await Tenant.findOne({ apiKey });
    if (tenant) {
      req.tenant = tenant;
      return next();
    }
    // Do not fail immediately on stale API keys; browser sessions may still be valid via cookie auth.
  }

  // Option 2: JWT cookie (for browser / frontend access)
  const token = req.cookies?.access_token;
  if (token) {
    try {
      const { userId } = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(userId).select('tenantId');
      if (!user?.tenantId)
        return res
          .status(401)
          .json({ error: 'No tenant linked to this account' });
      const tenant = await Tenant.findById(user.tenantId);
      if (!tenant) return res.status(401).json({ error: 'Tenant not found' });
      req.tenant = tenant;
      return next();
    } catch {
      // If both auth methods are present and invalid, prefer explicit API key error.
      if (apiKey) return res.status(401).json({ error: 'Invalid API key' });
      return res
        .status(401)
        .json({ error: 'Session expired, please login again' });
    }
  }

  if (apiKey) return res.status(401).json({ error: 'Invalid API key' });
  return res.status(401).json({ error: 'Authentication required' });
}
