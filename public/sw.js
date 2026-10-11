'use strict';
const CACHE = 'chats-shell-v2';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the app shell so updates show up on next load instead of
// being stuck behind a stale cache; fall back to cache only when offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/') || event.request.url.includes('/ws')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => { caches.open(CACHE).then((c) => c.put(event.request, res.clone())); return res; })
      .catch(() => caches.match(event.request))
  );
});
