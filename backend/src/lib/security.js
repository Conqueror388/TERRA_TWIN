// Security middleware for the government-deployment posture.
// Covers: CSP, security headers, rate limiting, account lockout,
// input sanitization, magic-byte file validation, global error handling.

import { logAction } from './audit.js';

// ── Content-Security-Policy ────────────────────────────────────────────────
// Scope is tight: only sources the app actually uses. Adjust the connect-src
// list if you add new third-party API calls, or the style/font-src list if
// you change the typeface.
const CSP = [
  "default-src 'self'",
  // Scripts: only this origin — no CDN, no inline scripts
  "script-src 'self'",
  // Styles: inline needed for Tailwind/CSS-in-JS; Google Fonts for typefaces
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // Fonts: Google Fonts CDN
  "font-src 'self' https://fonts.gstatic.com",
  // Images: self + data URIs (map markers/icons) + blob (canvas exports)
  //         + OpenStreetMap tile servers
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.openstreetmap.org",
  // Fetch/XHR: self (API calls) + Nominatim (city search) + Overpass (OSM pipes)
  //            + Generative Language API (Gemini assistant)
  "connect-src 'self' https://nominatim.openstreetmap.org https://overpass-api.de https://generativelanguage.googleapis.com",
  // Workers/worklets: none
  "worker-src 'none'",
  // No inline event handlers or object embeds
  "object-src 'none'",
  // Prevents this page from being embedded in any frame anywhere
  "frame-ancestors 'none'",
  // Upgrade insecure requests when served over HTTPS
  "upgrade-insecure-requests",
].join('; ');

// Security headers middleware — applied to every response.
export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY'); // stricter than SAMEORIGIN — we never embed this in a frame
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  // HSTS — only send over HTTPS (the header is ignored over HTTP so it's safe
  // to include unconditionally; browsers ignore it when received over HTTP).
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// ── Sliding-window rate limiter ────────────────────────────────────────────
// Returns 429 with Retry-After once a key exceeds `max` requests within
// `windowMs`. Prunes stale buckets opportunistically so the Map can't grow
// unbounded.

// Sliding-window in-memory rate limiter. Returns 429 with Retry-After once a
// key (default: client IP) exceeds `max` requests within `windowMs`.
// Prunes stale buckets opportunistically so the map can't grow unbounded.
export function rateLimit({ windowMs = 15 * 60 * 1000, max = 20, message, keyFn } = {}) {
  const hits = new Map();
  const intervalMs = Math.max(1000, Math.floor(windowMs / 2));

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const alive = times.filter((t) => t > cutoff);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }, intervalMs).unref?.();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (hits.get(key) || []).filter((t) => t > cutoff);

    if (recent.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      logAction(req, {
        action: 'SECURITY.RATE_LIMIT',
        detail: `Client hit rate limit. Key: ${key}. Window: ${windowMs}ms, Max: ${max}`,
      });
      return res.status(429).json({ error: message || 'Too many requests — please wait a moment and try again.' });
    }

    recent.push(now);
    hits.set(key, recent);
    next();
  };
}