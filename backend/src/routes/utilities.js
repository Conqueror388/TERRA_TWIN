import { Router } from 'express';
import { BASE } from '../data/utilities.js';
import {
  listApprovedUtilities,
  addApprovedUtility,
  deleteApprovedUtility,
  listRegistryHistory,
  saveRegistryHistory,
} from '../lib/store.js';
import { logAction } from '../lib/audit.js';
import { requireAuth, requireRole } from '../lib/auth.js';

const router = Router();

const TYPE_COLOR = { water: '#29B6D8', electric: '#F5A623', fiber: '#B58CFF', gas: '#E5E542', sewer: '#8D6E3B' };

// GET /api/utilities — the real underground utility registry: records an
// engineer has registered/approved. The Digital Twin and risk engine both
// read from this list (the risk engine additionally pulls live OSM pipes at
// analysis time via lib/liveUtilities.js). Each entry carries its
// registry-history provenance (latest change + by whom) when available.
router.get('/', async (req, res) => {
  const [approved, history, ...rest] = await Promise.all([listApprovedUtilities(), listRegistryHistory()]);
  const latestByUtility = new Map();
  for (const h of history) {
    if (!h.utilityId) continue;
    const prev = latestByUtility.get(h.utilityId);
    if (!prev || h.at > prev.at) latestByUtility.set(h.utilityId, h);
  }
  const withHistory = (u) => {
    const h = latestByUtility.get(u.id);
    return {
      ...u,
      registryHistory: {
        entries: history.filter((e) => e.utilityId === u.id).length,
        lastEvent: h ? h.event : null,
        lastChangeAt: h ? h.at : null,
        lastChangeBy: h ? h.actor?.name : null,
      },
    };
  };
  res.json({ base: BASE, utilities: approved.map(withHistory) });
});

// POST /api/utilities/quick-register — engineers register a verified utility
// record at specific coordinates. This is the only way the registry grows
// (besides approved discovery reports); there is no bundled simulated data.
router.post('/quick-register', requireRole('engineer', 'admin'), async (req, res) => {
  const { type, lat, lng, depth, owner, confidence, criticality, bearing } = req.body || {};
  if (!type || typeof lat !== 'number' || typeof lng !== 'number' || typeof depth !== 'number') {
    return res.status(400).json({ error: 'type, lat, lng, and depth are required.' });
  }

  const utility = await addApprovedUtility({
    type,
    lat,
    lng,
    depth,
    owner: owner || 'Engineer-registered',
    confidence: typeof confidence === 'number' ? confidence : 95,
    criticality: typeof criticality === 'number' ? criticality : 60,
    color: TYPE_COLOR[type] || '#8CA3BF',
    bearing: typeof bearing === 'number' ? bearing : null,
    createdAt: new Date().toISOString()
  });

  await saveRegistryHistory({
    event: 'CREATED',
    utilityId: utility.id,
    utility,
    origin: 'quick-register',
    actor: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role },
    summary: `Utility ${utility.id} (${type}) registered directly by engineer at ${lat}, ${lng}`,
  });

  logAction(req, {
    action: 'REGISTRY.CREATE',
    targetType: 'utility',
    targetId: utility.id,
    detail: `Engineer registered ${type} utility ${utility.id} (owner: ${utility.owner}) at ${lat}, ${lng}`,
  });

  res.status(201).json(utility);
});

// DELETE /api/utilities/:id — allow deleting registered/approved utilities,
// logging the removal to the registry ledger and audit trail.
router.delete('/:id', requireRole('engineer', 'admin'), async (req, res) => {
  const all = await listApprovedUtilities();
  const found = all.find((u) => u.id === req.params.id);
  const success = await deleteApprovedUtility(req.params.id);
  if (!success) {
    return res.status(404).json({ error: 'Utility not found or cannot be deleted.' });
  }

  await saveRegistryHistory({
    event: 'DELETED',
    utilityId: req.params.id,
    utility: found
      ? {
          id: found.id,
          type: found.type,
          lat: found.lat,
          lng: found.lng,
          depth: found.depth,
          owner: found.owner,
        }
      : { id: req.params.id, type: 'unknown' },
    origin: 'registry-delete',
    actor: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role },
    summary: `Utility ${req.params.id} removed from the registry`,
  });

  logAction(req, {
    action: 'REGISTRY.DELETE',
    targetType: 'utility',
    targetId: req.params.id,
    detail: `Engineer removed utility ${req.params.id} from the registry${found ? ` (${found.type}, owner: ${found.owner})` : ''}`,
  });

  res.json({ success: true, message: 'Utility deleted successfully.' });
});

export default router;
