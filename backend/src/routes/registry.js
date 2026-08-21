import { Router } from 'express';
import { listRegistryHistory } from '../lib/store.js';
import { requireRole } from '../lib/auth.js';

const router = Router();

// GET /api/registry/history — the multi-year asset ledger: every record that
// entered or left the registry, newest first, with who did it and when.
// Engineer/admin only; used by the Registry History page. Filters: utilityId,
// kind (CREATED/DELETED/...), actor (matches name/email), limit.
router.get('/history', requireRole('engineer', 'admin'), async (req, res) => {
  const { utilityId, kind, actor, limit } = req.query;

  let rows = await listRegistryHistory();

  if (utilityId) rows = rows.filter((h) => h.utilityId === String(utilityId));
  if (kind) rows = rows.filter((h) => String(h.event).toUpperCase() === String(kind).toUpperCase());
  if (actor) {
    const q = String(actor).toLowerCase();
    rows = rows.filter(
      (h) =>
        (h.actor?.name || '').toLowerCase().includes(q) ||
        (h.actor?.email || '').toLowerCase().includes(q)
    );
  }

  if (limit) rows = rows.slice(0, Number(limit));

  const kinds = [...new Set(rows.map((h) => h.event))].sort();

  res.json({ rows, kinds, total: rows.length });
});

export default router;
