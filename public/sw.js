// Switcher Remote's service worker: notifications only, no caching (the app needs the relay anyway).
// A push from the vault carries nothing: it only says that one of Claude's prompts is waiting. The open page, which can
// decrypt, shows a fuller notification under the same tag when it's running.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (tabs.some((tab) => tab.visibilityState === 'visible' && tab.focused)) {
        return; // Already looking at it.
      }
      await self.registration.showNotification('Claude is waiting on you', {
        body: 'A session needs your answer in Switcher Remote.',
        tag: 'needs-you',
        renotify: true,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = tabs.find((tab) => tab.url.startsWith(self.registration.scope));
      return open ? open.focus() : self.clients.openWindow(self.registration.scope);
    })(),
  );
});
