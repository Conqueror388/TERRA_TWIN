import { Router } from 'express';
import { scoreExcavation, generateRecommendations } from '../lib/riskEngine.js';
import { liveUtilitiesNear } from '../lib/liveUtilities.js';
import { saveExcavation, listExcavations, updateExcavation, saveRiskAssessment, listLocateRequests } from '../lib/store.js';
import { requireAuth } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';
import { GATE_RADIUS_M } from './locateRequests.js';

const router = Router();

// Strip null bytes and C0 control characters from free-text input before
// storing. Prevents null-byte injection and unexpected rendering in PDF/CSV
// exports. Trims to the specified max length after sanitization.
function sanitizeStr(value, maxLen = 300) {
  if (!value) return '';
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

// POST /api/excavations/analyze
// Body: { latitude, longitude, depth, width, length, purpose }
// requireAuth: blocks unauthenticated coordinate-scanning attacks that could
// reverse-engineer the utility registry by querying hundreds of coordinates.
router.post('/analyze', requireAuth, async (req, res) => {
  const { latitude, longitude, depth, width, length, purpose } = req.body || {};

  if (typeof latitude !== 'number' || typeof longitude !== 'number' || typeof depth !== 'number') {
    return res.status(400).json({ error: 'latitude, longitude, and depth are required numbers.' });
  }
  const safePurpose = sanitizeStr(purpose, 200);

  const nearbyUtilities = await liveUtilitiesNear(latitude, longitude, 150);

  const excavation = { point: { lat: latitude, lng: longitude }, depth, width, length, purpose };
  const result = scoreExcavation(excavation, nearbyUtilities);
  const recommendations = generateRecommendations(excavation, nearbyUtilities);
  const digSafeScore = Math.round(result.overall);
  const topRecommendation = recommendations[0]
    ? { label: recommendations[0].label, score: Math.round(recommendations[0].overall), level: recommendations[0].level }
    : null;

  // Log every analysis (not just started excavations) so Analytics reflects
  // real usage — "excavations analyzed this month", the real risk-level mix,
  // and how often a high-risk plan had a safer alternative available.
  saveRiskAssessment({
    latitude,
    longitude,
    depth,
    purpose: purpose || null,
    digSafeScore,
    riskLevel: result.level,
    topRecommendation,
    analyzedAt: new Date().toISOString(),
  }).catch((err) => console.warn('[risk_assessments] failed to log analysis:', err.message));

  logAction(req, {
    action: 'RISK.ANALYZE',
    targetType: 'analysis',
    detail: `DigSafe score ${digSafeScore} (${result.level}) for ${latitude.toFixed(6)}, ${longitude.toFixed(6)} @ ${depth}m — ${nearbyUtilities.length} real utility record(s) near site`,
  });

  res.json({
    digSafeScore,
    riskLevel: result.level,
    breakdown: result.results.map((r) => ({
      utilityId: r.utility.id,
      type: r.utility.type,
      lat: r.utility.lat,
      lng: r.utility.lng,
      depth: r.utility.depth,
      color: r.utility.color,
      source: r.utility.source || 'registry',
      name: r.utility.name || null,
      score: Math.round(r.score),
      level: r.level,
      distanceMeters: Number(r.dist.toFixed(2)),
      depthDifferenceMeters: Number(r.depthDiff.toFixed(2)),
    })),
    recommendations: recommendations.slice(0, 5).map((c) => ({
      label: c.label,
      score: Math.round(c.overall),
      level: c.level,
    })),
  });
});

// POST /api/excavations — start a live excavation record (Phase 11)
//
// Gated on a locate request: real excavation safety comes from calling
// 811/one-call before digging, not from this app's simulated utility score.
// A dig can only start once a locate request covering this location has been
// CONFIRMED (the real locate service came out and marked/cleared the site)
// or an engineer has logged an OVERRIDDEN justification. The DigSafe score
// is still recorded, but it never authorizes a dig on its own.
router.post('/', requireAuth, async (req, res) => {
  const { latitude, longitude, plannedDepth, riskScore } = req.body || {};

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'latitude and longitude are required numbers.' });
  }

  const allRequests = await listLocateRequests();
  const gating = allRequests
    .filter((r) => (r.status === 'CONFIRMED' || r.status === 'OVERRIDDEN'))
    .filter((r) => {
      const dLat = (r.latitude - latitude) * 111000;
      const dLng = (r.longitude - longitude) * 111000 * Math.cos(latitude * Math.PI / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng) <= GATE_RADIUS_M;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (!gating) {
    return res.status(403).json({
      error: 'No confirmed locate request for this location. File a locate request and get it confirmed (or have an engineer log an override) before starting excavation.',
      code: 'LOCATE_REQUEST_REQUIRED',
    });
  }

  const record = await saveExcavation({
    worker: req.user.name,
    status: 'active',
    latitude,
    longitude,
    plannedDepth,
    riskScore,
    locateRequestId: gating.id,
    locateStatus: gating.status,
    startTime: new Date().toISOString(),
  });

  logAction(req, {
    action: 'EXCAVATION.START',
    targetType: 'excavation',
    targetId: record.id,
    detail: `Dig started by ${req.user.name} at ${latitude.toFixed(6)}, ${longitude.toFixed(6)} — gated on locate request ${gating.id} (${gating.status})`,
  });

  res.status(201).json(record);
});

// GET /api/excavations — list active/past excavations for the dashboard
router.get('/', async (req, res) => {
  res.json(await listExcavations());
});

// PATCH /api/excavations/:id — update status/progress for live monitoring
// (Phase 11). Workers mark COMPLETE, or the dashboard can push a progress %.
router.patch('/:id', async (req, res) => {
  const { status, progressPercent } = req.body || {};
  const patch = {};
  if (status) patch.status = status;
  if (typeof progressPercent === 'number') patch.progressPercent = progressPercent;
  if (status === 'completed') patch.endTime = new Date().toISOString();

  const updated = await updateExcavation(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Excavation not found.' });
  res.json(updated);
});

export default router;
