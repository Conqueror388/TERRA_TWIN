// Bulk utility-data ingestion — the on-ramp for government/GIS datasets.
//
// Engineers and admins upload a GeoJSON FeatureCollection, a CSV, or a plain
// JSON array of utilities. The route parses it, maps common schema aliases,
// validates every row, and writes valid records into the same registry the
// planner/risk engine already reads — with full provenance in the registry
// history (event IMPORTED, origin bulk-import) and on the audit trail.
//
// Coordinates must be WGS84 (lat/lng). Shapefile (.shp) binaries are not
// parsed server-side — ask the data source to export GeoJSON or CSV first,
// which every GIS (ArcGIS/QGIS/PostGIS) can do.

import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { requireRole } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';
import { addApprovedUtility, listApprovedUtilities, saveRegistryHistory } from '../lib/store.js';
import { metersBetween } from '../lib/riskEngine.js';

const router = Router();

const TYPE_COLOR = {
  water: '#4FD1E8',
  electric: '#F5A623',
  fiber: '#B58CFF',
  gas: '#E4483C',
  sewer: '#8CA3BF',
  telecom: '#B58CFF',
  drainage: '#8CA3BF',
  unknown: '#8CA3BF',
};

// Default risk posture per type when the source file doesn't say. These are
// clamps/fallbacks the engineer can over-ride later; they never over-write a
// value the source actually provided.
const DEFAULT_CRITICALITY = { gas: 85, electric: 80, sewer: 60, water: 55, fiber: 40, telecom: 40, drainage: 45, unknown: 60 };
const DEFAULT_CONFIDENCE = 80; // government-provided dataset, higher trust than OSM
const OWNER_FALLBACK = 'Government utility registry';
const DEDUP_RADIUS_M = 2; // same type within 2 m of an existing record = duplicate
const MAX_RECORDS = 5000;

const KNOWN_TYPES = new Set(['water', 'electric', 'fiber', 'gas', 'sewer', 'telecom', 'drainage']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const ok =
      name.endsWith('.geojson') || name.endsWith('.json') || name.endsWith('.csv') ||
      file.mimetype === 'application/geo+json' || file.mimetype === 'application/json' ||
      file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel';
    if (!ok) return cb(new Error('Only .geojson, .json, or .csv files are accepted.'));
    cb(null, true);
  },
});

function pick(props, aliases, fallback = null) {
  if (!props || typeof props !== 'object') return fallback;
  for (const key of aliases) {
    if (props[key] !== undefined && props[key] !== null && props[key] !== '') return props[key];
  }
  return fallback;
}

function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(',', '.').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Rows come in three shapes:
//   1. GeoJSON FeatureCollection (or single Feature)
//   2. JSON array of plain objects  [{lat,lng,type,...}]
//   3. CSV text with a header row
function parsePayload(text, filename) {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], errors: [] };

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    json = null;
  }

  const errors = [];
  const rows = [];

  if (json !== null) {
    let features = [];
    if (Array.isArray(json)) {
      rows.push(...json.map((f, i) => ({ row: i + 1, obj: f })));
      return { rows, errors };
    }
    if (json.type === 'FeatureCollection' && Array.isArray(json.features)) {
      features = json.features;
    } else if (json.type === 'Feature') {
      features = [json];
    } else if (json.type && json.geometry) {
      features = [json]; // a bare Feature-ish object
    } else {
      errors.push({ row: 0, message: 'Unrecognized GeoJSON shape — expected a FeatureCollection or Feature.' });
      return { rows, errors };
    }
    features.forEach((f, i) => {
      if (!f || typeof f !== 'object') return rows.push({ row: i + 1, obj: {} });
      rows.push({ row: i + 1, obj: f });
    });
    return { rows, errors };
  }

  // Not JSON — treat as CSV.
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { rows, errors };
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const obj = {};
    header.forEach((h, idx) => { obj[h] = cells[idx]; });
    rows.push({ row: i + 1, obj });
  }
  return { rows, errors };
}

// Pull geometry from a GeoJSON Feature, preferring an explicit lat/lng in
// properties (some exports put them there), else the feature geometry point
// (GeoJSON coordinates are [lng, lat]). Lines/polygons use their first point.
// For plain CSV/JSON rows there is no .properties wrapper, so the row itself
// is the props source.
function geoPoint(obj) {
  const props = obj.properties || obj;
  const lat = parseNumber(pick(props, ['latitude', 'lat']));
  const lng = parseNumber(pick(props, ['longitude', 'lng', 'lon']));
  if (lat != null && lng != null) return { lat, lng };

  const g = obj.geometry;
  if (g && g.coordinates && Array.isArray(g.coordinates)) {
    const coords = Array.isArray(g.coordinates[0]) ? g.coordinates[0] : g.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      return { lng: parseNumber(coords[0]), lat: parseNumber(coords[1]) };
    }
  }
  return null;
}

function normalizeRecord(obj) {
  const props = obj.properties || obj;
  const typeRaw = String(pick(props, ['type', 'utilitytype', 'utility_type', 'material', 'asset_type', 'assettype']) || 'unknown').toLowerCase();
  const type = KNOWN_TYPES.has(typeRaw) ? typeRaw : (typeRaw !== 'unknown' && typeRaw ? typeRaw : 'unknown');

  const point = geoPoint(obj);
  if (!point) return { valid: false, message: 'No coordinates found — include latitude/longitude (or GeoJSON geometry).' };
  if (point.lat == null || point.lng == null) return { valid: false, message: 'Coordinates must be numbers.' };
  if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) {
    return { valid: false, message: `Coordinates out of range (${point.lat}, ${point.lng}).` };
  }

  const depth = parseNumber(pick(props, ['depth', 'depth_m', 'depthm', 'depthmeters', 'estimateddepth', 'size_m']));
  const confidence = Math.min(100, Math.max(0, parseNumber(pick(props, ['confidence', 'accuracy'])) ?? DEFAULT_CONFIDENCE));
  const criticality = Math.min(100, Math.max(0, parseNumber(pick(props, ['criticality', 'risk', 'risklevel', 'priority'])) ?? DEFAULT_CRITICALITY[type] ?? 60));
  const owner = String(pick(props, ['owner', 'agency', 'operator', 'department']) || OWNER_FALLBACK).slice(0, 120);
  const notes = String(pick(props, ['notes', 'remarks', 'description']) || '').slice(0, 300);

  return {
    valid: true,
    record: {
      type,
      lat: point.lat,
      lng: point.lng,
      depth: depth == null ? 1.2 : depth,
      owner,
      confidence,
      criticality,
      color: TYPE_COLOR[type] || TYPE_COLOR.unknown,
      notes,
    },
  };
}

// GET /api/imports/template — downloadable CSV so the data team can see the
// exact column names (with aliases) before exporting their GIS dataset.
router.get('/template', requireRole('engineer', 'admin'), (req, res) => {
  const header =
    'type,latitude,longitude,depth_m,owner,confidence,criticality,notes\n' +
    'gas,13.0827,80.2707,1.4,Gas Authority of India,85,85,12 inch main\n' +
    'water,13.0828,80.2708,1.0,City Water Board,80,55,\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="terratwin-utilities-template.csv"');
  res.send(header);
});

// POST /api/imports/utilities — upload a dataset, get back what imported and
// what was skipped (duplicates / invalid rows) so the engineer can fix the
// file and re-run. Everything imported lands in the registry with provenance.
router.post('/utilities', requireRole('engineer', 'admin'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    try {
      const text = req.file.buffer.toString('utf-8');
      const { rows, errors } = parsePayload(text, req.file.originalname);
      if (rows.length === 0) {
        return res.status(400).json({ error: 'No records found in the file.', errors });
      }
      if (rows.length > MAX_RECORDS) {
        return res.status(400).json({ error: `Too many records (${rows.length}). Max is ${MAX_RECORDS} per import.`, errors });
      }

      const existing = await listApprovedUtilities();
      const batchAdded = []; // batch-local, so we never touch the store array
      const batchId = `IMP${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const imported = [];
      const importedIds = [];
      let skippedDuplicates = 0;
      let invalid = 0;

      const isDuplicate = (rec) =>
        batchAdded.some((u) => u.type === rec.type && metersBetween({ lat: u.lat, lng: u.lng }, { lat: rec.lat, lng: rec.lng }) <= DEDUP_RADIUS_M) ||
        existing.some((u) => u.type === rec.type && metersBetween({ lat: u.lat, lng: u.lng }, { lat: rec.lat, lng: rec.lng }) <= DEDUP_RADIUS_M);

      for (const { row, obj } of rows) {
        const n = normalizeRecord(obj);
        if (!n.valid) {
          invalid++;
          errors.push({ row, message: n.message });
          continue;
        }
        const rec = n.record;

        if (isDuplicate(rec)) {
          skippedDuplicates++;
          continue;
        }

        const utility = await addApprovedUtility({
          ...rec,
          sourceImport: batchId,
          importedAt: new Date().toISOString(),
        });
        batchAdded.push(utility);
        imported.push(utility);
        importedIds.push(utility.id);

        await saveRegistryHistory({
          event: 'IMPORTED',
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
          origin: 'bulk-import',
          actor: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role },
          summary: `Utility ${utility.id} (${utility.type}) imported in bulk batch ${batchId}`,
          meta: { batchId, sourceFile: req.file.originalname, row },
        });
      }

      logAction(req, {
        action: 'UTILITY.BULK_IMPORT',
        targetType: 'registry',
        targetId: batchId,
        detail: `Bulk import "${req.file.originalname}" → ${imported.length} imported, ${skippedDuplicates} duplicates skipped, ${invalid} invalid rows`,
      });

      res.status(201).json({
        batchId,
        sourceFile: req.file.originalname,
        total: rows.length,
        imported: imported.length,
        skippedDuplicates,
        invalid,
        importedIds,
        errors: errors.slice(0, 50),
      });
    } catch (e) {
      console.error('[imports] failed:', e);
      res.status(500).json({ error: `Import failed: ${e.message}` });
    }
  });
});

export default router;