// TerraTwin offline app-shell service worker.
//
// Strategy (cached via the Cache Storage API, no external libs):
//   - Install: precache the app shell (index.html + favicon) so the dashboard
//     loads with no network after the first visit.
//   - Assets (*.js/*.css/*.svg): cache-first. Hashed filenames mean a new
//     deploy produces new URLs, so stale versions are automatically evicted.
//   - Navigations: network-first, falling back to the cached shell when
//     offline — the SPA router then serves whatever page the user is on.
//   - /api/*: network-first (kept fresh online); a failed API call falls back
//     to the last cached response for that exact URL so pages keep working
//     with stale data offline. Mutations (POST/PATCH/DELETE) are never
//     cached and only go to the network.

const CACHE = 'terratwin-shell-v1';

const PRECACHE = ['/', '/index.html', '/favicon.svg', '/icons.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch mutations

  const url = new URL(request.url);

  // API reads: network-first with cached fallback.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.error()))
    );
    return;
  }

  // Same-origin static assets: cache-first.
  if (url.origin === self.location.origin && /\.(js|css|svg|woff2?|png|jpg)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      }))
    );
    return;
  }

  // Navigations (and the shell): network-first, fall back to cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // Everything else (Leaflet tiles, external fonts): passthrough.
});