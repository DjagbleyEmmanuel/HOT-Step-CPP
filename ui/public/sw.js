// HOT-Step service worker: caches the app shell only.
// Never touches /api/*, /audio/*, /references/* or any audio/media request.
const CACHE = 'hotstep-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const BYPASS = /^\/(api|audio|references|mm3|socket\.io|ws)(\/|$)/;
const MEDIA_EXT = /\.(wav|mp3|flac|ogg|opus|m4a|aac|aiff?|webm|mp4)$/i;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS.test(url.pathname) || MEDIA_EXT.test(url.pathname)) return;
  if (req.headers.has('range') || req.destination === 'audio' || req.destination === 'video') return;

  // Navigations: network first so new builds win, cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); return res; })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }
  // Hashed build assets and icons: cache first.
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
