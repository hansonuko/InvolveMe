// App-shell service worker only (docs/22-FULL-PWA-SCOPING.md §5) — this
// caches the shell (navigation HTML + Metro's hashed JS/CSS/asset bundles)
// so an installed PWA has something to render offline, and nothing else.
// It deliberately never touches any Supabase request (auth, REST, Storage,
// Realtime's websocket) — all of those are cross-origin already and never
// reach this fetch handler, but even a future same-origin API route must
// stay out of this cache: data freshness/offline-outbox behavior is owned
// entirely by the TanStack-Query-persisted-cache + outbox mechanism
// (docs/13-OFFLINE-MODE-SCOPING.md) the native app already uses, not a
// second, competing cache here that could disagree about what's current.
//
// No manually-bumped cache-version string to remember on every deploy
// (the exact staleness risk docs/22 §5 calls out): Metro content-hashes
// every JS/CSS/asset filename under /_expo/static/, so those are safe to
// cache-first forever, while navigation requests (the HTML, which is what
// references this deploy's hashed filenames) are always network-first —
// a new deploy is picked up the moment it's reachable, with the old
// cache's entries simply aging out unused rather than needing deletion.
const SHELL_CACHE = 'involveme-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isHashedAsset(url) {
  return url.pathname.startsWith('/_expo/static/') || url.pathname.startsWith('/assets/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put('/', response.clone());
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('/')) ?? Response.error();
        }),
    );
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
  }
});
