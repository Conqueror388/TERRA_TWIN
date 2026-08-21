import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { Sun, Moon, Settings, LogOut } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { useLanguage } from '../lib/useLanguage';
import { LANGS } from '../lib/i18n';
import SparkAssistant from './SparkAssistant';

const TABS = [
  { to: '/', tKey: 'nav.overview', end: true },
  { to: '/planner', tKey: 'nav.planner' },
  { to: '/twin', tKey: 'nav.twin' },
  { to: '/live', tKey: 'nav.live' },
  { to: '/field', tKey: 'nav.field' },
  { to: '/discoveries', tKey: 'nav.discoveries' },
  { to: '/engineer', tKey: 'nav.engineer', engineerOnly: true },
  { to: '/imports', tKey: 'nav.imports', engineerOnly: true },
  { to: '/audit', tKey: 'nav.audit', engineerOnly: true },
  { to: '/registry', tKey: 'nav.registry', engineerOnly: true },
  { to: '/users', tKey: 'nav.users', adminOnly: true },
  { to: '/analytics', tKey: 'nav.analytics' },
  { to: '/methodology', tKey: 'nav.methodology' },
];

// Key destinations for the mobile bottom bar — phones get a real nav while
// the desktop top bar stays hidden below lg.
const MOBILE_TABS = [
  { to: '/', tKey: 'nav.home', end: true },
  { to: '/planner', tKey: 'nav.plan' },
  { to: '/field', tKey: 'nav.field' },
  { to: '/live', tKey: 'nav.live' },
];

// Extra pages shown in the "More" slide-up drawer on mobile
const MORE_TABS = [
  { to: '/twin', tKey: 'nav.twin' },
  { to: '/analytics', tKey: 'nav.analytics' },
  { to: '/methodology', tKey: 'nav.methodology' },
  { to: '/discoveries', tKey: 'nav.report' },
  { to: '/engineer', tKey: 'nav.engineer', engineerOnly: true },
  { to: '/imports', tKey: 'nav.imports', engineerOnly: true },
  { to: '/audit', tKey: 'nav.audit', engineerOnly: true },
  { to: '/registry', tKey: 'nav.registry', engineerOnly: true },
  { to: '/users', tKey: 'nav.users', adminOnly: true },
];


export default function Layout() {
  const { user, logout } = useAuth();
  const { lang, setLang, t } = useLanguage();
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const settingsRef = useRef(null);

  useEffect(() => {
    function handleOutside(e) {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setSettingsOpen(false);
      }
    }
    function handleKey(e) {
      if (e.key === 'Escape') setSettingsOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  };
  const tabs = TABS.filter(
    (t) =>
      (!t.engineerOnly || user?.role === 'engineer' || user?.role === 'admin') &&
      (!t.adminOnly || user?.role === 'admin')
  );

  const location = useLocation();

  // Registry connectivity — 'live' once the backend serves real records,
  // 'snapshot' when we're on the bundled fallback dataset.
  const [registry, setRegistry] = useState(null);
  useEffect(() => {
    let cancel = false;
    api.getUtilities().then((res) => {
      if (!cancel) setRegistry(res ? 'live' : 'snapshot');
    });
    return () => { cancel = true; };
  }, []);

  // On a route change: scroll back to the top so the fresh page starts at the
  // top rather than whatever scroll position the previous page left behind.
  // Also close the mobile More drawer.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    setMoreOpen(false);
  }, [location.pathname]);

  const registryChip =
    registry === 'live'
      ? { dot: 'bg-emerald-400', label: t('header.liveRegistry') }
      : registry === 'snapshot'
        ? { dot: 'bg-amber-400', label: t('header.offlineDataset') }
        : { dot: 'bg-white/40', label: t('header.connecting') };

  const langOrder = Object.keys(LANGS);
  const nextLang = () => langOrder[(langOrder.indexOf(lang) + 1) % langOrder.length];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">

      <header className="sticky top-0 z-50 flex items-center gap-3 px-6 py-3 bg-[var(--bg-panel)] border-b border-[var(--border)]">
        <div className="flex items-center gap-2.5 shrink-0">
          <svg viewBox="0 0 30 30" fill="none" className="w-[26px] h-[26px]">
            <g className="tt-spin-slow">
              <circle cx="15" cy="15" r="13" stroke="#5BC8DC" strokeWidth="1.2" opacity="0.5" />
              <path d="M15 4 V26 M4 15 H26" stroke="#5BC8DC" strokeWidth="1" opacity="0.4" />
            </g>
            <circle cx="15" cy="15" r="4" fill="#5BC8DC" />
          </svg>
          <div>
            <div className="font-display font-bold text-[15.5px] tracking-tight">
              Terra<span className="text-cyan">Twin</span>
            </div>
            <div className="text-[10px] text-[var(--text-faint)]">{t('header.tagline')}</div>
          </div>
        </div>

        <nav className="hidden lg:flex flex-1 min-w-0 overflow-x-auto scrollbar-none">
          <div className="flex gap-1 mx-auto">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `font-medium text-[12px] px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-[var(--bg-panel-2)] text-[var(--text)]'
                      : 'text-[var(--text-dim)] hover:text-[var(--text)]'
                  }`
                }
              >
                {t(tab.tKey)}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="flex items-center gap-3 shrink-0 ml-auto">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-faint)] mr-1">
            <span className={`w-1.5 h-1.5 rounded-full ${registryChip.dot}`} />
            {registryChip.label}
          </div>

          <div className="relative" ref={settingsRef}>
            <button
              onClick={() => setSettingsOpen((open) => !open)}
              title="Settings"
              className={`flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition shrink-0 ${settingsOpen ? 'text-cyan border-cyan bg-[var(--bg-panel-2)]' : ''}`}
            >
              <Settings className="h-4 w-4" />
            </button>

            {settingsOpen && (
              <div className="absolute right-0 mt-2 w-64 rounded-lg bg-[var(--bg-panel)] border border-[var(--border)] shadow-xl p-4 z-50">
                <div className="text-[11px] font-bold text-[var(--text-dim)] mb-3 pb-1.5 border-b border-[var(--border)]/60 uppercase tracking-wider">
                  Settings & Preferences
                </div>
                
                {/* 1. Theme Toggle */}
                <div className="flex items-center justify-between py-2 border-b border-[var(--border)]/40">
                  <span className="text-[12px] font-medium text-[var(--text-dim)]">Appearance</span>
                  <button
                    onClick={toggleTheme}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition bg-[var(--bg-panel-2)] text-[11px]"
                  >
                    {theme === 'dark' ? (
                      <>
                        <Sun className="h-3.5 w-3.5" /> Light Mode
                      </>
                    ) : (
                      <>
                        <Moon className="h-3.5 w-3.5" /> Dark Mode
                      </>
                    )}
                  </button>
                </div>

                {/* 2. Language Switcher */}
                <div className="flex items-center justify-between py-2.5 border-b border-[var(--border)]/40">
                  <span className="text-[12px] font-medium text-[var(--text-dim)]">Language</span>
                  <button
                    onClick={() => setLang(nextLang())}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition bg-[var(--bg-panel-2)] text-[11.5px] font-medium"
                  >
                    <span>{LANGS[lang].flag}</span>
                    <span>{LANGS[lang].label}</span>
                  </button>
                </div>

                {/* 3. User Info & Logout */}
                {user ? (
                  <div className="mt-3 pt-2">
                    <div className="bg-[var(--bg-panel-2)] rounded p-2.5 mb-2.5 border border-[var(--border)]/40">
                      <div className="text-[12px] font-semibold text-[var(--text)] truncate">{user.name}</div>
                      <div className="text-[10px] text-[var(--text-faint)] capitalize mt-0.5">{user.role}</div>
                    </div>
                    <button
                      onClick={() => {
                        setSettingsOpen(false);
                        logout();
                      }}
                      className="w-full flex items-center justify-center gap-1.5 text-[11.5px] font-semibold py-2 rounded bg-red/10 text-red border border-red/20 hover:bg-red hover:text-white transition"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      {t('header.signOut')}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 text-center">
                    <div className="text-[11px] text-[var(--text-faint)] italic">Not signed in</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1280px] mx-auto px-6 py-7 pb-24 lg:pb-16">
        {/* Keyed by route so the enter animation replays on every page change */}
        <div key={location.pathname} className="page-enter min-h-[60vh]">
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom navigation — visible only on small screens */}
      <nav className="fixed bottom-0 inset-x-0 z-50 lg:hidden bg-[var(--bg-panel)] border-t border-[var(--border)] pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-stretch">
          {MOBILE_TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `flex-1 py-3 text-center font-medium text-[10.5px] tracking-wide ${
                  isActive ? 'text-cyan' : 'text-[var(--text-dim)]'
                }`
              }
            >
              {t(tab.tKey)}
            </NavLink>
          ))}
          {/* More button */}
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className={`flex-1 py-3 text-center font-medium text-[10.5px] tracking-wide transition ${moreOpen ? 'text-cyan' : 'text-[var(--text-dim)]'}`}
          >
            More
          </button>
        </div>
      </nav>

      {/* Mobile "More" slide-up drawer */}
      {moreOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute bottom-[49px] inset-x-0 bg-[var(--bg-panel)] border-t border-[var(--border)] shadow-2xl rounded-t-2xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-[var(--border)] rounded-full mx-auto mb-4" />
            {/* Scrollable grid so all tabs fit on small screens */}
            <div className="overflow-y-auto max-h-[55vh]">
              <p className="text-[10px] text-[var(--text-faint)] uppercase tracking-widest mb-2 px-1">Pages</p>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {MORE_TABS.filter(
                  (tab) =>
                    (!tab.engineerOnly || user?.role === 'engineer' || user?.role === 'admin') &&
                    (!tab.adminOnly || user?.role === 'admin')
                ).map((tab) => (
                  <NavLink
                    key={tab.to}
                    to={tab.to}
                    className={({ isActive }) =>
                      `flex flex-col items-center justify-center gap-1 py-3 px-2 rounded-xl text-[11px] font-medium text-center transition ${
                        isActive
                          ? 'bg-cyan/10 text-cyan'
                          : 'bg-[var(--bg-panel-2)] text-[var(--text-dim)] hover:text-[var(--text)]'
                      }`
                    }
                  >
                    {t(tab.tKey)}
                  </NavLink>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="text-center py-6 text-[11px] text-[var(--text-faint)] border-t border-[var(--border)]">
        TerraTwin AI SafeDig Platform &mdash; underground utility data sourced from the official government registry.
        Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="underline hover:text-cyan transition">OpenStreetMap</a> contributors (ODbL).
      </footer>

      <SparkAssistant hidden={moreOpen} />
    </div>
  );
}
