/* venta-sw.js — funcionamiento sin conexión del punto de venta.
   Solo gestiona los archivos de venta.html (no toca index.html / pos.js del sistema anterior).
   Red primero; si no hay conexión usa lo guardado (y marca X-From-Cache para avisar).
   Sube CACHE_VERSION cuando publiques cambios de código. */
const CACHE_VERSION = 'v1';
const CACHE = 'farmacia-jn-venta-' + CACHE_VERSION;
const SHELL = ['venta.html', 'venta.css', 'venta.js', 'calc.js', 'db.js', 'search.js', 'scanner.js', 'data.json',
  'manifest-venta.json', 'icon-192.png', 'icon-512.png', 'zxing-library-0.21.3.min.js'];
const PATHS = new Set(SHELL.map((f) => new URL(f, self.registration.scope).pathname));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) =>
    fetch(new Request(u, { cache: 'reload' })).then((r) => { if (r.ok) return c.put(u, r); }).catch(() => {})))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('farmacia-jn-venta-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
const mark = (r) => { const h = new Headers(r.headers); h.set('X-From-Cache', '1'); return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h }); };

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !PATHS.has(url.pathname)) return;   // lo demás (sistema anterior) no se toca
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await fetch(req, { cache: 'no-cache' });
      if (net.ok) cache.put(url.pathname, net.clone());
      return net;
    } catch (err) {
      const hit = await cache.match(url.pathname, { ignoreSearch: true });
      if (hit) return mark(hit);
      throw err;
    }
  })());
});
