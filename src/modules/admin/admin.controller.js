// src/modules/admin/admin.controller.js
import axios from 'axios';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllPages(client, endpoint, dataKey) {
  const items = [];
  let page = 1;
  while (true) {
    try {
      const res = await client.get(endpoint, { params: { per_page: 100, page } });
      const data = res.data[dataKey] ?? [];
      items.push(...data);
      if (data.length < 100) break;
      page++;
      await delay(800);
    } catch {
      break;
    }
  }
  return items;
}

async function deleteAllItems(client, endpoint, items) {
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  console.log(`[cleanup] Deleting ${items.length} items from ${endpoint}`);
  for (const item of items) {
    try {
      await client.delete(`${endpoint}/${item.id}`);
      deleted++;
      if (deleted % 10 === 0) console.log(`[cleanup] ${endpoint} — deleted ${deleted}/${items.length}`);
      await delay(750);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        deleted++;
      } else if (status === 403 || status === 405) {
        skipped++;
      } else {
        failed++;
        console.error(`Failed ${endpoint}/${item.id}:`, err.response?.data?.message ?? err.message);
      }
    }
  }
  console.log(`[cleanup] Done ${endpoint}: deleted=${deleted} failed=${failed} skipped=${skipped}`);
  return { total: items.length, deleted, failed, skipped };
}

async function hardDeleteRequesters(client, items) {
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  console.log(`[cleanup] Hard-deleting ${items.length} requesters`);
  for (const item of items) {
    try {
      await client.delete(`/api/v2/requesters/${item.id}`);
      await delay(400);
      await client.delete(`/api/v2/requesters/${item.id}/forget`);
      deleted++;
      await delay(750);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        deleted++;
      } else if (status === 403 || status === 405) {
        skipped++;
      } else {
        failed++;
        console.error(`Requester ${item.id} failed:`, err.response?.data?.message ?? err.message);
      }
    }
  }
  console.log(`[cleanup] Requesters done: deleted=${deleted} failed=${failed} skipped=${skipped}`);
  return { total: items.length, deleted, failed, skipped };
}

/**
 * POST /api/admin/cleanup-freshservice
 * Wipes all tickets, changes, problems, KB, requesters, departments.
 * Never deletes agents.
 * Body: { domain: string, apiKey: string }
 */
export async function cleanupFreshservice(req, res) {
  const { domain, apiKey } = req.body;

  if (!domain || !apiKey) {
    return res.status(400).json({ message: 'domain and apiKey are required' });
  }

  const client = axios.create({
    baseURL: `https://${domain}.freshservice.com`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:X`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  try {
    await client.get('/api/v2/agents/me');
  } catch {
    return res.status(401).json({ message: 'Invalid Freshservice credentials' });
  }

  const results = {};

  console.log('[cleanup] Starting Freshservice wipe...');

  try {
    console.log('[cleanup] Fetching tickets...');
    const tickets = await fetchAllPages(client, '/api/v2/tickets', 'tickets');
    results.tickets = await deleteAllItems(client, '/api/v2/tickets', tickets);

    await delay(3000);

    console.log('[cleanup] Fetching changes...');
    const changes = await fetchAllPages(client, '/api/v2/changes', 'changes');
    results.changes = await deleteAllItems(client, '/api/v2/changes', changes);

    console.log('[cleanup] Fetching problems...');
    const problems = await fetchAllPages(client, '/api/v2/problems', 'problems');
    results.problems = await deleteAllItems(client, '/api/v2/problems', problems);

    console.log('[cleanup] Fetching KB articles...');
    const articles = await fetchAllPages(client, '/api/v2/solutions/articles', 'articles');
    results.articles = await deleteAllItems(client, '/api/v2/solutions/articles', articles);

    console.log('[cleanup] Fetching KB folders...');
    const folders = await fetchAllPages(client, '/api/v2/solutions/folders', 'folders');
    results.folders = await deleteAllItems(client, '/api/v2/solutions/folders', folders);

    console.log('[cleanup] Fetching KB categories...');
    const categories = await fetchAllPages(client, '/api/v2/solutions/categories', 'categories');
    results.categories = await deleteAllItems(client, '/api/v2/solutions/categories', categories);

    console.log('[cleanup] Fetching requesters...');
    const requesters = await fetchAllPages(client, '/api/v2/requesters', 'requesters');
    const deletable = requesters.filter(
      (r) =>
        r.primary_email !== 'system@freshservice.com' &&
        !r.primary_email?.endsWith('@freshworks.com') &&
        !r.is_agent,
    );

    const firstPass = await hardDeleteRequesters(client, deletable);
    if (firstPass.failed > 0) {
      await delay(5000);
      const retryItems = deletable.slice(firstPass.deleted);
      const secondPass = await hardDeleteRequesters(client, retryItems);
      results.requesters = {
        total: firstPass.total,
        deleted: firstPass.deleted + secondPass.deleted,
        failed: secondPass.failed,
        skipped: (firstPass.skipped ?? 0) + (secondPass.skipped ?? 0),
      };
    } else {
      results.requesters = firstPass;
    }

    console.log('[cleanup] Fetching departments...');
    const depts = await fetchAllPages(client, '/api/v2/departments', 'departments');
    results.departments = await deleteAllItems(client, '/api/v2/departments', depts);

    console.log('[cleanup] ✅ Wipe complete:', JSON.stringify(results, null, 2));
    return res.json({ success: true, message: 'Freshservice data wiped successfully', results });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: `Cleanup failed: ${err.message}`, results });
  }
}
