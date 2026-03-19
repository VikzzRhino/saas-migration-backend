// src/modules/reports/reports.controller.js
import Migration from '../migration/migration.model.js';

const STAT_KEYS = [
  'companies', 'users', 'admins', 'incidents', 'changes', 'problems',
  'kb_categories', 'kb_folders', 'kb_articles', 'comments', 'attachments', 'tasks',
];

function sumStats(stats) {
  const out = { total: 0, success: 0, failed: 0, skipped: 0 };
  for (const key of STAT_KEYS) {
    const s = stats?.[key];
    if (!s) continue;
    out.total   += s.total   ?? 0;
    out.success += s.success ?? 0;
    out.failed  += s.failed  ?? 0;
    out.skipped += s.skipped ?? 0;
  }
  return out;
}

function buildReport(m) {
  const { total, success, failed, skipped } = sumStats(m.stats);
  const duration =
    m.completedAt && m.startedAt
      ? Math.round((new Date(m.completedAt) - new Date(m.startedAt)) / 1000)
      : null;
  return {
    id:          m._id,
    name:        m.name,
    status:      m.status,
    source:      m.source?.system,
    target:      m.target?.system,
    startedAt:   m.startedAt,
    completedAt: m.completedAt,
    createdAt:   m.createdAt,
    duration,
    stats:       { total, success, failed, skipped },
    objectStats: m.stats,
    errorCount:  m.errorLog?.length ?? 0,
    successRate: total > 0 ? Math.round((success / total) * 100) : 0,
  };
}

const LIST_PROJECTION =
  '_id name status stats startedAt completedAt createdAt source target objectConfig errorLog';

export async function listReports(req, res) {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const { status, search } = req.query;

    const filter = { tenantId: req.tenant._id };
    if (status) filter.status = status;
    if (search) filter.name = { $regex: search, $options: 'i' };

    const [migrations, total] = await Promise.all([
      Migration.find(filter, LIST_PROJECTION)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Migration.countDocuments(filter),
    ]);

    res.json({
      data:       migrations.map(buildReport),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getReport(req, res) {
  try {
    const m = await Migration.findOne(
      { _id: req.params.id, tenantId: req.tenant._id },
      LIST_PROJECTION + ' postflight'
    ).lean();

    if (!m) return res.status(404).json({ error: 'Report not found' });

    const report = buildReport(m);
    report.errorLog   = m.errorLog ?? [];
    report.postflight = m.postflight ?? null;

    const objectStats = {};
    for (const key of STAT_KEYS) {
      const s = m.stats?.[key];
      if (!s) continue;
      objectStats[key] = {
        ...s,
        successRate: s.total > 0 ? Math.round((s.success / s.total) * 100) : 0,
      };
    }
    report.objectStats = objectStats;

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function exportReport(req, res) {
  try {
    const m = await Migration.findOne(
      { _id: req.params.id, tenantId: req.tenant._id },
      'errorLog'
    ).lean();

    if (!m) return res.status(404).json({ error: 'Report not found' });

    const escape = (v) => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    let csv = 'Timestamp,Object,Record ID,Status,Error Message\n';
    for (const e of m.errorLog ?? []) {
      csv += [e.timestamp, e.object, e.snowId, e.status, e.error].map(escape).join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="migration-${req.params.id}-errors.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
