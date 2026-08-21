import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useLanguage } from '../lib/useLanguage';

// Mobile field app — the worker's phone as a live tracking + alarm unit.
//   1. Streams GPS to /api/devices/gps (deviceId FIELD-<user>) so Live
//      Monitoring and the engineer dashboard see where every worker is.
//      HIGH/CRITICAL positions raise server-side incidents automatically.
//   2. Shows OPEN incidents near the worker with one-tap Acknowledge/Resolve.
//   3. Works offline: incidents are cached to localStorage, and any ack made
//      while unreachable is queued and flushed when the backend is back.

const FIELD_QUEUE_KEY = 'terratwin_field_queue';
const FIELD_POS_KEY = 'terratwin_field_lastpos';

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function persist(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function distM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const LEVEL_BADGE = {
  LOW: 'bg-[var(--bg-panel-2)] text-green',
  MEDIUM: 'bg-[var(--bg-panel-2)] text-amber',
  HIGH: 'bg-[var(--bg-panel-2)] text-red',
  CRITICAL: 'bg-[var(--bg-panel-2)] text-[#FF6B5E]',
};

const STATUS_BADGE = {
  OPEN: 'bg-[var(--bg-panel-2)] text-red',
  ACKNOWLEDGED: 'bg-[var(--bg-panel-2)] text-amber',
  RESOLVED: 'bg-[var(--bg-panel-2)] text-green',
};

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Field() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const deviceId = `FIELD-${user?.id || 'anon'}`;

  const [gps, setGps] = useState(() => load(FIELD_POS_KEY, null));
  const [gpsErr, setGpsErr] = useState('');
  const [tracking, setTracking] = useState(false);
  const [incidents, setIncidents] = useState([]);
  const [devices, setDevices] = useState([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [lastSync, setLastSync] = useState(null);
  const [queue, setQueue] = useState(() => load(FIELD_QUEUE_KEY, []));
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');

  const lastSentRef = useRef(0);
  const onlineRef = useRef(online);
  onlineRef.current = online;

  // ── Offline action queue ────────────────────────────────────────────
  // Defined before the online/offline effect below, which reads it in its
  // dependency array — a later const would be in the temporal dead zone.
  const flushQueue = useCallback(async () => {
    if (queue.length === 0 || !navigator.onLine) return;
    const remaining = [];
    for (const item of queue) {
      const res = await api.updateIncident(item.id, { status: item.status, note: item.note });
      if (!res) remaining.push(item);
    }
    setQueue(remaining);
    persist(FIELD_QUEUE_KEY, remaining);
  }, [queue]);

  // ── Online/offline awareness ────────────────────────────────────────
  useEffect(() => {
    const goOnline = () => { setOnline(true); setLastSync(null); flushQueue(); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [flushQueue]);

  // ── Live GPS ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsErr(t('field.gpsUnsupported'));
      return;
    }
    let watchId = null;
    const success = (pos) => {
      const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy), ts: Date.now() };
      setGps(next);
      persist(FIELD_POS_KEY, next);
      setGpsErr('');
      setTracking(true);
    };
    const error = (err) => {
      setTracking(false);
      if (err.code === err.PERMISSION_DENIED) setGpsErr(t('field.permissionDenied'));
      else setGpsErr(t('field.gpsError', { msg: err.message }));
    };
    navigator.geolocation.getCurrentPosition(success, error, { enableHighAccuracy: true, timeout: 10000 });
    watchId = navigator.geolocation.watchPosition(success, error, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
    return () => watchId && navigator.geolocation.clearWatch(watchId);
  }, [t]);

  // ── Data load + check-in loop ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const loadAll = async () => {
      const [inc, dev] = await Promise.all([api.listIncidents(), api.listDevices()]);
      if (cancelled) return;
      if (inc) { setIncidents(inc); setLastSync(new Date().toISOString()); }
      if (dev) setDevices(dev);
    };

    const tick = async () => {
      if (!onlineRef.current) return;
      await loadAll();
      // Stream our position — throttled so a static worker doesn't spam.
      if (gps && Date.now() - lastSentRef.current > 15000) {
        lastSentRef.current = Date.now();
        await api.reportDeviceCheckin({ deviceId, latitude: gps.lat, longitude: gps.lng, timestamp: Date.now() });
      }
    };

    tick();
    const iv = setInterval(tick, 20000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [gps, deviceId]);

  // ── Field actions ──────────────────────────────────────────────────
  const actOnIncident = async (incident, status) => {
    const note = status === 'RESOLVED' ? 'Cleared on site by field worker' : 'Acknowledged by field worker';
    const optimistic = { ...incident, status, acknowledgedBy: user?.name, updatedAt: new Date().toISOString() };
    setIncidents((prev) => prev.map((i) => (i.id === incident.id ? optimistic : i)));
    if (online) {
      const res = await api.updateIncident(incident.id, { status, note });
      if (!res) {
        const next = [...queue, { id: incident.id, status, note, at: new Date().toISOString() }];
        setQueue(next);
        persist(FIELD_QUEUE_KEY, next);
      }
    } else {
      const next = [...queue, { id: incident.id, status, note, at: new Date().toISOString() }];
      setQueue(next);
      persist(FIELD_QUEUE_KEY, next);
    }
  };

  const openIncidents = incidents.filter((i) => i.status !== 'RESOLVED');
  const nearMe = gps
    ? devices
        .filter((d) => distM({ lat: gps.lat, lng: gps.lng }, { lat: Number(d.latitude), lng: Number(d.longitude) }) <= 300)
        .sort((a, b) => distM({ lat: gps.lat, lng: gps.lng }, { lat: Number(a.latitude), lng: Number(a.longitude) }) - distM({ lat: gps.lat, lng: gps.lng }, { lat: Number(b.latitude), lng: Number(b.longitude) }))
    : [];

  const setManual = () => {
    const lat = parseFloat(manualLat);
    const lng = parseFloat(manualLng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;
    const next = { lat, lng, accuracy: 0, ts: Date.now(), manual: true };
    setGps(next);
    persist(FIELD_POS_KEY, next);
    setGpsErr('');
  };

  return (
    <section className="mx-auto max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="font-display font-bold text-[22px]">Field</h1>
          <p className="text-[12.5px] text-[var(--text-dim)] mt-1">
            {user?.name || 'Worker'} · device <span className="font-mono text-cyan">{deviceId}</span>
          </p>
        </div>
        <span
          className={`flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1.5 rounded-md ${
            online ? 'text-green bg-green/10 border border-green/30' : 'text-amber bg-amber/10 border border-amber/30'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-green animate-pulse' : 'bg-amber'}`} />
          {online ? t('field.online') : t('field.offline')}
        </span>
      </div>

      {queue.length > 0 && (
        <button
          onClick={() => flushQueue()}
          className="w-full mb-4 flex items-center justify-between rounded-lg border border-amber/40 bg-amber/10 px-4 py-3 text-[12px] text-amber"
        >
          <span>{t('field.queueSync', { n: queue.length })}</span>
          <span className="font-semibold">{t('field.retry')}</span>
        </button>
      )}

      {/* GPS card */}
      <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10.5px] text-[var(--text-faint)] uppercase tracking-wide">{t('field.livePosition')}</div>
          <span className="flex items-center gap-1.5 text-[10.5px]">
            <span className={`w-2 h-2 rounded-full ${tracking ? 'bg-green animate-pulse' : 'bg-amber'}`} />
            {tracking ? t('field.gpsTracking') : t('field.noGpsFix')}
          </span>
        </div>

        {gps ? (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
            <div>
              <div className="font-mono text-[20px] font-bold text-cyan">{gps.lat.toFixed(6)}</div>
              <div className="text-[10px] text-[var(--text-faint)]">{t('field.latitude')} {gps.accuracy > 0 ? `±${gps.accuracy} m` : t('field.manual')}</div>
            </div>
            <div>
              <div className="font-mono text-[20px] font-bold text-cyan">{gps.lng.toFixed(6)}</div>
              <div className="text-[10px] text-[var(--text-faint)]">{t('field.longitude')} {gps.ts ? fmtTime(new Date(gps.ts).toISOString()) : ''}</div>
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-[var(--text-dim)]">{t('field.waitingFix')}</div>
        )}

        {gpsErr && <div className="mt-3 text-[11.5px] text-amber">⚠ {gpsErr}</div>}

        <div className="mt-4 flex gap-2">
          <input
            value={manualLat}
            onChange={(e) => setManualLat(e.target.value)}
            placeholder="lat"
            inputMode="decimal"
            className="flex-1 font-mono rounded-md bg-[var(--bg-panel-2)] border border-[var(--border)] px-3 h-10 text-[13px] focus:outline-none focus:border-cyan"
          />
          <input
            value={manualLng}
            onChange={(e) => setManualLng(e.target.value)}
            placeholder="lng"
            inputMode="decimal"
            className="flex-1 font-mono rounded-md bg-[var(--bg-panel-2)] border border-[var(--border)] px-3 h-10 text-[13px] focus:outline-none focus:border-cyan"
          />
          <button
            onClick={setManual}
            className="font-semibold text-[12px] px-4 h-10 rounded-md border border-cyan text-cyan hover:bg-[var(--bg-panel-2)] transition"
          >
            {t('field.set')}
          </button>
        </div>
      </div>

      {/* Open incidents */}
      <h2 className="font-display font-semibold text-[15px] mb-3">
        {t('field.alarms')} <span className="font-mono text-[11px] text-[var(--text-faint)]">{t('field.alarmsOpen', { n: openIncidents.length })}</span>
      </h2>
      {openIncidents.length === 0 ? (
        <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-10 text-center text-[12.5px] text-[var(--text-dim)] mb-5">
          {t('field.allClear')}
        </div>
      ) : (
        <div className="flex flex-col gap-3 mb-5">
          {openIncidents.map((i) => {
            const distance = gps
              ? Math.round(distM({ lat: gps.lat, lng: gps.lng }, { lat: Number(i.latitude), lng: Number(i.longitude) }))
              : null;
            return (
              <div key={i.id} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-display font-semibold text-[14px]">
                      <span className="font-mono text-[11px] text-[var(--text-faint)]">{i.deviceId}</span>
                      <span className="text-[var(--text-dim)]"> · </span>
                      <span className="font-mono text-cyan">{i.id}</span>
                    </div>
                    <div className="font-mono text-[11.5px] text-[var(--text-dim)] mt-1">
                      {Number(i.latitude).toFixed(5)}, {Number(i.longitude).toFixed(5)}
                      {distance != null && <span className="text-[var(--text-faint)]"> · {t('field.mFromYou', { n: distance })}</span>}
                    </div>
                    <div className="text-[11px] text-[var(--text-faint)] mt-1">
                      {t('field.threat')} {i.threatUtilityType || '—'} @ {i.threatUtilityDepth ?? '—'} m · hits {i.hits} · last {fmtTime(i.lastSeenAt)}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${STATUS_BADGE[i.status]}`}>{i.status}</span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${LEVEL_BADGE[i.riskLevel]}`}>{i.riskLevel} · {i.lastScore}</span>
                  </div>
                </div>
                <div className="flex gap-2.5 mt-3.5">
                  {i.status === 'OPEN' && (
                    <button
                      onClick={() => actOnIncident(i, 'ACKNOWLEDGED')}
                      className="flex-1 font-semibold text-[12.5px] py-2.5 rounded-md bg-amber/15 text-amber border border-amber/30 hover:bg-amber/25 transition"
                    >
                      {t('field.acknowledge')}
                    </button>
                  )}
                  <button
                    onClick={() => actOnIncident(i, 'RESOLVED')}
                    className="flex-1 font-semibold text-[12.5px] py-2.5 rounded-md bg-green/15 text-green border border-green/30 hover:bg-green/25 transition"
                  >
                    {t('field.resolve')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Nearby workers */}
      <h2 className="font-display font-semibold text-[15px] mb-3">
        {t('field.crewNear')} <span className="font-mono text-[11px] text-[var(--text-faint)]">{t('field.crewWithin', { n: nearMe.length })}</span>
      </h2>
      {nearMe.length === 0 ? (
        <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-8 text-center text-[12px] text-[var(--text-faint)]">
          {gps ? t('field.noCrewNear') : t('field.enableGpsCrew')}
        </div>
      ) : (
        <div className="flex flex-col gap-2 mb-5">
          {nearMe.map((d) => {
            const distance = Math.round(distM({ lat: gps.lat, lng: gps.lng }, { lat: Number(d.latitude), lng: Number(d.longitude) }));
            return (
              <div key={d.deviceId} className="flex items-center justify-between bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-3 text-[12.5px]">
                <span className="font-mono text-[var(--text-dim)]">{d.deviceId}</span>
                <span className="flex items-center gap-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${LEVEL_BADGE[d.riskLevel]}`}>{d.riskLevel} · {d.digSafeScore}</span>
                  <span className="text-[11px] text-[var(--text-faint)]">{distance} m</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="text-center text-[10.5px] text-[var(--text-faint)] pb-4">
        {lastSync ? t('field.lastSync', { time: fmtTime(lastSync) }) : ''}{t('field.disclaimer')}
      </div>
    </section>
  );
}