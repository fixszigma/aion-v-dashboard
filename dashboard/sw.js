const CACHE = 'aionv-obd-v1-cockpit-2';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './css/styles.css',
  './css/cockpit.css',
  './assets/aion_v_front.png',
  './assets/aion_v_rear.png',
  './assets/aion_v_rear_straight.png',
  './assets/aion_v_side.png',
  './assets/aion_v_top.png',
  './js/app.js',
  './js/ble.js',
  './js/charts.js',
  './js/decoder.js',
  './js/elm327.js',
  './js/poller.js',
  './js/simulator.js',
  './js/telemetry.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const net = fetch(e.request)
        .then((res) => {
          if (res.ok && new URL(e.request.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    }),
  );
});
