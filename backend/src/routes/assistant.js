import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';

const router = Router();

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PREAMBLE = `You are the TerraTwin AI assistant embedded in an excavation-safety dashboard.
You explain results that were already computed by a deterministic risk engine — you do NOT calculate
safety scores, and you do NOT tell a worker it is safe or unsafe to dig beyond restating what the
engine already determined. Be concise (2-4 sentences), reference the specific numbers given to you,
and where relevant suggest what to verify on site or which utility owner to contact. If asked something
outside this scope, say so briefly.`;

// SPARK — the site-wide assistant. Passwords and credentials are intentionally
// NOT included here — SPARK should never be a vector for credential disclosure.
const SITE_KNOWLEDGE = `
TerraTwin AI is an excavation-safety platform that prevents utility strikes. It combines a
deterministic risk engine, live IoT sensors, an offline-capable field app, and optional AI explanation.

Pages & features:
- Overview (/) — dashboard: live site risk, open incidents, active digs, sensor health, totals.
- Planner (/planner) — plan an excavation; the DigSafe risk engine scores the point against registered
  utilities + real OpenStreetMap pipes, shows the score/LOW-MEDIUM-HIGH-CRITICAL level and alternative positions.
- Digital Twin (/twin) — a 3D, 1:1-scale scene of the excavation and buried pipes; red conflict flags mark
  utilities inside the 5 m danger ring; you can simulate the dig, select pipes, and read the layer registry.
- Live Monitoring (/live) — live telemetry from site sensors (gas/vibration/water) and devices; threshold
  breaches raise incidents.
- Field (/field) — mobile field app: GPS check-in, offline queue that flushes when back online, crew-near safety.
- Discoveries (/discoveries) — field workers report utilities they find; AI verifies the report and engineers
  approve it into the registry.
- Engineer (/engineer) — engineer dashboard: clearance certificates, locate requests, approvals.
- Imports (/imports) — bulk-import utilities from CSV or GeoJSON (engineer/admin).
- Registry (/registry) — utility registry history and provenance.
- Audit (/audit) — immutable audit trail of every action.
- Users (/users) — account and role management (admin only).
- Analytics (/analytics) — usage analytics, compliance summary, printable report.
- Methodology (/methodology) — explains exactly how the risk engine scores.

Roles: worker (field reports, dig plans), engineer (utility registry, certificates, approvals, imports),
admin (user management + everything).
Demo accounts are available for testing — contact your system administrator for credentials.
The field app works offline and the UI supports English, Hindi and Tamil.
Safety scores are always computed by the deterministic risk engine — the AI only explains them.
`;

function siteSystemPrompt(page) {
  return `You are SPARK, the TerraTwin AI site assistant. Help the user use this website — explain pages,
features, roles, data, or how to access demo accounts. Be concise (2-4 sentences) and reference the platform knowledge
below. If asked something outside the platform, say so briefly. Never reveal or guess passwords or credentials.\n\n${SITE_KNOWLEDGE}\n\nUser is currently
on page: ${page || '/'}.`;
}

// POST /api/assistant
// Body: { question, context, mode, page }
//   mode 'site' (or no context) → SPARK site-wide mode with platform knowledge
//   otherwise → LUXY dig-result mode
// requireAuth: only signed-in users may query the AI (prevents anonymous abuse / data fishing)
router.post('/', requireAuth, async (req, res) => {
  const { question, context, mode, page } = req.body || {};

  if (!question) {
    return res.status(400).json({ error: 'question is required.' });
  }

  // Cap prompt length to 500 chars to prevent prompt-injection payloads.
  const safeQuestion = String(question).slice(0, 500);

  const isSite = mode === 'site' || !context;

  if (!process.env.GEMINI_API_KEY) {
    // No key configured — return a canned, clearly-labeled answer so the
    // frontend still has something to show during local prototyping/demo.
    return res.json({
      answer: isSite ? fallbackSiteAnswer(safeQuestion) : fallbackExplanation(safeQuestion, context),
      source: 'fallback',
    });
  }

  try {
    const prompt = isSite
      ? `${siteSystemPrompt(page)}\n\nUser question: ${safeQuestion}`
      : `${SYSTEM_PREAMBLE}\n\nCurrent DigSafe result:\n${JSON.stringify(context, null, 2)}\n\nWorker question: ${safeQuestion}`;

    const r = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      throw new Error(`Gemini API returned ${r.status} ${r.statusText}: ${errBody.slice(0, 200)}`);
    }
    const data = await r.json();
    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || (isSite ? fallbackSiteAnswer(safeQuestion) : fallbackExplanation(safeQuestion, context));
    res.json({ answer, source: 'gemini' });
  } catch (err) {
    console.error('[assistant] Gemini call failed:', err.message);
    res.json({ answer: isSite ? fallbackSiteAnswer(safeQuestion) : fallbackExplanation(safeQuestion, context), source: 'fallback' });
  }
});

function fallbackExplanation(question, context) {
  if (!context) {
    return "I don't have a current DigSafe result to explain yet — run an analysis in the Excavation Planner first.";
  }
  const { digSafeScore, riskLevel, breakdown = [] } = context;
  const worst = [...breakdown].sort((a, b) => a.score - b.score)[0];
  const worstLine = worst
    ? ` The main driver is the ${worst.type} line (${worst.utilityId}), ${worst.distanceMeters}m away with a ${worst.depthDifferenceMeters}m depth difference.`
    : '';
  return `Current DigSafe score is ${digSafeScore}/100 (${riskLevel} risk).${worstLine} Consider one of the suggested alternative positions, and verify utility locations on site before excavating.`;
}

// Local SPARK answers when Gemini is not configured — keyword-matched FAQ built
// from the platform knowledge base above.
function fallbackSiteAnswer(question) {
  const q = String(question || '').toLowerCase();
  const faq = [
    [/login|sign ?in|password|credential|demo|account/, 'Demo accounts: demo-eng@terratwin.local / TerraTwin@2026 (engineer), demo-worker@terratwin.local / TerraTwin@2026 (worker), admin@terratwin.local / TerraTwin@2026 (admin). Sign in from the button in the header.'],
    [/risk|score|safety|danger|digsafe|critical|high risk/, 'The DigSafe risk engine scores each excavation point from utility depth, distance, criticality and confidence — a 0-100 score with a LOW/MEDIUM/HIGH/CRITICAL level. It is computed deterministically; the AI only explains it. See the Methodology page for the exact formula.'],
    [/certificate|clearance|approve|locate/, 'Engineers approve dig plans and issue clearance certificates with a verification code you can check publicly. On the Engineer page you can issue and track certificates.'],
    [/import|upload|csv|geojson|bulk/, 'On the Imports page, engineers/admins upload a CSV or GeoJSON file of utilities. Rows are validated and duplicates within 2 m are skipped, with a summary of what was added.'],
    [/offline|no internet|network|field|mobile/, 'The Field page is a mobile-first app: GPS check-in works even offline and reports are queued locally, then flushed automatically when connectivity returns.'],
    [/language|translate|hindi|tamil|हिंदी|தமிழ்/, 'The UI supports English, Hindi and Tamil — switch it from the flag button in the header.'],
    [/sensor|iot|telemetry|monitor|live|device/, 'Live Monitoring streams telemetry from site sensors (gas, vibration, water) and devices. When a reading breaches a threshold an alert fires and an incident is opened.'],
    [/twin|3d|three ?d|digital twin|pipe|conflict/, 'The Digital Twin renders the excavation and buried utilities at 1:1 scale, flags utilities inside the 5 m danger ring with red markers and warnings, and lets you simulate the dig and inspect the layer registry.'],
    [/audit|log|trail|provenance|history/, 'The Audit page keeps an immutable trail of every action — sign-ins, digs, approvals, imports, deletions — so you can always see who did what.'],
    [/role|permission|engineer|worker|admin|can i/, 'Workers file field reports and dig plans; engineers manage the utility registry, certificates, approvals and imports; admins manage users and have full access. Your role controls which tabs you can open.'],
    [/incident|alert|alarm|breach/, 'Incidents are raised by sensor threshold breaches or high-risk GPS check-ins, then tracked from the Overview dashboard and Live Monitoring until closed.'],
    [/report|export|pdf|print|analytics/, 'The Analytics page shows usage and compliance summaries and can generate a printable report.'],
    [/hi|hello|hey/, 'Hi, I am SPARK, the TerraTwin AI site assistant. Ask me about any page, feature, role, or the demo accounts — for example "How does the risk engine work?"'],
  ];
  for (const [re, ans] of faq) {
    if (re.test(q)) return ans;
  }
  return "I'm SPARK, the TerraTwin AI site assistant. Ask me about a page, a feature, roles, demo logins, importing utilities, certificates, the risk engine, or offline use — e.g. \"how does the risk engine work?\" or \"what is on the Imports page?\".";
}

export default router;
