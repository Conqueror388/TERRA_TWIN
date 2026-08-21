import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';

const ROLE_LABEL = { worker: 'Field worker', engineer: 'Engineer', admin: 'Administrator' };
const ROLE_CLS = {
  worker: 'bg-[var(--bg-panel-2)] text-[var(--text-faint)]',
  engineer: 'bg-[var(--bg-panel-2)] text-amber',
  admin: 'bg-[var(--bg-panel-2)] text-cyan',
};

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null); // null = backend offline
  const [busy, setBusy] = useState(null); // user id currently updating
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const res = await api.listUsers();
    setUsers(res || null);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(id, body) {
    setBusy(id);
    setError(null);
    const res = await api.updateUser(id, body);
    setBusy(null);
    if (!res) { setError('Update failed — is the backend running and are you signed in as admin?'); return; }
    setUsers((prev) => (prev ? prev.map((u) => (u.id === id ? { ...u, ...res } : u)) : prev));
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-display font-semibold text-[20px] tracking-tight">Users &amp; Roles</h1>
        <p className="text-[12.5px] text-[var(--text-dim)] mt-1.5 max-w-[680px] leading-relaxed">
          Role-based access control: the first account on the platform is bootstrapped as administrator; every later
          registration is a field worker. Engineer and admin access is granted here — never self-selected — and every
          change is recorded on the audit trail.
        </p>
      </header>

      {error && <p className="text-[12px] text-red mb-4">{error}</p>}

      {!users ? (
        <section className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-6 py-10 text-center text-[12.5px] text-[var(--text-dim)]">
          Start the backend with <code className="text-cyan">npm run dev</code> in <code className="text-cyan">backend/</code>{' '}
          and sign in as an administrator to manage users.
        </section>
      ) : (
        <section className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg overflow-hidden">
          {users.length === 0 ? (
            <div className="px-6 py-10 text-center text-[12.5px] text-[var(--text-dim)]">No users yet.</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {users.map((u) => {
                const isMe = me?.id === u.id;
                return (
                  <div key={u.id} className="grid grid-cols-[1fr_150px_150px_90px] gap-3 items-center px-5 py-3.5 hover:bg-[var(--bg-panel-2)]/50">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-semibold truncate">{u.name}</span>
                        {isMe && <span className="font-mono text-[9px] text-cyan border border-cyan/30 rounded px-1 py-0.5">YOU</span>}
                      </div>
                      <div className="font-mono text-[10px] text-[var(--text-faint)] truncate">{u.email}</div>
                      <div className="font-mono text-[9.5px] text-[var(--text-faint)] mt-0.5">
                        {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}
                      </div>
                    </div>

                    <div>
                      <div className={`text-[10px] font-semibold px-2 py-0.5 rounded-md text-center ${ROLE_CLS[u.role]}`}>
                        {(ROLE_LABEL[u.role] || u.role).toUpperCase()}
                      </div>
                    </div>

                    <div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md ${
                        u.active ? 'bg-[var(--bg-panel-2)] text-emerald-400' : 'bg-[var(--bg-panel-2)] text-red-400'
                      }`}>
                        {u.active ? 'ACTIVE' : 'DEACTIVATED'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 justify-end">
                      <select
                        value={u.role}
                        disabled={isMe || busy === u.id || !u.active}
                        onChange={(e) => run(u.id, { role: e.target.value }, 'role')}
                        className="bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-md px-1.5 h-8 text-[11px] focus:outline-none focus:border-cyan disabled:opacity-40"
                      >
                        {Object.keys(ROLE_LABEL).map((r) => (
                          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                        ))}
                      </select>
                      <button
                        disabled={isMe || busy === u.id}
                        onClick={() => run(u.id, { active: !u.active })}
                        title={isMe ? 'You cannot modify your own account' : u.active ? 'Deactivate' : 'Activate'}
                        className="font-semibold text-[10.5px] px-2.5 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {u.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <p className="mt-4 text-[11.5px] text-[var(--text-faint)] leading-relaxed">
        The last active administrator can never be demoted or deactivated from here, to guarantee the platform can
        always be administered. You cannot modify your own account in this view.
      </p>
    </div>
  );
}