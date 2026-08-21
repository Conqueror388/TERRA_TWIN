// Thin client for the TerraTwin backend. Vite proxies /api -> the Express
// server in dev (see vite.config.js). All calls fail soft to null so pages
// can fall back to local/simulated data while the backend is still stubbed.

const BASE_URL = '/api';
const TOKEN_KEY = 'terratwin_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Friendly message when Google's Firestore free-tier quota is exhausted
// (backend returns 500 with "8 RESOURCE_EXHAUSTED: Quota exceeded.").
const QUOTA_PATTERN = /quota|resource_exhausted/i;
export function quotaError(body) {
  const raw = (body && (body.error || body.message)) || '';
  if (!QUOTA_PATTERN.test(raw)) return null;
  return 'The live database read quota is exhausted (Firestore free tier). It resets daily — or upgrade the Firebase project to the Blaze plan. Until then this screen falls back to cached/local data.';
}

async function request(path, options = {}) {
  try {
    const token = getToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...options,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(quotaError(body) || body.error || `${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[api] ${path} failed, falling back to local data:`, err.message);
    return null;
  }
}

const CACHE_KEY = (key) => `terratwin_cache_${key}`;

// Offline-capable read: serves fresh data when online (and re-syncs the
// local snapshot), and the last-known snapshot when the backend is
// unreachable — so the registry "map" keeps working in the field with no
// network. Mutations always go to the network and are never cached.
async function cachedRead(path, key) {
  const fresh = await request(path);
  if (fresh != null) {
    try {
      localStorage.setItem(CACHE_KEY(key), JSON.stringify({ at: Date.now(), data: fresh }));
    } catch { /* storage full — ignore */ }
    return fresh;
  }
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY(key)) || 'null');
    if (hit && hit.data) return hit.data;
  } catch { /* corrupted cache — ignore */ }
  return null;
}

// Auth calls need to surface *why* something failed (wrong password, email
// taken) rather than fail-soft to null like the rest of this client.
async function authRequest(path, options = {}) {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: quotaError(body) || body.error || `${res.status} ${res.statusText}` };
    return { ok: true, data: body };
  } catch (err) {
    return { ok: false, error: `Can't reach the backend (${err.message}). Is it running?` };
  }
}

// Like authRequest — surfaces the real error (e.g. "locate request required")
// instead of failing soft to null, for actions where the reason a call was
// rejected matters to the user, not just that it failed.
async function strictRequest(path, options = {}) {
  try {
    const token = getToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: quotaError(body) || body.error || `${res.status} ${res.statusText}`, code: body.code };
    return { ok: true, data: body };
  } catch (err) {
    return { ok: false, error: `Can't reach the backend (${err.message}). Is it running?` };
  }
}

export const api = {
  getUtilities: () => cachedRead('/utilities', 'utilities'),
  getOsmPipes: (lat, lng, radius = 1000) =>
    request(`/osm?lat=${lat}&lng=${lng}&radius=${radius}`),
  quickRegisterUtility: (payload) =>
    request('/utilities/quick-register', { method: 'POST', body: JSON.stringify(payload) }),
  quickRegisterUtilityStrict: (payload) =>
    strictRequest('/utilities/quick-register', { method: 'POST', body: JSON.stringify(payload) }),
  deleteUtility: (id) =>
    request(`/utilities/${id}`, { method: 'DELETE' }),
  deleteUtilityStrict: (id) =>
    strictRequest(`/utilities/${id}`, { method: 'DELETE' }),
  analyzeExcavation: (payload) =>
    request('/excavations/analyze', { method: 'POST', body: JSON.stringify(payload) }),

  // Live excavation monitoring (Phase 11) — gated on a confirmed locate
  // request, so this uses strictRequest to surface *why* a start was
  // rejected (e.g. LOCATE_REQUEST_REQUIRED) rather than failing to null.
  startExcavation: (payload) => strictRequest('/excavations', { method: 'POST', body: JSON.stringify(payload) }),
  listExcavations: () => request('/excavations'),
  updateExcavation: (id, patch) => request(`/excavations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // Locate-request workflow (811 / one-call) — the thing that actually
  // authorizes a dig, as opposed to the DigSafe score.
  draftLocateRequest: (payload) => strictRequest('/locate-requests', { method: 'POST', body: JSON.stringify(payload) }),
  listLocateRequests: () => request('/locate-requests'),
  getLocateStatus: (lat, lng) => request(`/locate-requests/status?lat=${lat}&lng=${lng}`),
  submitLocateRequest: (id, payload) => strictRequest(`/locate-requests/${id}/submit`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  confirmLocateRequest: (id, payload) => strictRequest(`/locate-requests/${id}/confirm`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  overrideLocateRequest: (id, payload) => strictRequest(`/locate-requests/${id}/override`, { method: 'POST', body: JSON.stringify(payload || {}) }),

  // Field device (ESP32 GPS) check-ins (Phases 9-10)
  listDevices: () => request('/devices'),
  reportDeviceCheckin: (payload) => request('/devices/gps', { method: 'POST', body: JSON.stringify(payload) }),

  // Device-alarm incidents (HIGH/CRITICAL check-ins) — OPEN → ACKNOWLEDGED → RESOLVED
  listIncidents: () => request('/incidents'),
  updateIncident: (id, patch) => request(`/incidents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // IoT site sensors (gas/vibration/water) — telemetry feed + latest per sensor
  reportSensorTelemetry: (payload) => request('/sensors/telemetry', { method: 'POST', body: JSON.stringify(payload) }),
  listSensors: async () => (await request('/sensors'))?.sensors || [],
  listSensorTelemetry: async (limit = 50) => (await request(`/sensors/telemetry?limit=${limit}`))?.readings || [],
  getSensorTypes: async () => (await request('/sensors/types'))?.types || {},

  // Discovery reports + AI verification + engineer approval (Phases 12-15)
  reportDiscovery: (payload) =>
    request('/discoveries', { method: 'POST', body: JSON.stringify(payload) }),
  listDiscoveries: () => request('/discoveries'),
  verifyDiscovery: (id) => request(`/discoveries/${id}/verify`, { method: 'POST' }),
  approveDiscovery: (id, payload) =>
    request(`/discoveries/${id}/approve`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  rejectDiscovery: (id, payload) =>
    request(`/discoveries/${id}/reject`, { method: 'POST', body: JSON.stringify(payload || {}) }),

  askAssistant: (question, context) =>
    request('/assistant', { method: 'POST', body: JSON.stringify({ question, context }) }),

  // SPARK — site-wide assistant that answers questions about the whole platform.
  askSpark: (question, page) =>
    request('/assistant', { method: 'POST', body: JSON.stringify({ question, context: null, mode: 'site', page }) }),

  // Real usage aggregates for Analytics + Overview (Phase 17)
  getAnalytics: () => request('/analytics'),

  // Engineer/admin compliance + ROI summary and printable report (Phase 18)
  getAnalyticsSummary: () => request('/analytics/summary'),
  openAnalyticsReport: async () => {
    try {
      const token = getToken();
      const res = await fetch(`${BASE_URL}/analytics/report`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
      return true;
    } catch (err) {
      console.warn('[api] analytics report failed:', err.message);
      return false;
    }
  },

  // Engineer-only audit trail (who did what, when — server-side log)
  getAuditLog: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    ).toString();
    return request(`/audit${qs ? `?${qs}` : ''}`);
  },

  // Admin-only user administration (list, set role, activate/deactivate)
  listUsers: () => request('/users'),
  updateUser: (id, patch) => request(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // Server-persisted dig plans — the shared engineer review queue
  createPlan: (payload) => request('/plans', { method: 'POST', body: JSON.stringify(payload) }),
  listPlans: () => request('/plans'),
  reviewPlan: (id, reviewStatus) => request(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify({ reviewStatus }) }),
  deletePlan: (id) => request(`/plans/${id}`, { method: 'DELETE' }),

  // DigSafe clearance certificates for approved plans (permit workflow).
  getPlanCertificate: (planId) => request(`/certificates/plans/${planId}`),
  getPlanCertificateDocument: async (planId) => {
    try {
      const token = getToken();
      const res = await fetch(`${BASE_URL}/certificates/plans/${planId}/document`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return { blob: await res.blob(), filename: `terratwin-clearance-${planId}.html` };
    } catch (err) {
      console.warn(`[api] certificate document for ${planId} failed:`, err.message);
      return null;
    }
  },
  verifyCertificate: (code) => request(`/certificates/verify?code=${encodeURIComponent(code)}`),

  // Multi-year registry ledger (engineer/admin) — every asset added/removed
  getRegistryHistory: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''))
    ).toString();
    return request(`/registry/history${qs ? `?${qs}` : ''}`);
  },

  // Bulk utility-data ingestion (engineer/admin) — upload a GeoJSON/CSV/JSON
  // dataset straight into the registry with provenance. Returns a summary of
  // what imported vs. duplicates/invalid rows skipped.
  importUtilities: async (file) => {
    try {
      const token = getToken();
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${BASE_URL}/imports/utilities`, {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `${res.status} ${res.statusText}` };
      return { ok: true, data: body };
    } catch (err) {
      return { ok: false, error: `Can't reach the backend (${err.message}). Is it running?` };
    }
  },
  getImportTemplate: async () => {
    try {
      const token = getToken();
      const res = await fetch(`${BASE_URL}/imports/template`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return { blob: await res.blob(), filename: 'terratwin-utilities-template.csv' };
    } catch (err) {
      console.warn('[api] import template download failed:', err.message);
      return null;
    }
  },

  // GIS exports — downloads the raw file (GeoJSON/CSV/KML), so it can't use
  // request() which forces JSON. Returns { blob, filename } or null.
  exportFile: async (kind, format) => {
    try {
      const token = getToken();
      const res = await fetch(`${BASE_URL}/export/${kind}?format=${format}`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^";]+)"?/);
      return { blob: await res.blob(), filename: match ? match[1] : `terratwin-${kind}.${format}` };
    } catch (err) {
      console.warn(`[api] export ${kind}.${format} failed:`, err.message);
      return null;
    }
  },

  // Discovery report photo upload (Phase 12) — multipart, so it can't reuse
  // the JSON request() helper above.
  uploadPhoto: async (file) => {
    try {
      const form = new FormData();
      form.append('photo', file);
      const res = await fetch(`${BASE_URL}/uploads/photo`, { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      console.warn('[api] photo upload failed:', err.message);
      return null;
    }
  },

  // Authentication (Phase 18) — worker/engineer role separation
  register: (payload) => authRequest('/auth/register', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) => authRequest('/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  me: () => request('/auth/me'),
  // Exchange a 30-day refresh token for a new 8h access token.
  refreshToken: (refreshToken) => authRequest('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
  // Log the sign-out event server-side (best-effort; token is discarded client-side).
  logout: () => request('/auth/logout', { method: 'POST' }),
};
