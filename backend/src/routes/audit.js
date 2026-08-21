import { Router } from 'express';
import { listAuditLogs } from '../lib/store.js';
import { requireRole } from '../lib/auth.js';

const router = Router();

// GET /api/audit — engineer-only read of the append-only action log, newest
// first. Optional filters: action (substring), actorEmail (substring),
// targetType (exact). Also returns the distinct action names so the frontend
// can build a filter dropdown from what actually happened.
router.get('/', requireRole('engineer','admin'), async (req, res) => {
  const all = await listAuditLogs();
  const { action, actorEmail, targetType, limit } = req.query;

  let rows = [...all].sort((a, b) => new Date(b.at) - new Date(a.at));

  if (action) rows = rows.filter((r) => r.action.toLowerCase().includes(String(action).toLowerCase()));
  if (actorEmail) rows = rows.filter((r) => (r.actorEmail || '').toLowerCase().includes(String(actorEmail).toLowerCase()));
  if (targetType) rows = rows.filter((r) => r.targetType === targetType);

  const capped = parseInt(limit, 10);
  if (Number.isFinite(capped) && capped > 0) rows = rows.slice(0, Math.min(capped, 2000));

  const actions = [...new Set(all.map((r) => r.action))].sort();
  res.json({ rows, actions });
});

export default router;