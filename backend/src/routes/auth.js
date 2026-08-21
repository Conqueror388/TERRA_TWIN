import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, findUserByEmail, findUserById, listUsers } from '../lib/store.js';
import { signToken, requireAuth } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';

const router = Router();

const REFRESH_SECRET = (process.env.JWT_SECRET || 'terratwin-dev-secret-change-me') + '-refresh';

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active !== false };
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id }, REFRESH_SECRET, { expiresIn: '30d' });
}

// ── Password strength policy (CERT-In / MEITY compliant) ──────────────────
// Min 12 chars, at least one uppercase, lowercase, digit, and special char.
function validatePassword(password, email) {
  if (!password || typeof password !== 'string') return 'Password is required.';
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one digit.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain at least one special character (e.g. @, #, !, $).';
  // Do not allow email prefix as password
  const emailPrefix = (email || '').split('@')[0].toLowerCase();
  if (emailPrefix && emailPrefix.length > 3 && password.toLowerCase().includes(emailPrefix)) {
    return 'Password must not contain your email address.';
  }
  return null; // valid
}

// ── Per-account login lockout ──────────────────────────────────────────────
// 5 consecutive failures → account locked for 15 minutes.
// Uses in-memory Map keyed by normalised email — survives server restarts only
// as long as the process lives; for a clustered deployment, move to Redis.
const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map(); // email → { count, lockedUntil }

function checkLockout(email) {
  const rec = loginAttempts.get(email);
  if (!rec) return null;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    const secondsLeft = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    return `Account temporarily locked after too many failed attempts. Try again in ${secondsLeft} seconds.`;
  }
  return null;
}

function recordFailure(email) {
  const rec = loginAttempts.get(email) || { count: 0, lockedUntil: null };
  rec.count += 1;
  if (rec.count >= LOCKOUT_MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_WINDOW_MS;
  }
  loginAttempts.set(email, rec);
}

function clearFailures(email) {
  loginAttempts.delete(email);
}

// POST /api/auth/register — { name, email, password }
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required.' });
  }
  const pwError = validatePassword(password, email);
  if (pwError) return res.status(400).json({ error: pwError });

  const existing = await findUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

  const currentUsers = await listUsers();
  const role = currentUsers.length === 0 ? 'admin' : 'worker';

  // bcrypt cost 12 — CERT-In / NIST recommendation for 2024+
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await createUser({
    name,
    email: String(email).trim().toLowerCase(),
    passwordHash,
    role,
    active: true,
    createdAt: new Date().toISOString(),
  });

  logAction(req, {
    action: 'AUTH.REGISTER',
    targetType: 'user',
    targetId: user.id,
    detail: `New ${user.role} account created`,
    actor: { id: user.id, name: user.name, email: user.email, role: user.role },
  });

  res.status(201).json({
    token: signToken(user),
    refreshToken: signRefreshToken(user),
    user: publicUser(user),
  });
});

// POST /api/auth/login — { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required.' });

  const normalizedEmail = String(email).trim().toLowerCase();

  // Check account lockout before hitting the database at all.
  const lockMsg = checkLockout(normalizedEmail);
  if (lockMsg) return res.status(429).json({ error: lockMsg });

  const user = await findUserByEmail(normalizedEmail);

  if (!user) {
    // Record failure against the email even if it doesn't exist — prevents
    // timing-based user enumeration via lockout absence.
    recordFailure(normalizedEmail);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  if (user.active === false) {
    return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    recordFailure(normalizedEmail);
    // Use same message — don't reveal whether the email exists.
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  // Successful login — clear lockout counter.
  clearFailures(normalizedEmail);

  logAction(req, {
    action: 'AUTH.LOGIN',
    targetType: 'user',
    targetId: user.id,
    actor: { id: user.id, name: user.name, email: user.email, role: user.role },
  });

  res.json({
    token: signToken(user),
    refreshToken: signRefreshToken(user),
    user: publicUser(user),
  });
});

// POST /api/auth/refresh — { refreshToken }
// Issues a new short-lived access token without requiring the user to re-enter
// their password. The refresh token itself is long-lived (30d) and signed with
// a separate secret, so a leaked access token can't forge a refresh.
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required.' });

  let payload;
  try {
    payload = jwt.verify(refreshToken, REFRESH_SECRET);
  } catch {
    return res.status(401).json({ error: 'Refresh token invalid or expired. Please sign in again.' });
  }

  const user = await findUserById(payload.sub);
  if (!user) return res.status(401).json({ error: 'User not found.' });
  if (user.active === false) {
    return res.status(403).json({ error: 'Account deactivated. Contact an administrator.' });
  }

  res.json({ token: signToken(user), user: publicUser(user) });
});

// POST /api/auth/logout — logs the sign-out event (token is stateless, so the
// client simply discards it; this endpoint exists for audit-trail completeness).
router.post('/logout', requireAuth, async (req, res) => {
  logAction(req, {
    action: 'AUTH.LOGOUT',
    targetType: 'user',
    targetId: req.user.sub,
    actor: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role },
  });
  res.json({ ok: true });
});

// GET /api/auth/me — validate a stored token on app load
router.get('/me', requireAuth, async (req, res) => {
  const user = await findUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicUser(user) });
});

export default router;
