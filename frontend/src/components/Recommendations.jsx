import { levelColor } from '../lib/levels';

export default function Recommendations({ current, candidates }) {
  if (!current || !candidates?.length) return null;
  const best = candidates[0];
  const rows = [{ label: 'Current plan', overall: current.overall, level: current.level, isCurrent: true }, ...candidates.slice(0, 4)];

  return (
    <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-5 mt-4">
      <h3 className="font-display font-semibold text-[14.5px] mb-3">DigSafe recommendations</h3>
      {rows.map((c) => {
        const isBest = !c.isCurrent && c.overall === best.overall;
        return (
          <div
            key={c.label}
            className={`grid grid-cols-[auto_1fr_auto] items-center gap-2.5 px-3 py-2.5 rounded-md mb-2 bg-[var(--bg-panel-2)] border ${
              isBest ? 'border-green' : 'border-[var(--border)]'
            }`}
          >
            <span className="text-[10px] text-[var(--text-faint)]">{c.isCurrent ? 'Current' : 'Alt'}</span>
            <span className="text-[12.5px]">
              {c.label}
              {isBest ? ' — recommended' : ''}
            </span>
            <span className="font-display font-semibold text-sm" style={{ color: levelColor(c.level) }}>
              {Math.round(c.overall)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
