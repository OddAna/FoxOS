self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'FoxOS';
  const body = typeof payload.body === 'string' ? payload.body : '';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    renotify: payload.severity === 'critical',
    requireInteraction: payload.severity === 'critical',
    data: {
      id: payload.id || null,
      target: payload.target || null,
      url: typeof payload.url === 'string' ? payload.url : '/'
    }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'foxos:notification-open', id: data.id, target: data.target });
      return;
    }
    await self.clients.openWindow(data.url || '/');
  })());
});
