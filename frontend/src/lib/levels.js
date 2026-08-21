// Shared risk-level tokens so components don't each re-declare colour maps
// (also keeps ScoreCard.jsx a pure component file for fast-refresh).

export const LEVEL_COLOR = {
  LOW: 'var(--green)',
  MEDIUM: 'var(--amber)',
  HIGH: 'var(--red)',
  CRITICAL: 'var(--red)',
};

export const BADGE_CLASS = {
  LOW: 'bg-[var(--bg-panel-2)] text-green',
  MEDIUM: 'bg-[var(--bg-panel-2)] text-amber',
  HIGH: 'bg-[var(--bg-panel-2)] text-red',
  CRITICAL: 'bg-red/15 text-red',
};

export function levelColor(level) {
  return LEVEL_COLOR[level];
}
