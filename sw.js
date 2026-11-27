// Network first, so a launch picks up new versions; the cache keeps the app usable offline.
// A network that does not answer within NET_TIMEOUT_MS (Wi-Fi without internet) falls back
// to the cache, and the late response still refreshes the cache for the next launch.
const CACHE = 'inkpad-v6.2';
const NET_TIMEOUT_MS = 1500;
// After one timeout the network counts as stalled for STALL_MS: later requests answer from
// the cache at once instead of each waiting out its own timeout.
const STALL_MS = 30000;
let stalledUntil = 0;
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/ink.js', 'js/exporter.js',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.esm.min.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
// cmaps and standard fonts, listed in vendor/fonts.json, so PDFs without embedded fonts
// render offline too.
const FONT_LIST = 'vendor/fonts.json';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    const fonts = await (await fetch(FONT_LIST, { cache: 'no-cache' })).json();
    await c.addAll(fonts);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fromCache(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit || req.mode !== 'navigate') return hit;
  return caches.match('index.html');
}

// Resolves with the network response, or with the cached copy once the network has failed
// or taken longer than NET_TIMEOUT_MS. Without a cached copy it keeps waiting for the network.
function race(req, net) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };
    const tryCache = () => fromCache(req).then((hit) => { if (hit) finish(hit); return hit; });
    const wait = Date.now() < stalledUntil ? 0 : NET_TIMEOUT_MS;
    const timer = setTimeout(() => { stalledUntil = Date.now() + STALL_MS; tryCache(); }, wait);
    net.then(
      (res) => { clearTimeout(timer); stalledUntil = 0; finish(res); },
      () => { clearTimeout(timer); tryCache().then((hit) => { if (!hit) finish(Response.error()); }); },
    );
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // GitHub Pages sends max-age=600; revalidate so a new version shows up on the next launch.
  const fresh = req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache' }) : new Request(req, { cache: 'no-cache' });
  let store = Promise.resolve();
  const net = fetch(fresh).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      store = caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
  e.respondWith(race(req, net));
  e.waitUntil(net.then(() => store, () => {}));
});
