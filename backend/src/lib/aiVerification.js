// TerraTwin AI — Discovery verification (Phase 13)
// Gemini reviews a worker's "new utility" report against the existing
// registry and returns a confidence score + recommendation. This is
// advisory only: it NEVER writes to the utility database on its own. Only
// an explicit engineer approval (routes/discoveries.js -> /approve) does
// that (Phase 15).

import { listApprovedUtilities } from './store.js';
import { metersBetween } from './riskEngine.js';

// "gemini-flash-latest" is a self-updating alias (Google hot-swaps it to the
// current recommended Flash model with 2 weeks' notice on breaking changes),
// which is preferable to hardcoding a dated model string in a prototype repo
// that may sit untouched for a while. Pin to a specific version (e.g.
// "gemini-3.5-flash-lite") instead if you need fully reproducible behavior.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PREAMBLE = `You are the TerraTwin AI verification assistant. A field worker reported an
unrecorded underground utility. Compare it against the existing utility registry and give a short,
professional assessment: how plausible is this as a genuinely new record vs. a duplicate/misreport,
what should the engineer double-check, and a confidence percentage (0-100). Respond ONLY as compact
JSON: {"confidence": <0-100 integer>, "verdict": "<one short sentence>", "checks": ["<short check>", ...]}.
Do not approve or reject anything yourself — an engineer makes that call.`;

export async function verifyDiscovery(report) {
  const registered = await listApprovedUtilities();
  const nearby = registered
    .map((u) => ({ ...u, distanceMeters: metersBetween({ lat: report.latitude, lng: report.longitude }, u) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 3);

  if (!process.env.GEMINI_API_KEY) {
    return heuristicVerification(report, nearby);
  }

  try {
    const prompt = `${SYSTEM_PREAMBLE}\n\nDiscovery report:\n${JSON.stringify(report, null, 2)}\n\nNearest existing records:\n${JSON.stringify(
      nearby.map((n) => ({ id: n.id, type: n.type, depth: n.depth, distanceMeters: Number(n.distanceMeters.toFixed(1)) })),
      null,
      2
    )}`;

    const r = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      throw new Error(`Gemini API returned ${r.status} ${r.statusText}: ${errBody.slice(0, 200)}`);
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return {
      confidence: clampInt(parsed.confidence, 0, 100),
      verdict: parsed.verdict || 'Reviewed against nearby records.',
      checks: Array.isArray(parsed.checks) ? parsed.checks.slice(0, 5) : [],
      source: 'gemini',
      nearestExisting: nearby.map((n) => ({ id: n.id, type: n.type, distanceMeters: Number(n.distanceMeters.toFixed(1)) })),
    };
  } catch (err) {
    console.error('[aiVerification] Gemini call failed, using heuristic fallback:', err.message);
    return heuristicVerification(report, nearby);
  }
}

function heuristicVerification(report, nearby) {
  const closest = nearby[0];
  const sameTypeClose = nearby.find((n) => n.type === report.utilityType && n.distanceMeters < 3);

  let confidence = 78;
  const checks = [];

  if (sameTypeClose) {
    confidence -= 35;
    checks.push(`Within 3m of existing ${sameTypeClose.type} record ${sameTypeClose.id} — may be a duplicate, not a new find.`);
  } else {
    checks.push('No matching utility type recorded within 3m — plausible new record.');
  }

  if (closest && closest.distanceMeters < 1) {
    confidence -= 10;
    checks.push(`Very close (${closest.distanceMeters.toFixed(1)}m) to ${closest.id} — verify this isn't the same line.`);
  }

  if (report.estimatedDepth < 0.2 || report.estimatedDepth > 3) {
    confidence -= 15;
    checks.push('Estimated depth is outside the typical 0.2–3m range for this area — re-measure on site.');
  }

  if (report.notes && report.notes.length > 10) {
    confidence += 5;
    checks.push('Field notes provided — improves confidence in the report.');
  }

  confidence = clampInt(confidence, 5, 96);

  return {
    confidence,
    verdict:
      confidence >= 70
        ? 'Likely a genuine new infrastructure record. Recommend engineer review before adding.'
        : 'Possible duplicate or uncertain measurement. Recommend on-site re-verification before adding.',
    checks,
    source: 'fallback',
    nearestExisting: nearby.map((n) => ({ id: n.id, type: n.type, distanceMeters: Number(n.distanceMeters.toFixed(1)) })),
  };
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
