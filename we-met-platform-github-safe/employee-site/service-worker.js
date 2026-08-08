const VERSION = '5.16.0';
const CACHE_PREFIX = 'we-met-listener-';
const CACHE = `${CACHE_PREFIX}v${VERSION}`;
const STATIC = ['./','index.html','style.css','app.js','api.js','socket-loader.js','webrtc.js','config.js','manifest.webmanifest','assets/logo.svg','assets/favicon.png','assets/icon-192.png','assets/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(STATIC.map((path) => new Request(path, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
    const scopePath = new URL(self.registration.scope).pathname;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows
      .filter((client) => new URL(client.url).pathname.startsWith(scopePath))
      .map((client) => client.navigate(client.url).catch(() => null)));
  })());
});

async function networkFirst(request, navigation = false) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (navigation) return caches.match('./index.html');
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  event.respondWith(networkFirst(request, request.mode === 'navigate'));
});
