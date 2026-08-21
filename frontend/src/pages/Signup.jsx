import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

const FEATURES = [
  { title: 'Plan safer trenches', copy: 'Dig-zone drawing with instant, per-utility risk scoring.' },
  { title: 'Live excavation monitoring', copy: 'ESP32 GPS check-ins surface as live, color-coded risk.' },
  { title: 'Engineer-approved registry', copy: 'Every discovery goes through AI + human verification.' },
];

function strengthOf(p) {
  if (!p) return 0;
  let s = 1;
  if (p.length >= 12) s += 1;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s += 1;
  if (/\d/.test(p)) s += 1;
  if (/[^A-Za-z0-9]/.test(p)) s += 1;
  return Math.min(4, s);
}
const STRENGTH_COLOR = ['bg-[var(--border)]', 'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-emerald-500'];
const STRENGTH_LABEL = ['', 'Weak (too short)', 'Fair', 'Good', 'Strong'];

export default function Signup() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from || '/';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const strength = strengthOf(password);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await register(name, email, password, 'worker');
    setSubmitting(false);
    if (result.ok) {
      navigate(redirectTo, { replace: true });
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="page-enter min-h-screen bg-[var(--bg)] text-[var(--text)] lg:grid lg:grid-cols-[1.02fr_1fr]">
      {/* ── Brand / value panel (desktop) ─────────────────────────────── */}
      <aside className="hidden lg:flex flex-col justify-between p-12 relative overflow-hidden border-r border-[var(--border)] bg-[#08141f]">
        <div className="absolute -top-40 -left-40 w-[480px] h-[480px] rounded-full bg-cyan/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-48 -right-32 w-[420px] h-[420px] rounded-full bg-amber/10 blur-3xl pointer-events-none" />

        <div className="relative flex items-center gap-2.5">
          <svg viewBox="0 0 30 30" fill="none" className="w-[30px] h-[30px]">
            <circle cx="15" cy="15" r="13" stroke="#4FD1E8" strokeWidth="1.4" opacity="0.4" />
            <path d="M15 4 V26 M4 15 H26" stroke="#4FD1E8" strokeWidth="1" opacity="0.35" />
            <circle cx="15" cy="15" r="4.5" fill="#4FD1E8" />
            <circle cx="21" cy="10" r="2" fill="#F5A623" />
          </svg>
          <div className="font-display font-bold text-[17px] tracking-tight">
            TERRA<span className="text-cyan">TWIN</span> AI
          </div>
        </div>

        <div className="relative">
          <div className="font-display text-[34px] leading-[1.12] font-bold tracking-tight">
            Know what&rsquo;s underground.
            <br />
            <span className="text-cyan">Dig with confidence.</span>
          </div>
          <p className="text-[13.5px] text-[var(--text-dim)] mt-4 max-w-[420px] leading-relaxed">
            TerraTwin AI turns public records, live sensors, and reasoning into a clear, accountable dig
            risk picture — before the first bucket breaks ground.
          </p>

          <div className="mt-9 space-y-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="flex gap-3.5">
                <span className="mt-0.5 w-5 h-5 shrink-0 rounded-full border border-cyan/40 text-cyan flex items-center justify-center text-[11px] font-bold">✓</span>
                <div>
                  <div className="font-semibold text-[13.5px]">{f.title}</div>
                  <div className="text-[12px] text-[var(--text-dim)] mt-0.5">{f.copy}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative font-mono text-[10.5px] text-[var(--text-faint)]">
          UTILITY DATA FROM THE OFFICIAL REGISTRY &middot; GPS DOES NOT DETECT BURIED INFRASTRUCTURE
        </div>
      </aside>

      {/* ── Signup form panel ─────────────────────────────────────────── */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[440px]">
          {/* Mobile brand */}
          <div className="lg:hidden flex items-center justify-center gap-2.5 mb-8">
            <svg viewBox="0 0 30 30" fill="none" className="w-[28px] h-[28px]">
              <circle cx="15" cy="15" r="13" stroke="#4FD1E8" strokeWidth="1.4" opacity="0.4" />
              <path d="M15 4 V26 M4 15 H26" stroke="#4FD1E8" strokeWidth="1" opacity="0.35" />
              <circle cx="15" cy="15" r="4.5" fill="#4FD1E8" />
              <circle cx="21" cy="10" r="2" fill="#F5A623" />
            </svg>
            <span className="font-display text-[16px] font-bold tracking-tight">TERRA<span className="text-cyan">TWIN</span> AI</span>
          </div>

          <h1 className="font-display font-bold text-[24px] tracking-tight">Create your account</h1>
          <p className="text-[13px] text-[var(--text-dim)] mt-1.5">
            Start planning safer excavation in under a minute.
          </p>

          <form onSubmit={submit} className="mt-7">
            <Field label="Full name">
              <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Jane Worker" autoComplete="name" />
            </Field>

            <Field label="Work email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@company.com"
                autoComplete="email"
              />
            </Field>

            <Field label="Password">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                placeholder="Create a strong password"
                autoComplete="new-password"
              />
              <p className="text-[10px] text-[var(--text-dim)] mt-1.5 leading-normal">
                Must be at least 12 characters, including uppercase, lowercase, numbers, and special characters.
              </p>
              <div className="flex items-center gap-1.5 mt-2">
                {[1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className="h-1 flex-1 rounded-full transition-colors"
                    style={{ background: i <= strength ? STRENGTH_COLOR[strength] : 'var(--border)' }}
                  />
                ))}
                <span className="w-12 text-[10px] font-mono text-right text-[var(--text-faint)]">{STRENGTH_LABEL[strength]}</span>
              </div>
            </Field>

            <Field label="Access level">
              <div className="rounded-lg border border-[var(--border)] px-3 py-3 text-[11.5px] text-[var(--text-dim)] leading-relaxed">
                Your account starts as a <span className="text-cyan font-semibold">field worker</span>. Review and
                verification permissions are granted by an administrator after your identity is confirmed — roles are
                never self-selected.
              </div>
            </Field>

            <label className="flex items-start gap-2.5 text-[11.5px] text-[var(--text-dim)] cursor-pointer select-none mb-4">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                required
                className="mt-0.5 w-3.5 h-3.5 accent-cyan"
              />
              <span>
                I agree to the <span className="text-cyan underline underline-offset-2">terms of service</span> and{' '}
                <span className="text-cyan underline underline-offset-2">privacy policy</span>, and understand that
                demonstrated content may use sample utility data while the live registry feed is connected.
              </span>
            </label>

            {error && <p className="text-[12px] text-red mb-3">{error}</p>}

            <button
              type="submit"
              disabled={submitting || !consent}
              className="w-full font-semibold text-[13.5px] py-2.5 rounded-md bg-cyan text-[#03151F] hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating account…' : 'Create account'}
            </button>

            <p className="text-[12px] text-[var(--text-dim)] text-center mt-5">
              Already have an account?{' '}
              <Link to="/login" className="text-cyan font-semibold hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        </div>
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