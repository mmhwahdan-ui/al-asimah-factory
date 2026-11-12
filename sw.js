const CACHE_NAME = 'al-asimah-factory-v22';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=22',
  './app.js?v=22',
  './manifest.webmanifest',
  './icons/logo.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const oldKeys = keys.filter((k) => k !== CACHE_NAME);
      await Promise.all(oldKeys.map((k) => caches.delete(k)));
      await self.clients.claim();
      if (oldKeys.length > 0) {
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientList) {
          try {
            client.postMessage({ type: 'FORCE_RELOAD_V22' });
            if (client.navigate) {
              await client.navigate(client.url);
            }
          } catch (_) {}
        }
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/') || event.request.url.includes('firebaseio.com')) {
    return;
  }
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
  );
});
