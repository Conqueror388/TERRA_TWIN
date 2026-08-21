import { Router } from 'express';
import { scoreExcavation } from '../lib/riskEngine.js';
import { liveUtilitiesNear } from '../lib/liveUtilities.js';
import {
  saveDeviceReading,
  listLatestDeviceReadings,
  listIncidents,
  saveIncident,
  updateIncident,
} from '../lib/store.js';
import { logAction } from '../lib/audit.js';

const router = Router();

// ── Device API key authentication ─────────────────────────────────────────
// ESP32 devices include X-Device-Key: <shared-secret> in every request.
// Set DEVICE_API_KEY in backend/.env before production deployment.
// In dev mode (no key configured), the endpoint logs a warning and continues
// so local testing without hardware still works.
const DEVICE_API_KEY = process.env.DEVICE_API_KEY;

function requireDeviceKey(req, res, next) {
  if (!DEVICE_API_KEY) {
    // No key configured — dev/demo mode. Log a warning but allow through.
    console.warn('[devices] DEVICE_API_KEY not set — running in unauthenticated dev mode. Set it in .env before production.');
    return next();
  }
  const provided = req.headers['x-device-key'];
  if (!provided || provided !== DEVICE_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing device API key (X-Device-Key header).' });
  }
  next();
}

const ASSUMED_ALERT_DEPTH_M = 1.5;

// POST /api/devices/gps — ESP32 + NEO-6M check-in.
// Body: { deviceId, latitude, longitude, timestamp }
router.post('/gps', requireDeviceKey, async (req, res) => {
  const { deviceId, latitude, longitude, timestamp } = req.body || {};

  if (!deviceId || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'deviceId, latitude, and longitude are required.' });
  }

  const result = scoreExcavation({ point: { lat: latitude, lng: longitude }, depth: ASSUMED_ALERT_DEPTH_M }, await liveUtilitiesNear(latitude, longitude, 150));
  // Two distinct selections matter:
  //   worst   — lowest score = highest risk; this is what should drive the alert
  //   nearest — smallest distance; the physically closest asset (label accuracy)
  const all = [...result.results];
  const worst = [...all].sort((a, b) => a.score - b.score)[0];
  const nearest = [...all].sort((a, b) => a.dist - b.dist)[0];

  const reading = await saveDeviceReading({
    deviceId,
    latitude,
    longitude,
    timestamp: timestamp || Date.now(),
    digSafeScore: Math.round(result.overall),
    riskLevel: result.level,
    receivedAt: new Date().toISOString(),
  });

  // ── Incident handling ──────────────────────────────────────────────
  // A HIGH/CRITICAL check-in creates (or re-arms) a persistent incident for
  // this device. Incidents stay OPEN until a human acknowledges, then
  // RESOLVED — a device leaving the zone never auto-closes one. Logged to
  // the audit trail so the alert lifecycle is fully accountable.
  if (reading.riskLevel === 'HIGH' || reading.riskLevel === 'CRITICAL') {
    const incidents = await listIncidents();
    const open = incidents.find((i) => i.deviceId === deviceId && (i.status === 'OPEN' || i.status === 'ACKNOWLEDGED'));

    if (open) {
      await updateIncident(open.id, {
        lastSeenAt: new Date().toISOString(),
        lastScore: reading.digSafeScore,
        riskLevel: reading.riskLevel,
        hits: (open.hits || 1) + 1,
      }).catch((err) => console.warn('[incidents] update failed:', err.message));
    } else {
      const incident = await saveIncident({
        deviceId,
        status: 'OPEN',
        riskLevel: reading.riskLevel,
        firstScore: reading.digSafeScore,
        lastScore: reading.digSafeScore,
        latitude,
        longitude,
        nearestUtilityType: nearest ? nearest.utility.type : null,
        nearestUtilityDepth: nearest ? nearest.utility.depth : null,
        threatUtilityType: worst ? worst.utility.type : null,
        threatUtilityDepth: worst ? worst.utility.depth : null,
        hits: 1,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }).catch((err) => {
        console.warn('[incidents] create failed:', err.message);
        return null;
      });
      if (incident) {
        logAction(req, {
          action: 'INCIDENT.TRIGGER',
          targetType: 'incident',
          targetId: incident.id,
          detail: `${reading.riskLevel} alarm on ${deviceId} — score ${reading.digSafeScore}, threat ${incident.threatUtilityType || 'unknown'} @ ${incident.threatUtilityDepth ?? '—'}m (nearest ${incident.nearestUtilityType || 'unknown'} @ ${incident.nearestUtilityDepth ?? '—'}m)`,
        });
      }
    }
  }

  // Firmware contract: alert=true means red LED + buzzer + OLED warning.
  // alert=false means green LED. nearest* = physically closest asset;
  // threat* = the one that drove the risk score (what the alert warns about).
  // See hardware/esp32_terratwin/esp32_terratwin.ino.
  res.json({
    deviceId,
    digSafeScore: reading.digSafeScore,
    riskLevel: reading.riskLevel,
    alert: reading.riskLevel === 'HIGH' || reading.riskLevel === 'CRITICAL',
    nearestUtilityType: nearest ? nearest.utility.type : null,
    nearestUtilityDepth: nearest ? nearest.utility.depth : null,
    threatUtilityType: worst ? worst.utility.type : null,
    threatUtilityDepth: worst ? worst.utility.depth : null,
  });
});

// GET /api/devices — latest known position per device, for the dashboard.
router.get('/', async (req, res) => {
  res.json(await listLatestDeviceReadings());
});

export default router;
