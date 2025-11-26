// FILIATRON — Service Worker básico para PWA OFFLINE

const CACHE_NAME = 'filiatron-v4';

// Archivos que se cachean en la instalación
const FILES = [
  "./",
  "./index.html",
  "./aq.png",
  "./municipios.json",
  "./nombres.json"
];

// INSTALACIÓN
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(FILES))
  );
  self.skipWaiting();
});

// ACTIVACIÓN
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : null))
      )
    )
  );
  self.clients.claim();
});

// FETCH: CACHE-FIRST
self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(resp => {
      return resp || fetch(event.request);
    })
  );
});
