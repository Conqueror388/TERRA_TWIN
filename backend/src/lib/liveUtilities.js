// Live utility source for the DigSafe risk engine.
// Converts real OpenStreetMap underground pipes near an excavation point into
// utility records the risk engine can score, merged with engineer-registered
// records from the backend store. There is NO simulated data here.

import { fetchOsmFeatures } from './osmQuery.js';
import { listApprovedUtilities } from './store.js';
import { metersBetween } from './riskEngine.js';

// Unverified public map data is treated honestly: moderate criticality per
// network and a deliberately low confidence, so the confidence term of the
// engine nudges the score down instead of pretending certainty.
const TYPE_CRITICALITY = { gas: 90, electric: 80, water: 60, sewer: 50, fiber: 45, unknown: 40 };
// Assumed typical burial depth when OSM has no recorded depth (many mapped
// pipes omit it). Honest numbers with low confidence — never presented as fact.
const TYPE_DEPTH_M = { gas: 0.9, electric: 0.7, water: 1.0, sewer: 1.5, fiber: 0.6, unknown: 1.0 };
const OSM_CONFIDENCE = 45;
// Only candidates within this horizontal distance matter to the engine
// (DANGER_RADIUS_M is 5); keep the response small and relevant.
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

// Closest point on a pipe polyline (coordinates: [[lat,lng],...]) to the
// excavation point, with the horizontal distance in metres.
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

// Real utility records near (lat,lng): engineer-registered + live OSM pipes.
export async function liveUtilitiesNear(lat, lng, radiusM = 150) {
  const registered = (await listApprovedUtilities())
    .map((u) => ({ ...u, dist: metersBetween({ lat, lng }, u) }))
    .filter((u) => u.dist <= SCORE_CANDIDATE_RADIUS_M);

  let osm = [];
  try {
    const features = await fetchOsmFeatures(lat, lng, radiusM);
    osm = features
      // Road-corridor proxies are a display aid, NOT a real utility — never
      // let an estimate drive a risk score.
      .filter((f) => f.type !== 'corridor')
      .map((f) => {
        const near = closestOnPolyline({ lat, lng }, f.coordinates);
        if (!near) return null;
        const type = f.type;
        return {
          id: f.id,
          type,
          color: f.color,
          lat: near.lat,
          lng: near.lng,
          depth: f.depth ?? TYPE_DEPTH_M[type] ?? 1.0,
          confidence: OSM_CONFIDENCE,
          criticality: TYPE_CRITICALITY[type] ?? 40,
          owner: 'OpenStreetMap (unverified)',
          source: 'osm',
          name: f.name || null,
          verified: false,
          dist: near.dist,
        };
      })
      .filter(Boolean)
      .filter((u) => u.dist <= SCORE_CANDIDATE_RADIUS_M);
  } catch (err) {
    console.warn('[liveUtilities] OSM unavailable — scoring registry records only:', err.message);
  }

  return [...registered, ...osm];
}
