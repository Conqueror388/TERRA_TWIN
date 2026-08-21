// DigSafe clearance certificates — the permit-workflow bridge.
//
// When an engineer APPROVES a dig plan, an excavator can pull an official
// clearance certificate for that plan. The certificate is a printable
// document with a stable certificate number + verification code that an
// authority (site inspector, permitting office, municipal building-approval
// desk) can verify against the platform via /api/certificates/verify.
//
// One certificate per plan — never re-issued — so the number/code stay valid
// for the life of the job. Generation is idempotent: subsequent requests
// return the same certificate.

import { Router } from 'express';
import crypto from 'node:crypto';
import { getPlan } from '../lib/store.js';
import {
  saveCertificate,
  getCertificateByPlanId,
  getCertificateByCode,
  listCertificates,
  listRiskAssessments,
  listLocateRequests,
} from '../lib/store.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';

const router = Router();

const GATE_RADIUS_M = 25;

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

function fmtCoord(v) {
  return v == null ? '—' : Number(v).toFixed(6);
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — easy to read over the phone
  const pick = (n) => Array.from(crypto.randomBytes(n)).map((b) => alphabet[b % alphabet.length]).join('');
  return `TT-${pick(4)}-${pick(4)}`;
}

function riskLevelColor(level) {
  const map = {
    LOW: '#2E7D52',
    MODERATE: '#B26A17',
    HIGH: '#B3402F',
    CRITICAL: '#8F1D13',
  };
  return map[String(level).toUpperCase()] || '#3A3F47';
}

// Builds (and persists on first call) the certificate for an approved plan.
// Returns { certificate, created } so callers can distinguish a fresh issue
// from a repeat view on the audit trail.
async function buildCertificate(plan) {
  const existing = await getCertificateByPlanId(plan.id);
  if (existing) return { certificate: existing, created: false };

  const [assessments, locateRequests] = await Promise.all([listRiskAssessments(), listLocateRequests()]);

  // The analysis that best matches this plan's site — the latest risk
  // assessment logged within the gate radius.
  const analysis = assessments
    .filter((a) => {
      const dLat = (a.latitude - plan.excavation.point.lat) * 111000;
      const dLng = (a.longitude - plan.excavation.point.lng) * 111000 * Math.cos(plan.excavation.point.lat * Math.PI / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng) <= GATE_RADIUS_M;
    })
    .sort((a, b) => new Date(b.analyzedAt) - new Date(a.analyzedAt))[0] || null;

  // The confirmed locate that cleared this site (if any).
  const locate = locateRequests
    .filter((r) => {
      const dLat = (r.latitude - plan.excavation.point.lat) * 111000;
      const dLng = (r.longitude - plan.excavation.point.lng) * 111000 * Math.cos(plan.excavation.point.lat * Math.PI / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng) <= GATE_RADIUS_M;
    })
    .filter((r) => r.status === 'CONFIRMED' || r.status === 'OVERRIDDEN')
    .sort((a, b) => new Date(b.confirmedAt || b.updatedAt || b.createdAt) - new Date(a.confirmedAt || a.updatedAt || a.createdAt))[0] || null;

  const certificate = await saveCertificate({
    verificationCode: makeCode(),
    planId: plan.id,
    plan: {
      id: plan.id,
      name: plan.name,
      createdTs: plan.ts,
      creatorName: plan.creatorName,
      excavation: plan.excavation,
      result: plan.result,
      reviewedBy: plan.reviewedBy,
      reviewedAt: plan.reviewedAt,
    },
    analysis: analysis
      ? {
          digSafeScore: analysis.digSafeScore,
          riskLevel: analysis.riskLevel,
          depth: analysis.depth,
          purpose: analysis.purpose,
          topRecommendation: analysis.topRecommendation,
          analyzedAt: analysis.analyzedAt,
        }
      : null,
    locate: locate
      ? {
          id: locate.id,
          status: locate.status,
          ticketNumber: locate.ticketNumber,
          confirmedBy: locate.confirmedBy,
          overriddenBy: locate.overriddenBy,
          confirmedAt: locate.confirmedAt || locate.overriddenAt || null,
        }
      : null,
    issuedBy: { name: 'TerraTwin AI clearance service' },
  });

  return { certificate, created: true };
}

// GET /api/certificates/plans/:planId — JSON metadata for the frontend modal
// (number + verification code). The certificate is only issuable once the
// engineer has APPROVED the plan.
router.get('/plans/:planId', requireAuth, async (req, res) => {
  const plan = await getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  if ((plan.reviewStatus || 'PENDING') !== 'APPROVED') {
    return res.status(400).json({ error: 'A clearance certificate can only be issued for an APPROVED plan.' });
  }

  const { certificate, created } = await buildCertificate(plan);
  logAction(req, {
    action: created ? 'CERTIFICATE.ISSUE' : 'CERTIFICATE.VIEW',
    targetType: 'certificate',
    targetId: certificate.id,
    detail: `Certificate ${certificate.id} (${certificate.verificationCode}) ${created ? 'issued' : 'viewed'} for approved plan ${plan.id}`,
  });
  res.json({ certificate });
});

// GET /api/certificates/plans/:planId/document — the official printable
// HTML document (open in a new tab / iframe, print to PDF).
router.get('/plans/:planId/document', requireAuth, async (req, res) => {
  const plan = await getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found.' });
  if ((plan.reviewStatus || 'PENDING') !== 'APPROVED') {
    return res.status(400).json({ error: 'A clearance certificate can only be issued for an APPROVED plan.' });
  }

  const { certificate: c, created: certCreated } = await buildCertificate(plan);
  logAction(req, {
    action: certCreated ? 'CERTIFICATE.ISSUE' : 'CERTIFICATE.VIEW',
    targetType: 'certificate',
    targetId: c.id,
    detail: `Certificate ${c.id} (${c.verificationCode}) ${certCreated ? 'issued' : 'viewed'} for approved plan ${plan.id}`,
  });
  const p = c.plan;
  const point = p.excavation?.point || {};
  const riskLevel = c.analysis?.riskLevel || p.result?.level || '—';
  const score = c.analysis?.digSafeScore ?? (p.result && typeof p.result.overall === 'number' ? Math.round(p.result.overall) : null);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DigSafe Clearance — ${esc(p.name)}</title>
<style>
  :root { --ink:#1A1D23; --muted:#6B7280; --line:#E5E7EB; --accent:#0E7490; --green:#1B7F4B; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color:var(--ink); margin:0; background:#F2F4F6; }
  .sheet { max-width:820px; margin:28px auto; background:#fff; border:1px solid var(--line); box-shadow:0 6px 24px rgba(0,0,0,.06); padding:44px 48px; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid var(--ink); padding-bottom:18px; }
  .brand { font-size:20px; font-weight:800; letter-spacing:-.02em; }
  .brand span { color:var(--accent); }
  .brand small { display:block; font-size:10px; font-weight:600; letter-spacing:.14em; color:var(--muted); margin-top:2px; }
  .doc-title { text-align:right; font-size:13px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  h1 { font-size:26px; margin:26px 0 4px; letter-spacing:-.02em; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 26px; }
  .verify { display:flex; align-items:center; gap:22px; background:#F8FAFC; border:1px dashed var(--line); border-radius:10px; padding:18px 20px; margin-bottom:26px; }
  .verify .code { font-family:'SFMono-Regular', Consolas, monospace; font-size:26px; font-weight:700; letter-spacing:.06em; color:var(--ink); }
  .verify .hint { font-size:11px; color:var(--muted); margin-top:3px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:26px; }
  .section { margin-top:26px; }
  .section h2 { font-size:11px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin:0 0 10px; }
  .rows { border-top:1px solid var(--line); }
  .row { display:flex; justify-content:space-between; gap:20px; padding:8px 0; border-bottom:1px solid var(--line); font-size:13px; }
  .row .k { color:var(--muted); }
  .row .v { font-weight:600; text-align:right; }
  .score { display:flex; align-items:baseline; gap:12px; }
  .score b { font-size:34px; font-weight:800; letter-spacing:-.02em; }
  .score span { font-size:12px; font-weight:700; padding:3px 10px; border-radius:99px; color:#fff; }
  .warn { margin-top:24px; background:#FFFBEB; border:1px solid #FDE68A; border-radius:8px; padding:14px 16px; font-size:12px; color:#92400E; line-height:1.5; }
  .foot { margin-top:30px; padding-top:16px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); line-height:1.6; }
  .sig { margin-top:34px; display:flex; justify-content:space-between; gap:40px; }
  .sig .block { flex:1; }
  .sig .line { border-top:1.5px solid var(--ink); padding-top:6px; font-size:12px; font-weight:600; }
  .sig .lbl { font-size:10px; color:var(--muted); margin-top:2px; }
  @media print { body { background:#fff; } .sheet { box-shadow:none; border:none; margin:0; max-width:none; padding:24px; } .no-print { display:none; } }
  .no-print { margin:16px auto 0; max-width:820px; text-align:center; }
  .btn { display:inline-block; padding:10px 18px; border:1px solid var(--ink); border-radius:8px; background:var(--ink); color:#fff; font-size:13px; font-weight:700; text-decoration:none; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="top">
      <div class="brand">Terra<span>Twin</span><small>DIGSAFE EXCAVATION PLATFORM</small></div>
      <div class="doc-title">Excavation Clearance<br />Certificate</div>
    </div>

    <h1>${esc(p.name)}</h1>
    <p class="sub">This plan was reviewed against the underground utility registry and approved for excavation.</p>

    <div class="verify">
      <div>
        <div class="hint">VERIFICATION CODE — quote to the site inspector</div>
        <div class="code">${esc(c.verificationCode)}</div>
        <div class="hint">Certificate ${esc(c.id)} · issued ${fmt(c.issuedAt)}</div>
      </div>
      <div style="margin-left:auto; text-align:right; font-size:12px; color:var(--muted);">
        Verify at<br /><b style="color:var(--ink)">/api/certificates/verify</b><br />with the code above
      </div>
    </div>

    <div class="section">
      <h2>Excavation plan</h2>
      <div class="rows">
        <div class="row"><span class="k">Plan reference</span><span class="v">${esc(p.id)}</span></div>
        <div class="row"><span class="k">Submitted by</span><span class="v">${esc(p.creatorName || '—')}</span></div>
        <div class="row"><span class="k">Location (WGS84)</span><span class="v">${fmtCoord(point.lat)}, ${fmtCoord(point.lng)}</span></div>
        <div class="row"><span class="k">Planned depth</span><span class="v">${p.excavation?.depth != null ? esc(String(p.excavation.depth)) + ' m' : '—'}</span></div>
        <div class="row"><span class="k">Footprint</span><span class="v">${p.excavation?.width != null ? esc(String(p.excavation.width)) + ' W × ' + esc(String(p.excavation.length ?? '—')) + ' L (m)' : '—'}</span></div>
        <div class="row"><span class="k">Purpose</span><span class="v">${esc(p.excavation?.purpose || 'Not specified')}</span></div>
      </div>
    </div>

    <div class="grid">
      <div class="section">
        <h2>DigSafe risk assessment</h2>
        <div class="rows">
          <div class="row"><span class="k">DigSafe score</span><span class="v score"><b>${score == null ? '—' : esc(String(score))}</b>${riskLevel !== '—' ? `<span style="background:${riskLevelColor(riskLevel)}">${esc(riskLevel)}</span>` : ''}</span></div>
          <div class="row"><span class="k">Analysis depth</span><span class="v">${c.analysis?.depth != null ? esc(String(c.analysis.depth)) + ' m' : '—'}</span></div>
          <div class="row"><span class="k">Analysis time</span><span class="v">${fmt(c.analysis?.analyzedAt)}</span></div>
          <div class="row"><span class="k">Safest alternative</span><span class="v">${c.analysis?.topRecommendation ? esc(c.analysis.topRecommendation.label) + ' (score ' + esc(String(c.analysis.topRecommendation.score)) + ')' : '—'}</span></div>
        </div>
      </div>
      <div class="section">
        <h2>Engineering approval</h2>
        <div class="rows">
          <div class="row"><span class="k">Review status</span><span class="v">APPROVED</span></div>
          <div class="row"><span class="k">Approved by</span><span class="v">${esc(p.reviewedBy || '—')}</span></div>
          <div class="row"><span class="k">Approved at</span><span class="v">${fmt(p.reviewedAt)}</span></div>
          <div class="row"><span class="k">Plan created</span><span class="v">${p.createdTs ? fmt(new Date(p.createdTs).toISOString()) : '—'}</span></div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>CBuD / locate clearance</h2>
      <div class="rows">
        ${c.locate
          ? `<div class="row"><span class="k">Locate status</span><span class="v">${esc(c.locate.status)}</span></div>
             <div class="row"><span class="k">Ticket</span><span class="v">${esc(c.locate.ticketNumber || '—')}</span></div>
             <div class="row"><span class="k">Cleared by</span><span class="v">${esc(c.locate.confirmedBy || c.locate.overriddenBy || '—')}</span></div>
             <div class="row"><span class="k">Cleared at</span><span class="v">${fmt(c.locate.confirmedAt)}</span></div>`
          : `<div class="row"><span class="k">Locate status</span><span class="v">Not confirmed</span></div>`}
      </div>
    </div>

    <div class="warn">
      <b>Read before you dig.</b> This certificate is a record of the DigSafe risk review and engineering approval for this
      plan. It is <b>not</b> a substitute for physically locating utilities. Coordinate marks still apply; the registered
      underground data and live OSM records used in scoring carry confidence levels, not guarantees. Follow all on-site
      safe-digging practices and the marked locate lines.
    </div>

    <div class="sig">
      <div class="block">
        <div class="line">${esc(p.reviewedBy || '—')}</div>
        <div class="lbl">Approving engineer</div>
      </div>
      <div class="block">
        <div class="line">TerraTwin AI clearance service</div>
        <div class="lbl">Issued ${fmt(c.issuedAt)}</div>
      </div>
    </div>

    <div class="foot">
      Certificate ${esc(c.id)} · Verification code ${esc(c.verificationCode)} · Generated by TerraTwin AI — DigSafe
      excavation platform. Verify authenticity at the platform's certificate verification endpoint. Utility data is the
      official registry plus live OpenStreetMap records; TerraTwin AI does not physically detect buried infrastructure.
    </div>
  </div>
  <div class="no-print"><a class="btn" href="javascript:window.print()">Print / Save as PDF</a></div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="terratwin-clearance-${esc(p.id)}.html"`);
  res.send(html);
});

// GET /api/certificates/verify?code=TT-XXXX-XXXX — public, no auth. A site
// inspector or permitting authority enters the code from the printed
// certificate and gets the certificate record (or a clear "not found").
router.get('/verify', async (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code query param is required.' });

  const cert = await getCertificateByCode(code);
  if (!cert) return res.status(404).json({ valid: false, code, message: 'No certificate found for that code.' });

  res.json({
    valid: true,
    code,
    certificate: {
      id: cert.id,
      planId: cert.planId,
      planName: cert.plan?.name,
      issuedAt: cert.issuedAt,
      approvedBy: cert.plan?.reviewedBy,
      approvedAt: cert.plan?.reviewedAt,
      score: cert.analysis?.digSafeScore ?? (cert.plan?.result && typeof cert.plan.result.overall === 'number' ? Math.round(cert.plan.result.overall) : null),
      riskLevel: cert.analysis?.riskLevel || cert.plan?.result?.level || null,
      locateStatus: cert.locate?.status || null,
    },
  });
});

// GET /api/certificates — engineer/admin: all issued certificates, newest first.
router.get('/', requireRole('engineer', 'admin'), async (req, res) => {
  res.json({ certificates: await listCertificates() });
});

export default router;