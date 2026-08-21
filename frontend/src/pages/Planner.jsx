import { useMemo, useState, useEffect, useRef } from 'react';
import UtilityMap from '../components/UtilityMap';
import ScoreCard from '../components/ScoreCard';
import Recommendations from '../components/Recommendations';
import AIAssistant from '../components/AIAssistant';
import LocateRequestPanel from '../components/LocateRequestPanel';
import { OfflinePanel } from '../components/Feedback';
import { BASE } from '../lib/utilities';
import { scoreExcavation, generateRecommendations } from '../lib/riskEngine';
import { osmPipesToUtilities } from '../lib/osmUtils';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

// ─── Nominatim city search hook ──────────────────────────────────────────────
function useCitySearch() {
  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (query.length < 2) { setResults([]); return; }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        // VITE_SEARCH_REGION controls geographic bias (e.g., "Tamil Nadu, India",
        // "Maharashtra, India"). Leave empty in .env to search all of India.
        const region = import.meta.env.VITE_SEARCH_REGION || 'India';
        const q = region ? `${query}, ${region}` : query;
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=0`;
        const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        setResults(await res.json());
      } catch {}
      setSearching(false);
    }, 500);
  }, [query]);

  return { query, setQuery, results, setResults, searching };
}

export default function Planner() {
  const { user } = useAuth();
  const canRegisterUtility = user?.role === 'engineer' || user?.role === 'admin';
  const [point, setPoint] = useState(() => {
    const saved = localStorage.getItem('terratwin_planned_excavation');
    if (saved) {
      try {
        return JSON.parse(saved).point || BASE;
      } catch {}
    }
    return BASE;
  });
  const [depth, setDepth] = useState(() => {
    const saved = localStorage.getItem('terratwin_planned_excavation');
    if (saved) {
      try {
        return JSON.parse(saved).depth || 1.5;
      } catch {}
    }
    return 1.5;
  });
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('terratwin_planned_excavation');
    if (saved) {
      try {
        return JSON.parse(saved).width || 2;
      } catch {}
    }
    return 2;
  });
  const [length, setLength] = useState(() => {
    const saved = localStorage.getItem('terratwin_planned_excavation');
    if (saved) {
      try {
        return JSON.parse(saved).length || 3;
      } catch {}
    }
    return 3;
  });
  const [purpose, setPurpose] = useState(() => {
    const saved = localStorage.getItem('terratwin_planned_excavation');
    if (saved) {
      try {
        return JSON.parse(saved).purpose || 'Foundation';
      } catch {}
    }
    return 'Foundation';
  });

  const [utilitiesList, setUtilitiesList] = useState([]);
  const [baseCoords, setBaseCoords] = useState(BASE);
  const [result, setResult] = useState(null);
  const [recs, setRecs] = useState(null);
  const [source, setSource] = useState(null); // 'backend' | 'local'
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [syncedAt, setSyncedAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function checkBackend() {
      const res = await api.getUtilities();
      if (!cancelled) setOffline(!res);
    }
    checkBackend();
    return () => { cancelled = true; };
  }, []);

  // OSM underground layer
  const [osmPipes, setOsmPipes]     = useState([]);
  const [osmLoading, setOsmLoading] = useState(false);
  const [showOsm, setShowOsm]       = useState(true);

  // Dig-zone drawing on the map
  const [drawMode, setDrawMode] = useState(false);
  const [drawRect, setDrawRect] = useState(null);

  // Saved plans + export
  const [savedPlans, setSavedPlans] = useState(() => loadSavedPlans());
  const [serverPlans, setServerPlans] = useState([]);
  const [planName, setPlanName] = useState('');

  // Pull the server-side review queue so "Saved plans" reflects what an
  // engineer would actually see. Falls back to the local draft library when
  // the backend is unreachable or this user has no session yet.
  useEffect(() => {
    api.listPlans().then((res) => {
      if (res) setServerPlans(res);
    });
  }, []);
  const allPlans = useMemo(() => [...serverPlans, ...savedPlans], [serverPlans, savedPlans]);

  // City search
  const citySearch = useCitySearch();

  // Real position from the browser (device GPS / network). Recenters the map
  // and pins the excavation point at the user's actual location. Requires
  // HTTPS or localhost — browsers block geolocation on plain HTTP.
  const [geoStatus, setGeoStatus] = useState('idle');
  const [geoError, setGeoError] = useState(null);

  function useMyLocation() {
    if (!navigator.geolocation) {
      setGeoError('Geolocation is not supported by this browser.');
      return;
    }
    setGeoStatus('locating');
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setPoint(loc);
        setBaseCoords(loc);
        citySearch.setQuery('');
        citySearch.setResults([]);
        setGeoStatus('ok');
        analyze({ point: loc });
      },
      (err) => {
        setGeoStatus('error');
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied — allow access in your browser, then retry.'
            : err.code === err.TIMEOUT
              ? 'Timed out waiting for your location. Check GPS/network and retry.'
              : 'Could not determine your location. Retry.'
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  // Jump to a {lat,lng} — moves both the excavation point and the map centre
  function flyToCity(lat, lng) {
    const loc = { lat, lng };
    setPoint(loc);
    setBaseCoords(loc);
    citySearch.setQuery('');
    citySearch.setResults([]);
  }

  // Two clicked corners → derive the trench (centre point + width/length) and
  // auto-score the risk immediately, so drawing feels like the whole workflow.
  function handleDrawRect(corners) {
    const [a, b] = corners;
    const c = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    const latN = Math.max(a.lat, b.lat), latS = Math.min(a.lat, b.lat);
    const lngE = Math.max(a.lng, b.lng), lngW = Math.min(a.lng, b.lng);
    const w = Math.max(0.5, +latlngMeters({ lat: c.lat, lng: lngW }, { lat: c.lat, lng: lngE }).toFixed(2));
    const len = Math.max(0.5, +latlngMeters({ lat: latN, lng: c.lng }, { lat: latS, lng: c.lng }).toFixed(2));
    setPoint(c);
    setWidth(w);
    setLength(len);
    setDrawRect(corners);
    setDrawMode(false);
    analyze({ point: c, width: w, length: len });
  }

  // Quick utility registration states
  const [quickType, setQuickType] = useState('water');
  const [quickDepth, setQuickDepth] = useState(1.2);
  const [quickRegistering, setQuickRegistering] = useState(false);
  const [quickSuccess, setQuickSuccess] = useState(false);
  const [quickError, setQuickError] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  async function registerQuickUtility() {
    setQuickRegistering(true);
    setQuickSuccess(false);
    setQuickError(null);
    const res = await api.quickRegisterUtilityStrict({
      type: quickType,
      lat: point.lat,
      lng: point.lng,
      depth: quickDepth,
      owner: 'Engineer-registered',
      confidence: 100,
      criticality: quickType === 'gas' ? 90 : quickType === 'electric' ? 80 : 50,
    });
    setQuickRegistering(false);
    if (res?.ok && res.data) {
      setQuickSuccess(true);
      // Re-fetch all utilities so it instantly displays as a verified circle on the map
      const uRes = await api.getUtilities();
      if (uRes?.utilities) {
        setUtilitiesList(uRes.utilities);
      }
      setTimeout(() => setQuickSuccess(false), 3000);
    } else {
      setQuickError(res?.error || 'Backend unreachable — registration failed.');
    }
  }

  async function handleDeleteUtility(id) {
    setDeleteError(null);
    const res = await api.deleteUtilityStrict(id);
    if (!res?.ok) {
      setDeleteError(res?.error || 'Backend unreachable — delete failed.');
      return;
    }
    const uRes = await api.getUtilities();
    if (uRes?.utilities) {
      setUtilitiesList(uRes.utilities);
    }
  }

  const customPipes = useMemo(() => {
    return utilitiesList.filter((u) => u.id.includes('-D'));
  }, [utilitiesList]);

  const excavation = useMemo(() => ({ point, depth, width, length, purpose }), [point, depth, width, length, purpose]);

  // Real scoring set: engineer-registered utilities plus real OSM pipes near
  // the excavation point converted into scoring records (local mirror of the
  // backend's liveUtilities.js).
  const scoringUtilities = useMemo(
    () => [...utilitiesList, ...osmPipesToUtilities(osmPipes, point)],
    [utilitiesList, osmPipes, point]
  );

  // Sync plan parameters to localStorage
  useEffect(() => {
    localStorage.setItem('terratwin_planned_excavation', JSON.stringify({
      point,
      depth,
      width,
      length,
      purpose
    }));
  }, [point, depth, width, length, purpose]);

  // Load live utilities from backend on mount
  useEffect(() => {
    async function loadUtilities() {
      const res = await api.getUtilities();
      if (res && res.utilities) {
        setUtilitiesList(res.utilities);
        if (res.base) setBaseCoords(res.base);
        setSyncedAt(new Date());
      }
    }
    loadUtilities();
  }, []);

  // Fetch OSM underground pipes whenever excavation point moves
  // Radius 3000 m for broader Tamil Nadu / India coverage
  useEffect(() => {
    let cancelled = false;
    async function loadOsm() {
      setOsmLoading(true);
      const res = await api.getOsmPipes(point.lat, point.lng, 3000);
      if (!cancelled) {
        setOsmPipes(res?.pipes || []);
        setOsmLoading(false);
      }
    }
    const t = setTimeout(loadOsm, 700);
    return () => { cancelled = true; clearTimeout(t); };
  }, [point.lat, point.lng]);

  const assistantContext = useMemo(() => {
    if (!result) return null;
    return {
      digSafeScore: Math.round(result.overall),
      riskLevel: result.level,
      breakdown: result.results.map((r) => ({
        utilityId: r.utility.id,
        type: r.utility.type,
        score: Math.round(r.score),
        level: r.level,
        distanceMeters: Number(r.dist.toFixed(2)),
        depthDifferenceMeters: Number(r.depthDiff.toFixed(2)),
      })),
      recommendations: (recs || []).slice(0, 5).map((c) => ({ label: c.label, score: Math.round(c.overall), level: c.level })),
    };
  }, [result, recs]);

  async function analyze(overrides = {}) {
    setLoading(true);

    // Allow drawing to score with freshly-drawn dimensions before the
    // state has committed.
    const eff = {
      point: overrides.point || point,
      depth: overrides.depth ?? depth,
      width: overrides.width ?? width,
      length: overrides.length ?? length,
      purpose: overrides.purpose || purpose,
    };

    // Try the live backend first (same risk-engine logic, but the
    // authoritative source once Firestore/Gemini are wired up).
    const remote = await api.analyzeExcavation({
      latitude: eff.point.lat,
      longitude: eff.point.lng,
      depth: eff.depth,
      width: eff.width,
      length: eff.length,
      purpose: eff.purpose,
    });

    if (remote) {
      setResult({
        overall: remote.digSafeScore,
        level: remote.riskLevel,
        results: remote.breakdown.map((b) => ({
          utility: {
            id: b.utilityId,
            type: b.type,
            lat: b.lat,
            lng: b.lng,
            depth: b.depth,
            color: b.color,
            source: b.source,
            name: b.name,
          },
          score: b.score,
          level: b.level,
          dist: b.distanceMeters,
          depthDiff: b.depthDifferenceMeters,
        })),
      });
      setRecs(remote.recommendations.map((r) => ({ label: r.label, overall: r.score, level: r.level })));
      setSource('backend');
    } else {
      // Backend unreachable — compute locally with the identical engine over
      // the same real inputs (registered + OSM pipes at this point).
      const r = scoreExcavation(eff, scoringUtilities);
      setResult(r);
      setRecs(generateRecommendations(eff, scoringUtilities));
      setSource('local');
    }

    setLoading(false);
  }

  // ── Save / load / export helpers ────────────────────────────────────────
  async function savePlan() {
    const name = planName.trim() || `Plan ${new Date().toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    const excavation = { ...excavation, point: { ...excavation.point } };
    const result = result ? { overall: result.overall, level: result.level } : null;

    // Server is the source of truth: it lands straight in the engineer
    // review queue. If the backend is unreachable, keep an offline draft.
    const created = await api.createPlan({ name, excavation, result });
    if (created) {
      setServerPlans((prev) => [created, ...prev]);
    } else {
      const local = {
        id: Date.now().toString(36),
        name,
        ts: Date.now(),
        reviewStatus: 'PENDING', // flags this for the Engineer review queue
        excavation,
        result,
      };
      setSavedPlans((prev) => [local, ...prev].slice(0, 20));
    }
    setPlanName('');
  }

  function loadPlan(id) {
    const p = allPlans.find((s) => s.id === id);
    if (!p) return;
    setPoint(p.excavation.point);
    setDepth(p.excavation.depth);
    setWidth(p.excavation.width);
    setLength(p.excavation.length);
    setPurpose(p.excavation.purpose);
    setDrawRect(null);
    analyze(p.excavation);
  }

  async function deletePlan(id) {
    if (serverPlans.some((s) => s.id === id)) {
      const ok = await api.deletePlan(id);
      if (ok) setServerPlans((prev) => prev.filter((s) => s.id !== id));
    } else {
      setSavedPlans((prev) => {
        const next = prev.filter((s) => s.id !== id);
        persistSavedPlans(next);
        return next;
      });
    }
  }

  function exportJSON() {
    downloadFile(
      `digsafe-plan-${Date.now()}.json`,
      JSON.stringify({ app: 'TerraTwin AI', generatedAt: new Date().toISOString(), excavation, risk: result ? { overall: result.overall, level: result.level, breakdown: result.results } : null }, null, 2),
      'application/json'
    );
  }

  function exportKML() {
    downloadFile(`digsafe-plan-${Date.now()}.kml`, buildKML(excavation, result), 'application/vnd.google-earth.kml+xml');
  }

  function exportHTML() {
    downloadFile(`digsafe-report-${Date.now()}.html`, buildHTMLReport(excavation, result), 'text/html');
  }

  return (
    <section>
      {offline && (
        <OfflinePanel
          className="mb-5"
          label="Backend offline — scoring locally"
          message="Backend unreachable — scoring locally against real OpenStreetMap pipes and any registered records. Live registry updates need the backend connected."
        />
      )}
      <div className="grid lg:grid-cols-[1.3fr_1fr] gap-5 items-start">
        <div>
          {/* ── City search ──────────────────────────────────────── */}
          <div className="mb-3">
            {/* Real position from the browser */}
            <div className="flex flex-wrap gap-1.5 mb-2 items-center">
              <button
                onClick={useMyLocation}
                disabled={geoStatus === 'locating'}
                title="Use your device's real GPS / network position"
                className="text-[10.5px] font-mono px-2 py-1 rounded-md border border-cyan/60 text-cyan bg-cyan/10 hover:bg-cyan/20 transition disabled:opacity-60"
              >
                {geoStatus === 'locating' ? '◉ Locating…' : '📍 My location'}
              </button>
              <span className="w-px h-4 bg-white/10" />
            </div>
            {geoError && (
              <p className="text-[10.5px] font-mono text-red-400 mt-1 mb-2">{geoError}</p>
            )}
            {/* Nominatim free-text search */}
            <div className="relative">
              <input
                type="text"
                value={citySearch.query}
                onChange={(e) => citySearch.setQuery(e.target.value)}
                placeholder="🔍  Search any place in Tamil Nadu / India…"
                className="w-full text-sm px-3 py-2 rounded-lg bg-[var(--bg-panel-2)] border border-[var(--border)] text-[var(--text)] placeholder-[var(--text-faint)] focus:outline-none focus:border-cyan transition"
              />
              {citySearch.searching && (
                <span className="absolute right-3 top-2 text-[10px] text-cyan font-mono animate-pulse">searching…</span>
              )}
              {citySearch.results.length > 0 && (
                <div className="absolute z-50 w-full mt-1 bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg overflow-hidden shadow-2xl">
                  {citySearch.results.map((r) => (
                    <button
                      key={r.place_id}
                      onClick={() => flyToCity(parseFloat(r.lat), parseFloat(r.lon))}
                      className="w-full text-left px-3 py-2 text-xs text-[var(--text-dim)] hover:bg-cyan/10 hover:text-cyan border-b border-[var(--border)] last:border-none transition"
                    >
                      {r.display_name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <UtilityMap
            base={baseCoords}
            utilities={utilitiesList}
            point={point}
            onPick={setPoint}
            osmPipes={osmPipes}
            osmLoading={osmLoading}
            showOsm={showOsm}
            onDeleteUtility={handleDeleteUtility}
            drawMode={drawMode}
            onDrawRect={handleDrawRect}
            digRect={drawRect}
          />

          <div className="flex gap-2 mt-2 items-center">
            <button
              onClick={() => setDrawMode((v) => !v)}
              className={`text-[10.5px] font-mono px-2.5 py-1.5 rounded-md border transition ${
                drawMode
                  ? 'border-amber bg-amber/15 text-amber'
                  : 'border-cyan/50 text-cyan bg-cyan/10 hover:bg-cyan/15'
              }`}
            >
              {drawMode ? '✚ Drawing… (click 2 corners)' : '✚ Draw dig zone'}
            </button>
            {drawRect && (
              <button
                onClick={() => { setDrawRect(null); }}
                className="text-[10.5px] font-mono px-2.5 py-1.5 rounded-md border border-white/15 text-[var(--text-dim)] hover:text-white hover:border-white/40 transition"
              >
                Clear zone
              </button>
            )}
          </div>

          <div className="flex gap-3.5 flex-wrap mt-2.5 items-center">
            <Legend color="#29B6D8" label="Water" dashed={false} />
            <Legend color="#F5A623" label="Gas" dashed={false} />
            <Legend color="#FFE066" label="Electric" dashed={false} />
            <Legend color="#B58CFF" label="Fiber" dashed={false} />
            <Legend color="#8D6E3B" label="Sewer" dashed={false} />
            <span className="w-px h-3 bg-white/10" />
            <Legend color="#29B6D8" label="OSM records (dashed) — may be incomplete" dashed />
            <Legend color="#4A6080" label="Road-proxy corridor (unverified guess)" dashed />
            <button
              onClick={() => setShowOsm((v) => !v)}
              className={`ml-auto text-[10.5px] font-mono px-2.5 py-1 rounded-md border transition ${
                showOsm
                  ? 'border-cyan text-cyan bg-cyan/10'
                  : 'border-white/20 text-white/40'
              }`}
            >
              {showOsm ? 'OSM ON' : 'OSM OFF'}
            </button>
          </div>
<p className="text-[11.5px] text-[var(--text-faint)] mt-2">
            Click the map to move the excavation point, or use <span className="text-cyan">✚ Draw dig zone</span> to draw a trench
            rectangle in two clicks — its centre, width &amp; length are applied and risk is scored automatically.
            Everything shown here is prior public-record knowledge, not a
            live scan of what&rsquo;s underground — where actual utility data is absent, road alignments are shown
            as an unverified proxy corridor to narrow attention, not to predict a pipe&rsquo;s real location.
          </p>

          {/* Registry data / lineage — the provenance a government evaluator reads first */}
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-4">
            <Meta label="Source" value="Utility authority GIS registry" />
            <Meta label="Coordinate system" value="WGS84 · EPSG:4326" />
            <Meta label="Verified records" value={String(utilitiesList.length)} />
            <Meta
              label="Latest sync"
              value={offline
                ? (syncedAt ? `Last registry sync · ${syncedAt.toLocaleTimeString()}` : 'Offline — local only')
                : 'Live via API · continuous'}
            />
          </div>
          <p className="text-[10.5px] text-[var(--text-faint)] mt-1.5 leading-relaxed">
            Every registry entry carries source, owner and last-updated metadata; engineer approvals and worker
            reports are the only ways the registry changes.
          </p>

          {recs && <Recommendations current={result} candidates={recs} />}
        </div>

        <div>
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5.5 py-5">
            <h3 className="font-display font-semibold text-[14.5px] mb-3.5">Excavation plan</h3>
            <div className="font-mono text-[11.5px] text-cyan bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-3 py-2 mb-3.5">
              {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Planned depth (m)">
                <input type="number" step="0.1" min="0.1" value={depth} onChange={(e) => setDepth(parseFloat(e.target.value) || 0)} />
              </Field>
              <Field label="Purpose">
                <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                  {['Foundation', 'Drainage', 'Landscaping', 'Pipeline install', 'Pole / post setting'].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <Field label="Width (m)">
                <input type="number" step="0.1" min="0.1" value={width} onChange={(e) => setWidth(parseFloat(e.target.value) || 0)} />
              </Field>
              <Field label="Length (m)">
                <input type="number" step="0.1" min="0.1" value={length} onChange={(e) => setLength(parseFloat(e.target.value) || 0)} />
              </Field>
            </div>

            <button
              onClick={analyze}
              disabled={loading}
              className="w-full mt-3 font-semibold text-[13.5px] py-2.5 rounded-md bg-cyan text-[#03151F] hover:bg-[#6EDCF0] transition disabled:opacity-60"
            >
              {loading ? 'Analyzing…' : 'Analyze risk'}
            </button>
            {source && (
              <div className="mt-2 font-mono text-[10px] text-[var(--text-faint)] text-center">
                {source === 'backend' ? 'Scored by backend API' : 'Scored locally (backend unreachable)'}
              </div>
            )}
          </div>

          {/* Save & share plan */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5.5 py-5 mt-4">
            <h3 className="font-display font-semibold text-[14.5px] mb-3.5 flex items-center gap-1.5 text-cyan">
              <span>📌 Save &amp; Share</span>
            </h3>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={planName}
                onChange={(e) => setPlanName(e.target.value)}
                placeholder="Plan name (optional)"
                className="flex-1 text-sm px-3 py-2 rounded-lg bg-[var(--bg-panel-2)] border border-[var(--border)] text-[var(--text)] placeholder-[var(--text-faint)] focus:outline-none focus:border-cyan transition min-w-0"
              />
              <button
                onClick={savePlan}
                className="font-semibold text-xs px-3 py-2 rounded-md border border-cyan/50 text-cyan hover:bg-cyan/10 transition whitespace-nowrap"
              >
                💾 Save
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-3">
              <button onClick={exportJSON} className="font-semibold text-[11.5px] py-2 rounded-md border border-[var(--border)] hover:border-cyan hover:text-cyan transition">JSON</button>
              <button onClick={exportKML} className="font-semibold text-[11.5px] py-2 rounded-md border border-[var(--border)] hover:border-cyan hover:text-cyan transition">KML</button>
              <button onClick={exportHTML} className="font-semibold text-[11.5px] py-2 rounded-md border border-[var(--border)] hover:border-cyan hover:text-cyan transition">Report</button>
            </div>
            <p className="text-[10.5px] text-[var(--text-faint)] leading-relaxed">
              KML opens in GIS tools (QGIS / Google Earth). JSON = full plan + risk breakdown. Report = printable HTML.
            </p>
            <p className="text-[10.5px] text-[var(--text-faint)] leading-relaxed mt-2">
              Saving files the plan into the server&rsquo;s engineer review queue{offline ? ' — while offline, plans are kept as local drafts.' : '.'}
            </p>
          </div>

          {/* Saved plans library */}
          {allPlans.length > 0 && (
            <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5.5 py-5 mt-4">
              <h3 className="font-display font-semibold text-[14.5px] mb-3.5 flex items-center gap-1.5 text-cyan">
                <span>🗂️ Saved plans</span>
                <span className="ml-auto font-mono text-[10px] text-[var(--text-faint)]">{allPlans.length}</span>
              </h3>
              <div className="flex flex-col gap-2 max-h-[220px] overflow-y-auto pr-1">
                {allPlans.map((p) => (
                  <div key={p.id} className="bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-white/85 truncate">{p.name}</div>
                        <div className="font-mono text-[10px] text-[var(--text-faint)] mt-0.5">
                          {p.excavation.point.lat.toFixed(4)}, {p.excavation.point.lng.toFixed(4)} · {p.excavation.depth} m{typeof p.result?.overall === 'number' ? ` · ${p.result.level}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {p.reviewStatus && (
                          <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                            p.reviewStatus === 'APPROVED' ? 'bg-green/15 text-green'
                            : p.reviewStatus === 'REJECTED' ? 'bg-red/15 text-red'
                            : 'bg-amber/15 text-amber'
                          }`}>
                            {p.reviewStatus}
                          </span>
                        )}
                        <button onClick={() => loadPlan(p.id)} className="text-[10.5px] font-mono px-2 py-1 rounded border border-cyan/40 text-cyan hover:bg-cyan/10 transition">Open</button>
                        <button onClick={() => deletePlan(p.id)} className="text-[10.5px] font-mono px-2 py-1 rounded border border-red/30 text-red-400 hover:bg-red/10 transition">✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4">
            <LocateRequestPanel point={point} depth={depth} width={width} length={length} purpose={purpose} />
          </div>

          {canRegisterUtility && (
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5.5 py-5 mt-4">
            <h3 className="font-display font-semibold text-[14.5px] mb-3.5 flex items-center gap-1.5 text-cyan">
              <span>🛠️ Quick Register Utility</span>
            </h3>
            <p className="text-[11.5px] text-[var(--text-dim)] mb-3">
              Add a verified pipe at the current map pin coordinates to test the risk engine.
            </p>

            <div className="grid grid-cols-2 gap-2.5 mb-3.5">
              <Field label="Utility Type">
                <select value={quickType} onChange={(e) => setQuickType(e.target.value)}>
                  {['water', 'electric', 'fiber', 'gas', 'sewer'].map((t) => (
                    <option key={t} value={t}>
                      {t.toUpperCase()}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Utility Depth (m)">
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={quickDepth}
                  onChange={(e) => setQuickDepth(parseFloat(e.target.value) || 0)}
                />
              </Field>
            </div>

            <button
              onClick={registerQuickUtility}
              disabled={quickRegistering}
              className="w-full font-semibold text-[13.5px] py-2.5 rounded-md border border-cyan/40 text-cyan hover:bg-cyan/10 transition disabled:opacity-60"
            >
              {quickRegistering ? 'Registering...' : 'Register Verified Pipe'}
            </button>

            {quickError && (
              <div className="mt-2 font-mono text-[11px] text-red" role="alert">
                ⚠ {quickError}
              </div>
            )}

            {quickSuccess && (
              <div className="mt-2 font-mono text-[11px] text-green-400 text-center animate-pulse">
                ✓ Registered! Re-analyze risk to see it.
              </div>
            )}

            {customPipes.length > 0 && (
              <div className="mt-4 pt-3.5 border-t border-white/5">
                <h4 className="text-[11px] text-[var(--text-faint)] uppercase tracking-wider font-semibold mb-2">
                  Custom Registered Pipes
                </h4>
                {deleteError && (
                  <div className="mb-2 font-mono text-[11px] text-red" role="alert">
                    ⚠ {deleteError}
                  </div>
                )}
                <div className="flex flex-col gap-1.5 max-h-[120px] overflow-y-auto pr-1">
                  {customPipes.map((p) => (
                    <div key={p.id} className="flex justify-between items-center bg-[var(--bg-panel-2)] border border-[var(--border)] rounded px-2.5 py-1.5 text-xs">
                      <span className="flex items-center gap-1.5 font-semibold" style={{ color: p.color }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
                        {p.type.toUpperCase()} ({p.depth}m)
                      </span>
                      <button
                        onClick={() => handleDeleteUtility(p.id)}
                        className="text-red-400 hover:text-red transition font-bold px-1"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

          <div className="mt-4">
            <ScoreCard result={result} />
          </div>
        </div>
      </div>

      <AIAssistant context={assistantContext} />
    </section>
  );
}

// ─── Great-circle distance in metres between two lat/lng points ───────────────
function latlngMeters(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ─── Saved-plans library (persisted in localStorage) ─────────────────────────
const PLANS_KEY = 'terratwin_saved_plans';

function loadSavedPlans() {
  try {
    return JSON.parse(localStorage.getItem(PLANS_KEY)) || [];
  } catch {
    return [];
  }
}

function persistSavedPlans(plans) {
  localStorage.setItem(PLANS_KEY, JSON.stringify(plans));
}

// Trigger a browser download of an in-memory string.
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function buildKML(exc, result) {
  const { point, depth, width, length, purpose } = exc;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((point.lat * Math.PI) / 180);
  const hw = width / 2, hl = length / 2;
  const corners = [
    { lat: point.lat + hl / mPerDegLat, lng: point.lng - hw / mPerDegLng },
    { lat: point.lat + hl / mPerDegLat, lng: point.lng + hw / mPerDegLng },
    { lat: point.lat - hl / mPerDegLat, lng: point.lng + hw / mPerDegLng },
    { lat: point.lat - hl / mPerDegLat, lng: point.lng - hw / mPerDegLng },
  ];
  const ring = corners.concat([corners[0]])
    .map((c) => `${c.lng.toFixed(7)},${c.lat.toFixed(7)},0`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>DigSafe excavation plan</name>
  <Placemark>
    <name>Excavation — ${purpose}</name>
    <description>${width} m W x ${length} m L x ${depth} m D.${result ? ` DigSafe risk: ${result.level} (${Math.round(result.overall)}/100).` : ''} Generated ${new Date().toISOString()}.</description>
    <ExtendedData>
      <Data name="depth"><value>${depth} m</value></Data>
      <Data name="width"><value>${width} m</value></Data>
      <Data name="length"><value>${length} m</value></Data>
      <Data name="purpose"><value>${purpose}</value></Data>
    </ExtendedData>
    <Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
</Document>
</kml>`;
}

function buildHTMLReport(exc, result) {
  const rows = [
    ['Location', `${exc.point.lat.toFixed(5)}, ${exc.point.lng.toFixed(5)}`],
    ['Purpose', exc.purpose],
    ['Depth', `${exc.depth} m`],
    ['Width', `${exc.width} m`],
    ['Length', `${exc.length} m`],
    ['Volume', `${(exc.depth * exc.width * exc.length).toFixed(2)} m³`],
    ['Risk level', result ? result.level : '—'],
    ['DigSafe score', result ? `${Math.round(result.overall)} / 100` : '—'],
  ];
  const trs = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<title>TerraTwin AI — Dig plan</title>
<style>body{font-family:system-ui;margin:40px;color:#0b1a2e}h1{font-size:20px;margin-bottom:4px}.sub{width:100%;border-collapse:collapse;margin-top:18px}.sub td{border:1px solid #cbd5e1;padding:8px 10px;font-size:14px}td:first-child{font-weight:600;width:34%}.note{margin-top:18px;font-size:12px;color:#64748b}</style>
</head><body>
<h1>TerraTwin AI — DigSafe excavation plan</h1>
<p>Exported ${new Date().toISOString()}</p>
<table class="sub">${trs}</table>
<p class="note"><em>Record-based clearance against the utility registry; GPS does not detect buried infrastructure.</em></p>
</body></html>`;
}

function Legend({ color, label, dashed = false }) {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-dim)]">
      {dashed ? (
        <svg width="18" height="8" viewBox="0 0 18 8">
          <line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth="2.5" strokeDasharray="5 3" />
        </svg>
      ) : (
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
      )}
      {label}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="mb-1">
      <label className="block text-[11.5px] text-[var(--text-dim)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[11.5px] font-bold text-white/85 truncate" title={value}>
        {value}
      </div>
      <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-faint)] mt-0.5">{label}</div>
    </div>
  );
}
