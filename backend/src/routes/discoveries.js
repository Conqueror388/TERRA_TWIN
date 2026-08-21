import { Router } from 'express';
import {
  saveDiscoveryReport,
  listDiscoveryReports,
  getDiscoveryReport,
  updateDiscoveryReport,
  addApprovedUtility,
  saveRegistryHistory,
} from '../lib/store.js';
import { verifyDiscovery } from '../lib/aiVerification.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';

const router = Router();

const TYPE_COLOR = { water: '#4FD1E8', electric: '#F5A623', fiber: '#B58CFF', gas: '#E4483C', sewer: '#8CA3BF' };

// POST /api/discoveries — worker reports a new/unrecorded utility (Phase 12).
// Status starts PENDING REVIEW. AI verification is a separate step
// (POST /:id/verify) and only an engineer approval writes it into the
// utility database (Phase 15) — the AI never does this on its own.
router.post('/', requireAuth, async (req, res) => {
  const { utilityType, estimatedDepth, latitude, longitude, notes, photoUrl } = req.body || {};

  if (!utilityType || typeof estimatedDepth !== 'number' || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'utilityType, estimatedDepth, latitude, and longitude are required.' });
  }

  const record = await saveDiscoveryReport({
    utilityType,
    estimatedDepth,
    latitude,
    longitude,
    notes: notes || '',
    photoUrl: photoUrl || null,
    reportedBy: req.user.name,
    reportedAt: new Date().toISOString(),
  });

  logAction(req, {
    action: 'DISCOVERY.REPORT',
    targetType: 'discovery',
    targetId: record.id,
    detail: `${utilityType} @ ${estimatedDepth}m reported at ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
  });

  res.status(201).json(record);
});

// GET /api/discoveries — requires authentication. Workers see all pending
// reports they can action in the field; engineers use this for the review queue.
// Unauthenticated access is blocked — this data contains infrastructure coords.
router.get('/', requireAuth, async (req, res) => {
  const reports = await listDiscoveryReports();
  // Workers only see their own reports; engineers/admins see all.
  if (req.user.role === 'worker') {
    return res.json(reports.filter((r) => r.reportedBy === req.user.name));
  }
  res.json(reports);
});

// POST /api/discoveries/:id/verify — Gemini reviews the report against the
// existing registry and attaches a confidence score (Phase 13). Advisory
// only; does not change approval status.
router.post('/:id/verify', requireRole('engineer', 'admin'), async (req, res) => {
  const report = await getDiscoveryReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Discovery report not found.' });

  const verification = await verifyDiscovery(report);
  const updated = await updateDiscoveryReport(report.id, {
    aiConfidence: verification.confidence,
    aiVerdict: verification.verdict,
    aiChecks: verification.checks,
    aiSource: verification.source,
    status: 'AI VERIFIED — PENDING ENGINEER REVIEW',
  });

  logAction(req, {
    action: 'DISCOVERY.AI_VERIFY',
    targetType: 'discovery',
    targetId: report.id,
    detail: `AI verified ${report.utilityType} report — confidence ${verification.confidence}%`,
  });

  res.json({ ...updated, nearestExisting: verification.nearestExisting });
});

// POST /api/discoveries/:id/approve — engineer approves the report; it
// becomes a real utility record (Phase 15) and the Digital Twin / risk
// engine will pick it up on the next /api/utilities fetch.
router.post('/:id/approve', requireRole('engineer', 'admin'), async (req, res) => {
  const report = await getDiscoveryReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Discovery report not found.' });

  const { owner, criticality } = req.body || {};

  const utility = await addApprovedUtility({
    type: report.utilityType,
    lat: report.latitude,
    lng: report.longitude,
    depth: report.estimatedDepth,
    owner: owner || 'Unverified owner — confirm on site',
    confidence: report.aiConfidence ?? 60,
    criticality: typeof criticality === 'number' ? criticality : 50,
    color: TYPE_COLOR[report.utilityType] || '#8CA3BF',
    sourceDiscoveryId: report.id,
  });

  const updated = await updateDiscoveryReport(report.id, {
    status: 'APPROVED',
    reviewedBy: req.user.name,
    reviewedAt: new Date().toISOString(),
    approvedUtilityId: utility.id,
  });

  await saveRegistryHistory({
    event: 'CREATED',
    utilityId: utility.id,
    utility: {
      id: utility.id,
      type: utility.type,
      lat: utility.lat,
      lng: utility.lng,
      depth: utility.depth,
      owner: utility.owner,
      confidence: utility.confidence,
      criticality: utility.criticality,
    },
    origin: 'discovery-approval',
    actor: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role },
    summary: `Utility ${utility.id} (${utility.type}) entered into the registry from discovery report ${report.id}`,
    meta: { sourceDiscoveryId: report.id },
  });

  logAction(req, {
    action: 'DISCOVERY.APPROVE',
    targetType: 'utility',
    targetId: utility.id,
    detail: `Engineer approved ${report.utilityType} report ${report.id} → utility ${utility.id} (owner: ${utility.owner})`,
  });

  res.json({ report: updated, utility });
});

// POST /api/discoveries/:id/reject — engineer rejects the report; no
// utility record is created.
router.post('/:id/reject', requireRole('engineer', 'admin'), async (req, res) => {
  const report = await getDiscoveryReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Discovery report not found.' });

  const { reason } = req.body || {};

  const updated = await updateDiscoveryReport(report.id, {
    status: 'REJECTED',
    reviewedBy: req.user.name,
    reviewedAt: new Date().toISOString(),
    rejectionReason: reason || '',
  });

  logAction(req, {
    action: 'DISCOVERY.REJECT',
    targetType: 'discovery',
    targetId: report.id,
    detail: `Engineer rejected ${report.utilityType} report — ${(reason || 'no reason given').slice(0, 120)}`,
  });

  res.json(updated);
});

export default router;
