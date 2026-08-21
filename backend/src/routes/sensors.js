import { Router } from 'express';
import { saveSensorReading, listLatestSensors, listSensorReadings, listIncidents, saveIncident } from '../lib/store.js';
import { logAction } from '../lib/audit.js';

const router = Router();

// Known site sensor families with their units and alert thresholds. `warning`
// may be null for sensors that only have two states (e.g. water leak).
export const SENSOR_TYPES = {
  gas: { unit: 'ppm', warning: 100, alert: 300, label: 'Gas / methane' },
  vibration: { unit: 'mm/s', warning: 5, alert: 10, label: 'Vibration' },
  water: { unit: '%', warning: null, alert: 0.5, label: 'Water intrusion' },
};

function statusFor(type, value) {
  const cfg = SENSOR_TYPES[type];
  if (!cfg) return 'NORMAL';
  if (value >= cfg.alert) return 'ALERT';
  if (cfg.warning != null && value >= cfg.warning) return 'WARNING';
  return 'NORMAL';
}

// POST /api/sensors/telemetry — hardware/field endpoint (no auth). Body:
// { sensorId, type, value, latitude?, longitude?, timestamp? }. The reading is
// stored and, if it crosses the ALERT threshold, an incident is raised so the
// existing OPEN -> ACKNOWLEDGED -> RESOLVED lifecycle applies to sensor alarms.
router.post('/telemetry', async (req, res) => {
  const { sensorId, type, value, latitude, longitude, timestamp } = req.body || {};

  if (!sensorId || typeof sensorId !== 'string') {
    return res.status(400).json({ error: 'sensorId (string) is required.' });
  }
  if (!SENSOR_TYPES[type]) {
    return res.status(400).json({ error: `type must be one of: ${Object.keys(SENSOR_TYPES).join(', ')}` });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return res.status(400).json({ error: 'value must be a number.' });
  }
  if (latitude != null && !Number.isFinite(Number(latitude))) {
    return res.status(400).json({ error: 'latitude must be a number.' });
  }
  if (longitude != null && !Number.isFinite(Number(longitude))) {
    return res.status(400).json({ error: 'longitude must be a number.' });
  }

  const cfg = SENSOR_TYPES[type];
  const status = statusFor(type, num);
  const reading = await saveSensorReading({
    sensorId: String(sensorId).slice(0, 64),
    type,
    unit: cfg.unit,
    value: Math.round(num * 100) / 100,
    status,
    latitude: latitude != null ? Number(latitude) : null,
    longitude: longitude != null ? Number(longitude) : null,
    timestamp: timestamp || null,
  });

  // Raise (or keep open) one incident per sensor while readings stay ALERT.
  if (status === 'ALERT') {
    const open = (await listIncidents()).find(
      (i) => i.deviceId === String(sensorId) && (i.status === 'OPEN' || i.status === 'ACKNOWLEDGED')
    );
    if (!open) {
      await saveIncident({
        deviceId: String(sensorId),
        status: 'OPEN',
        riskLevel: 'CRITICAL',
        firstScore: num,
        lastScore: num,
        latitude: latitude != null ? Number(latitude) : null,
        longitude: longitude != null ? Number(longitude) : null,
        nearestUtilityType: null,
        nearestUtilityDepth: null,
        hits: 1,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        note: `${cfg.label} sensor exceeded alert threshold: ${reading.value} ${cfg.unit} (limit ${cfg.alert} ${cfg.unit})`,
        sensorType: type,
      });
      logAction(req, {
        action: 'INCIDENT.TRIGGER',
        targetType: 'incident',
        targetId: null,
        detail: `Sensor ${reading.sensorId} (${cfg.label}) alert: ${reading.value} ${cfg.unit}`,
      });
    }
  }

  res.status(201).json(reading);
});

// GET /api/sensors — latest reading per sensor with its NORMAL/WARNING/ALERT
// status. Open to the dashboard monitoring feed (read-only).
router.get('/', async (req, res) => {
  res.json({ sensors: await listLatestSensors() });
});

// GET /api/sensors/telemetry?limit=50 — recent readings, newest first.
router.get('/telemetry', async (req, res) => {
  res.json({ readings: await listSensorReadings(req.query.limit) });
});

// GET /api/sensors/types — threshold config so the UI can render units and
// limits without duplicating the backend rules.
router.get('/types', async (req, res) => {
  res.json({ types: SENSOR_TYPES });
});

export default router;