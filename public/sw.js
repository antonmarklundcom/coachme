/**
 * sw.js — the service worker.
 *
 * Two jobs, and deliberately no third:
 *
 *   1. receive Web Push and show the notification;
 *   2. precache the app shell's static assets so the icon and manifest are
 *      there instantly and Chrome treats the app as installable.
 *
 * It does NOT cache pages. This is a status dashboard whose whole value is
 * being current — serving a cached "Today's One Thing" from yesterday would be
 * worse than showing nothing — and every page behind the owner gate is
 * personal state that has no business sitting in a shared cache. plan.md §5 O2
 * asks for "cache-shell only, no complex offline logic", and this is the honest
 * reading of that.
 */

const CACHE = 'coachme-shell-v1';
const SHELL = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/**
 * Cache-first for the precached shell assets, straight to the network for
 * everything else. The `respondWith` is skipped entirely for non-shell requests
 * so the browser's own handling (cookies, redirects, streaming) is untouched.
 */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!SHELL.includes(url.pathname)) return;

  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
});

/**
 * A nudge arrived. The payload is what lib/push.ts sent; a push with no body
 * (or an unreadable one) still shows something rather than nothing, because a
 * silent failure here looks identical to the coach having nothing to say.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'coachme';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // One coach, one ask a day: a new nudge replaces the old one rather than
      // stacking up a wall of guilt in the shade.
      tag: payload.tag || 'coachme-nudge',
      renotify: true,
      data: { url: payload.url || '/' },
    })
  );
});

/** Tapping the notification focuses the open app, or opens it. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
