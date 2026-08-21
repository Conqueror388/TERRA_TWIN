import { Loader2, Inbox, CloudOff } from 'lucide-react';

// A single-source-of-truth set of loading / empty / offline feedback states,
// so every page reflects the same TerraTwin look instead of ad-hoc text rows.

export function Spinner({ className = '' }) {
  return <Loader2 className={`h-5 w-5 animate-spin text-cyan ${className}`} aria-hidden />;
}

export function LoadingState({ label = 'Loading…', className = '' }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center px-5 py-10 ${className}`}
    >
      <span className="mb-3 flex h-10 w-10 items-center justify-center">
        <Spinner />
      </span>
      <span className="text-[12px] text-[var(--text-faint)]">{label}</span>
      <span className="tt-shimmer mt-3 h-1.5 w-40 rounded-full" />
    </div>
  );
}

export function EmptyState({
  title = 'Nothing here yet',
  message,
  icon: Icon = Inbox,
  action,
  className = '',
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] px-6 py-10 text-center ${className}`}
    >
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-panel-2)]">
        <Icon className="h-5 w-5 text-[var(--text-faint)]" aria-hidden />
      </span>
      <div className="font-display font-semibold text-[14px] text-[var(--text)]">{title}</div>
      <p className="mt-1.5 max-w-[360px] text-[12px] leading-relaxed text-[var(--text-faint)]">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function OfflinePanel({
  label = 'Backend unreachable',
  message = 'Start the backend (npm run dev in /backend) and reload to see live data.',
  className = '',
}) {
  return (
    <div className={`flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] px-4 py-3.5 ${className}`}>
      <CloudOff className="mt-0.5 h-5 w-5 shrink-0 text-[var(--text-dim)]" aria-hidden />
      <div>
        <div className="text-[12px] font-semibold text-[var(--text)]">{label}</div>
        {message && <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-dim)]">{message}</p>}
      </div>
    </div>
  );
}