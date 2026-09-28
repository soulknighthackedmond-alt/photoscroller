'use strict';

/* Photoscroller service worker.

   It exists for two reasons: an installed app should open with no network, and
   Chrome/Android only offer to install a site that has a fetch handler. The rules
   are deliberately narrow so it can never show stale content:

   - /api/ (login, albums, uploads) and /i/ (the photos) are never touched, so the
     feed and the upload flow always talk to the server;
   - the login page is never cached, and neither is a redirected response: a logged-out
     "/" is a 302 to /login, and caching that would leave the form sitting in the slot
     the app belongs in;
   - navigations and the app shell are network-first: a redeploy is picked up on the
     next load, and the cache is only a fallback when the server is unreachable;
   - everything else is left to the browser's own HTTP cache.

   Bump CACHE when the shell list changes; activate() drops the old one. */

const CACHE = 'photoscroller-shell-v4';
const SHELL = ['/', '/styles.css', '/app.js', '/zoommath.js', '/admin.js', '/pwa.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      /* cache each file on its own: one failure (or being offline at install time)
         must not stop the worker from installing */
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (res && res.ok) await cache.put(url, res);
          } catch {
            /* filled in later by the fetch handler */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/i/')) return;

  /* the login page is never cached and never served from cache: it is the one page
     whose freshness decides whether you get in */
  if (url.pathname === '/login') {
    event.respondWith(fetch(req).catch(() => offlineResponse()));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, '/'));
    return;
  }
  if (/\.(?:css|js|webmanifest|png|svg|ico|webp|avif)$/.test(url.pathname)) {
    event.respondWith(networkFirst(req, null));
  }
});

async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    /* res.redirected is the logged-out case — "/" came back as the login page. Caching
       it would put the form where the app shell belongs. */
    if (res && res.ok && res.type === 'basic' && !res.redirected) {
      await cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (fallbackUrl) {
      const shell = await cache.match(fallbackUrl);
      if (shell) return shell;
    }
    return offlineResponse();
  }
}

function offlineResponse() {
  return new Response('Offline — this page has not been cached yet.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
