import jwt from 'jsonwebtoken';
import User from './user.model.js';
import Tenant from '../tenants/tenant.model.js';

export async function protect(req, res, next) {
  const token = req.cookies?.access_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(userId).select('-password');
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;

    // Attach tenant + apiKey; auto-create tenant for legacy users without one
    if (user.tenantId) {
      req.tenant = await Tenant.findById(user.tenantId);
    } else {
      const tenant = await Tenant.create({ name: user.fullName || user.email });
      user.tenantId = tenant._id;
      await user.save();
      req.tenant = tenant;
    }
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please login again' });
  }
}
