import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const formRef = useRef(null);

  useEffect(() => {
    // Clear credentials on mount (prevent browser state caching on refresh)
    setEmail('');
    setPassword('');
    formRef.current?.reset();
  }, []);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await login(email, password);
    setSubmitting(false);
    if (result.ok) {
      navigate(redirectTo, { replace: true });
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="page-enter min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-6 py-12">
      <div className="page-enter w-full max-w-[420px]">
        <div className="flex items-center gap-2.5 justify-center mb-8">
          <svg viewBox="0 0 30 30" fill="none" className="w-[30px] h-[30px]">
            <circle cx="15" cy="15" r="13" stroke="#4FD1E8" strokeWidth="1.4" opacity="0.4" />
            <path d="M15 4 V26 M4 15 H26" stroke="#4FD1E8" strokeWidth="1" opacity="0.35" />
            <circle cx="15" cy="15" r="4.5" fill="#4FD1E8" />
            <circle cx="21" cy="10" r="2" fill="#F5A623" />
          </svg>
          <div className="font-display font-bold text-[16.5px] tracking-tight">
            TERRA<span className="text-cyan">TWIN</span> AI
          </div>
        </div>

        <h1 className="font-display font-bold text-[24px] tracking-tight text-center">Welcome back</h1>
        <p className="text-[13px] text-[var(--text-dim)] text-center mt-1.5 mb-7">
          Sign in to your DigSafe excavation workspace.
        </p>

        <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-6 py-6">
          <form ref={formRef} onSubmit={submit}>
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" autoComplete="email" />
            </Field>
            <Field label="Password">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="Your password" autoComplete="current-password" />
            </Field>

            {error && <p className="text-[12px] text-red mb-3">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full font-semibold text-[13.5px] py-2.5 rounded-md bg-cyan text-[#03151F] hover:opacity-90 transition disabled:opacity-60"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-[12px] text-[var(--text-dim)] text-center mt-5">
          New to TerraTwin AI?{' '}
          <Link to="/signup" className="text-cyan font-semibold hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="mb-4">
      <label className="block text-[11.5px] text-[var(--text-dim)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}