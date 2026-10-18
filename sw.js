// Offline support: serve the app shell and word list from cache, refresh them in the background.
// Bump VERSION when you change any file listed in SHELL.
const VERSION = 'mabble-v14';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/vision.js',
  'js/localreader.js',
  'js/racks.js',
  'js/quackle-worker.js',
  'js/practice.js',
  'js/simulate.js',
  'js/explain.js',
  'js/solver.js',
  'data/words.txt',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  // 'reload' skips the browser's HTTP cache (GitHub Pages allows 10 minutes), so a new
  // version never starts out with the previous version's files.
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Only same-origin GETs; API calls and CDN requests go straight to the network.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      // The Quackle engine is large (about 26 MB) and rarely changes: once stored, serve it
      // from the cache without refreshing. Bumping VERSION clears it.
      if (cached && url.pathname.includes('/engine/')) return cached;
      // 'no-cache' checks with the server (a cheap conditional request) instead of
      // trusting the HTTP cache, so the background refresh really is fresh
      const fresh = fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then(res => { if (res.ok) cache.put(event.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
