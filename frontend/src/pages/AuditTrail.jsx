import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

const CAT_COLOR = {
  AUTH: 'text-cyan',
  RISK: 'text-[#F5A623]',
  EXCAVATION: 'text-[#3ECF8E]',
  DISCOVERY: 'text-[#B58CFF]',
  LOCATE: 'text-[#E4483C]',
};

function catOf(action) {
  return String(action || '').split('.')[0];
}

function downloadCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['time', 'actor', 'email', 'role', 'action', 'target', 'detail'];
  const lines = [
    head.join(','),
    ...rows.map((r) =>
      [r.at, r.actorName, r.actorEmail, r.actorRole, r.action, r.targetId, r.detail].map(esc).join(',')
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'terratwin-audit-trail.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function AuditTrail() {
  const [data, setData] = useState(null); // { rows, actions } | null when backend is offline
  const [q, setQ] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState('');

  useEffect(() => {
    let cancel = false;
    api.getAuditLog({ limit: 500 }).then((res) => {
      if (cancel) return;
      setData(res ? { rows: res.rows || [], actions: res.actions || [] } : null);
    });
    return () => { cancel = true; };
  }, []);

  const targetTypes = useMemo(
    () => [...new Set((data?.rows || []).map((r) => r.targetType).filter(Boolean))].sort(),
    [data]
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return (data.rows || []).filter((r) => {
      if (actionFilter && r.action !== actionFilter) return false;
      if (targetFilter && r.targetType !== targetFilter) return false;
      if (!needle) return true;
      const hay = [r.actorName, r.actorEmail, r.actorRole, r.targetId, r.detail, r.action]
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [data, q, actionFilter, targetFilter]);

  const selectCls =
    'bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-lg px-2.5 h-9 text-[11.5px] text-[var(--text)] focus:outline-none focus:border-cyan';

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display font-semibold text-[20px] tracking-tight">Audit Trail</h1>
          <p className="text-[12.5px] text-[var(--text-dim)] mt-1.5 max-w-[680px] leading-relaxed">
            Server-side, append-only record of every decision on the platform — who did what, when, and from where.
            Entries are written by the backend and can never be edited or deleted from this interface.
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
          The audit log lives on the backend — start it with <code className="text-cyan">npm run dev</code> in{' '}
          <code className="text-cyan">backend/</code>, then sign in as an engineer to view activity.
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-5">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search actor, target, detail…"
              className="min-w-[220px] flex-1 rounded-lg bg-[var(--bg-panel-2)] border border-[var(--border)] px-3 h-9 text-[12px] focus:outline-none focus:border-cyan"
            />
            <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className={selectCls}>
              <option value="">All actions</option>
              {data.actions.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <select value={targetFilter} onChange={(e) => setTargetFilter(e.target.value)} className={selectCls}>
              <option value="">All targets</option>
              {targetTypes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <div className="font-mono text-[10.5px] text-[var(--text-faint)]">
              {filtered.length} of {data.rows.length} events
            </div>
          </div>

          <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg overflow-hidden">
            {filtered.length === 0 ? (
              <div className="px-6 py-10 text-center text-[12.5px] text-[var(--text-dim)]">
                No matching events.
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {filtered.map((r) => (
                  <div key={r.id} className="grid grid-cols-[150px_170px_150px_90px_1fr] gap-3 px-5 py-3 items-start hover:bg-[var(--bg-panel-2)]/50">
                    <div className="font-mono text-[11px] text-[var(--text-faint)] leading-snug pt-0.5">
                      {r.at ? new Date(r.at).toLocaleString() : '—'}
                    </div>
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold truncate">{r.actorName}</div>
                      <div className="font-mono text-[10px] text-[var(--text-faint)] truncate">{r.actorEmail}</div>
                      <div className="font-mono text-[9px] text-[var(--text-dim)] mt-0.5">{r.actorRole}</div>
                    </div>
                    <div className="font-mono text-[11px] leading-snug">
                      <span className={CAT_COLOR[catOf(r.action)] || 'text-[var(--text)]'}>{r.action}</span>
                      {r.targetType && (
                        <div className="text-[10px] text-[var(--text-faint)] mt-0.5 truncate">
                          {r.targetType} · {r.targetId || '—'}
                        </div>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-[var(--text-faint)] truncate pt-0.5">
                      {r.ip ? (r.ip.startsWith('::ffff:') ? r.ip.slice(7) : r.ip) : '—'}
                    </div>
                    <div className="text-[11.5px] text-[var(--text-dim)] leading-relaxed">
                      {r.detail || '—'}
                    </div>
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