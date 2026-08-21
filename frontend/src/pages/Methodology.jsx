import { useMemo, useState } from 'react';
import { WEIGHTS, DANGER_RADIUS_M, SAFE_DEPTH_SPAN_M, bandFor, clamp, offset, scoreUtility } from '../lib/riskEngine';

const LEVEL_STYLE = {
  LOW: 'bg-[var(--bg-panel-2)] text-emerald-400',
  MEDIUM: 'bg-[var(--bg-panel-2)] text-amber-400',
  HIGH: 'bg-[var(--bg-panel-2)] text-orange-400',
  CRITICAL: 'bg-[var(--bg-panel-2)] text-red-400',
};

const PRESETS = [
  { label: 'Clear site', value: { dist: 8, gap: 1.2, criticality: 50, confidence: 90, digDepth: 1.5 } },
  { label: 'Safe practice', value: { dist: 4, gap: 1.0, criticality: 40, confidence: 85, digDepth: 1.5 } },
  { label: 'Gas line overhead', value: { dist: 1.2, gap: 0.1, criticality: 85, confidence: 80, digDepth: 1.5 } },
  { label: 'Conflicting depth', value: { dist: 2.0, gap: 0.0, criticality: 60, confidence: 55, digDepth: 1.5 } },
];

const FACTORS = [
  {
    name: 'Vertical clearance',
    weight: WEIGHTS.depth,
    kind: '0–100',
    detail: `How far the dig bottom sits from a utility's recorded depth. Risk follows a cosine falloff over the safe depth span (${SAFE_DEPTH_SPAN_M} m): at the same depth risk = 100, at ${SAFE_DEPTH_SPAN_M} m of separation risk = 0. A smooth physical curve instead of a hard cutoff.`,
  },
  {
    name: 'Horizontal clearance',
    weight: WEIGHTS.horizontal,
    kind: '0–100',
    detail: `Straight-line distance from the dig point, scored linearly inside the danger radius (${DANGER_RADIUS_M} m). At 0 m risk = 100; at ${DANGER_RADIUS_M} m risk = 0 and the utility drops out of scoring entirely.`,
  },
  {
    name: 'Utility criticality',
    weight: WEIGHTS.criticality,
    kind: '0–100',
    detail: 'How consequential a strike would be. Gas and high-voltage electric score highest (≈85–95); water and sewer lower (≈40–60). Set per record by the engineer.',
  },
  {
    name: 'Data confidence',
    weight: WEIGHTS.confidence,
    kind: '0–100',
    detail: 'Registry certainty in the record. Low confidence increases the uncertainty contribution, nudging the score down so a doubtful record is treated with more caution.',
  },
];

function Slider({ label, value, min, max, step, unit, onChange }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-[11.5px] mb-1">
        <span className="text-[var(--text-dim)]">{label}</span>
        <span className="font-mono text-cyan">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-[#4FD1E8]"
      />
    </label>
  );
}

function Bar({ label, value, weight }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 shrink-0 font-mono text-[10px] text-[var(--text-faint)]">{label}</div>
      <div className="flex-1 h-2 bg-[var(--bg-panel-2)] rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-gradient-to-r from-[#4FD1E8] to-[#E4483C]" style={{ width: `${value}%` }} />
      </div>
      <div className="w-24 shrink-0 text-right font-mono text-[11px] text-[var(--text)]">
        {Math.round(value)} · ×{weight}
      </div>
    </div>
  );
}

export default function Methodology() {
  const [arg, setArg] = useState({ dist: 3, gap: 0.4, criticality: 60, confidence: 80, digDepth: 1.5 });

  const r = useMemo(() => {
    const utility = offset({ lat: 0, lng: 0 }, 0, arg.dist);
    const result = scoreUtility(
      { point: { lat: 0, lng: 0 }, depth: arg.digDepth },
      { ...utility, depth: Math.max(0.1, arg.digDepth - arg.gap), criticality: arg.criticality, confidence: arg.confidence }
    );
    const contributions = {
      depth: WEIGHTS.depth * result.depthRisk,
      horizontal: WEIGHTS.horizontal * result.horizontalRisk,
      criticality: WEIGHTS.criticality * result.criticalityRisk,
      confidence: WEIGHTS.confidence * result.confidenceRisk,
    };
    const weightedRisk = Object.values(contributions).reduce((a, b) => a + b, 0);
    const score = clamp(100 - weightedRisk, 0, 100);
    return { result, contributions, weightedRisk, score };
  }, [arg]);

  const band = bandFor(r.score);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-display font-semibold text-[20px] tracking-tight">DigSafe Risk Methodology</h1>
        <p className="text-[12.5px] text-[var(--text-dim)] mt-1.5 max-w-[720px] leading-relaxed">
          The DigSafe score is a deterministic, explainable model — never AI-computed. Gemini only narrates these
          results; the arithmetic below is open code that runs identically in the planner and on the backend. This
          page renders from the same engine, so it can never drift from what the product actually computes.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Live demo */}
        <section className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display font-semibold text-[14px]">Interactive example</h2>
            <span className="font-mono text-[10px] text-[var(--text-faint)]">one utility · live engine</span>
          </div>

          <div className="space-y-3.5 mb-4">
            <Slider label="Horizontal distance from dig point" value={arg.dist} min={0.5} max={10} step={0.1} unit=" m" onChange={(v) => setArg((s) => ({ ...s, dist: v }))} />
            <Slider label="Utility depth below the dig bottom" value={arg.gap} min={0} max={1.5} step={0.05} unit=" m" onChange={(v) => setArg((s) => ({ ...s, gap: v }))} />
            <Slider label="Utility criticality" value={arg.criticality} min={0} max={100} step={5} unit="" onChange={(v) => setArg((s) => ({ ...s, criticality: v }))} />
            <Slider label="Registry confidence" value={arg.confidence} min={50} max={100} step={5} unit="%" onChange={(v) => setArg((s) => ({ ...s, confidence: v }))} />
          </div>

          <div className="flex flex-wrap gap-1.5 mb-4">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setArg(p.value)}
                className="text-[10.5px] font-semibold px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <Bar label="Vertical" value={r.result.depthRisk} weight={WEIGHTS.depth} />
            <Bar label="Horizontal" value={r.result.horizontalRisk} weight={WEIGHTS.horizontal} />
            <Bar label="Criticality" value={r.result.criticalityRisk} weight={WEIGHTS.criticality} />
            <Bar label="Confidence" value={r.result.confidenceRisk} weight={WEIGHTS.confidence} />
          </div>

          <div className="mt-4 border-t border-[var(--border)] pt-4 flex items-center justify-between">
            <div className="font-mono text-[11px] text-[var(--text-faint)]">
              weighted risk Σ = {Math.round(r.weightedRisk)}
            </div>
            <div className="flex items-center gap-2.5">
              <span className="font-display text-[22px] font-semibold text-[var(--text)]">{Math.round(r.score)}</span>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${LEVEL_STYLE[band]}`}>
                {band}
              </span>
            </div>
          </div>
          <p className="mt-3 text-[10.5px] text-[var(--text-faint)] leading-relaxed">
            Working: 100 − (0.40×{Math.round(r.result.depthRisk)} + 0.35×{Math.round(r.result.horizontalRisk)} +
            0.15×{Math.round(r.result.criticalityRisk)} + 0.10×{Math.round(r.result.confidenceRisk)}) = {Math.round(r.score)}.
            {r.result.dist > DANGER_RADIUS_M ? ' (utility beyond danger radius — scores 100/LOW.)' : ''}
          </p>
        </section>

        {/* Bands */}
        <section className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg p-5">
          <h2 className="font-display font-semibold text-[14px] mb-4">Score bands</h2>
          <div className="space-y-2.5">
            {[
              { level: 'LOW', min: 78, color: 'text-emerald-400', note: 'Site is clear of recorded utilities within the danger radius.' },
              { level: 'MEDIUM', min: 55, color: 'text-amber-400', note: 'Close to a recorded utility — proceed with hand-dig care.' },
              { level: 'HIGH', min: 32, color: 'text-orange-400', note: 'Significant proximity. Stop, re-route or pull back.' },
              { level: 'CRITICAL', min: 0, color: 'text-red-400', note: 'A strike is highly likely at this point. Do not dig here.' },
            ].map((b) => (
              <div key={b.level} className="flex items-center gap-3 border border-[var(--border)] rounded-lg px-4 py-3">
                <div className={`font-mono text-[11px] font-bold ${b.color}`}>{b.level}</div>
                <div className="text-[10.5px] text-[var(--text-dim)] flex-1">{b.note}</div>
                <div className="font-mono text-[10.5px] text-[var(--text-faint)]">≥ {b.min}</div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11.5px] text-[var(--text-dim)] leading-relaxed">
            The score is <span className="text-[var(--text)]">record-relative</span> — it says how consistent a dig is with
            the utility registry. It is not a ground-truth scan. The only thing that authorises digging is a confirmed
            locate request (CBuD / Call Before u Dig).
          </p>
        </section>
      </div>

      {/* Factor cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {FACTORS.map((f) => (
          <section key={f.name} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg p-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-display font-semibold text-[13px]">{f.name}</h3>
              <span className="font-mono text-[10px] text-[var(--text-faint)]">weight ×{f.weight} · {f.kind}</span>
            </div>
            <p className="text-[12px] text-[var(--text-dim)] leading-relaxed">{f.detail}</p>
          </section>
        ))}
      </div>

      {/* Overall score + recommendations */}
      <section className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg p-5">
        <h2 className="font-display font-semibold text-[14px] mb-3">Aggregation &amp; alternatives</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-[12px] text-[var(--text-dim)] leading-relaxed">
          <div>
            <p className="mb-2">
              Every utility within the danger radius is scored; utilities farther away are excluded so a
              far-away safe pipe can&rsquo;t dilute a real nearby danger. The plan&rsquo;s overall score is
              <span className="font-mono text-[var(--text)]"> 0.4 × worst + 0.6 × average</span> of those nearby
              scores — a single risky utility still pulls the plan down, but no one factor can dominate alone.
            </p>
          </div>
          <div>
            <p className="mb-2">
              The planner then re-scores six candidate positions (1&nbsp;m shifts N/S/E/W and 2&nbsp;m diagonals)
              plus a shallower cut (depth − 0.5&nbsp;m) and ranks them by score, so a safer location is always
              one click away instead of being found by trial and error.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}