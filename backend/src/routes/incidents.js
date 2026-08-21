import { Router } from 'express';
import { listIncidents, getIncident, updateIncident } from '../lib/store.js';
import { requireAuth } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';

const router = Router();

// Statuses an actor may set explicitly. OPEN is created automatically by the
// device check-in; incidents are never deleted — only ACKNOWLEDGED or RESOLVED.
const SETTABLE = ['ACKNOWLEDGED', 'RESOLVED'];
const SET_LABEL = { ACKNOWLEDGED: 'acknowledged', RESOLVED: 'resolved' };

// GET /api/incidents — alarm feed, newest first. Any authenticated user can
// view; acknowledging and resolving are also open to any signed-in role so a
// worker in the field can clear a resolved situation, not just the engineer.
router.get('/', requireAuth, async (req, res) => {
  res.json(await listIncidents());
});

// PATCH /api/incidents/:id — { status, note } actor acknowledges or resolves.
router.patch('/:id', requireAuth, async (req, res) => {
  const { status, note } = req.body || {};
  if (!SETTABLE.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE.join(', ')}` });
  }

  const incident = await getIncident(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found.' });

  const patch = {
    status,
    note: note || incident.note || null,
    updatedAt: new Date().toISOString(),
  };
  if (status === 'ACKNOWLEDGED') {
    patch.acknowledgedBy = req.user.name;
    patch.acknowledgedAt = new Date().toISOString();
  }
  if (status === 'RESOLVED') {
    patch.resolvedAt = new Date().toISOString();
  } else {
    patch.resolvedAt = null;
  }

  const updated = await updateIncident(incident.id, patch);
  if (!updated) return res.status(404).json({ error: 'Incident not found.' });

  logAction(req, {
    action: status === 'ACKNOWLEDGED' ? 'INCIDENT.ACKNOWLEDGED' : 'INCIDENT.RESOLVED',
    targetType: 'incident',
    targetId: incident.id,
    detail: `Incident on ${incident.deviceId} ${SET_LABEL[status]} by ${req.user.name}${note ? ` — "${String(note).slice(0, 120)}"` : ''}`,
  });

  res.json(updated);
});

export default router;