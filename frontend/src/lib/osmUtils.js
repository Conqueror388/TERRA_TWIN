// Converts real OpenStreetMap pipe features (as returned by /api/osm) into
// utility records the DigSafe risk engine can score locally, mirroring the
// backend's lib/liveUtilities.js. There is no simulated data here.
import { metersBetween } from './riskEngine.js';

const TYPE_CRITICALITY = { gas: 90, electric: 80, water: 60, sewer: 50, fiber: 45, unknown: 40 };
const TYPE_DEPTH_M = { gas: 0.9, electric: 0.7, water: 1.0, sewer: 1.5, fiber: 0.6, unknown: 1.0 };
const OSM_CONFIDENCE = 45;
const SCORE_CANDIDATE_RADIUS_M = 20;

function toLocal(point, lat, lng) {
  const dLat = (lat - point.lat) * 111320;
  const dLng = (lng - point.lng) * 111320 * Math.cos((point.lat * Math.PI) / 180);
  return { x: dLng, y: dLat };
}

function pointToSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const cx = a.x + abx * t, cy = a.y + aby * t;
  return { x: cx, y: cy, dist: Math.hypot(p.x - cx, p.y - cy) };
}

function closestOnPolyline(point, coordinates) {
  const origin = { x: 0, y: 0 };
  let best = null;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const a = toLocal(point, coordinates[i][0], coordinates[i][1]);
    const b = toLocal(point, coordinates[i + 1][0], coordinates[i + 1][1]);
    const r = pointToSegment(origin, a, b);
    if (!best || r.dist < best.dist) best = r;
  }
  if (!best) return null;
  return {
    lat: point.lat + best.y / 111320,
    lng: point.lng + best.x / (111320 * Math.cos((point.lat * Math.PI) / 180)),
    dist: best.dist,
  };
}

export function osmPipesToUtilities(pipes, point) {
  return (pipes || [])
    .filter((p) => p.type !== 'corridor')
    .map((p) => {
      const near = closestOnPolyline(point, p.coordinates);
      if (!near) return null;
      const type = p.type;
      return {
        id: p.id,
        type,
        color: p.color,
        lat: near.lat,
        lng: near.lng,
        depth: p.depth ?? TYPE_DEPTH_M[type] ?? 1.0,
        confidence: OSM_CONFIDENCE,
        criticality: TYPE_CRITICALITY[type] ?? 40,
        owner: 'OpenStreetMap (unverified)',
        source: 'osm',
        name: p.name || null,
        verified: false,
        dist: near.dist,
      };
    })
    .filter(Boolean)
    .filter((u) => u.dist <= SCORE_CANDIDATE_RADIUS_M);
}

export { metersBetween };
