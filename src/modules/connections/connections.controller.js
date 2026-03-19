// src/modules/connections/connections.controller.js
import axios from 'axios';
import Connection from './connection.model.js';

const REQUIRED_FIELDS = {
  servicenow: ['instanceUrl', 'username', 'password'],
  freshservice: ['domain', 'apiKey'],
};

function validateCredentials(platform, credentials) {
  const required = REQUIRED_FIELDS[platform] ?? [];
  const missing = required.filter((f) => !credentials?.[f]);
  return missing.length ? `Missing credential fields: ${missing.join(', ')}` : null;
}

/**
 * GET /api/connections
 * List all connections for the current tenant (credentials masked).
 */
export async function listConnections(req, res) {
  try {
    const connections = await Connection.find(
      { tenantId: req.tenant._id },
      '-__v'
    ).sort({ createdAt: -1 });
    return res.json(connections.map((c) => c.toSafeObject()));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/connections
 * Create a new connection. Credentials are encrypted via pre-save hook.
 */
export async function createConnection(req, res) {
  try {
    const { name, platform, credentials } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!['servicenow', 'freshservice'].includes(platform))
      return res.status(400).json({ error: 'platform must be servicenow or freshservice' });

    const credError = validateCredentials(platform, credentials);
    if (credError) return res.status(400).json({ error: credError });

    const connection = await Connection.create({
      tenantId: req.tenant._id,
      name,
      platform,
      credentials,
    });

    return res.status(201).json(connection.toSafeObject());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * PUT /api/connections/:id
 * Update name and/or credentials. Re-encrypts credentials if provided.
 */
export async function updateConnection(req, res) {
  try {
    const connection = await Connection.findOne({
      _id: req.params.id,
      tenantId: req.tenant._id,
    });
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const { name, credentials } = req.body;

    if (name !== undefined) connection.name = name;

    if (credentials !== undefined) {
      const credError = validateCredentials(connection.platform, credentials);
      if (credError) return res.status(400).json({ error: credError });
      // Merge so partial updates (e.g. only password) are supported
      connection.credentials = { ...connection.credentials, ...credentials };
      // Strip encryption markers so the pre-save hook re-encrypts cleanly
      const sensitiveField = connection.platform === 'servicenow' ? 'password' : 'apiKey';
      if (credentials[sensitiveField]) {
        connection.credentials[sensitiveField] = credentials[sensitiveField];
      }
      connection.markModified('credentials');
    }

    await connection.save();
    return res.json(connection.toSafeObject());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /api/connections/:id
 */
export async function deleteConnection(req, res) {
  try {
    const connection = await Connection.findOne({
      _id: req.params.id,
      tenantId: req.tenant._id,
    });
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    await connection.deleteOne();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/connections/:id/test
 * Verifies connectivity using decrypted credentials.
 */
export async function testConnection(req, res) {
  try {
    const connection = await Connection.findOne({
      _id: req.params.id,
      tenantId: req.tenant._id,
    });
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const creds = connection.getDecryptedCredentials();
    const testedAt = new Date();
    let success = false;
    let errorMessage = null;

    try {
      if (connection.platform === 'servicenow') {
        await axios.get(
          `${creds.instanceUrl}/api/now/table/sys_user?sysparm_limit=1`,
          { auth: { username: creds.username, password: creds.password } }
        );
      } else {
        await axios.get(
          `https://${creds.domain}.freshservice.com/api/v2/agents?per_page=1`,
          { auth: { username: creds.apiKey, password: 'X' } }
        );
      }
      success = true;
    } catch (err) {
      errorMessage =
        err.response
          ? `HTTP ${err.response.status}: ${err.response.statusText}`
          : err.message;
    }

    await Connection.findByIdAndUpdate(connection._id, {
      lastTestedAt: testedAt,
      lastTestStatus: success ? 'success' : 'failed',
      lastTestError: success ? null : errorMessage,
    });

    return res.json({
      success,
      testedAt,
      ...(errorMessage && { error: errorMessage }),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
