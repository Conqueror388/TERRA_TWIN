import { saveAuditLog } from './store.js';

// Appends one immutable audit entry for a request. `req.user` is populated by
// the attachUser middleware (JWT); register/login pass an explicit `actor`
// since the user is only being created at that moment. Never throws — a
// failed audit write must not break the action that triggered it.
export function logAction(req, { action, targetType, targetId, detail, actor } = {}) {
  const who = actor || {
    id: req.user?.sub || 'system',
    name: req.user?.name || 'system',
    email: req.user?.email || null,
    role: req.user?.role || 'system',
  };

  saveAuditLog({
    actorId: String(who.id),
    actorName: who.name,
    actorEmail: who.email || null,
    actorRole: who.role,
    action,
    targetType: targetType || null,
    targetId: targetId != null ? String(targetId) : null,
    detail: detail || null,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
    at: new Date().toISOString(),
  }).catch((err) => console.warn('[audit] failed to log action:', err.message));
}