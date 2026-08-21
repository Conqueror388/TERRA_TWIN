import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

export function RequireAuth({ children }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'checking') {
    return <div className="min-h-screen flex items-center justify-center text-[13px] text-[var(--text-faint)]">Checking session…</div>;
  }
  if (status !== 'signed-in') {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return children;
}

export function RequireRole({ role, children }) {
  const { user } = useAuth();
  if (user?.role !== role) {
    return (
      <section className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-6 py-10 text-center max-w-[480px] mx-auto mt-10">
        <h2 className="font-display font-semibold text-[16px] mb-2">{role} only</h2>
        <p className="text-[12.5px] text-[var(--text-dim)]">
          You&apos;re signed in as a {user?.role || 'guest'}. This page is restricted to the {role} role.
          {role === 'admin'
            ? ' Only administrators can manage accounts and permissions.'
            : ' Engineer and administrator access is granted by an administrator.'}
        </p>
      </section>
    );
  }
  return children;
}

export function RequireAnyRole({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(user?.role)) {
    return (
      <section className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-6 py-10 text-center max-w-[480px] mx-auto mt-10">
        <h2 className="font-display font-semibold text-[16px] mb-2">Restricted</h2>
        <p className="text-[12.5px] text-[var(--text-dim)]">
          You&apos;re signed in as a {user?.role || 'guest'}. This page is restricted to the {roles.join(' / ')} roles.
        </p>
      </section>
    );
  }
  return children;
}
