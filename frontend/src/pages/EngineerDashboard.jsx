import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { bandFor } from '../lib/riskEngine';
import { useAuth } from '../lib/AuthContext';
import { LoadingState, EmptyState, OfflinePanel } from '../components/Feedback';
import CertificateModal from '../components/CertificateModal';
import { Inbox, ClipboardList, Activity } from 'lucide-react';

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

const LEVEL_BADGE = {
  LOW: 'bg-[var(--bg-panel-2)] text-green',
  MEDIUM: 'bg-[var(--bg-panel-2)] text-amber',
  HIGH: 'bg-[var(--bg-panel-2)] text-red',
  CRITICAL: 'bg-[var(--bg-panel-2)] text-[#FF6B5E]',
};

const STATUS_BADGE = {
  'PENDING REVIEW': 'bg-[var(--bg-panel-2)] text-amber',
  'AI VERIFIED — PENDING ENGINEER REVIEW': 'bg-[var(--bg-panel-2)] text-cyan',
  APPROVED: 'bg-[var(--bg-panel-2)] text-green',
  REJECTED: 'bg-[var(--bg-panel-2)] text-red',
};

export default function EngineerDashboard() {
  const { user } = useAuth();
  const [reports, setReports] = useState([]);
  const [excavations, setExcavations] = useState([]);
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const [savedPlans, setSavedPlans] = useState(() => loadSavedPlans());
  const [serverPlans, setServerPlans] = useState([]);
  const [exporting, setExporting] = useState(null);
  const [exportMsg, setExportMsg] = useState('');
  const [certPlanId, setCertPlanId] = useState(null);

  // Server queue (shared, cross-device) is authoritative when reachable;
  // offline, fall back to the localStorage draft queue.
  const plansPending = (connected ? serverPlans : savedPlans).filter((p) => (p.reviewStatus || 'PENDING') === 'PENDING');
  const plansDecided = (connected ? serverPlans : savedPlans).filter((p) => ['APPROVED', 'REJECTED'].includes(p.reviewStatus));

  async function decidePlan(id, review) {
    if (connected) {
      await api.reviewPlan(id, review);
      setServerPlans((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, reviewStatus: review, reviewedBy: user?.name || 'Engineer', reviewedAt: new Date().toISOString() }
            : p
        )
      );
    } else {
      const next = savedPlans.map((p) =>
        p.id === id
          ? { ...p, reviewStatus: review, reviewedBy: user?.name || 'Engineer', reviewedAt: new Date().toISOString() }
          : p
      );
      setSavedPlans(next);
      persistSavedPlans(next);
    }
  }

  async function refresh() {
    const [r, e, plans] = await Promise.all([api.listDiscoveries(), api.listExcavations(), api.listPlans()]);
    if (r && e) {
      setReports([...r].reverse());
      setExcavations(e);
      setConnected(true);
    } else {
      setConnected(false);
    }
    if (plans) setServerPlans(plans);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function runVerify(id) {
    setBusyId(id);
    await api.verifyDiscovery(id);
    await refresh();
    setBusyId(null);
  }

  async function approve(id) {
    setBusyId(id);
    await api.approveDiscovery(id, {});
    await refresh();
    setBusyId(null);
  }

  async function reject(id) {
    setBusyId(id);
    await api.rejectDiscovery(id, { reason: 'Not verified on site' });
    await refresh();
    setBusyId(null);
  }

  const pending = reports.filter((r) => r.status === 'PENDING REVIEW' || r.status === 'AI VERIFIED — PENDING ENGINEER REVIEW');
  const decided = reports.filter((r) => r.status === 'APPROVED' || r.status === 'REJECTED');

  const active = excavations.filter((e) => e.status === 'active');
  const highRisk = active.filter((e) => e.riskScore != null && ['HIGH', 'CRITICAL'].includes(bandFor(e.riskScore)));

  async function downloadExport(kind, format) {
    setExporting(`${kind}-${format}`);
    setExportMsg('');
    const file = await api.exportFile(kind, format);
    if (!file) {
      setExportMsg(`Export failed — start the backend and try again.`);
      setExporting(null);
      return;
    }
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(url);
    setExportMsg(`${kind} exported as ${format.toUpperCase()} (WGS84 · EPSG:4326).`);
    setExporting(null);
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="font-display font-bold text-[22px]">Engineer dashboard</h1>
          <p className="text-[12.5px] text-[var(--text-dim)] mt-1">
            Approval queue for worker discoveries, plus a live view of active and high-risk sites.
          </p>
        </div>
        {!connected && (
          <span className="text-[10px] text-red border border-red/35 bg-red/10 px-2.5 py-1.5 rounded-md">
            BACKEND UNREACHABLE
          </span>
        )}
      </div>

      {!connected && (
        <OfflinePanel
          className="mb-5"
          label="Dashboard unavailable"
          message="The backend is unreachable, so the approval queue and live-site view can&apos;t load. Start it and reload."
        />
      )}

      {loading ? (
        <LoadingState label="Loading dashboard…" className="rounded-lg border border-[var(--border)]" />
      ) : (
        <>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-8">
        <SummaryStat num={pending.length} label="Pending review" color="var(--amber)" />
        <SummaryStat num={active.length} label="Active excavations" color="var(--cyan)" />
        <SummaryStat num={highRisk.length} label="High-risk active sites" color="var(--red)" />
        <SummaryStat num={decided.filter((d) => d.status === 'APPROVED').length} label="Utilities approved" color="var(--green)" />
      </div>

      {/* ── GIS export (plans + registry) ─────────────────────────────── */}
      <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg mb-8">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3 border-b border-[var(--border)]">
          <div>
            <h3 className="font-display font-semibold text-[15px]">GIS export</h3>
            <p className="text-[11.5px] text-[var(--text-dim)] mt-0.5">
              Both datasets share the registry — exports are WGS84 / EPSG:4326 with metric depths,
              ready for QGIS, ArcGIS, or Google Earth.
            </p>
          </div>
          {exportMsg && (
            <span className="font-mono text-[10.5px] text-cyan">{exportMsg}</span>
          )}
        </div>
        {connected ? (
          <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[var(--border)]">
            <ExportKind
              title="Dig plans"
              desc="Every dig plan + its risk result, and the utilities within the 20 m site zone."
              formats={['geojson', 'csv', 'kml']}
              kind="plans"
              busy={exporting}
              onPick={(f) => downloadExport('plans', f)}
            />
            <ExportKind
              title="Utility registry"
              desc="The full underground asset map — network, depth, owner, confidence, history."
              formats={['geojson', 'csv', 'kml']}
              kind="registry"
              busy={exporting}
              onPick={(f) => downloadExport('registry', f)}
            />
          </div>
        ) : (
          <div className="px-5 py-6 text-center text-[12px] text-[var(--text-dim)]">
            Exports are built server-side — start the backend to enable GIS downloads.
          </div>
        )}
      </div>

      {/* ── Dig plan review queue (from saved plans) ─────────────────── */}
      <h3 className="font-display font-semibold text-[15px] mb-3">
        Dig plan review queue <span className="font-mono text-[11px] text-[var(--text-faint)]">({plansPending.length} pending)</span>
      </h3>
      {plansPending.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No dig plans to review"
          message="Plans saved from the Planner appear here as PENDING for engineer sign-off."
          className="mb-7"
        />
      ) : (
        <div className="flex flex-col gap-3 mb-5">
          {plansPending.map((p) => (
            <div key={p.id} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-display font-semibold text-[14.5px]">
                    {p.name}
                    <span className="font-mono text-[10.5px] text-[var(--text-faint)]"> · {p.id}</span>
                  </div>
                  <div className="font-mono text-[11.5px] text-[var(--text-dim)] mt-1">
                    {p.excavation.point.lat.toFixed(5)}, {p.excavation.point.lng.toFixed(5)} &middot; {p.excavation.width}w &times; {p.excavation.length}l &times; {p.excavation.depth}d m &middot; {p.excavation.purpose}
                  </div>
                  <div className="text-[10.5px] text-[var(--text-faint)] mt-1">Saved {new Date(p.ts).toLocaleString()}</div>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md whitespace-nowrap ${p.result?.level ? LEVEL_BADGE[p.result.level] : 'bg-[var(--bg-panel-2)] text-[var(--text-faint)]'}`}>
                  {p.result?.level || 'NOT SCORED'}
                  {typeof p.result?.overall === 'number' ? ` · ${Math.round(p.result.overall)}/100` : ''}
                </span>
              </div>
              <div className="flex gap-2.5 mt-3.5">
                <button
                  onClick={() => decidePlan(p.id, 'APPROVED')}
                  className="flex-1 font-semibold text-[12.5px] py-2 rounded-md bg-green/15 text-green border border-green/30 hover:bg-green/25 transition"
                >
                  Approve plan
                </button>
                <button
                  onClick={() => decidePlan(p.id, 'REJECTED')}
                  className="flex-1 font-semibold text-[12.5px] py-2 rounded-md bg-red/15 text-red border border-red/30 hover:bg-red/25 transition"
                >
                  Reject plan
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {plansDecided.length > 0 && (
        <>
          <h3 className="font-display font-semibold text-[15px] mb-3">Reviewed dig plans</h3>
          <div className="flex flex-col gap-2 mb-8">
            {plansDecided.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-[12.5px]">
                <span className="text-[var(--text-dim)]">{p.name} · {p.reviewedBy || '—'}</span>
                <span className="flex items-center gap-2.5">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${p.reviewStatus === 'APPROVED' ? 'bg-[var(--bg-panel-2)] text-green' : 'bg-[var(--bg-panel-2)] text-red'}`}>
                    {p.reviewStatus}
                  </span>
                  {p.reviewStatus === 'APPROVED' && (
                    <button
                      onClick={() => setCertPlanId(p.id)}
                      className="font-semibold text-[11px] px-2.5 py-1 rounded-md border border-cyan/40 text-cyan hover:bg-[var(--bg-panel-2)] transition"
                    >
                      Clearance certificate
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="font-display font-semibold text-[15px] mb-3">Pending discovery reports</h3>
      {pending.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Queue is clear"
          message="No reports waiting for review."
          className="mb-8"
        />
      ) : (
        <div className="flex flex-col gap-3 mb-8">
          {pending.map((r) => (
            <div key={r.id} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-display font-semibold text-[14.5px]">
                    {r.utilityType[0].toUpperCase() + r.utilityType.slice(1)} cable/line{' '}
                    <span className="font-mono text-[10.5px] text-[var(--text-faint)]">{r.id}</span>
                  </div>
                  <div className="font-mono text-[11.5px] text-[var(--text-dim)] mt-1">
                    {Number(r.latitude).toFixed(5)}, {Number(r.longitude).toFixed(5)} &middot; Depth {r.estimatedDepth} m
                  </div>
                  <div className="text-[10.5px] text-[var(--text-faint)] mt-1">Reported by {r.reportedBy}</div>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md whitespace-nowrap ${STATUS_BADGE[r.status]}`}>
                  {r.status}
                </span>
              </div>

              {r.notes && <p className="text-[12px] text-[var(--text-dim)] mt-3">{r.notes}</p>}
              {r.photoUrl && (
                <img
                  src={r.photoUrl}
                  alt={`${r.utilityType} discovery site`}
                  className="mt-3 w-full max-w-[280px] h-32 object-cover rounded-md border border-[var(--border)]"
                />
              )}

              {typeof r.aiConfidence === 'number' ? (
                <div className="mt-3 bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-3.5 py-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-cyan">AI verification</span>
                    <span className="font-display text-sm font-bold text-cyan">{r.aiConfidence}%</span>
                  </div>
                  <p className="text-[12px] text-[var(--text-dim)] mt-1.5">{r.aiVerdict}</p>
                  {r.aiSource === 'fallback' && (
                    <div className="font-mono text-[9.5px] text-[var(--text-faint)] mt-1">
                      Heuristic check &mdash; Gemini not configured
                    </div>
                  )}
                  {r.aiChecks?.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {r.aiChecks.map((c, i) => (
                        <li key={i} className="text-[11.5px] text-[var(--text-faint)] flex gap-1.5">
                          <span>&mdash;</span>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => runVerify(r.id)}
                  disabled={busyId === r.id}
                  className="mt-3 font-semibold text-[12.5px] px-4 py-2 rounded-md border border-cyan text-cyan hover:bg-[var(--bg-panel-2)] transition disabled:opacity-60"
                >
                  {busyId === r.id ? 'Verifying…' : 'Run AI verification'}
                </button>
              )}

              <div className="flex gap-2.5 mt-3.5">
                <button
                  onClick={() => approve(r.id)}
                  disabled={busyId === r.id}
                  className="flex-1 font-semibold text-[12.5px] py-2 rounded-md bg-green/15 text-green border border-green/30 hover:bg-green/25 transition disabled:opacity-60"
                >
                  Approve &rarr; add to registry
                </button>
                <button
                  onClick={() => reject(r.id)}
                  disabled={busyId === r.id}
                  className="flex-1 font-semibold text-[12.5px] py-2 rounded-md bg-red/15 text-red border border-red/30 hover:bg-red/25 transition disabled:opacity-60"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 className="font-display font-semibold text-[15px] mb-3">Active excavations</h3>
      {active.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No excavations currently active"
          message="Any active dig started from Live Monitoring will appear here with its risk level."
          className="mb-8"
        />
      ) : (
        <div className="grid md:grid-cols-2 gap-3 mb-8">
          {active.map((e) => {
            const level = e.riskScore != null ? bandFor(e.riskScore) : null;
            return (
              <div key={e.id} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4.5 py-4 flex items-center justify-between">
                <div>
                  <div className="font-display font-semibold text-[13.5px]">{e.worker}</div>
                  <div className="font-mono text-[11px] text-[var(--text-faint)] mt-1">
                    {Number(e.latitude).toFixed(5)}, {Number(e.longitude).toFixed(5)}
                  </div>
                </div>
                {level && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${LEVEL_BADGE[level]}`}>
                    {level} &middot; {Math.round(e.riskScore)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {decided.length > 0 && (
        <>
          <h3 className="font-display font-semibold text-[15px] mb-3">Recently reviewed</h3>
          <div className="flex flex-col gap-2">
            {decided.map((r) => (
              <div key={r.id} className="flex items-center justify-between bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-[12.5px]">
                <span className="text-[var(--text-dim)]">
                  {r.id} &middot; {r.utilityType} &middot; {r.reviewedBy}
                </span>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${STATUS_BADGE[r.status]}`}>
                  {r.status}
                  {r.approvedUtilityId ? ` → ${r.approvedUtilityId}` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
      )}
      {certPlanId && <CertificateModal planId={certPlanId} onClose={() => setCertPlanId(null)} />}
    </section>
  );
}

function SummaryStat({ num, label, color }) {
  return (
    <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4.5 pt-4.5 pb-4">
      <div className="font-display text-2xl font-bold" style={{ color }}>
        {num}
      </div>
      <div className="text-[11.5px] text-[var(--text-dim)] mt-1">{label}</div>
    </div>
  );
}

const FORMAT_HINT = { geojson: 'GeoJSON', csv: 'CSV', kml: 'KML' };

function ExportKind({ title, desc, formats, kind, busy, onPick }) {
  return (
    <div className="px-5 py-4">
      <div className="font-display font-semibold text-[13.5px]">{title}</div>
      <p className="text-[11.5px] text-[var(--text-dim)] mt-1 leading-relaxed">{desc}</p>
      <div className="flex gap-2 mt-3">
        {formats.map((f) => (
          <button
            key={f}
            onClick={() => onPick(f)}
            disabled={busy === `${kind}-${f}`}
            className="font-semibold text-[11.5px] px-3.5 py-2 rounded-lg border border-cyan/40 text-cyan hover:bg-[var(--bg-panel-2)] transition disabled:opacity-50"
          >
            {busy === `${kind}-${f}` ? '…' : FORMAT_HINT[f]}
          </button>
        ))}
      </div>
    </div>
  );
}
