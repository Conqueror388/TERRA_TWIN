// TerraTwin AI — DigSafe Risk Engine  (v2 — calibrated)
// Deterministic, explainable risk scoring. NOT AI-driven.
// Gemini explains these results — it never computes or overrides them.
//
// v2 fixes:
//  1. DANGER_RADIUS_M reduced 15 → 5  (utilities > 5 m away score 100/LOW)
//  2. depthRisk uses cosine falloff (not linear x100) — gradual, physical
//  3. Utilities outside danger radius get early-exit score=100 (no bleed-through)
//  4. Overall uses 0.4 x min + 0.6 x avg  (one bad utility no longer tanks everything)
//  5. BANDS widened so LOW is achievable when site is genuinely clear

export const WEIGHTS = {
  depth:       0.40,
  horizontal:  0.35,
  criticality: 0.15,
  confidence:  0.10,
};

export const DANGER_RADIUS_M   = 5;
export const SAFE_DEPTH_SPAN_M = 1.5;

export const BANDS = [
  { min: 78, level: 'LOW'      },
  { min: 55, level: 'MEDIUM'   },
  { min: 32, level: 'HIGH'     },
  { min: -Infinity, level: 'CRITICAL' },
];

export function bandFor(score) {
  return BANDS.find((b) => score >= b.min).level;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function metersBetween(a, b) {
  const dNorth = (a.lat - b.lat) * 111320;
  const dEast  = (a.lng - b.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dNorth * dNorth + dEast * dEast);
}

export function offset(base, dNorthM, dEastM) {
  const dLat = dNorthM / 111320;
  const dLng = dEastM / (111320 * Math.cos((base.lat * Math.PI) / 180));
  return { lat: base.lat + dLat, lng: base.lng + dLng };
}

export function scoreUtility(excavation, utility) {
  const dist      = metersBetween(excavation.point, utility);
  const depthDiff = Math.abs(excavation.depth - utility.depth);

  if (dist > DANGER_RADIUS_M) {
    return {
      utility, depthDiff, dist,
      depthRisk: 0, horizontalRisk: 0, criticalityRisk: 0, confidenceRisk: 0,
      weightedRisk: 0, score: 100, level: 'LOW',
    };
  }

  const depthRatio = clamp(depthDiff / SAFE_DEPTH_SPAN_M, 0, 1);
  const depthRisk  = clamp(Math.cos(depthRatio * (Math.PI / 2)) * 100, 0, 100);
  const horizontalRisk  = clamp(100 - (dist / DANGER_RADIUS_M) * 100, 0, 100);
  const criticalityRisk = utility.criticality;
  const confidenceRisk  = 100 - utility.confidence;

  const weightedRisk =
    WEIGHTS.depth       * depthRisk       +
    WEIGHTS.horizontal  * horizontalRisk  +
    WEIGHTS.criticality * criticalityRisk +
    WEIGHTS.confidence  * confidenceRisk;

  const score = clamp(100 - weightedRisk, 0, 100);

  return {
    utility, depthDiff, dist,
    depthRisk, horizontalRisk, criticalityRisk, confidenceRisk,
    weightedRisk, score, level: bandFor(score),
  };
}

export function scoreExcavation(excavation, utilities) {
  const results = utilities.map((u) => scoreUtility(excavation, u));
  if (!results.length) return { results, overall: 100, level: 'LOW' };

  // Only nearby utilities (within DANGER_RADIUS) contribute to the overall
  // score — far-away LOW utilities must not dilute a real nearby danger.
  const nearbyResults = results.filter((r) => r.dist <= DANGER_RADIUS_M);
  const scoringSet    = nearbyResults.length > 0 ? nearbyResults : results;

  const scores   = scoringSet.map((r) => r.score);
  const minScore = Math.min(...scores);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const overall  = clamp(0.4 * minScore + 0.6 * avgScore, 0, 100);

  return { results, overall, level: bandFor(overall) };
}

export function generateRecommendations(excavation, utilities) {
  const shifts = [
    ['1 m North',       1,    0   ],
    ['1 m South',      -1,    0   ],
    ['1 m East',        0,    1   ],
    ['1 m West',        0,   -1   ],
    ['2 m North-East',  1.4,  1.4 ],
    ['2 m South-West', -1.4, -1.4 ],
  ];

  const candidates = shifts.map(([label, dN, dE]) => {
    const point = offset(excavation.point, dN, dE);
    const r = scoreExcavation({ ...excavation, point }, utilities);
    return { label, type: 'shift', point, overall: r.overall, level: r.level };
  });

  const shallower = { ...excavation, depth: Math.max(0.2, excavation.depth - 0.5) };
  const rShallow  = scoreExcavation(shallower, utilities);
  candidates.push({
    label: `Reduce depth to ${shallower.depth.toFixed(1)} m`,
    type: 'depth', depth: shallower.depth,
    overall: rShallow.overall, level: rShallow.level,
  });

  candidates.sort((a, b) => b.overall - a.overall);
  return candidates;
}
