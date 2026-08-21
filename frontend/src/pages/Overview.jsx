import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { LoadingState } from '../components/Feedback';
import { useLanguage } from '../lib/useLanguage';

const TYPE_COLOR = { water: '#29B6D8', gas: '#F5A623', sewer: '#8D6E3B', electric: '#FFE066', fiber: '#B58CFF', unknown: '#8CA3BF' };

export default function Overview() {
  const { t } = useLanguage();
  const [totals, setTotals] = useState(null);
  const [preventedHighRisk, setPreventedHighRisk] = useState(null);
  const [registry, setRegistry] = useState(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getAnalytics().then((res) => {
      if (cancelled) return;
      if (res) {
        setTotals(res.totals);
        setPreventedHighRisk(res.preventedHighRisk);
      } else {
        setOffline(true);
      }
    });
    api.getUtilities().then((res) => {
      if (cancelled) return;
      if (res?.utilities) setRegistry(res.utilities);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = offline
    ? [
        ['\u2014', t('overview.offlineBackend')],
        ['\u2014', t('overview.activeExcavations')],
        ['\u2014', t('overview.avgConfidence')],
        ['\u2014', t('overview.rerouted')],
      ]
    : [
        [totals ? String(totals.utilityRecords) : '\u2026', t('overview.records')],
        [totals ? String(totals.activeExcavations) : '\u2026', t('overview.activeExcavations')],
        [totals && totals.avgVerificationConfidence != null ? `${totals.avgVerificationConfidence}%` : '\u2013', t('overview.avgConfidence')],
        [preventedHighRisk != null ? String(preventedHighRisk) : '\u2026', t('overview.rerouted')],
      ];

  return (
    <section>
      <div className="grid md:grid-cols-[1.1fr_0.9fr] gap-10 items-center pb-9 border-b border-[var(--border)]">
        <div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-cyan mb-4">
            <span className="w-4 h-px bg-cyan" /> {t('overview.tagline')}
          </div>
          <h1 className="font-display font-bold text-[38px] md:text-[44px] leading-[1.1] tracking-tight mb-4">
            {t('overview.title')}
            <br />
            <span className="text-cyan">{t('overview.subtitle')}</span>
          </h1>
          <p className="text-[var(--text-dim)] text-[15.5px] leading-relaxed max-w-[480px] mb-5">
            {t('overview.description')}
          </p>
          <div className="flex gap-2.5">
            <Link
              to="/planner"
              className="font-semibold text-[13.5px] px-5 py-2.5 rounded-md bg-cyan text-[#03151F] hover:opacity-90 hover:-translate-y-px transition"
            >
              {t('overview.btnPlan')}
            </Link>
            <Link
              to="/twin"
              className="font-semibold text-[13.5px] px-5 py-2.5 rounded-md border border-[var(--border)] hover:border-cyan hover:text-cyan transition"
            >
              {t('overview.btnTwin')}
            </Link>
          </div>
        </div>

        <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg p-6">
          <div className="font-mono text-[10px] text-[var(--text-faint)] mb-3.5">
            {t('overview.registryDepth')}
          </div>
          <div className="flex items-center gap-3.5 py-2.5 border-b border-dashed border-white/5">
            <div className="font-mono text-xs text-[var(--text-faint)] w-11 shrink-0">0.0 m</div>
            <div className="flex-1 h-2 bg-[var(--bg-panel-2)] rounded-full" />
            <div className="text-xs text-[var(--text-dim)] w-[110px] shrink-0 text-right">{t('overview.surface')}</div>
          </div>
          {!registry ? (
            <div className="py-4">
              <LoadingState label="Loading registry…" className="py-4" />
            </div>
          ) : registry.length === 0 ? (
            <p className="text-[12px] text-[var(--text-faint)] leading-relaxed py-3">
              No verified utility records registered yet. Records appear once an engineer registers
              or approves them, or as real OpenStreetMap pipe data is mapped nearby your site.
            </p>
          ) : (
            [...registry]
              .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))
              .map((l) => {
                const color = l.color || TYPE_COLOR[l.type] || TYPE_COLOR.unknown;
                const pct = Math.min(100, Math.max(8, ((l.depth ?? 0) / 2.5) * 100));
                return (
                  <div key={l.id} className="flex items-center gap-3.5 py-2.5 border-b border-dashed border-white/5 last:border-none">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    <div className="font-mono text-xs text-[var(--text-faint)] w-11 shrink-0">{l.depth} m</div>
                    <div className="flex-1 h-2 bg-[var(--bg-panel-2)] rounded-full relative overflow-hidden">
                      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <div className="text-xs text-[var(--text-dim)] w-[110px] shrink-0 text-right">
                      {l.type[0].toUpperCase() + l.type.slice(1)}
                      {l.source === 'osm' ? ' · OSM' : ''}
                    </div>
                  </div>
                );
              })
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mt-8">
        {offline || totals ? (
          stats.map(([num, lbl]) => (
            <div key={lbl} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4.5 pt-4.5 pb-4">
              <div className="font-display text-2xl font-bold text-cyan">{num}</div>
              <div className="text-[11.5px] text-[var(--text-dim)] mt-1">{lbl}</div>
            </div>
          ))
        ) : (
          <div className="col-span-2 md:col-span-4 rounded-lg border border-[var(--border)] bg-[var(--bg-panel)]">
            <LoadingState label="Loading live stats…" className="py-6" />
          </div>
        )}
      </div>

      <h2 className="font-display font-semibold text-[19px] mt-11 mb-4">{t('overview.principlesTitle')}</h2>
      <div className="grid md:grid-cols-3 gap-3.5">
        {Array.from({ length: 6 }).map((_, i) => {
          const key = `overview.principle.${i}`;
          const p = t(key);
          return (
            <div key={key} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4.5 py-4">
              <div className="font-mono text-[10.5px] text-cyan mb-2">{String(i + 1).padStart(2, '0')}</div>
              <p className="text-[12.8px] text-[var(--text-dim)] leading-relaxed">{p}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
