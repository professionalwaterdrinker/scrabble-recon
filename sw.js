// Offline support: serve the app shell and word list from cache, refresh them in the background.
// Bump VERSION when you change any file listed in SHELL.
const VERSION = 'tile-rewind-v4';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/vision.js',
  'js/localreader.js',
  'js/racks.js',
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
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
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
      const fresh = fetch(event.request)
        .then(res => { if (res.ok) cache.put(event.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
