import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { LoadingState } from './Feedback';

// The locate-request workflow — this, not the DigSafe score, is what
// actually authorizes an excavation. TerraTwin doesn't know what's really
// underground; a real one-call/811 locate does. This panel:
//   1. Drafts a locate-request ticket from the current excavation plan
//   2. Lets the worker mark it submitted (filed with the real one-call center)
//   3. Lets the worker mark it confirmed (the locate crew came out and marked
//      or cleared the site) — this is what flips `cleared: true`
//   4. Gives engineers a friction-y override path with a required, logged
//      justification, for when digging has to start before a locate returns
//
// `onStatusChange(cleared)` fires whenever the cleared state is known/changes
// so a parent (e.g. LiveMonitoring's "Start excavation" button) can gate on it.
export default function LocateRequestPanel({ point, depth, width, length, purpose, onStatusChange, compact = false }) {
  const { user } = useAuth();
  const [status, setStatus] = useState(null); // { cleared, gatingRequest, nearby }
  const [loading, setLoading] = useState(true);
  const [drafted, setDrafted] = useState(null); // most recent draft this session, with ticketBody
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ticketNumber, setTicketNumber] = useState('');
  const [justification, setJustification] = useState('');
  const [showOverride, setShowOverride] = useState(false);

  async function refresh() {
    const res = await api.getLocateStatus(point.lat, point.lng);
    if (res) {
      setStatus(res);
      onStatusChange?.(res.cleared, res.gatingRequest);
    }
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    setDrafted(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point.lat, point.lng]);

  async function draft() {
    setBusy(true);
    setError(null);
    const res = await api.draftLocateRequest({ latitude: point.lat, longitude: point.lng, depth, width, length, purpose });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDrafted(res.data);
    await refresh();
  }

  async function submit(id) {
    setBusy(true);
    setError(null);
    const res = await api.submitLocateRequest(id, { ticketNumber: ticketNumber || undefined });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDrafted(res.data);
    await refresh();
  }

  async function confirm(id) {
    setBusy(true);
    setError(null);
    const res = await api.confirmLocateRequest(id, { ticketNumber: ticketNumber || undefined });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDrafted(res.data);
    await refresh();
  }

  async function override(id) {
    if (justification.trim().length < 10) {
      setError('Justification must be at least 10 characters — this gets logged against your name.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api.overrideLocateRequest(id, { justification });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setShowOverride(false);
    setJustification('');
    await refresh();
  }

  const gating = status?.gatingRequest;
  const current = drafted || status?.nearby?.[0] || null;

  return (
    <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-display font-semibold text-[14.5px]">CBuD Locate request (Call Before u Dig)</h3>
        {status && (
          <span className={`text-[10.5px] font-semibold ${status.cleared ? 'text-green' : 'text-amber'}`}>
            {status.cleared ? 'Cleared to dig' : 'Locate required'}
          </span>
        )}
      </div>
      <p className="text-[11.5px] text-[var(--text-dim)] mb-3">
        This — not the DigSafe score — is what actually authorizes digging. TerraTwin doesn&rsquo;t know what&rsquo;s
        underground here; the real CBuD service marking the site does.
      </p>

      {loading ? (
        <LoadingState label="Checking locate status…" className="py-4" />
      ) : !status ? (
        <div className="text-[11.5px] text-red">Can&rsquo;t reach the backend to check locate status.</div>
      ) : status.cleared ? (
        <div className="text-[12px] bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-md px-3 py-2.5">
          <div className="font-semibold text-green">
            {gating.status === 'OVERRIDDEN' ? 'Cleared by engineer override' : 'Locate confirmed'}
          </div>
          <div className="text-[var(--text-dim)] mt-1 text-[11px]">
            {gating.id} &middot;{' '}
            {gating.status === 'OVERRIDDEN'
              ? `${gating.overriddenBy}, ${new Date(gating.overriddenAt).toLocaleString()}`
              : `${gating.confirmedBy}, ${new Date(gating.confirmedAt).toLocaleString()}`}
          </div>
          {gating.status === 'OVERRIDDEN' && (
            <div className="text-[var(--text-faint)] mt-1.5 italic">&ldquo;{gating.overrideJustification}&rdquo;</div>
          )}
          {gating.ticketNumber && (
            <div className="text-[var(--text-faint)] mt-1">Ticket #{gating.ticketNumber}</div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {!current ? (
            <button
              onClick={draft}
              disabled={busy}
              className="w-full font-semibold text-[12.5px] py-2 rounded-md bg-cyan text-[#03151F] hover:opacity-90 transition disabled:opacity-60"
            >
              {busy ? 'Drafting…' : 'Draft locate request'}
            </button>
          ) : (
            <>
              <div className="text-[11px] text-[var(--text-dim)] bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-md px-3 py-2.5 whitespace-pre-wrap max-h-40 overflow-y-auto">
                {current.ticketBody || `${current.id} — status: ${current.status}`}
              </div>

              {!compact && (
                <input
                  type="text"
                  value={ticketNumber}
                  onChange={(e) => setTicketNumber(e.target.value)}
                  placeholder="CBuD ticket # (optional)"
                  className="w-full text-[11.5px] px-3 py-2 rounded-md bg-[var(--bg-panel-2)] border border-[var(--border)] text-[var(--text)] placeholder-[var(--text-faint)] focus:outline-none focus:border-cyan transition"
                />
              )}

              {current.status === 'DRAFTED' && (
                <button
                  onClick={() => submit(current.id)}
                  disabled={busy}
                  className="w-full font-semibold text-[12.5px] py-2 rounded-md border border-cyan/40 text-cyan hover:bg-cyan/10 transition disabled:opacity-60"
                >
                  {busy ? 'Submitting…' : 'Mark filed with CBuD registry'}
                </button>
              )}

              {current.status === 'SUBMITTED' && (
                <button
                  onClick={() => confirm(current.id)}
                  disabled={busy}
                  className="w-full font-semibold text-[12.5px] py-2 rounded-md bg-green/80 text-[#03151F] hover:opacity-90 transition disabled:opacity-60"
                >
                  {busy ? 'Confirming…' : 'Mark locate confirmed (site marked / cleared)'}
                </button>
              )}
            </>
          )}

          {user?.role === 'engineer' && current && current.status !== 'OVERRIDDEN' && (
            <div className="pt-2 border-t border-white/5">
              {!showOverride ? (
                <button
                  onClick={() => setShowOverride(true)}
                  className="text-[11px] text-[var(--text-faint)] hover:text-amber underline transition"
                >
                  Engineer override (skip locate confirmation)
                </button>
              ) : (
                <div className="flex flex-col gap-2 mt-2">
                  <textarea
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    placeholder="Required: why is it safe to proceed without a confirmed locate? This is logged against your name."
                    rows={3}
                    className="w-full text-[11.5px] px-3 py-2 rounded-md bg-[var(--bg-panel-2)] border border-amber/40 text-[var(--text)] placeholder-[var(--text-faint)] focus:outline-none focus:border-amber transition resize-none"
                  />
                  <button
                    onClick={() => override(current.id)}
                    disabled={busy}
                    className="w-full font-semibold text-[12.5px] py-2 rounded-md bg-amber/80 text-[#1a1300] hover:opacity-90 transition disabled:opacity-60"
                  >
                    {busy ? 'Logging override…' : 'Log override & authorize dig'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && <div className="text-[11px] text-red mt-2.5">{error}</div>}
    </div>
  );
}
