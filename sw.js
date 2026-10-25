// PAOTY S2 Jury — offline support
const VERSION = 'paoty-v3';
const SHELL = ['./', './index.html', './admin.html', './styles.css', './shared.js', './app.js', './admin.js',
  './config.js', './data.json', './logo.png', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const ART = 'paoty-art';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== VERSION && k !== ART).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache the live backend
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // Artwork photos and fonts: cache first, keep forever
  if (url.hostname === 'static.wixstatic.com' || url.hostname.endsWith('gstatic.com') || url.hostname === 'fonts.googleapis.com') {
    e.respondWith(caches.open(ART).then(async c => {
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
      try { const res = await fetch(req); if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }
      catch (err) { return hit || Response.error(); }
    }));
    return;
  }

  // App files: network first (so updates arrive), fall back to cache offline
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
  }
});
