import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

const KIND_STYLE = {
  CREATED: 'bg-[var(--bg-panel-2)] text-emerald',
  DELETED: 'bg-[var(--bg-panel-2)] text-[#E4483C]',
  UPDATED: 'bg-[var(--bg-panel-2)] text-cyan',
  IMPORTED: 'bg-[var(--bg-panel-2)] text-[var(--text-faint)]',
};

const ORIGIN_LABEL = {
  'discovery-approval': 'Discovery approval',
  'quick-register': 'Engineer direct register',
  'registry-delete': 'Engineer removal',
};

function downloadCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['time', 'event', 'utility_id', 'type', 'owner', 'actor', 'actor_role', 'origin', 'summary'];
  const lines = [
    head.join(','),
    ...rows.map((r) =>
      [
        r.at,
        r.event,
        r.utilityId,
        r.utility?.type,
        r.utility?.owner,
        r.actor?.name,
        r.actor?.role,
        ORIGIN_LABEL[r.origin] || r.origin,
        r.summary,
      ].map(esc).join(',')
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'terratwin-registry-history.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function RegistryHistory() {
  const [data, setData] = useState(null); // { rows, kinds } | null when backend offline
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [utilityFilter, setUtilityFilter] = useState('');

  useEffect(() => {
    let cancel = false;
    api.getRegistryHistory({ limit: 1000 }).then((res) => {
      if (cancel) return;
      setData(res ? { rows: res.rows || [], kinds: res.kinds || [] } : null);
    });
    return () => { cancel = true; };
  }, []);

  const utilityIds = useMemo(
    () => [...new Set((data?.rows || []).map((r) => r.utilityId).filter(Boolean))].sort(),
    [data]
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return (data.rows || []).filter((r) => {
      if (kindFilter && r.event !== kindFilter) return false;
      if (utilityFilter && r.utilityId !== utilityFilter) return false;
      if (!needle) return true;
      const hay = [
        r.utilityId,
        r.utility?.type,
        r.utility?.owner,
        r.actor?.name,
        r.actor?.email,
        r.origin,
        r.summary,
      ].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }, [data, q, kindFilter, utilityFilter]);

  const spans = useMemo(() => {
    const rows = data?.rows || [];
    if (!rows.length) return null;
    const first = new Date(rows[rows.length - 1].at).getTime();
    const last = new Date(rows[0].at).getTime();
    const days = Math.max(1, Math.round((last - first) / 86400000));
    return { events: rows.length, days, from: first, to: last };
  }, [data]);

  const selectCls =
    'bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-2.5 h-9 text-[11.5px] text-[var(--text)] focus:outline-none focus:border-cyan';

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display font-semibold text-[20px] tracking-tight">Registry History</h1>
          <p className="text-[12.5px] text-[var(--text-dim)] mt-1.5 max-w-[680px] leading-relaxed">
            The multi-year asset ledger. Baseline seed records are the official registry; every record that is
            added or removed after that is appended here with the record snapshot, the actor, and the timestamp —
            so the underground map shows not just what exists, but how the registry evolved.
          </p>
        </div>
        <button
          onClick={() => downloadCsv(filtered)}
          disabled={!filtered.length}
          className="font-semibold text-[11.5px] px-3.5 py-2 rounded-lg border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition disabled:opacity-40"
        >
          ⤓ Export CSV
        </button>
      </header>

      {!data ? (
        <section className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-6 py-10 text-center text-[12.5px] text-[var(--text-dim)]">
          The registry ledger lives on the backend — start it with <code className="text-cyan">npm run dev</code> in{' '}
          <code className="text-cyan">backend/</code>, then approve a discovery or register a utility to see entries here.
        </section>
      ) : (
        <>
          {spans && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-3">
                <div className="text-[10.5px] text-[var(--text-faint)]">Ledger entries</div>
                <div className="font-display text-[22px] font-semibold mt-1">{spans.events}</div>
              </div>
              <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-3">
                <div className="text-[10.5px] text-[var(--text-faint)]">Span covered</div>
                <div className="font-display text-[22px] font-semibold mt-1">{spans.days}<span className="text-[13px] text-[var(--text-dim)]"> days</span></div>
              </div>
              <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-3 col-span-2">
                <div className="text-[10.5px] text-[var(--text-faint)]">Assets touched</div>
                <div className="font-display text-[22px] font-semibold mt-1">{utilityIds.length}<span className="text-[13px] text-[var(--text-dim)]"> of {data.rows[0] ? 'registry records' : 'records'}</span></div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 mb-5">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search asset, owner, actor, summary…"
              className="min-w-[220px] flex-1 rounded-lg bg-[var(--bg-panel-2)] border border-[var(--border)] px-3 h-9 text-[12px] focus:outline-none focus:border-cyan"
            />
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className={selectCls}>
              <option value="">All events</option>
              {data.kinds.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <select value={utilityFilter} onChange={(e) => setUtilityFilter(e.target.value)} className={selectCls}>
              <option value="">All records</option>
              {utilityIds.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <div className="font-mono text-[10.5px] text-[var(--text-faint)]">
              {filtered.length} of {data.rows.length} events
            </div>
          </div>

          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg overflow-hidden">
            {filtered.length === 0 ? (
              <div className="px-6 py-10 text-center text-[12.5px] text-[var(--text-dim)]">
                No ledger entries match. Approve a discovery or register a utility to grow the history.
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {filtered.map((r) => (
                  <div key={r.id} className="px-5 py-4 hover:bg-[var(--bg-panel-2)]/50">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${KIND_STYLE[r.event] || KIND_STYLE.IMPORTED}`}>
                        {r.event}
                      </span>
                      <span className="font-mono text-[11px] text-[var(--text-dim)] font-semibold">{r.utilityId}</span>
                      <span className="text-[11.5px] font-semibold">{r.utility?.type || 'utility'}</span>
                      {r.utility?.owner && (
                        <span className="text-[11px] text-[var(--text-dim)] truncate">owner: {r.utility.owner}</span>
                      )}
                      <span className="ml-auto font-mono text-[10.5px] text-[var(--text-faint)]">
                        {r.at ? new Date(r.at).toLocaleString() : '—'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 text-[11px] text-[var(--text-dim)]">
                      <span>by {r.actor?.name || 'system'}{r.actor?.email ? ` <${r.actor.email}>` : ''}</span>
                      <span className="font-mono text-[9px] text-[var(--text-faint)]">{r.actor?.role}</span>
                      <span>{ORIGIN_LABEL[r.origin] || r.origin}</span>
                    </div>
                    <div className="mt-1 text-[11.5px] text-[var(--text-dim)] leading-relaxed">{r.summary || '—'}</div>
                    {r.utility?.lat != null && (
                      <div className="mt-1 font-mono text-[10px] text-[var(--text-faint)]">
                        {r.utility.lat.toFixed(6)}, {r.utility.lng.toFixed(6)} · depth {r.utility.depth}m
                        {r.utility.confidence != null && ` · confidence ${r.utility.confidence}%`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}