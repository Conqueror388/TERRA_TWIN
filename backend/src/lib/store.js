// Minimal in-memory store, used as a fallback when Firestore isn't
// configured or when its API quota is exhausted (RESOURCE_EXHAUSTED).
// Same shape as the Firebase collections in the plan so swapping in real
// Firestore or falling back dynamically is a seamless runtime operation.

import { getFirestore } from './firebase.js';

const memory = {
  excavations: [],
  discovery_reports: [],
  approved_utilities: [], // Phase 15: discoveries an engineer has approved
  device_readings: [], // Phase 9-10: raw ESP32 GPS check-ins
  risk_assessments: [], // every /analyze call — powers Analytics with real usage data
  users: [],
  locate_requests: [], // 811/one-call locate-request drafts + confirmations, gates live excavation start
  audit_logs: [], // append-only action log — who did what, when (audit trail)
  incidents: [], // HIGH/CRITICAL device-alarm incidents: OPEN -> ACKNOWLEDGED -> RESOLVED
  plans: [], // worker dig plans saved to the server: PENDING -> APPROVED/REJECTED
  registry_history: [], // multi-currency ledger: every registry add/remove, append-only
  certificates: [], // DigSafe clearance certificates issued for approved plans
  sensors: [], // latest telemetry per site sensor (gas/vibration/water)
  sensor_readings: [], // rolling telemetry feed from site sensors
};

let excavationSeq = 1;
let discoverySeq = 1;
let utilitySeq = 1;
let readingSeq = 1;
let assessmentSeq = 1;
let userSeq = 1;
let locateSeq = 1;
let auditSeq = 1;
let incidentSeq = 1;
let planSeq = 1;
let historySeq = 1;
let certSeq = 1;

/**
 * Execute a Firestore operation. If it fails (e.g. quota exceeded / RESOURCE_EXHAUSTED,
 * permission denied, or network offline), catches the error, logs a warning,
 * and executes the fallback operation.
 */
async function safeDb(op, fallback) {
  const db = getFirestore();
  if (db) {
    try {
      return await op(db);
    } catch (err) {
      console.warn('[firebase] Firestore query failed (e.g., quota exceeded), falling back to memory store:', err.message);
    }
  }
  return typeof fallback === 'function' ? fallback() : fallback;
}

// ---------------------------------------------------------------- excavations

export async function saveExcavation(record) {
  const withId = { id: `EX${String(excavationSeq++).padStart(3, '0')}`, ...record };
  return safeDb(
    async (db) => {
      await db.collection('excavations').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.excavations.push(withId);
      return withId;
    }
  );
}

export async function listExcavations() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('excavations').get();
      return snap.docs.map((d) => d.data());
    },
    memory.excavations
  );
}

export async function updateExcavation(id, patch) {
  return safeDb(
    async (db) => {
      const ref = db.collection('excavations').doc(id);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const updated = { ...doc.data(), ...patch };
      await ref.set(updated);
      return updated;
    },
    () => {
      const idx = memory.excavations.findIndex((e) => e.id === id);
      if (idx === -1) return null;
      memory.excavations[idx] = { ...memory.excavations[idx], ...patch };
      return memory.excavations[idx];
    }
  );
}

// ------------------------------------------------------------ discoveries

export async function saveDiscoveryReport(record) {
  const withId = { id: `DR${String(discoverySeq++).padStart(3, '0')}`, status: 'PENDING REVIEW', ...record };
  return safeDb(
    async (db) => {
      await db.collection('discovery_reports').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.discovery_reports.push(withId);
      return withId;
    }
  );
}

export async function listDiscoveryReports() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('discovery_reports').get();
      return snap.docs.map((d) => d.data());
    },
    memory.discovery_reports
  );
}

export async function getDiscoveryReport(id) {
  return safeDb(
    async (db) => {
      const doc = await db.collection('discovery_reports').doc(id).get();
      return doc.exists ? doc.data() : null;
    },
    () => memory.discovery_reports.find((d) => d.id === id) || null
  );
}

export async function updateDiscoveryReport(id, patch) {
  return safeDb(
    async (db) => {
      const ref = db.collection('discovery_reports').doc(id);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const updated = { ...doc.data(), ...patch };
      await ref.set(updated);
      return updated;
    },
    () => {
      const idx = memory.discovery_reports.findIndex((d) => d.id === id);
      if (idx === -1) return null;
      memory.discovery_reports[idx] = { ...memory.discovery_reports[idx], ...patch };
      return memory.discovery_reports[idx];
    }
  );
}

// ------------------------------------------------- approved utilities (Phase 15)
// Engineer-approved discovery reports become real utility records. These are
// kept separate from the static simulated registry (data/utilities.js) and
// merged onto it when the frontend requests /api/utilities, so the Digital
// Twin and risk engine see them on the next analysis without a redeploy.

export async function addApprovedUtility(record) {
  const withId = { id: `UT-D${String(utilitySeq++).padStart(3, '0')}`, ...record };
  return safeDb(
    async (db) => {
      await db.collection('utilities').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.approved_utilities.push(withId);
      return withId;
    }
  );
}

export async function listApprovedUtilities() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('utilities').get();
      return snap.docs.map((d) => d.data());
    },
    memory.approved_utilities
  );
}

export async function deleteApprovedUtility(id) {
  return safeDb(
    async (db) => {
      await db.collection('utilities').doc(id).delete();
      return true;
    },
    () => {
      const idx = memory.approved_utilities.findIndex((u) => u.id === id);
      if (idx !== -1) {
        memory.approved_utilities.splice(idx, 1);
        return true;
      }
      return false;
    }
  );
}

// --------------------------------------------------- device GPS readings (Phase 9-10)
// Raw check-ins from the ESP32 + NEO-6M field unit. We keep a short rolling
// history and expose "latest reading per device" for the dashboard's live
// GPS view — the excavation record itself is a separate, richer concept
// created explicitly via /api/excavations when a worker presses START.

export async function saveDeviceReading(record) {
  const withId = { id: `GPS${String(readingSeq++).padStart(5, '0')}`, ...record };
  return safeDb(
    async (db) => {
      await db.collection('device_readings').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.device_readings.push(withId);
      if (memory.device_readings.length > 500) memory.device_readings.shift();
      return withId;
    }
  );
}

export async function listLatestDeviceReadings() {
  const all = await safeDb(
    async (db) => {
      const snap = await db.collection('device_readings').orderBy('receivedAt', 'desc').limit(300).get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.device_readings].reverse()
  );
  const latestByDevice = new Map();
  for (const r of all) {
    if (!latestByDevice.has(r.deviceId)) latestByDevice.set(r.deviceId, r);
  }
  return [...latestByDevice.values()];
}

// ------------------------------------------------- risk assessments (Analytics)
// Every call to POST /api/excavations/analyze is logged here, independent of
// whether the worker goes on to actually start the dig. This is what lets
// Analytics report real "excavations analyzed this month" / "risk mix" /
// "prevented high-risk digs" numbers instead of hardcoded mock arrays.

export async function saveRiskAssessment(record) {
  const withId = { id: `RA${String(assessmentSeq++).padStart(5, '0')}`, ...record };
  return safeDb(
    async (db) => {
      await db.collection('risk_assessments').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.risk_assessments.push(withId);
      if (memory.risk_assessments.length > 2000) memory.risk_assessments.shift();
      return withId;
    }
  );
}

export async function listRiskAssessments() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('risk_assessments').orderBy('analyzedAt', 'desc').limit(1000).get();
      return snap.docs.map((d) => d.data());
    },
    memory.risk_assessments
  );
}

// ------------------------------------------------------------------- users
// Phase 18 (Authentication). Passwords are stored pre-hashed by the auth
// route — this module never sees a plaintext password. Email is used as the
// natural lookup key; Firestore doc IDs are still the generated userSeq id
// so this matches the same fallback pattern as every other collection here.

export async function createUser(record) {
  const withId = { id: `U${String(userSeq++).padStart(4, '0')}`, ...record };
  return safeDb(
    async (db) => {
      await db.collection('users').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.users.push(withId);
      return withId;
    }
  );
}

export async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return safeDb(
    async (db) => {
      const snap = await db.collection('users').where('email', '==', normalized).limit(1).get();
      return snap.empty ? null : snap.docs[0].data();
    },
    () => memory.users.find((u) => u.email === normalized) || null
  );
}

export async function findUserById(id) {
  return safeDb(
    async (db) => {
      const doc = await db.collection('users').doc(id).get();
      return doc.exists ? doc.data() : null;
    },
    () => memory.users.find((u) => u.id === id) || null
  );
}

export async function listUsers() {
  const usersList = await safeDb(
    async (db) => {
      const snap = await db.collection('users').get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.users]
  );
  return usersList.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

export async function updateUser(id, patch) {
  return safeDb(
    async (db) => {
      const ref = db.collection('users').doc(id);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const updated = { ...doc.data(), ...patch };
      await ref.set(updated);
      return updated;
    },
    () => {
      const idx = memory.users.findIndex((u) => u.id === id);
      if (idx === -1) return null;
      memory.users[idx] = { ...memory.users[idx], ...patch };
      return memory.users[idx];
    }
  );
}

// ------------------------------------------------- locate requests (811 / one-call)
// TerraTwin does not know what's actually underground — nobody does without a
// physical locate. This collection tracks the one thing that *does* prevent
// utility strikes: a locate request being filed and confirmed before digging
// starts. `POST /api/excavations` checks this before allowing a dig to begin.

export async function saveLocateRequest(record) {
  const withId = {
    id: `LR${String(locateSeq++).padStart(4, '0')}`,
    status: 'DRAFTED', // DRAFTED -> SUBMITTED -> CONFIRMED  (or OVERRIDDEN by an engineer)
    createdAt: new Date().toISOString(),
    ...record,
  };
  return safeDb(
    async (db) => {
      await db.collection('locate_requests').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.locate_requests.push(withId);
      return withId;
    }
  );
}

export async function listLocateRequests() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('locate_requests').get();
      return snap.docs.map((d) => d.data());
    },
    memory.locate_requests
  );
}

export async function getLocateRequest(id) {
  return safeDb(
    async (db) => {
      const doc = await db.collection('locate_requests').doc(id).get();
      return doc.exists ? doc.data() : null;
    },
    () => memory.locate_requests.find((l) => l.id === id) || null
  );
}

export async function updateLocateRequest(id, patch) {
  return safeDb(
    async (db) => {
      const ref = db.collection('locate_requests').doc(id);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const updated = { ...doc.data(), ...patch };
      await ref.set(updated);
      return updated;
    },
    () => {
      const idx = memory.locate_requests.findIndex((l) => l.id === id);
      if (idx === -1) return null;
      memory.locate_requests[idx] = { ...memory.locate_requests[idx], ...patch };
      return memory.locate_requests[idx];
    }
  );
}

// --------------------------------------------------------------- audit trail
// Append-only action log: every state-changing event (auth, dig starts,
// discovery reviews, locate overrides) writes an immutable entry with who,
// what, when, and where. Entries are never mutated or deleted — this is the
// record a government security review reads to verify accountability.

export async function saveAuditLog(entry) {
  const withId = { id: `AU${String(auditSeq++).padStart(6, '0')}`, ...entry };
  return safeDb(
    async (db) => {
      await db.collection('audit_logs').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.audit_logs.push(withId);
      // Append-only, but bound growth so a long-running dev backend can't
      // grow unbounded; production Firestore has no such cap.
      if (memory.audit_logs.length > 5000) memory.audit_logs.shift();
      return withId;
    }
  );
}

export async function listAuditLogs() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('audit_logs').orderBy('at', 'desc').limit(2000).get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.audit_logs].reverse()
  );
}

// ----------------------------------------------------------------- incidents
// Device alarm incidents. Created automatically when a field device check-in
// scores HIGH or CRITICAL, kept OPEN until a human acknowledges, then RESOLVED
// after the situation is addressed. A device leaving the danger zone never
// auto-closes an incident — clearing it is a deliberate, audited action.

export async function saveIncident(record) {
  const withId = { id: `INC${String(incidentSeq++).padStart(5, '0')}`, ...record };
  return safeDb(
    async (db) => {
      await db.collection('incidents').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.incidents.push(withId);
      if (memory.incidents.length > 2000) memory.incidents.shift();
      return withId;
    }
  );
}

export async function listIncidents() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('incidents').orderBy('createdAt', 'desc').limit(500).get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.incidents].reverse()
  );
}

export async function getIncident(id) {
  return safeDb(
    async (db) => {
      const doc = await db.collection('incidents').doc(id).get();
      return doc.exists ? doc.data() : null;
    },
    () => memory.incidents.find((i) => i.id === id) || null
  );
}

export async function updateIncident(id, patch) {
  return safeDb(
    async (db) => {
      const ref = db.collection('incidents').doc(id);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const updated = { ...doc.data(), ...patch };
      await ref.set(updated);
      return updated;
    },
    () => {
      const idx = memory.incidents.findIndex((i) => i.id === id);
      if (idx === -1) return null;
      memory.incidents[idx] = { ...memory.incidents[idx], ...patch };
      return memory.incidents[idx];
    }
  );
}

// -------------------------------------------------------------------- plans
// Worker dig plans saved to the server (the official review queue). A plan
// starts PENDING, an engineer flips it to APPROVED or REJECTED, and every
// step is on the audit trail. Central storage means the queue is shared
// across devices instead of living in one browser's localStorage.

export async function savePlan(record) {
  const withId = { id: `P${String(planSeq++).padStart(4, '0')}`, ...record };
  return safeDb(
    async (db) => {
      await db.collection('plans').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.plans.push(withId);
      if (memory.plans.length > 2000) memory.plans.shift();
      return withId;
    }
  );
}

export async function listPlans() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('plans').get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.plans]
  );
}

export async function getPlan(id) {
  return safeDb(
    async (db) => {
      const doc = await db.collection('plans').doc(id).get();
      return doc.exists ? doc.data() : null;
    },
    () => memory.plans.find((p) => p.id === id) || null
  );
}

export async function updatePlan(id, patch) {
  return safeDb(
    async (db) => {
      const ref = db.collection('plans').doc(id);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const updated = { ...doc.data(), ...patch };
      await ref.set(updated);
      return updated;
    },
    () => {
      const idx = memory.plans.findIndex((p) => p.id === id);
      if (idx === -1) return null;
      memory.plans[idx] = { ...memory.plans[idx], ...patch };
      return memory.plans[idx];
    }
  );
}

export async function deletePlan(id) {
  return safeDb(
    async (db) => {
      await db.collection('plans').doc(id).delete();
      return true;
    },
    () => {
      const idx = memory.plans.findIndex((p) => p.id === id);
      if (idx === -1) return false;
      memory.plans.splice(idx, 1);
      return true;
    }
  );
}

// --------------------------------------------------- clearance certificates
// DigSafe clearance certificates are issued once per APPROVED plan and reused
// (never re-issued) on later requests, so a certificate number and its
// verification code stay stable for the life of the job. A certificate is the
// official, printable document an excavator shows a site inspector or the
// permitting authority to prove the dig was risk-checked and approved.

export async function saveCertificate(record) {
  const withId = {
    id: `CERT-${String(certSeq++).padStart(5, '0')}`,
    verificationCode: record.verificationCode,
    planId: record.planId,
    plan: record.plan,
    analysis: record.analysis || null,
    locate: record.locate || null,
    issuedAt: record.issuedAt || new Date().toISOString(),
    issuedBy: record.issuedBy || { name: 'system' },
  };
  return safeDb(
    async (db) => {
      await db.collection('certificates').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.certificates.push(withId);
      return withId;
    }
  );
}

export async function getCertificateByPlanId(planId) {
  return safeDb(
    async (db) => {
      const snap = await db.collection('certificates').where('planId', '==', planId).limit(1).get();
      return snap.empty ? null : snap.docs[0].data();
    },
    () => memory.certificates.find((c) => c.planId === planId) || null
  );
}

export async function getCertificateByCode(code) {
  return safeDb(
    async (db) => {
      const snap = await db.collection('certificates').where('verificationCode', '==', String(code)).limit(1).get();
      return snap.empty ? null : snap.docs[0].data();
    },
    () => memory.certificates.find((c) => c.verificationCode === String(code)) || null
  );
}

export async function listCertificates() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('certificates').orderBy('issuedAt', 'desc').limit(500).get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.certificates].reverse()
  );
}

// ------------------------------------------------------- registry history
// Multi-year asset ledger. Static seed utilities are the official baseline;
// every record that enters, leaves, or changes the registry is appended here
// with who did it, when, and a snapshot of the record. This collection is
// never mutated or deleted — it is the versioned history that powers the
// Registry History page and per-asset provenance in the Digital Twin.

export async function saveRegistryHistory(entry) {
  const withId = {
    id: `REG${String(historySeq++).padStart(6, '0')}`,
    event: entry.event || 'CHANGED', // CREATED | DELETED | UPDATED | IMPORTED
    utilityId: entry.utilityId || null,
    utility: entry.utility || null,
    origin: entry.origin || 'registry', // discovery-approval | quick-register | registry-delete
    actor: entry.actor || { id: null, name: 'system', email: null, role: 'system' },
    at: entry.at || new Date().toISOString(),
    summary: entry.summary || '',
    meta: entry.meta || {},
  };
  return safeDb(
    async (db) => {
      await db.collection('registry_history').doc(withId.id).set(withId);
      return withId;
    },
    () => {
      memory.registry_history.push(withId);
      if (memory.registry_history.length > 5000) memory.registry_history.shift();
      return withId;
    }
  );
}

export async function listRegistryHistory() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('registry_history').orderBy('at', 'desc').limit(2000).get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.registry_history].reverse()
  );
}

export async function findUtilityRecord(id) {
  const all = await listApprovedUtilities();
  const found = all.find((u) => u.id === id);
  if (found) return found;
  try {
    const { UTILITIES } = await import('../data/utilities.js');
    return UTILITIES.find((u) => u.id === id) || null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- site sensors
// IoT site telemetry (gas/vibration/water). Every reading is appended to a
// rolling feed; the latest reading per sensor id drives the monitoring cards.
// ALERT-level readings raise an incident so the existing OPEN->ACK->RESOLVED
// lifecycle applies to sensor alarms exactly as it does to GPS check-in alarms.

export async function saveSensorReading(record) {
  const withId = {
    id: `SR${String(readingSeq++).padStart(5, '0')}`,
    receivedAt: new Date().toISOString(),
    ...record,
  };
  return safeDb(
    async (db) => {
      await db.collection('sensor_readings').doc(withId.id).set(withId);
      await db.collection('sensors').doc(record.sensorId).set({
        sensorId: record.sensorId,
        type: record.type,
        unit: record.unit,
        value: record.value,
        status: record.status,
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        receivedAt: withId.receivedAt,
      });
      return withId;
    },
    () => {
      memory.sensor_readings.push(withId);
      if (memory.sensor_readings.length > 1000) memory.sensor_readings.shift();
      const latest = {
        sensorId: record.sensorId,
        type: record.type,
        unit: record.unit,
        value: record.value,
        status: record.status,
        latitude: record.latitude ?? null,
        longitude: record.longitude ?? null,
        receivedAt: withId.receivedAt,
      };
      const idx = memory.sensors.findIndex((s) => s.sensorId === record.sensorId);
      if (idx !== -1) memory.sensors[idx] = latest;
      else memory.sensors.push(latest);
      return withId;
    }
  );
}

export async function listLatestSensors() {
  return safeDb(
    async (db) => {
      const snap = await db.collection('sensors').orderBy('receivedAt', 'desc').limit(500).get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.sensors]
  );
}

export async function listSensorReadings(limit) {
  const n = Number.isFinite(parseInt(limit, 10)) ? Math.min(parseInt(limit, 10), 500) : 50;
  return safeDb(
    async (db) => {
      const snap = await db.collection('sensor_readings').orderBy('receivedAt', 'desc').limit(n).get();
      return snap.docs.map((d) => d.data());
    },
    () => [...memory.sensor_readings].reverse().slice(0, n)
  );
}
