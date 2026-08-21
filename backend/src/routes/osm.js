/**
 * OSM underground utility layer — with road-corridor fallback.
 *
 * Thin wrapper over lib/osmQuery.js (shared with the risk engine's live
 * utility source), exposing the map payload shape the frontend draws.
 *
 * Strategy:
 *  1. Query Overpass for actual underground pipes/cables.
 *  2. If < 3 results (common in India where OSM utility tagging is sparse),
 *     query for major roads and return them as "Estimated utility corridors".
 *     Real utilities in India almost always run alongside roads.
 */
import { Router } from 'express';
import { fetchOsmFeatures } from '../lib/osmQuery.js';

const router = Router();

// ── GET /api/osm?lat=&lng=&radius= ───────────────────────────────────────────
router.get('/', async (req, res) => {
  const lat    = parseFloat(req.query.lat);
  const lng    = parseFloat(req.query.lng);
  const radius = Math.min(parseInt(req.query.radius || 3000, 10), 5000);

  if (isNaN(lat) || isNaN(lng))
    return res.status(400).json({ error: 'lat and lng required.' });

  try {
    const features = await fetchOsmFeatures(lat, lng, radius);
    const pipes = features.filter((f) => f.type !== 'corridor');
    const corridors = features.filter((f) => f.type === 'corridor');

    res.json({
      pipes: features,
      count: features.length,
      pipeCount: pipes.length,
      corridorCount: corridors.length,
      hasCorridor: corridors.length > 0,
      source: 'overpass',
    });
  } catch (err) {
    console.error('[osm] Overpass query failed:', err.message);
    return res.status(502).json({ error: 'Overpass API unavailable.', detail: err.message });
  }
});

export default router;
