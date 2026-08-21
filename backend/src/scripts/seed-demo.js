// Seeds realistic demo data so a pitch walkthrough shows live numbers:
// demo engineer + worker accounts, a handful of registry utilities, a risk
// assessment, an approved dig plan with a clearance certificate, a confirmed
// locate request, a field GPS check-in that raises an alarm, and a gas-sensor
// ALERT. Idempotent — re-running adds nothing it already seeded: users are
// reused via login, imports are deduped by the backend, the plan/certificate
// is not re-created once approved, and open incidents are not duplicated.
//
// Self-registration never grants privileged roles, so the demo engineer is
// promoted via the store directly (the same action an admin takes in
// /api/users). Runs against the real backend store (Firestore via
// backend/.env). Run:
//   npm run seed-demo
//
// Credentials (shown once at the end): the demo accounts log in normally.

import 'dotenv/config';
import { appExport } from '../server.js';
import { findUserByEmail, updateUser } from '../lib/store.js';

const DEMO = {
  engineer: { name: 'Demo Engineer', email: 'demo-eng@terratwin.local', password: 'TerraTwin@2026' },
  worker: { name: 'Demo Worker', email: 'demo-worker@terratwin.local', password: 'TerraTwin@2026' },
  site: { name: 'Demo — Utility jointing', lat: 13.0827, lng: 80.2707 },
  sensor: 'DEMO-GAS-SITE',
};

const server = appExport.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://localhost:${server.address().port}`;
const log = (...a) => console.log('[seed]', ...a);

const json = async (path, opts = {}) => {
  const res = await fetch(base + path, opts);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
};
const must = (res, label) => {
  if (res.status >= 400) throw new Error(`${label}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  return res;
};
const auth = (token) => ({ headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

async function ensureUser({ name, email, password }) {
  let res = await json('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (res.status === 200) {
    log(`user ${email}: reused`);
    return res.data;
  }
  res = await json('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password }) });
  if (res.status !== 201) throw new Error(`register ${email}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  log(`user ${email}: created`);
  return res.data;
}

try {
  // ── 1. Accounts ─────────────────────────────────────────────────────
  const engineer = await ensureUser(DEMO.engineer);
  const worker = await ensureUser(DEMO.worker);
  const engAuth = auth(engineer.token);
  const workerAuth = auth(worker.token);

  const engUser = await findUserByEmail(DEMO.engineer.email);
  if (engUser && engUser.role !== 'engineer' && engUser.role !== 'admin') {
    await updateUser(engUser.id, { role: 'engineer' });
    log(`user ${DEMO.engineer.email}: promoted to engineer`);
  }

  // ── 2. Registry utilities (deduped by the import route) ─────────────
  const csv = [
    'type,latitude,longitude,depth_m,owner,confidence,criticality',
    'gas,13.082700,80.270700,1.2,Gas Authority,88,90',
    'electric,13.082710,80.270750,0.9,State Powergrid,80,85',
    'water,13.082690,80.270660,1.1,Municipal Water,75,60',
    'telecom,13.082650,80.270720,0.7,National Telecom,70,50',
    'sewer,13.082730,80.270620,2.4,Municipal Sewerage,78,70',
    'fibre,13.082680,80.270780,0.6,City Fibre,72,45',
  ].join('\n');
  const form = new FormData();
  form.append('file', new Blob([csv]), 'demo-utilities.csv');
  const impRes = must(await json('/api/imports/utilities', { method: 'POST', headers: { Authorization: `Bearer ${engineer.token}` }, body: form }), 'import utilities');
  log(`import: imported=${impRes.data.imported} (dup=${impRes.data.skippedDuplicates}, invalid=${impRes.data.invalid})`);

  // ── 3. Risk assessment + locate request ─────────────────────────────
  const analysis = must(await json('/api/excavations/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ latitude: DEMO.site.lat, longitude: DEMO.site.lng, depth: 1.2, width: 2, length: 3, purpose: 'Utility jointing' }) }), 'analyze');
  log(`analyze: score=${analysis.data?.digSafeScore} level=${analysis.data?.riskLevel}`);

  let locateReq = null;
  {
    const existing = must(await json('/api/locate-requests', engAuth), 'list locate requests');
    locateReq = existing.data?.find((r) => r.requestedByUserId === engineer.user?.id) || null;
  }
  if (!locateReq) {
    const res = must(await json('/api/locate-requests', { method: 'POST', ...engAuth, body: JSON.stringify({ latitude: DEMO.site.lat, longitude: DEMO.site.lng, depth: 1.2, width: 2, length: 3, purpose: 'Utility jointing' }) }), 'create locate request');
    locateReq = res.data;
    must(await json(`/api/locate-requests/${locateReq.id}/submit`, { method: 'POST', ...engAuth, body: JSON.stringify({ ticketNumber: 'CBuD-DEMO-2026' }) }), 'submit locate request');
    must(await json(`/api/locate-requests/${locateReq.id}/confirm`, { method: 'POST', ...engAuth, body: JSON.stringify({ ticketNumber: 'CBuD-DEMO-2026' }) }), 'confirm locate request');
    log(`locate request ${locateReq.id}: drafted + submitted + confirmed`);
  } else {
    log(`locate request ${locateReq.id}: reused (status ${locateReq.status})`);
  }

  // ── 4. Dig plan + engineer approval + clearance certificate ─────────
  let plan = null;
  {
    const existing = must(await json('/api/plans', workerAuth), 'list plans');
    plan = existing.data?.find((p) => p.name === DEMO.site.name) || null;
    if (!plan) {
      const res = must(await json('/api/plans', { method: 'POST', ...workerAuth, body: JSON.stringify({
        name: DEMO.site.name,
        excavation: { point: { lat: DEMO.site.lat, lng: DEMO.site.lng }, depth: 1.2, width: 2, length: 3, purpose: 'Utility jointing' },
        result: { overall: analysis.data?.digSafeScore, level: analysis.data?.riskLevel },
      }) }), 'create plan');
      plan = res.data;
      log(`plan ${plan.id}: created (${plan.reviewStatus || 'PENDING'})`);
    }
    if ((plan.reviewStatus || 'PENDING') !== 'APPROVED') {
      must(await json(`/api/plans/${plan.id}`, { method: 'PATCH', ...engAuth, body: JSON.stringify({ reviewStatus: 'APPROVED' }) }), 'approve plan');
      log(`plan ${plan.id}: approved`);
    } else {
      log(`plan ${plan.id}: already approved — reusing`);
    }
    // Certificate issuance is idempotent: reuses an existing one if present.
    const cert = must(await json(`/api/certificates/plans/${plan.id}`, engAuth), 'issue certificate');
    log(`certificate: ${cert.data?.certificate?.id || '—'} code=${cert.data?.certificate?.verificationCode || '—'}`);
  }

  // ── 5. Field GPS check-in (raises an alarm near the gas line) ───────
  const checkin = must(await json('/api/devices/gps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'FIELD-DEMO', latitude: DEMO.site.lat, longitude: DEMO.site.lng, timestamp: Date.now() }) }), 'gps check-in');
  log(`gps check-in: score=${checkin.data?.digSafeScore} level=${checkin.data?.riskLevel} alert=${checkin.data?.alert}`);

  // ── 6. Gas-sensor ALERT (raises/keeps an incident) + a normal reading ─
  const alertReading = must(await json('/api/sensors/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sensorId: DEMO.sensor, type: 'gas', value: 420, latitude: DEMO.site.lat, longitude: DEMO.site.lng, timestamp: Date.now() }) }), 'sensor alert');
  const normalReading = must(await json('/api/sensors/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sensorId: DEMO.sensor, type: 'gas', value: 20, latitude: DEMO.site.lat, longitude: DEMO.site.lng, timestamp: Date.now() }) }), 'sensor normal reading');
  log(`sensor: alert=${alertReading.data?.status} (${alertReading.data?.value} ppm), latest=${normalReading.data?.status} (${normalReading.data?.value} ppm)`);

  // ── 7. Summary ──────────────────────────────────────────────────────
  const summary = must(await json('/api/analytics/summary', engAuth), 'analytics summary');
  const t = summary.data.totals;
  log('— summary —');
  log(`analyses=${t.excavationsAnalyzed} utilities=${t.utilityRecords} incidents=${summary.data.incidents.total}`);
  log(`plans approved=${summary.data.plans.approved} certificates=${summary.data.certificates.issued}`);
  log(`locate cleared=${summary.data.locate.cleared}/${summary.data.locate.total} devices=${summary.data.devices.active} sensors=${summary.data.sensors.active}`);

  log(`Login: ${DEMO.engineer.email} / ${DEMO.engineer.password}  and  ${DEMO.worker.email} / ${DEMO.worker.password}`);
  log('Done.');
} catch (err) {
  console.error('[seed] FAILED:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
  process.exit(process.exitCode || 0);
}