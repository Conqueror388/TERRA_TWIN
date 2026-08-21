import { Router } from 'express';
import { listPlans, listApprovedUtilities } from '../lib/store.js';
import { scoreExcavation } from '../lib/riskEngine.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';

const router = Router();

// GIS formats: geojson (QGIS/ArcGIS/Leaflet), csv (tabular AQL/Excel), kml
// (Google Earth). Everything ships in WGS84 / EPSG:4326 with metric depths.
const FORMATS = ['geojson', 'csv', 'kml'];
const CONTEXT_RADIUS_M = 20; // every utility inside this zone ships with the dig plan

// ---- small helpers -------------------------------------------------------

function escapeXml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function geoJSON(features, name) {
  return JSON.stringify(
    { type: 'FeatureCollection', name, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } }, features },
    null,
    2
  );
}

function csv(headers, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '\uFEFF' + [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

function kml(placemarks) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
${placemarks.join('\n')}
</Document>
</kml>`;
}

function digFootprintRect(center, width, length) {
  // Axis-aligned rectangle around the dig point (W-E width, N-S length).
  const dLat = (length || 1) / 2 / 111320;
  const dLng = (width || 1) / 2 / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return [
    { lat: center.lat - dLat, lng: center.lng - dLng },
    { lat: center.lat - dLat, lng: center.lng + dLng },
    { lat: center.lat + dLat, lng: center.lng + dLng },
    { lat: center.lat + dLat, lng: center.lng - dLng },
    { lat: center.lat - dLat, lng: center.lng - dLng },
  ];
}

// ---- data preparation ----------------------------------------------------

function preparedPlans(plans, utilities) {
  return plans.map((p) => {
    const ctx = scoreExcavation(p.excavation, utilities);
    const nearby = ctx.results
      .filter((r) => r.dist <= CONTEXT_RADIUS_M)
      .sort((a, b) => a.dist - b.dist);
    const result = p.result || { overall: ctx.overall, level: ctx.level };
    return { p, nearby, result };
  });
}

function preparedUtilities(utilities) {
  return utilities.map((u) => ({
    id: u.id,
    type: u.type,
    lat: u.lat,
    lng: u.lng,
    depth: u.depth,
    owner: u.owner,
    confidence: u.confidence,
    criticality: u.criticality,
    source: u.sourceDiscoveryId ? 'discovery-approved' : 'official-baseline',
    history: u.registryHistory || { entries: 0 },
  }));
}

// ---- GET /api/export/:kind?format=geojson|csv|kml ------------------------
//   'plans'   — any signed-in user can export the dig plans they can see
//   'registry'— engineer/admin: the full asset map (secret operational data)
async function sendExport(req, res, kind) {
  const format = String(req.query.format || 'geojson').toLowerCase();
  if (!FORMATS.includes(format)) return res.status(400).json({ error: `format must be one of ${FORMATS.join(', ')}.` });

  const [plans, approved] = await Promise.all([kind === 'plans' ? listPlans() : [], kind === 'registry' ? listApprovedUtilities() : []]);
  const utilities = approved;
  if (kind === 'plans') plans.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  logAction(req, {
    action: kind === 'plans' ? 'EXPORT.PLANS' : 'EXPORT.REGISTRY',
    targetType: kind,
    targetId: null,
    detail: `Exported ${kind} as ${format.toUpperCase()}${
      kind === 'plans' ? ` — ${plans.length} plan(s)` : ` — ${utilities.length} asset(s)`
    }`,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  let body;
  let filename;

  if (kind === 'plans') {
    const rows = preparedPlans(plans, utilities);
    if (format === 'geojson') {
      const features = [];
      for (const { p, nearby, result } of rows) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.excavation.point.lng, p.excavation.point.lat] },
          properties: {
            feature: 'plan-point', id: p.id, name: p.name, reviewStatus: p.reviewStatus || 'PENDING',
            createdBy: p.creatorName, createdIso: new Date(p.ts).toISOString(),
            purpose: p.excavation.purpose, depthM: p.excavation.depth, widthM: p.excavation.width, lengthM: p.excavation.length,
            riskScore: result.overall, riskLevel: result.level,
            reviewedBy: p.reviewedBy, reviewedAt: p.reviewedAt || null,
            nearUtilities: nearby.length,
            utilities: nearby.map((r) => `${r.utility.id}:${r.utility.type}@${r.dist.toFixed(1)}m`),
          },
        });
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [digFootprintRect(p.excavation.point, p.excavation.width, p.excavation.length).map((c) => [c.lng, c.lat])] },
          properties: { feature: 'plan-footprint', id: p.id, plan: p.name, areaM2: (p.excavation.width || 0) * (p.excavation.length || 0) },
        });
        for (const n of nearby) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [n.utility.lng, n.utility.lat] },
            properties: {
              feature: 'near-utility', planId: p.id, utilityId: n.utility.id, network: n.utility.type,
              distanceM: n.dist, utilityDepthM: n.utility.depth, owner: n.utility.owner,
              riskScore: n.score, riskLevel: n.level,
            },
          });
        }
      }
      body = geoJSON(features, 'terratwin planned digs');
      filename = `terratwin-plans-${stamp}.geojson`;
    } else if (format === 'csv') {
      body = csv(
        ['plan_id', 'name', 'review_status', 'latitude', 'longitude', 'depth_m', 'width_m', 'length_m', 'purpose', 'risk_score', 'risk_level', 'created_by', 'reviewed_by', 'near_utilities'],
        rows.flatMap(({ p, nearby, result }) => [
          [p.id, p.name, p.reviewStatus || 'PENDING', p.excavation.point.lat, p.excavation.point.lng, p.excavation.depth, p.excavation.width, p.excavation.length, p.excavation.purpose, result.overall, result.level, p.creatorName, p.reviewedBy, nearby.map((u) => `${u.utility.type}@${u.dist.toFixed(1)}m`).join(' | ')],
        ])
      );
      filename = `terratwin-plans-${stamp}.csv`;
    } else {
      body = kml(
        rows.map(({ p, result }) => {
          const desc = escapeXml(`Review: ${p.reviewStatus || 'PENDING'} | Depth: ${p.excavation.depth}m | DWS: ${result.overall}/${result.level}`);
          return `<Placemark><name>${escapeXml(p.name)} (${p.id})</name><description>${desc}</description><Point><coordinates>${p.excavation.point.lng},${p.excavation.point.lat}</coordinates></Point></Placemark>`;
        })
      );
      filename = 'terratwin-plans.kml';
    }
  } else {
    const rows = preparedUtilities(utilities);
    if (format === 'geojson') {
      body = geoJSON(
        rows.map((u) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [u.lng, u.lat] },
          properties: {
            feature: 'utility', utilityId: u.id, network: u.type, depthM: u.depth, owner: u.owner,
            confidence: u.confidence, criticality: u.criticality, source: u.source,
            historyEntries: u.history.entries, lastChangedAt: u.history.lastChangeAt || null,
          },
        })),
        'terratwin utility registry'
      );
      filename = `terratwin-registry-${stamp}.geojson`;
    } else if (format === 'csv') {
      body = csv(
        ['utility_id', 'network', 'latitude', 'longitude', 'depth_m', 'owner', 'confidence', 'criticality', 'source', 'history_entries'],
        rows.map((u) => [u.id, u.type, u.lat, u.lng, u.depth, u.owner, u.confidence, u.criticality, u.source, u.history.entries])
      );
      filename = `terratwin-registry-${stamp}.csv`;
    } else {
      body = kml(
        rows.map((u) => {
          const desc = escapeXml(`Depth: ${u.depth}m | Owner: ${u.owner} | Confidence: ${u.confidence}%`);
          return `<Placemark><name>${escapeXml(`${u.type} ${u.id}`)}</name><description>${desc}</description><Point><coordinates>${u.lng},${u.lat}</coordinates></Point></Placemark>`;
        })
      );
      filename = 'terratwin-registry.kml';
    }
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

// /api/export/plans — any signed-in user (their plans, shared review queue)
router.get('/plans', requireAuth, (req, res) => sendExport(req, res, 'plans'));

// /api/export/registry — engineer/admin only (full underground asset map)
router.get('/registry', requireRole('engineer', 'admin'), (req, res) => sendExport(req, res, 'registry'));

export default router;