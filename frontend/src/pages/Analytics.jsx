import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { LoadingState, OfflinePanel } from '../components/Feedback';

const RISK_BADGE = {
  LOW: 'bg-[var(--bg-panel-2)] text-green',
  MEDIUM: 'bg-[var(--bg-panel-2)] text-amber',
  HIGH: 'bg-[var(--bg-panel-2)] text-red',
  CRITICAL: 'bg-[var(--bg-panel-2)] text-[#FF6B5E]',
};

const RISK_LABEL = { LOW: 'Low risk', MEDIUM: 'Medium risk', HIGH: 'High risk', CRITICAL: 'Critical' };

export default function Analytics() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | offline
  const [reportBusy, setReportBusy] = useState(false);
  const isStaff = user?.role === 'engineer' || user?.role === 'admin';

  useEffect(() => {
    let cancelled = false;
    api.getAnalytics().then((res) => {
      if (cancelled) return;
      if (res) {
        setData(res);
        setStatus('ready');
      } else {
        setStatus('offline');
      }
    });
    if (user?.role === 'engineer' || user?.role === 'admin') {
      api.getAnalyticsSummary().then((res) => {
        if (!cancelled && res) setSummary(res);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [user?.role]);

  const printReport = async () => {
    setReportBusy(true);
    await api.openAnalyticsReport();
    setReportBusy(false);
  };

  if (status === 'offline') {
    return (
      <section>
        <OfflinePanel message="Can&apos;t reach the TerraTwin backend right now, so there&apos;s no live analytics to show. Start the backend and reload &mdash; every excavation you analyze in the Planner will show up here." />
      </section>
    );
  }

  const monthly = data?.monthly ?? [];
  const riskMix = data?.riskMix ?? [];
  const totals = data?.totals ?? {};
  const noData = status === 'ready' && (totals.excavationsAnalyzed ?? 0) === 0;

  return (
    <section>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="font-display font-bold text-[22px]">Analytics</h1>
          <p className="text-[12.5px] text-[var(--text-dim)] mt-1">
            Real usage from every analysis, dig, discovery, and incident on the platform.
          </p>
        </div>
        {isStaff && (
          <button
            onClick={printReport}
            disabled={reportBusy}
            className="shrink-0 font-semibold text-[11.5px] px-3.5 py-2 rounded-md border border-cyan/50 text-cyan hover:bg-[var(--bg-panel-2)] transition disabled:opacity-50"
          >
            {reportBusy ? 'Opening…' : 'Print compliance report'}
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4.5">
      <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5.5 py-5">
        <h3 className="font-display font-semibold text-[14.5px] mb-4">Excavations analyzed &mdash; last 6 months</h3>
        {status === 'loading' ? (
          <LoadingState label="Crunching analytics…" className="py-12" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthly}>
              <XAxis dataKey="month" stroke="#5A7291" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: '#101F35', border: '1px solid #1D3350', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#8CA3BF' }}
              />
              <Bar dataKey="count" fill="#4FD1E8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
        {noData && (
          <EmptyChartNote />
        )}
      </div>

      <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5.5 py-5">
        <h3 className="font-display font-semibold text-[14.5px] mb-4">Risk mix (all analyzed plans)</h3>
        {riskMix.map((r) => (
          <div key={r.level} className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-none text-[12.5px]">
            <span>{RISK_LABEL[r.level]}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${RISK_BADGE[r.level]}`}>
              {r.count} plans
            </span>
          </div>
        ))}

        <h3 className="font-display font-semibold text-[14.5px] mt-6 mb-3">Prevented high-risk digs</h3>
        <div className="bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-4 py-3.5">
          <div className="font-display text-2xl font-bold text-cyan">{data?.preventedHighRisk ?? 0}</div>
          <div className="text-[11.5px] text-[var(--text-dim)] mt-1">
            Plans that started HIGH/CRITICAL risk where DigSafe found a meaningfully safer nearby alternative
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 mt-4">
          <div className="bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-3.5 py-3">
            <div className="font-display text-lg font-bold text-cyan">{totals.discoveryReports ?? 0}</div>
            <div className="text-[11px] text-[var(--text-dim)] mt-0.5">Discovery reports filed</div>
          </div>
          <div className="bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-3.5 py-3">
            <div className="font-display text-lg font-bold text-cyan">{totals.approvedReports ?? 0}</div>
            <div className="text-[11px] text-[var(--text-dim)] mt-0.5">Engineer-approved</div>
          </div>
        </div>
      </div>
      </div>

      {isStaff && summary && (
        <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5.5 py-5 mt-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-display font-semibold text-[14.5px]">Compliance &amp; impact</h3>
            <span className="text-[10.5px] text-[var(--text-faint)]">
              Generated {new Date(summary.generatedAt).toLocaleString()}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
            <SummaryStat label="Incidents resolved" value={summary.incidents.resolved} sub={summary.incidents.avgResolveHours != null ? `avg ${summary.incidents.avgResolveHours} h` : null} />
            <SummaryStat label="Certificates issued" value={summary.certificates.issued} />
            <SummaryStat
              label="Locate coverage"
              value={summary.compliance.locateCoveragePct != null ? `${summary.compliance.locateCoveragePct}%` : '—'}
              sub={`${summary.compliance.digsWithLocate} digs cleared`}
            />
            <SummaryStat label="Sensors in ALERT" value={summary.sensors.alerting} sub={`${summary.sensors.active} reporting`} />
            <SummaryStat
              label="Estimated cost avoided"
              value={new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(summary.roi.estimatedAvoided)}
              sub={`${summary.roi.preventedHighRisk} high-risk digs averted`}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryStat({ label, value, sub }) {
  return (
    <div className="bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-3.5 py-3">
      <div className="font-display text-lg font-bold text-cyan">{value}</div>
      <div className="text-[11px] text-[var(--text-dim)] mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-[var(--text-faint)] mt-0.5">{sub}</div>}
    </div>
  );
}

function EmptyChartNote() {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-panel-2)] px-3 py-2.5 text-[11.5px] text-[var(--text-faint)]">
      No excavations analyzed yet &mdash; run one through the Planner to see it appear here.
    </div>
  );
}
