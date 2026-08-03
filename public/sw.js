// YKP-refs service worker — offline-first app shell + CDN runtime caching.
//
// This app loads React, Babel standalone, Tailwind, and Lucide from CDNs
// with no build step. Classic <script src="https://...">/<link rel="stylesheet">
// tags for cross-origin hosts are fetched by the browser in "no-cors" mode,
// which produces an *opaque* response (status 0, body unreadable to JS, but
// still cacheable and replayable). Because of that:
//   - We must precache the CDN URLs ourselves using an explicit
//     `new Request(url, { mode: 'no-cors' })`, since cache.addAll() builds
//     Requests in 'cors' mode by default and would fail against hosts that
//     don't send CORS headers.
//   - In the fetch handler we must treat `response.type === 'opaque'` as a
//     cacheable success, since opaque responses always report `ok: false`.

const CACHE_VERSION = 'v4.0.2';
const CACHE_NAME = `refcourt-${CACHE_VERSION}`;

// Safari/WebKit refuses to let a service worker fulfill a *navigation*
// request with a response whose internal URL list has more than one entry
// (i.e. Response.redirected === true) — per the HTML/Fetch spec, that's a
// hard network error ("Response served by service worker has redirections").
// If the origin ever 30x-redirects a same-origin request we precache or
// proxy (e.g. bare '/' -> '/index.html', or a trailing-slash normalization),
// `fetch()` follows it transparently and hands back a redirected Response.
// Caching or returning that as-is poisons the cache/serves a page that
// throws in Safari. Rebuilding a plain Response from its body/status/headers
// drops the redirect history so it's safe to cache and respond with.
async function stripRedirect(response) {
  if (!response || !response.redirected) return response;
  const body = await response.clone().blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Same-origin app shell.
const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// Cross-origin CDN dependencies (must match the <script>/<link> tags in index.html).
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://unpkg.com/lucide@latest/dist/umd/lucide.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Same-origin assets — fetched individually (rather than cache.addAll)
      // so a redirected response (e.g. './' -> './index.html') can be
      // unwrapped with stripRedirect() before it lands in the cache.
      await Promise.all(
        LOCAL_ASSETS.map(async (url) => {
          const response = await fetch(url);
          await cache.put(url, await stripRedirect(response));
        })
      );

      // Cross-origin CDN assets — fetched individually as opaque responses
      // so a missing CORS header on any one host can't fail the whole install.
      await Promise.all(
        CDN_ASSETS.map(async (url) => {
          try {
            const request = new Request(url, { mode: 'no-cors' });
            const response = await fetch(request);
            await cache.put(request, response);
          } catch (err) {
            console.warn('[sw] failed to precache', url, err);
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
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable; let everything else pass through untouched.
  if (request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) return cached;

      try {
        // Cross-origin CDN requests already arrive here in 'no-cors' mode
        // (that's how the browser loads classic cross-origin <script>/<link>
        // tags), so fetching the request as-is preserves that automatically.
        const response = await stripRedirect(await fetch(request));

        // Cache same-origin 200s ('basic'/'cors') and cross-origin opaque
        // responses (always status 0 / ok:false, but still valid to store).
        if (response && (response.ok || response.type === 'opaque')) {
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // Offline and nothing cached for this exact request. For page
        // navigations, fall back to the cached app shell so the SPA still
        // boots; for everything else, let the failure surface normally.
        if (request.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
