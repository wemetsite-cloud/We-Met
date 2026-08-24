const VERSION = '8.0.0';
const CACHE_PREFIX = 'we-met-admin-';
const CACHE = `${CACHE_PREFIX}v${VERSION}`;
const STATIC = ['./','index.html','style.css','app.js','api.js','config.js','manifest.webmanifest','assets/logo.svg','assets/favicon.png','assets/icon-192.png','assets/icon-512.png','assets/avatar-01.svg','assets/avatar-02.svg','assets/avatar-03.svg','assets/avatar-04.svg','assets/avatar-05.svg','assets/avatar-06.svg','assets/avatar-07.svg','assets/avatar-08.svg','assets/avatar-09.svg','assets/avatar-10.svg','assets/avatar-11.svg','assets/avatar-12.svg','assets/avatar-13.svg','assets/avatar-14.svg','assets/avatar-15.svg','assets/avatar-16.svg','assets/avatar-17.svg','assets/avatar-18.svg','assets/avatar-19.svg','assets/avatar-20.svg'];

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
  })());
});

async function networkFirst(request, navigation = false) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    if (!response.ok) {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
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
