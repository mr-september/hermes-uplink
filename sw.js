// hermes-uplink service worker.
// Caches manifest and worker for PWA installation.
// index.html is intentionally not cached to prevent stale states on reload.
const CACHE = "uplink-shell-v2";
const SHELL = ["/manifest.webmanifest", "/sw.js", "/vendor/marked.umd.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname === "/__auth" || url.pathname === "/__logout") {
    return;
  }
  // Live data is always network-only.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname === "/health") {
    return;
  }
  // App shell (HTML) is always network-only; no stale HTML is served.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(fetch(e.request));
    return;
  }
  // Static assets: cache-first, then network.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
