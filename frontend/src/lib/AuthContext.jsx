/* oxlint-disable react/only-export-components -- AuthProvider + useAuth are
   intentionally co-located: useAuth is a thin hook over the same context. */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken } from '../lib/api';

const AuthContext = createContext(null);

const REFRESH_KEY = 'terratwin_refresh_token';
function getRefreshToken() { return localStorage.getItem(REFRESH_KEY); }
function setRefreshToken(t) {
  if (t) localStorage.setItem(REFRESH_KEY, t);
  else localStorage.removeItem(REFRESH_KEY);
}

// Decode JWT payload without verifying (verification is server-side).
// Returns null if the token is malformed.
function decodeJwtPayload(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch { return null; }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('checking'); // checking | signed-out | signed-in | offline
  const refreshTimerRef = useRef(null);

  // Silently exchange the stored refresh token for a new access token.
  async function silentRefresh() {
    const rt = getRefreshToken();
    if (!rt) return false;
    const res = await api.refreshToken(rt);
    if (res.ok && res.data?.token) {
      setToken(res.data.token);
      if (res.data.user) setUser(res.data.user);
      scheduleRefresh(res.data.token);
      return true;
    }
    return false;
  }

  // Schedule a silent refresh ~30 min before the access token expires.
  function scheduleRefresh(token) {
    clearTimeout(refreshTimerRef.current);
    const payload = decodeJwtPayload(token);
    if (!payload?.exp) return;
    const msUntilExpiry = payload.exp * 1000 - Date.now();
    const refreshIn = Math.max(0, msUntilExpiry - 30 * 60 * 1000); // 30 min before expiry
    refreshTimerRef.current = setTimeout(silentRefresh, refreshIn);
  }

  async function refreshFromToken() {
    const token = getToken();
    if (!token) {
      // No access token — try the refresh token before giving up.
      const refreshed = await silentRefresh();
      if (!refreshed) {
        setStatus('signed-out');
        return;
      }
    }
    const res = await api.me();
    if (res?.user) {
      setUser(res.user);
      setStatus('signed-in');
      scheduleRefresh(getToken());
    } else {
      // Token expired — try refresh token.
      const refreshed = await silentRefresh();
      if (refreshed) {
        const res2 = await api.me();
        if (res2?.user) { setUser(res2.user); setStatus('signed-in'); return; }
      }
      setToken(null);
      setRefreshToken(null);
      setUser(null);
      setStatus('signed-out');
    }
  }

  useEffect(() => {
    refreshFromToken();
    return () => clearTimeout(refreshTimerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(email, password) {
    const res = await api.login({ email, password });
    if (res.ok) {
      setToken(res.data.token);
      setRefreshToken(res.data.refreshToken || null);
      setUser(res.data.user);
      setStatus('signed-in');
      scheduleRefresh(res.data.token);
      return { ok: true };
    }
    return { ok: false, error: res.error };
  }

  async function register(name, email, password, role) {
    const res = await api.register({ name, email, password, role });
    if (res.ok) {
      setToken(res.data.token);
      setRefreshToken(res.data.refreshToken || null);
      setUser(res.data.user);
      setStatus('signed-in');
      scheduleRefresh(res.data.token);
      return { ok: true };
    }
    return { ok: false, error: res.error };
  }

  function logout() {
    clearTimeout(refreshTimerRef.current);
    // Best-effort server-side logout log — don't block on it.
    api.logout?.().catch(() => {});
    setToken(null);
    setRefreshToken(null);
    setUser(null);
    setStatus('signed-out');
  }

  return (
    <AuthContext.Provider value={{ user, status, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
