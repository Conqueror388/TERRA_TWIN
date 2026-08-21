import jwt from 'jsonwebtoken';
import { findUserById } from './store.js';

// Dev fallback secret so the app still runs without extra setup — same
// philosophy as the Firebase/Gemini fallbacks elsewhere in this backend.
// Set a real JWT_SECRET in .env before deploying this anywhere real.
const SECRET = process.env.JWT_SECRET || 'terratwin-dev-secret-change-me';

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, name: user.name }, SECRET, {
    expiresIn: '30d',
  });
}

// Populates req.user from the Bearer token if present; does NOT reject
// requests with no token. Use requireAuth/requireRole below for that.
export function attachUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, SECRET);
    } catch {
      req.user = null;
    }
  }
  next();
}

// Hydrates the token's claims from the live user record (so role changes and
// deactivations take effect immediately — they don't wait on the JWT expiry)
// and blocks deactivated accounts. Shared by requireAuth and requireRole.
async function requireActiveUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  let full = null;
  try {
    full = await findUserById(req.user.sub);
  } catch {
    full = null;
  }
  if (!full) return res.status(401).json({ error: 'Sign in required.' });
  if (full.active === false) {
    return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
  }
  req.user.sub = full.id;
  req.user.email = full.email;
  req.user.name = full.name;
  req.user.role = full.role;
  next();
}

export function requireAuth(req, res, next) {
  return requireActiveUser(req, res, next);
}

export function requireRole(...roles) {
  return (req, res, next) =>
    requireActiveUser(req, res, () => {
      if (!roles.includes(req.user.role)) {
        return res
          .status(403)
          .json({ error: `This action requires one of these roles: ${roles.join(', ')}.` });
      }
      next();
    });
}