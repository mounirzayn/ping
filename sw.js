// Service worker de Ping : reçoit les alertes (Web Push envoyé par ntfy) et les affiche,
// même quand l'appli Ping est fermée sur l'iPhone.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  let title = 'Ping', body = '', url = './app.html', tag;
  if (data.event === 'message' && data.message) {
    const m = data.message;
    title = m.title || 'Ping';
    body = m.message || '';
    if (m.click) url = m.click;
    tag = m.id;
  } else if (data.event === 'subscription_expiring') {
    title = 'Ping';
    body = 'Ouvre Ping pour continuer à recevoir les alertes.';
  } else {
    return; // rien à afficher
  }
  event.waitUntil(self.registration.showNotification(title, {
    body, tag, icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    data: { url }, renotify: true, requireInteraction: false,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './app.html';
  event.waitUntil((async () => {
    // l'appli Ping se met à jour dès qu'on touche une alerte, puis l'annonce s'ouvre
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach((c) => c.postMessage('refresh'));
    return self.clients.openWindow(url);
  })());
});
