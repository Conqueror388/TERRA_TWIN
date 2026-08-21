import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import { LoadingState } from './components/Feedback';
import { RequireAuth, RequireRole, RequireAnyRole } from './components/ProtectedRoute';
import { AuthProvider } from './lib/AuthContext';
import { LanguageProvider } from './lib/LanguageContext';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Overview from './pages/Overview';

// Lazy-loaded: each of these pulls in a large per-route dependency
// (Planner -> Leaflet, Twin -> Three.js/React Three Fiber, Analytics ->
// Recharts) that shouldn't be in the initial bundle everyone downloads
// just to see the Overview page.
const Planner = lazy(() => import('./pages/Planner'));
const Twin = lazy(() => import('./pages/Twin'));
const LiveMonitoring = lazy(() => import('./pages/LiveMonitoring'));
const DiscoveryReports = lazy(() => import('./pages/DiscoveryReports'));
const EngineerDashboard = lazy(() => import('./pages/EngineerDashboard'));
const AuditTrail = lazy(() => import('./pages/AuditTrail'));
const RegistryHistory = lazy(() => import('./pages/RegistryHistory'));
const Methodology = lazy(() => import('./pages/Methodology'));
const Users = lazy(() => import('./pages/Users'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Imports = lazy(() => import('./pages/Imports'));
const Field = lazy(() => import('./pages/Field'));

function PageFallback() {
  return (
    <div className="flex h-64 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-panel)]">
      <LoadingState label="Loading view…" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <LanguageProvider>
        <AuthProvider>
          <Routes>
          <Route path="login" element={<Login />} />
          <Route path="signup" element={<Signup />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<Overview />} />
            <Route
              path="planner"
              element={
                <Suspense fallback={<PageFallback />}>
                  <Planner />
                </Suspense>
              }
            />
            <Route
              path="twin"
              element={
                <Suspense fallback={<PageFallback />}>
                  <Twin />
                </Suspense>
              }
            />
            <Route
              path="live"
              element={
                <Suspense fallback={<PageFallback />}>
                  <LiveMonitoring />
                </Suspense>
              }
            />
            <Route
              path="field"
              element={
                <Suspense fallback={<PageFallback />}>
                  <Field />
                </Suspense>
              }
            />
            <Route
              path="discoveries"
              element={
                <Suspense fallback={<PageFallback />}>
                  <DiscoveryReports />
                </Suspense>
              }
            />
            <Route
              path="engineer"
              element={
                <RequireAnyRole roles={['engineer', 'admin']}>
                  <Suspense fallback={<PageFallback />}>
                    <EngineerDashboard />
                  </Suspense>
                </RequireAnyRole>
              }
            />
            <Route
              path="audit"
              element={
                <RequireAnyRole roles={['engineer', 'admin']}>
                  <Suspense fallback={<PageFallback />}>
                    <AuditTrail />
                  </Suspense>
                </RequireAnyRole>
              }
            />
            <Route
              path="registry"
              element={
                <RequireAnyRole roles={['engineer', 'admin']}>
                  <Suspense fallback={<PageFallback />}>
                    <RegistryHistory />
                  </Suspense>
                </RequireAnyRole>
              }
            />
            <Route
              path="imports"
              element={
                <RequireAnyRole roles={['engineer', 'admin']}>
                  <Suspense fallback={<PageFallback />}>
                    <Imports />
                  </Suspense>
                </RequireAnyRole>
              }
            />
            <Route
              path="users"
              element={
                <RequireRole role="admin">
                  <Suspense fallback={<PageFallback />}>
                    <Users />
                  </Suspense>
                </RequireRole>
              }
            />
            <Route
              path="analytics"
              element={
                <Suspense fallback={<PageFallback />}>
                  <Analytics />
                </Suspense>
              }
            />
            <Route
              path="methodology"
              element={
                <Suspense fallback={<PageFallback />}>
                  <Methodology />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  );
}
