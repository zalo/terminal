// Service worker for the terminal app.
//
// Responsibilities:
//   - Receive push events from the browser's push service.
//   - Display the notification.
//   - On click, focus an existing window if one is open at the same URL, or
//     open a new one.
//
// Intentionally no offline caching — the app is online-only and we don't
// want stale JS/CSS shipped via the SW lifecycle.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  /** @type {{ title?: string, body?: string, url?: string, tag?: string, icon?: string, data?: object }} */
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    // Non-JSON payload; fall back to text
    payload = { title: 'Notification', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Terminal';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'default',
    renotify: true,
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
    data: {
      url: payload.url || '/',
      ...(payload.data || {}),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // If we already have a window open, focus it. Prefer one already on this URL.
      const exact = allClients.find((c) => c.url.endsWith(url));
      if (exact) return exact.focus();
      if (allClients.length > 0) {
        const client = allClients[0];
        await client.focus();
        if ('navigate' in client) {
          try { await client.navigate(url); } catch {}
        }
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
