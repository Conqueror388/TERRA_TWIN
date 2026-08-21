import { Router } from 'express';
import {
  listRiskAssessments,
  listExcavations,
  listDiscoveryReports,
  listApprovedUtilities,
  listIncidents,
  listCertificates,
  listPlans,
  listLocateRequests,
  listLatestDeviceReadings,
  listLatestSensors,
} from '../lib/store.js';
import { requireRole } from '../lib/auth.js';

const router = Router();

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Working assumption for the ROI estimate: the average cost of one accidental
// utility strike (repairs, gas/water damage, service disruption, downtime).
// Kept explicit and labeled "estimate" in the report so the number is honest,
// not a magic metric.
const AVOID_COST_PER_STRIKE = 50000;

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

// A recommendation counts as "prevented a high-risk dig" when the plan as
// analyzed was HIGH/CRITICAL and the top alternative the engine offered was
// meaningfully safer (LOW/MEDIUM, or +25 points). It's a proxy — we don't
// yet track whether the worker actually took the suggested position — but
// it's derived from real analyze calls, not a hardcoded "5".
function wasHighRiskAverted(a) {
  if (a.riskLevel !== 'HIGH' && a.riskLevel !== 'CRITICAL') return false;
  if (!a.topRecommendation) return false;
  const improved = a.topRecommendation.score - a.digSafeScore >= 25;
  const saferLevel = a.topRecommendation.level === 'LOW' || a.topRecommendation.level === 'MEDIUM';
  return improved || saferLevel;
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

// Shared computation for both the JSON summary and the printable report —
// every figure is derived from real store data, never mocked.
async function computeSummary() {
  const [assessments, excavations, discoveries, approvedUtilities, incidents, certificates, plans, locateRequests, deviceReadings, sensors] = await Promise.all([
    listRiskAssessments(),
    listExcavations(),
    listDiscoveryReports(),
    listApprovedUtilities(),
    listIncidents(),
    listCertificates(),
    listPlans(),
    listLocateRequests(),
    listLatestDeviceReadings(),
    listLatestSensors(),
  ]);

  // Excavations analyzed per month, last 6 months, oldest first.
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, month: MONTH_LABELS[d.getMonth()], count: 0 });
  }
  const monthIndex = new Map(months.map((m) => [m.key, m]));
  for (const a of assessments) {
    const d = new Date(a.analyzedAt);
    if (Number.isNaN(d.getTime())) continue;
    const bucket = monthIndex.get(`${d.getFullYear()}-${d.getMonth()}`);
    if (bucket) bucket.count += 1;
  }

  const levels = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const riskMix = levels.map((level) => ({
    level,
    count: assessments.filter((a) => a.riskLevel === level).length,
  }));

  const preventedHighRisk = assessments.filter(wasHighRiskAverted).length;

  const verifiedConfidences = discoveries
    .map((d) => d.aiConfidence)
    .filter((c) => typeof c === 'number');
  const avgConfidence = verifiedConfidences.length
    ? Math.round(verifiedConfidences.reduce((sum, c) => sum + c, 0) / verifiedConfidences.length)
    : null;

  const resolvedIncidents = incidents.filter((i) => i.status === 'RESOLVED');
  const resolveDurations = resolvedIncidents
    .map((i) => new Date(i.resolvedAt).getTime() - new Date(i.createdAt).getTime())
    .filter((d) => Number.isFinite(d) && d >= 0);

  const digsWithLocate = excavations.filter((e) => e.locateStatus === 'CONFIRMED' || e.locateStatus === 'OVERRIDDEN').length;

  const approvedPlans = plans.filter((p) => (p.reviewStatus || 'PENDING') === 'APPROVED').length;

  const alertingSensors = sensors.filter((s) => s.status === 'ALERT').length;

  return {
    generatedAt: now.toISOString(),
    monthly: months.map(({ month, count }) => ({ month, count })),
    riskMix,
    totals: {
      excavationsAnalyzed: assessments.length,
      activeExcavations: excavations.filter((e) => e.status === 'active').length,
      completedExcavations: excavations.filter((e) => e.status === 'completed').length,
      utilityRecords: approvedUtilities.length,
      discoveryReports: discoveries.length,
      verifiedReports: discoveries.filter((d) => typeof d.aiConfidence === 'number').length,
      approvedReports: discoveries.filter((d) => d.status === 'APPROVED').length,
      avgVerificationConfidence: avgConfidence,
    },
    incidents: {
      total: incidents.length,
      open: incidents.filter((i) => i.status === 'OPEN').length,
      acknowledged: incidents.filter((i) => i.status === 'ACKNOWLEDGED').length,
      resolved: resolvedIncidents.length,
      avgResolveHours: resolveDurations.length ? round1(resolveDurations.reduce((s, d) => s + d, 0) / resolveDurations.length / 3600000) : null,
    },
    certificates: { issued: certificates.length },
    locate: {
      total: locateRequests.length,
      cleared: locateRequests.filter((r) => r.status === 'CONFIRMED' || r.status === 'OVERRIDDEN').length,
    },
    plans: {
      total: plans.length,
      approved: approvedPlans,
      pending: plans.filter((p) => (p.reviewStatus || 'PENDING') === 'PENDING').length,
      rejected: plans.filter((p) => (p.reviewStatus || 'PENDING') === 'REJECTED').length,
    },
    devices: { active: deviceReadings.length },
    sensors: { active: sensors.length, alerting: alertingSensors },
    roi: {
      preventedHighRisk,
      costPerStrike: AVOID_COST_PER_STRIKE,
      estimatedAvoided: preventedHighRisk * AVOID_COST_PER_STRIKE,
    },
    compliance: {
      digsWithLocate,
      locateCoveragePct: excavations.length ? Math.round((digsWithLocate / excavations.length) * 100) : null,
      certificateCoveragePct: approvedPlans ? Math.round((certificates.length / approvedPlans) * 100) : null,
    },
  };
}

// GET /api/analytics — aggregates real usage data for the Analytics and
// Overview pages. Falls back to empty/zeroed shapes (never mock numbers).
router.get('/', async (req, res) => {
  const s = await computeSummary();
  res.json({
    monthly: s.monthly,
    riskMix: s.riskMix,
    preventedHighRisk: s.roi.preventedHighRisk,
    totals: s.totals,
  });
});

// GET /api/analytics/summary — engineer/admin: full compliance + ROI picture
// (incident lifecycle, certificates, locate coverage, cost-avoidance estimate).
router.get('/summary', requireRole('engineer', 'admin'), async (req, res) => {
  res.json(await computeSummary());
});

// GET /api/analytics/report — engineer/admin: printable compliance report
// (open in a new tab / iframe, print to PDF for the permitting authority).
router.get('/report', requireRole('engineer', 'admin'), async (req, res) => {
  const s = await computeSummary();
  const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(s.roi.estimatedAvoided);
  const pct = (v) => (v == null ? '—' : `${v}%`);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DigSafe Compliance Report — ${fmt(s.generatedAt)}</title>
<style>
  :root { --ink:#1A1D23; --muted:#6B7280; --line:#E5E7EB; --accent:#0E7490; --green:#1B7F4B; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color:var(--ink); margin:0; background:#F2F4F6; }
  .sheet { max-width:880px; margin:28px auto; background:#fff; border:1px solid var(--line); box-shadow:0 6px 24px rgba(0,0,0,.06); padding:44px 48px; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid var(--ink); padding-bottom:18px; }
  .brand { font-size:20px; font-weight:800; letter-spacing:-.02em; }
  .brand span { color:var(--accent); }
  .brand small { display:block; font-size:10px; font-weight:600; letter-spacing:.14em; color:var(--muted); margin-top:2px; }
  .doc-title { text-align:right; font-size:13px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  h1 { font-size:25px; margin:26px 0 4px; letter-spacing:-.02em; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 24px; }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:28px; }
  .kpi { border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .kpi b { font-size:24px; font-weight:800; letter-spacing:-.02em; display:block; }
  .kpi span { font-size:11px; color:var(--muted); }
  .section { margin-top:24px; }
  .section h2 { font-size:11px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin:0 0 10px; }
  .rows { border-top:1px solid var(--line); }
  .row { display:flex; justify-content:space-between; gap:20px; padding:8px 0; border-bottom:1px solid var(--line); font-size:13px; }
  .row .k { color:var(--muted); }
  .row .v { font-weight:600; text-align:right; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:32px; }
  .bar { height:8px; background:#EDF0F3; border-radius:99px; margin-top:6px; }
  .bar > i { display:block; height:8px; border-radius:99px; background:var(--accent); }
  .warn { margin-top:24px; background:#FFFBEB; border:1px solid #FDE68A; border-radius:8px; padding:14px 16px; font-size:12px; color:#92400E; line-height:1.5; }
  .foot { margin-top:30px; padding-top:16px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); line-height:1.6; }
  .sig { margin-top:30px; display:flex; justify-content:space-between; gap:40px; }
  .sig .block { flex:1; }
  .sig .line { border-top:1.5px solid var(--ink); padding-top:6px; font-size:12px; font-weight:600; }
  .sig .lbl { font-size:10px; color:var(--muted); margin-top:2px; }
  @media print { body { background:#fff; } .sheet { box-shadow:none; border:none; margin:0; max-width:none; padding:24px; } .no-print { display:none; } }
  .no-print { margin:16px auto 0; max-width:880px; text-align:center; }
  .btn { display:inline-block; padding:10px 18px; border:1px solid var(--ink); border-radius:8px; background:var(--ink); color:#fff; font-size:13px; font-weight:700; text-decoration:none; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="top">
      <div class="brand">Terra<span>Twin</span><small>DIGSAFE EXCAVATION PLATFORM</small></div>
      <div class="doc-title">Compliance &amp; Impact Report</div>
    </div>

    <h1>Platform compliance report</h1>
    <p class="sub">Generated ${fmt(s.generatedAt)} · All figures derived from live platform records (zero-filled until data exists).</p>

    <div class="kpis">
      <div class="kpi"><b>${s.totals.excavationsAnalyzed}</b><span>digs analyzed</span></div>
      <div class="kpi"><b>${s.totals.utilityRecords}</b><span>registry utility records</span></div>
      <div class="kpi"><b>${s.incidents.total}</b><span>alarm incidents raised</span></div>
      <div class="kpi"><b>${s.certificates.issued}</b><span>clearance certificates issued</span></div>
    </div>

    <div class="section">
      <h2>Activity — digs analyzed (last 6 months)</h2>
      <div class="rows">
        ${s.monthly.map((m) => `<div class="row"><span class="k">${esc(m.month)}</span><span class="v">${m.count}</span></div>`).join('')}
      </div>
    </div>

    <div class="grid">
      <div class="section">
        <h2>Risk mix of all analyses</h2>
        <div class="rows">
          ${s.riskMix.map((r) => `<div class="row"><span class="k">${esc(r.level)}</span><span class="v">${r.count}</span></div>`).join('')}
        </div>
      </div>

      <div class="section">
        <h2>High-risk digs prevented (engine-estimate)</h2>
        <div class="rows">
          <div class="row"><span class="k">HIGH/CRITICAL analyses averted</span><span class="v">${s.roi.preventedHighRisk}</span></div>
          <div class="row"><span class="k">Assumed cost per strike</span><span class="v">${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(s.roi.costPerStrike)}</span></div>
          <div class="row"><span class="k">Estimated cost avoided</span><span class="v">${money}</span></div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Incident lifecycle</h2>
      <div class="rows">
        <div class="row"><span class="k">Total incidents</span><span class="v">${s.incidents.total}</span></div>
        <div class="row"><span class="k">Open</span><span class="v">${s.incidents.open}</span></div>
        <div class="row"><span class="k">Acknowledged</span><span class="v">${s.incidents.acknowledged}</span></div>
        <div class="row"><span class="k">Resolved</span><span class="v">${s.incidents.resolved}</span></div>
        <div class="row"><span class="k">Avg. time to resolve</span><span class="v">${s.incidents.avgResolveHours == null ? '—' : `${s.incidents.avgResolveHours} h`}</span></div>
      </div>
    </div>

    <div class="grid">
      <div class="section">
        <h2>Dig-plan approvals</h2>
        <div class="rows">
          <div class="row"><span class="k">Plans submitted</span><span class="v">${s.plans.total}</span></div>
          <div class="row"><span class="k">Approved</span><span class="v">${s.plans.approved}</span></div>
          <div class="row"><span class="k">Pending review</span><span class="v">${s.plans.pending}</span></div>
          <div class="row"><span class="k">Rejected</span><span class="v">${s.plans.rejected}</span></div>
          <div class="row"><span class="k">Certificate coverage (approved)</span><span class="v">${pct(s.compliance.certificateCoveragePct)}</span></div>
        </div>
      </div>

      <div class="section">
        <h2>Locate &amp; CBuD compliance</h2>
        <div class="rows">
          <div class="row"><span class="k">Locate requests logged</span><span class="v">${s.locate.total}</span></div>
          <div class="row"><span class="k">Cleared (confirmed / overridden)</span><span class="v">${s.locate.cleared}</span></div>
          <div class="row"><span class="k">Digs started with a cleared locate</span><span class="v">${s.compliance.digsWithLocate} / ${s.totals.activeExcavations + s.totals.completedExcavations}</span></div>
          <div class="row"><span class="k">Locate coverage of digs</span><span class="v">${pct(s.compliance.locateCoveragePct)}</span></div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Live field &amp; IoT</h2>
      <div class="rows">
        <div class="row"><span class="k">Active field devices (GPS)</span><span class="v">${s.devices.active}</span></div>
        <div class="row"><span class="k">Site sensors reporting</span><span class="v">${s.sensors.active}</span></div>
        <div class="row"><span class="k">Sensors in ALERT</span><span class="v">${s.sensors.alerting}</span></div>
        <div class="row"><span class="k">Discovery reports</span><span class="v">${s.totals.discoveryReports}</span></div>
        <div class="row"><span class="k">Avg. AI verification confidence</span><span class="v">${s.totals.avgVerificationConfidence == null ? '—' : `${s.totals.avgVerificationConfidence}%`}</span></div>
      </div>
    </div>

    <div class="warn">
      <b>Method note.</b> "High-risk digs prevented" counts analyzed plans that scored HIGH/CRITICAL where the engine's top
      alternative was meaningfully safer; it does not yet confirm the worker took the alternative. The cost-avoidance figure
      multiplies that count by an assumed $50,000 per strike and is an <b>estimate</b>, not a measured saving. All other
      figures are exact counts from platform records.
    </div>

    <div class="sig">
      <div class="block">
        <div class="line">${esc((req.user && (req.user.name || req.user.email)) || '—')}</div>
        <div class="lbl">Generated by</div>
      </div>
      <div class="block">
        <div class="line">TerraTwin AI — DigSafe platform</div>
        <div class="lbl">${fmt(s.generatedAt)}</div>
      </div>
    </div>

    <div class="foot">
      Generated by TerraTwin AI — DigSafe excavation platform. Utility data is the official registry plus live OpenStreetMap
      records; TerraTwin AI does not physically detect buried infrastructure. Report ID ${s.generatedAt}.
    </div>
  </div>
  <div class="no-print"><a class="btn" href="javascript:window.print()">Print / Save as PDF</a></div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="terratwin-compliance-report.html"`);
  res.send(html);
});

export default router;