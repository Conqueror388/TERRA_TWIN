import { BADGE_CLASS, levelColor } from '../lib/levels';

// Matches DANGER_RADIUS_M in riskEngine.js — utilities outside this range
// score 100/LOW and don't affect the overall DigSafe score.
const DANGER_RADIUS_M = 5;

export default function ScoreCard({ result }) {
  if (!result) return null;
  const { overall, level, results } = result;

  // Only show utilities that are close enough to have actually affected the score.
  // Far-away utilities all score 100/LOW and are excluded to avoid cluttering the list.
  const activeConflicts = results.filter((r) => r.dist <= DANGER_RADIUS_M);
  const hasNoNearby = activeConflicts.length === 0;

  return (
    <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-5">
      <h3 className="font-display font-semibold text-[14.5px] mb-3">DigSafe score</h3>

      <div className="text-center py-2 mb-2">
        <span className="font-display text-[46px] font-bold leading-none" style={{ color: levelColor(level) }}>
          {Math.round(overall)}
        </span>
        <span className="text-sm text-[var(--text-faint)]">/100</span>
        <div className="font-display font-semibold text-sm mt-1.5" style={{ color: levelColor(level) }}>
          {level.toLowerCase()} risk
        </div>
      </div>

      <p className="text-[11.5px] text-[var(--text-faint)] text-center leading-snug mb-4">
        Cleared against registered and OSM-mapped utilities within {DANGER_RADIUS_M} m of the excavation point.
        This is a record check, not live detection — it never replaces a locate request.
      </p>

      <div className="mt-1">
        <h4 className="text-[11.5px] text-[var(--text-faint)] font-semibold mb-2.5">
          Conflicts within {DANGER_RADIUS_M} m
        </h4>

        {hasNoNearby ? (
          <div className="text-center py-4 border border-[var(--border)] rounded-lg bg-[var(--bg-panel-2)] text-[12px] text-[var(--text-dim)]">
            No known utility conflicts within {DANGER_RADIUS_M} m in the current records — file a locate
            request before digging regardless.
          </div>
        ) : (
          [...activeConflicts]
            .sort((a, b) => a.score - b.score)
            .map((r) => (
              <div key={r.utility.id} className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-none text-[12.5px]">
                <span>
                  {r.utility.type[0].toUpperCase() + r.utility.type.slice(1)} &mdash; {r.utility.id}
                  <span className="text-[11px] text-[var(--text-faint)] block">
                    {r.dist.toFixed(1)} m away &middot; &Delta;depth {r.depthDiff.toFixed(2)} m
                  </span>
                </span>
                <span className={`font-mono text-[10px] font-semibold px-2.5 py-0.5 rounded-md ${BADGE_CLASS[r.level]}`}>
                  {r.level}
                </span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
