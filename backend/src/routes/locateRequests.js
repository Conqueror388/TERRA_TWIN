import { Router } from 'express';
import {
  saveLocateRequest,
  listLocateRequests,
  getLocateRequest,
  updateLocateRequest,
} from '../lib/store.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { metersBetween } from '../lib/riskEngine.js';
import { logAction } from '../lib/audit.js';

const router = Router();

// A locate request "covers" a location if it was drafted within GATE_RADIUS_M
// of that point and is CONFIRMED or OVERRIDDEN. This is what
// POST /api/excavations checks before letting a dig start — see
// excavations.js. Radius is generous (excavation footprints move a little
// between planning and start) but not so wide it covers a different site.
export const GATE_RADIUS_M = 25;

function formatTicketBody(req) {
  const { latitude, longitude, depth, width, length, purpose, requestedBy } = req;
  const lines = [
    'CBuD LOCATE REQUEST — DRAFT',
    '(TerraTwin AI does not know what utilities are actually present at this',
    ' site. This draft exists so a real CBuD locate service can tell you.)',
    '',
    `Requested by: ${requestedBy || 'Unknown'}`,
    `Excavation location: ${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`,
    `Planned dig dimensions: ${width ?? '—'} m (W) x ${length ?? '—'} m (L) x ${depth ?? '—'} m (D)`,
    `Purpose of excavation: ${purpose || 'Not specified'}`,
    `Requested start: as soon as locate is confirmed`,
    '',
    'Submit this information to your local CBuD (Call Before u Dig) portal',
    '(Ministry of Communications / DoT right-of-way service) before excavation begins.',
    'Standard notice windows are typically 2-3 business days — confirm with',
    'your local CBuD portal.',
  ];
  return lines.join('\n');
}

// POST /api/locate-requests — draft a locate request from a planned excavation.
router.post('/', requireAuth, async (req, res) => {
  const { latitude, longitude, depth, width, length, purpose } = req.body || {};
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'latitude and longitude are required numbers.' });
  }

  const record = await saveLocateRequest({
    latitude,
    longitude,
    depth: depth ?? null,
    width: width ?? null,
    length: length ?? null,
    purpose: purpose || null,
    requestedBy: req.user.name,
    requestedByUserId: req.user.sub,
  });

  logAction(req, {
    action: 'LOCATE.DRAFT',
    targetType: 'locate_request',
    targetId: record.id,
    detail: `Locate request drafted by ${req.user.name} for ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
  });

  res.status(201).json({ ...record, ticketBody: formatTicketBody(record) });
});

// GET /api/locate-requests — list all, most recent first (for a dashboard / history view).
router.get('/', async (req, res) => {
  const all = await listLocateRequests();
  res.json([...all].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// GET /api/locate-requests/status?lat=&lng= — is there a request covering
// this location, and what state is it in? Frontend uses this to decide
// whether "Start excavation" should be enabled.
router.get('/status', async (req, res) => {
  const latitude = parseFloat(req.query.lat);
  const longitude = parseFloat(req.query.lng);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({ error: 'lat and lng query params are required.' });
  }
  const all = await listLocateRequests();
  const nearby = all
    .filter((r) => metersBetween({ lat: latitude, lng: longitude }, { lat: r.latitude, lng: r.longitude }) <= GATE_RADIUS_M)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const gating = nearby.find((r) => r.status === 'CONFIRMED' || r.status === 'OVERRIDDEN') || null;

  res.json({
    cleared: !!gating,
    gatingRequest: gating,
    nearby,
  });
});

// POST /api/locate-requests/:id/submit — mark as filed with the real one-call center.
router.post('/:id/submit', requireAuth, async (req, res) => {
  const record = await getLocateRequest(req.params.id);
  if (!record) return res.status(404).json({ error: 'Locate request not found.' });
  const updated = await updateLocateRequest(req.params.id, {
    status: 'SUBMITTED',
    submittedAt: new Date().toISOString(),
    ticketNumber: req.body?.ticketNumber || null,
  });
  logAction(req, {
    action: 'LOCATE.SUBMIT',
    targetType: 'locate_request',
    targetId: updated.id,
    detail: `Locate request ${updated.id} submitted to CBuD (ticket ${req.body?.ticketNumber || 'pending'})`,
  });
  res.json(updated);
});

// POST /api/locate-requests/:id/confirm — the locate service has come out and
// marked (or cleared) the site. This — not the DigSafe score — is what
// actually authorizes digging.
router.post('/:id/confirm', requireAuth, async (req, res) => {
  const record = await getLocateRequest(req.params.id);
  if (!record) return res.status(404).json({ error: 'Locate request not found.' });
  const updated = await updateLocateRequest(req.params.id, {
    status: 'CONFIRMED',
    confirmedAt: new Date().toISOString(),
    confirmedBy: req.user.name,
    ticketNumber: req.body?.ticketNumber || record.ticketNumber || null,
    notes: req.body?.notes || null,
  });
  logAction(req, {
    action: 'LOCATE.CONFIRM',
    targetType: 'locate_request',
    targetId: updated.id,
    detail: `Locate request ${updated.id} confirmed by ${req.user.name} — site cleared for excavation`,
  });
  res.json(updated);
});

// POST /api/locate-requests/:id/override — engineer-only. Lets a dig proceed
// without a confirmed locate, with an explicit, logged, named justification.
// This is deliberately friction-y: it's an escape hatch, not a default path.
router.post('/:id/override', requireAuth, requireRole('engineer', 'admin'), async (req, res) => {
  const { justification } = req.body || {};
  if (!justification || String(justification).trim().length < 10) {
    return res.status(400).json({ error: 'A written justification (10+ characters) is required to override a locate request.' });
  }
  const record = await getLocateRequest(req.params.id);
  if (!record) return res.status(404).json({ error: 'Locate request not found.' });
  const updated = await updateLocateRequest(req.params.id, {
    status: 'OVERRIDDEN',
    overriddenAt: new Date().toISOString(),
    overriddenBy: req.user.name,
    overrideJustification: String(justification).trim(),
  });
  logAction(req, {
    action: 'LOCATE.OVERRIDE',
    targetType: 'locate_request',
    targetId: updated.id,
    detail: `Engineer ${req.user.name} OVERRODE locate request ${updated.id} — "${String(justification).trim().slice(0, 160)}"`,
  });
  res.json(updated);
});

export default router;
