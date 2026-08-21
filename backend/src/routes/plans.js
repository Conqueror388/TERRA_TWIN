import { Router } from 'express';
import { savePlan, listPlans, getPlan, updatePlan, deletePlan } from '../lib/store.js';
import { requireAuth } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';

const router = Router();

// POST /api/plans — a worker saves a planned dig for engineer review.
// Body: { name, excavation: { point:{lat,lng}, depth, width, length, purpose }, result }
router.post('/', requireAuth, async (req, res) => {
  const { name, excavation, result } = req.body || {};
  const point = excavation?.point;
  if (!excavation || !point || typeof point.lat !== 'number' || typeof point.lng !== 'number') {
    return res.status(400).json({ error: 'excavation.point (lat/lng) is required.' });
  }

  const plan = await savePlan({
    name: String(name || 'Untitled plan').slice(0, 120),
    ts: Date.now(),
    reviewStatus: 'PENDING',
    creatorId: req.user.sub,
    creatorName: req.user.name,
    excavation: {
      point: { lat: point.lat, lng: point.lng },
      depth: excavation.depth ?? null,
      width: excavation.width ?? null,
      length: excavation.length ?? null,
      purpose: excavation.purpose || null,
    },
    result:
      result && typeof result.overall === 'number'
        ? { overall: result.overall, level: result.level || null }
        : null,
    reviewedBy: null,
    reviewedAt: null,
  });

  logAction(req, {
    action: 'PLAN.CREATE',
    targetType: 'plan',
    targetId: plan.id,
    detail: `Plan "${plan.name}" saved by ${req.user.name} at ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`,
  });

  res.status(201).json(plan);
});

// GET /api/plans — the shared review queue, newest first.
router.get('/', requireAuth, async (req, res) => {
  const plans = await listPlans();
  res.json(plans.sort((a, b) => new Date(b.ts) - new Date(a.ts)));
});

// PATCH /api/plans/:id — engineer sets reviewStatus APPROVED/REJECTED.
router.patch('/:id', requireAuth, async (req, res) => {
  const { reviewStatus } = req.body || {};
  if (!['APPROVED', 'REJECTED'].includes(reviewStatus)) {
    return res.status(400).json({ error: 'reviewStatus must be APPROVED or REJECTED.' });
  }

  const plan = await getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  if ((plan.reviewStatus || 'PENDING') !== 'PENDING') {
    return res.status(409).json({ error: `Plan is already ${plan.reviewStatus}.` });
  }

  const updated = await updatePlan(plan.id, {
    reviewStatus,
    reviewedBy: req.user.name,
    reviewedAt: new Date().toISOString(),
  });

  logAction(req, {
    action: 'PLAN.REVIEW',
    targetType: 'plan',
    targetId: plan.id,
    detail: `Plan "${plan.name}" ${reviewStatus.toLowerCase()} by ${req.user.name} (created ${plan.creatorName || '—'}@${new Date(plan.ts).toLocaleString()})`,
  });

  res.json(updated);
});

// DELETE /api/plans/:id — the creating worker or an admin may remove a plan.
router.delete('/:id', requireAuth, async (req, res) => {
  const plan = await getPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });

  const isOwner = plan.creatorId === req.user.sub;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Only the plan creator or an administrator can delete this plan.' });
  }

  await deletePlan(plan.id);
  logAction(req, {
    action: 'PLAN.DELETE',
    targetType: 'plan',
    targetId: plan.id,
    detail: `Plan "${plan.name}" deleted by ${req.user.name}`,
  });
  res.json({ ok: true, id: plan.id });
});

export default router;