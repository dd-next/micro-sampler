/* Cache the shell so the instrument opens offline once visited.
   Bump CACHE when any of these files change. */
const CACHE = 'micro-sampler-v8';

const SHELL = [
  './',
  'index.html',
  'src/styles.css',
  'src/state.js',
  'src/audio.js',
  'src/record.js',
  'src/fx.js',
  'src/sequencer.js',
  'src/knob.js',
  'src/wave.js',
  'src/ui.js',
  'src/keys.js',
  'src/persist.js',
  'src/main.js',
  'public/manifest.webmanifest',
  'public/icon.svg',
  'public/icon-192.png',
  'public/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // `reload` bypasses the browser's own HTTP cache, so a new worker
      // never fills itself with the copies the old one was serving
      .then(c => Promise.all(
        SHELL.map(u => fetch(new Request(u, { cache:'reload' }))
          .then(res => { if (res.ok) return c.put(u, res); }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network first so a deploy is picked up straight away, cache as the
   fallback so the app still opens with no connection. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
