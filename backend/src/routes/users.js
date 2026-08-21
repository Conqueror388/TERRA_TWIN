import { Router } from 'express';
import { listUsers, updateUser } from '../lib/store.js';
import { requireRole } from '../lib/auth.js';
import { logAction } from '../lib/audit.js';

const router = Router();

const ROLES = ['worker', 'engineer', 'admin'];

function safeUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active !== false,
    createdAt: u.createdAt || null,
  };
}

// GET /api/users — admin-only directory.
router.get('/', requireRole('admin'), async (req, res) => {
  const users = await listUsers();
  res.json(users.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)).map(safeUser));
});

// PATCH /api/users/:id — admin sets a role or activates/deactivates an
// account. Guards: you cannot modify yourself, and the last admin can never
// be demoted or deactivated (a lockout-proof deployment).
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { role, active } = req.body || {};

  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }
  if (active !== undefined && typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active must be a boolean.' });
  }
  if (role === undefined && active === undefined) {
    return res.status(400).json({ error: 'Provide role or active to update.' });
  }

  if (req.params.id === req.user.sub) {
    return res.status(400).json({ error: 'Administrators cannot modify their own role or status.' });
  }

  const users = await listUsers();
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const willBeActive = active !== undefined ? active : target.active !== false;
  const willBeRole = role !== undefined ? role : target.role;
  const adminCount = users.filter((u) => u.role === 'admin' && u.active !== false).length;
  const isTargetAdmin = target.role === 'admin' && target.active !== false;

  if (isTargetAdmin && adminCount === 1 && (willBeRole !== 'admin' || !willBeActive)) {
    return res.status(400).json({ error: 'Cannot demote or deactivate the last active administrator.' });
  }

  const patch = {};
  if (role !== undefined) patch.role = role;
  if (active !== undefined) patch.active = active;

  const updated = await updateUser(target.id, patch);
  if (!updated) return res.status(404).json({ error: 'User not found.' });

  const changes = [];
  if (role !== undefined) changes.push(`role → ${role}`);
  if (active !== undefined) changes.push(active ? 'activated' : 'deactivated');
  logAction(req, {
    action: 'USER.UPDATE',
    targetType: 'user',
    targetId: target.id,
    detail: `Admin ${req.user.name} updated ${target.email} — ${changes.join(', ')}`,
  });

  res.json(safeUser({ ...updated, active: updated.active !== false }));
});

export default router;