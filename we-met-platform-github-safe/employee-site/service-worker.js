const VERSION = '5.15.1';
const CACHE_PREFIX = 'we-met-listener-';
const CACHE = `${CACHE_PREFIX}v${VERSION}`;
const STATE_CACHE = 'we-met-runtime-listener-state';
const AVAILABILITY_KEY = new URL('__listener_availability__', self.registration.scope).href;
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
    await Promise.all(windows.filter((client) => new URL(client.url).pathname.startsWith(scopePath)).map((client) => client.navigate(client.url).catch(() => null)));
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

async function saveAvailability(status) {
  const normalized = ['online', 'break', 'offline'].includes(status) ? status : 'offline';
  const cache = await caches.open(STATE_CACHE);
  await cache.put(AVAILABILITY_KEY, new Response(normalized, {
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  }));
}

async function readAvailability() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const response = await cache.match(AVAILABILITY_KEY);
    return response ? await response.text() : 'offline';
  } catch {
    return 'offline';
  }
}

async function closeCallNotifications() {
  const notifications = await self.registration.getNotifications();
  notifications
    .filter((notification) => String(notification.tag || '').startsWith('we-met-call-'))
    .forEach((notification) => notification.close());
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = { body: event.data?.text() || '' }; }

  event.waitUntil((async () => {
    const tag = data.tag || 'we-met-update';
    // Call pushes remain available while the PWA is minimized or suspended, but a
    // listener who explicitly selected Break/Offline must never see a call alert.
    if (String(tag).startsWith('we-met-call-') && await readAvailability() !== 'online') return;

    const icon = new URL(data.icon || 'assets/icon-192.png', self.registration.scope).href;
    const badge = new URL(data.badge || 'assets/favicon.png', self.registration.scope).href;
    const options = {
      body: data.body || 'You have a new update.',
      icon,
      badge,
      tag,
      renotify: data.renotify === true,
      requireInteraction: data.requireInteraction === true,
      silent: data.silent === true,
      data: { url: data.url || './' },
    };
    if (!options.silent) options.vibrate = Array.isArray(data.vibrate) ? data.vibrate : [180, 80, 180];
    await self.registration.showNotification(data.title || 'We Met', options);
  })());
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
  if (event.data?.type === 'SET_LISTENER_AVAILABILITY') {
    event.waitUntil((async () => {
      await saveAvailability(event.data.status);
      if (event.data.status !== 'online') await closeCallNotifications();
    })());
    return;
  }
  if (event.data?.type !== 'CLOSE_NOTIFICATION' || !event.data.tag) return;
  event.waitUntil(self.registration.getNotifications({ tag: event.data.tag })
    .then((items) => items.forEach((notification) => notification.close())));
});
