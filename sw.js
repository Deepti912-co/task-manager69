const CACHE_NAME = 'voca-shell-v2';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './favicon.svg'];
const DEFAULT_NOTIFICATION = {
  title: 'Voca reminder',
  body: 'You have a reminder due now.',
  icon: './favicon.svg',
  badge: './favicon.svg',
  tag: 'voca-reminder',
  data: { url: './index.html#tasks' },
  requireInteraction: true,
};

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const copy = response.clone();
    if (response.ok && event.request.mode === 'navigate') caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
    return response;
  }).catch(() => caches.match('./index.html'))));
});

self.addEventListener('push', event => {
  event.waitUntil(showReminderNotification(event));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || './index.html#tasks', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
    for (const client of windowClients) {
      if ('focus' in client) {
        client.navigate(targetUrl);
        return client.focus();
      }
    }
    return clients.openWindow(targetUrl);
  }));
});

self.addEventListener('notificationclose', event => {
  event.waitUntil(fetch('/api/reminders/deliveries?userId=local-user').catch(() => undefined));
});

async function showReminderNotification(event) {
  let payload = DEFAULT_NOTIFICATION;
  if (event.data) {
    try {
      const data = event.data.json();
      payload = notificationFromReminder(data);
    } catch (error) {
      payload = { ...DEFAULT_NOTIFICATION, body: event.data.text() || DEFAULT_NOTIFICATION.body };
    }
  } else {
    payload = await latestReminderNotification();
  }
  return self.registration.showNotification(payload.title, payload);
}

async function latestReminderNotification() {
  try {
    const response = await fetch('/api/reminders/deliveries?userId=local-user', { cache: 'no-store' });
    const data = await response.json();
    const reminder = data.deliveries?.[0];
    if (reminder) return notificationFromReminder(reminder);
  } catch (error) {
    // Keep notification delivery reliable even when the app API cannot be reached.
  }
  return DEFAULT_NOTIFICATION;
}

function notificationFromReminder(reminder) {
  const scheduled = reminder.scheduledTime ? new Date(reminder.scheduledTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'now';
  return {
    title: reminder.title || DEFAULT_NOTIFICATION.title,
    body: reminder.description || `Scheduled for ${scheduled}`,
    icon: './favicon.svg',
    badge: './favicon.svg',
    tag: reminder.id ? `voca-reminder-${reminder.id}` : DEFAULT_NOTIFICATION.tag,
    data: { url: `./index.html#tasks`, reminderId: reminder.id || null },
    requireInteraction: true,
    actions: [{ action: 'open', title: 'Open Voca' }],
  };
}
