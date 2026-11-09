'use strict';
self.addEventListener('push', event => {
  let data; try { data = event.data.json(); } catch { return; }
  event.waitUntil(self.registration.showNotification(data.title || 'Hub', { body: data.body || '', tag: data.tag, icon: '/favicon.svg', data: { url: data.url } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const raw = event.notification.data?.url || '/crm';
  const url = /^\/crm(?:\/|$)/.test(raw) ? raw : '/crm';
  event.waitUntil(clients.openWindow(url));
});
