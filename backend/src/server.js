import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import utilitiesRoute from './routes/utilities.js';
import excavationsRoute from './routes/excavations.js';
import discoveriesRoute from './routes/discoveries.js';
import assistantRoute from './routes/assistant.js';
import devicesRoute from './routes/devices.js';
import analyticsRoute from './routes/analytics.js';
import uploadsRoute, { UPLOAD_DIR } from './routes/uploads.js';
import authRoute from './routes/auth.js';
import usersRoute from './routes/users.js';
import osmRoute from './routes/osm.js';
import locateRequestsRoute from './routes/locateRequests.js';
import auditRoute from './routes/audit.js';
import incidentsRoute from './routes/incidents.js';
import plansRoute from './routes/plans.js';
import registryRoute from './routes/registry.js';
import exportRoute from './routes/export.js';
import importsRoute from './routes/imports.js';
import certificatesRoute from './routes/certificates.js';
import sensorsRoute from './routes/sensors.js';
import { attachUser, requireAuth } from './lib/auth.js';
import { securityHeaders, rateLimit } from './lib/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Trust the first proxy hop (Render's load balancer / Vercel proxy) so
// req.ip correctly reflects the real client IP from X-Forwarded-For.
// Without this, all requests appear to come from the same proxy IP and
// everyone shares a single rate-limit bucket.
app.set('trust proxy', 1);

app.disable('x-powered-by');

app.use(securityHeaders);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Include X-Device-Key so ESP32 hardware can authenticate GPS check-ins.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Key'],
}));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(attachUser);

// Generic API guardrail.
app.use('/api', rateLimit({ windowMs: 10 * 60 * 1000, max: 600, message: 'Rate limit exceeded — slow down and try again.' }));
// Brute-force protection on credential endpoints — 30 per 15 min per real IP.
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many login attempts — try again in a few minutes.' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'terratwin-backend' });
});

// ── Public security.txt ────────────────────────────────────────────────────
// CERT-In and government partners expect this file at /.well-known/security.txt
// so security researchers know how to responsibly disclose vulnerabilities.
app.get('/.well-known/security.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send([
    'Contact: mailto:security@terratwin.local',
    'Preferred-Languages: en, hi, ta',
    'Scope: https://terratwin.local/',
    'Policy: https://terratwin.local/security-policy',
    'Encryption: none',
    '# TerraTwin AI SafeDig Platform — responsible vulnerability disclosure.',
    '# Please report security issues to the contact address above.',
    '# We commit to acknowledging reports within 2 business days.',
  ].join('\n'));
});

app.use('/api/auth', authRoute);
app.use('/api/users', usersRoute);

app.use('/api/utilities', utilitiesRoute);
// /api/excavations/analyze is guarded inside the route (requireAuth added there).
app.use('/api/excavations', excavationsRoute);
app.use('/api/discoveries', discoveriesRoute);
// /api/assistant requires auth (added inside the route).
app.use('/api/assistant', assistantRoute);
app.use('/api/devices', devicesRoute);
// Analytics, locate-requests, incidents, plans, registry, exports, imports,
// certificates, sensors — all guarded inside their own route files.
app.use('/api/analytics', analyticsRoute);
app.use('/api/uploads', uploadsRoute);
app.use('/api/osm', osmRoute);
app.use('/api/locate-requests', locateRequestsRoute);
app.use('/api/incidents', incidentsRoute);
app.use('/api/plans', plansRoute);
app.use('/api/registry', registryRoute);
app.use('/api/export', exportRoute);
app.use('/api/audit', auditRoute);
app.use('/api/imports', importsRoute);
app.use('/api/certificates', certificatesRoute);
app.use('/api/sensors', sensorsRoute);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ───────────────────────────────────────────────────
// Catches any unhandled synchronous or async errors that propagate via next(err).
// In production: returns a generic message — stack traces NEVER reach the client.
// In development: includes the message (not the full stack) for easier debugging.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[unhandled error]', err);
  const status = err.status || err.statusCode || 500;
  const message = IS_PROD
    ? 'An unexpected server error occurred. Please try again or contact support.'
    : (err.message || 'Internal server error');
  res.status(status).json({ error: message });
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TerraTwin backend listening on http://localhost:${PORT}`);
  });
}

export const appExport = app;
export default app;
