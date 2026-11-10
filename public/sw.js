// AgentX offline shell. The dashboard is a chat client, so the rule is simple: never serve
// stale API data, and always have something to show when the laptop loses its connection.
const SHELL = 'agentx-shell-v1';
const ASSETS = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/favicon.svg', '/icon-1024.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Anything under /api is live data: go to the network, and never fall back to a cached answer.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Navigations: fresh page when the network answers, the stored shell when it does not.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); return r; })
        .catch(() => caches.match('/').then((r) => r || new Response('AgentX is offline and no copy was stored yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } })))
    );
    return;
  }

  // Static files: serve the stored copy first, and refresh it in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req).then((r) => {
        if (r && r.ok) caches.open(SHELL).then((c) => c.put(req, r.clone()));
        return r;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});

// The page asks for this when a new build is waiting.
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
