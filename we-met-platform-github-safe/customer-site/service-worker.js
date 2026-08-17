const VERSION = '6.5.0';
const CACHE_PREFIX = 'we-met-customer-';
const CACHE = `${CACHE_PREFIX}v${VERSION}`;
const STATIC = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'api.js',
  'socket-loader.js',
  'webrtc.js',
  'config.js',
  'manifest.webmanifest',
  'legal.css',
  'about.html',
  'contact.html',
  'terms.html',
  'privacy.html',
  'refund.html',
  'safety.html',
  'assets/logo.svg',
  'assets/favicon.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/avatar-01.svg',
  'assets/avatar-02.svg',
  'assets/avatar-03.svg',
  'assets/avatar-04.svg',
  'assets/avatar-05.svg',
  'assets/avatar-06.svg',
  'assets/avatar-07.svg',
  'assets/avatar-08.svg',
  'assets/avatar-09.svg',
  'assets/avatar-10.svg',
  'assets/avatar-11.svg',
  'assets/avatar-12.svg',
  'assets/avatar-13.svg',
  'assets/avatar-14.svg',
  'assets/avatar-15.svg',
  'assets/avatar-16.svg',
  'assets/avatar-17.svg',
  'assets/avatar-18.svg',
  'assets/avatar-19.svg',
  'assets/avatar-20.svg',

];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(STATIC.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();

    // Reload controlled pages once so an already-open device cannot keep running old JS.
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
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  event.respondWith(networkFirst(request, request.mode === 'navigate'));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = { body: event.data?.text() || '' }; }
  const icon = new URL(data.icon || 'assets/icon-192.png', self.registration.scope).href;
  const badge = new URL(data.badge || 'assets/favicon.png', self.registration.scope).href;
  event.waitUntil(self.registration.showNotification(data.title || 'We Met', {
    body: data.body || 'You have a new update.',
    icon,
    badge,
    tag: data.tag || 'we-met-update',
    renotify: data.renotify === true,
    requireInteraction: data.requireInteraction === true,
    vibrate: Array.isArray(data.vibrate) ? data.vibrate : [180, 80, 180],
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(target).catch(() => null);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CLOSE_NOTIFICATION' || !event.data.tag) return;
  event.waitUntil(self.registration.getNotifications({ tag: event.data.tag })
    .then((items) => items.forEach((notification) => notification.close())));
});
