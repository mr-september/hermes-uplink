// hermes-uplink service worker.
// IMPORTANT: during dev (and in general for a remote client you're always online to use),
// we deliberately do NOT cache index.html — only the manifest + this worker, so the PWA
// can install. Caching the HTML caused stale-page bugs on refresh. Every page load hits
// the network, so edits show up immediately on refresh. Offline simply won't load the app
// (acceptable: you must be online to reach your desktop agent anyway).
const CACHE = "uplink-shell-v2";
const SHELL = ["/manifest.webmanifest", "/sw.js"];

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
  // Live data is always network-only.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname === "/health") {
    return;
  }
  // App shell (HTML) is always network-first; no stale HTML ever.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/index.html")));
    return;
  }
  // Static assets: cache-first, then network.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
