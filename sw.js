const CACHE_NAME = 'tactical-cmd-v2.5.0';
const CORE_ASSETS = [
  './',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './sfx-kill-them-all.mp3',
  './sfx-game-over.mp3'
];

// Helper to strip the `redirected` flag from a Response so Chrome never throws ERR_FAILED on navigation
async function cleanRedirectedResponse(response) {
  if (!response || !response.redirected) {
    return response;
  }
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of CORE_ASSETS) {
        try {
          const req = new Request(asset, { redirect: 'follow' });
          const res = await fetch(req);
          if (res && res.status === 200) {
            const cleanRes = await cleanRedirectedResponse(res);
            await cache.put(req, cleanRes);
          }
        } catch (err) {
          console.warn('[SW] Failed to pre-cache asset:', asset, err);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Never cache Supabase REST or Realtime API calls
  if (event.request.url.includes('supabase.co')) {
    return;
  }

  // For HTML navigation requests (e.g. opening installed PWA at ./ or ./index.html):
  // Use Network-First with clean response fallback so Vercel redirects never cause ERR_FAILED
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(async (networkResponse) => {
          const cleanRes = await cleanRedirectedResponse(networkResponse);
          if (cleanRes && cleanRes.status === 200) {
            const clone = cleanRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./', clone));
          }
          return cleanRes;
        })
        .catch(async () => {
          const cached =
            (await caches.match(event.request)) ||
            (await caches.match('./')) ||
            (await caches.match('./index.html'));
          return cleanRedirectedResponse(cached);
        })
    );
    return;
  }

  // For static assets: Stale-While-Revalidate with redirect sanitization
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then(async (networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const cleanRes = await cleanRedirectedResponse(networkResponse);
            const responseClone = cleanRes.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
            return cleanRes;
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse ? cleanRedirectedResponse(cachedResponse) : fetchPromise;
    })
  );
});
