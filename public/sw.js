/**
 * sw.js — Service Worker: guarda en caché los archivos de la app para que abra y funcione
 * sin internet (los datos en sí viven en IndexedDB, no en este caché).
 * Sube CACHE_NAME cada vez que publiques una actualización para forzar la renovación.
 */
const CACHE_NAME = 'prestamos-app-v22';
const ARCHIVOS_APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/idb.js',
  './js/logic.js',
  './js/firebase-sync.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ARCHIVOS_APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Las llamadas a Google/Firebase (login / Firestore) siempre van directo a la red, nunca a caché.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  // Red primero: así, en cuanto hay internet, el usuario ve siempre la versión más reciente
  // de la app (HTML/CSS/JS) sin depender de varios recargues. Si no hay internet, se usa
  // la última copia guardada en caché para que la app siga funcionando offline.
  event.respondWith(
    fetch(event.request)
      .then((respuestaRed) => {
        if (respuestaRed && respuestaRed.status === 200) {
          const copia = respuestaRed.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        }
        return respuestaRed;
      })
      .catch(() => caches.match(event.request))
  );
});
