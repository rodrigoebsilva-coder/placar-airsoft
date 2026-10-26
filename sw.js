/* =============================================================================
   TACTICAL COMMAND — sw.js (v2.7.0)
   Estratégias:
   • Navegação (HTML)         → rede primeiro, com TIMEOUT de 3 s (4G ruim não trava o app) → cache
   • app.js / styles.css / …  → rede primeiro com timeout de 2.5 s → cache.
     (antes: stale-while-revalidate ⇒ a versão nova só aparecia na 2ª abertura e podia
      casar index.html NOVO com app.js ANTIGO)
   • Imagens/áudio/ícones     → cache primeiro + revalida em segundo plano; suporta Range (iOS)
   • CDN (tailwind, supabase) → cache primeiro; refetch em modo CORS (evita "opaque response",
                                que o Chrome contabiliza com ~7 MB de cota cada)
   • supabase.co / outros     → nem toca (REST e Realtime passam direto)
   Atualização: a nova versão instala em segundo plano e só assume quando o app pedir
   (mensagem SKIP_WAITING) — nunca no meio de uma partida.
   ============================================================================= */

const VERSION = '2.8.0';
const CACHE_NAME = `tactical-cmd-v${VERSION}`;

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './sfx-kill-them-all.mp3',
  './sfx-game-over.mp3'
];

const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const NETWORK_TIMEOUT_NAV = 3000;
const NETWORK_TIMEOUT_CODE = 2500;

const CODE_RE = /\.(?:js|css|html|json|webmanifest)$/i;
const MEDIA_RE = /\.(?:mp3|wav|ogg|m4a|png|jpg|jpeg|webp|svg|ico|woff2?)$/i;

async function cleanRedirectedResponse(response) {
  if (!response || !response.redirected) return response;
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error('sw-timeout'));
    }, ms);
    fetch(request, { signal: ctrl.signal }).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function putInCache(request, response) {
  try {
    if (!response || response.status !== 200) return;
    if (response.type !== 'basic' && response.type !== 'cors') return; // nunca guarda "opaque"
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch (e) {
    /* QuotaExceeded etc.: seguimos sem cachear */
  }
}

// 206 a partir do cache: Safari/iOS pede <audio> com "Range" e exige 206
async function respondWithRange(request, cached) {
  const range = request.headers.get('range');
  if (!range || !cached) return cached;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return cached;
  const blob = await cached.clone().blob();
  const size = blob.size;
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

/* ------------------------------ ciclo de vida ------------------------------ */
self.addEventListener('install', (event) => {
  // NÃO chama skipWaiting aqui: a nova versão espera o app pedir (ver message abaixo).
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        CORE_ASSETS.map(async (asset) => {
          try {
            const req = new Request(asset, { cache: 'reload', redirect: 'follow' }); // ignora cache HTTP intermediário
            const res = await fetch(req);
            if (res && res.status === 200) await cache.put(asset, await cleanRedirectedResponse(res));
          } catch (err) {
            console.warn('[SW] pré-cache falhou:', asset, err);
          }
        })
      );
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('tactical-cmd-') && k !== CACHE_NAME).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch (e) {}
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) self.skipWaiting();
  if (data && data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

/* --------------------------------- fetch ----------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return; // REST/Realtime: direto

  const sameOrigin = url.origin === self.location.origin;
  const isCdn = CDN_HOSTS.includes(url.hostname);
  if (!sameOrigin && !isCdn) return; // não interfere em terceiros desconhecidos

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (isCdn) {
    event.respondWith(cdnCacheFirst(event));
    return;
  }
  if (MEDIA_RE.test(url.pathname)) {
    event.respondWith(mediaCacheFirst(event));
    return;
  }
  // código e demais arquivos do mesmo origin
  event.respondWith(networkFirst(event, NETWORK_TIMEOUT_CODE));
});

async function handleNavigation(event) {
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const net = preload || (await fetchWithTimeout(event.request, NETWORK_TIMEOUT_NAV));
    const clean = await cleanRedirectedResponse(net);
    if (clean && clean.status === 200) event.waitUntil(putInCache('./', clean.clone())); // não deixa o SW morrer antes de gravar
    return clean;
  } catch (e) {
    const cached =
      (await caches.match(event.request, { ignoreSearch: true })) || // ./?room=CODE cai no mesmo HTML
      (await caches.match('./')) ||
      (await caches.match('./index.html'));
    if (cached) return cleanRedirectedResponse(cached);
    return new Response('Sem conexão e sem versão em cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function networkFirst(event, timeoutMs) {
  const req = event.request;
  try {
    const res = await fetchWithTimeout(req, timeoutMs);
    const clean = await cleanRedirectedResponse(res);
    event.waitUntil(putInCache(req, clean.clone()));
    return clean;
  } catch (e) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cleanRedirectedResponse(cached);
    throw e;
  }
}

async function mediaCacheFirst(event) {
  const req = event.request;
  const cached = await caches.match(req.url, { ignoreSearch: true });
  const revalidate = fetch(new Request(req.url, { cache: 'no-cache' }))
    .then(async (res) => {
      if (res && res.status === 200) await putInCache(req.url, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(revalidate);
    return req.headers.has('range') ? respondWithRange(req, cached) : cached;
  }
  const res = await revalidate;
  if (!res) return new Response('', { status: 504 });
  const stored = req.headers.has('range') ? await caches.match(req.url) : null;
  return stored ? respondWithRange(req, stored) : res;
}

async function cdnCacheFirst(event) {
  const req = event.request;
  const cached = await caches.match(req.url);
  if (cached) return cached;
  try {
    // Mesmo que a tag <script> seja no-cors, respondemos com a versão CORS (não-opaca)
    const res = await fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }));
    event.waitUntil(putInCache(req.url, res.clone()));
    return res;
  } catch (e) {
    return fetch(req); // sem CORS no host: devolve opaco, sem guardar
  }
}
