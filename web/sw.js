// hermes-uplink service worker. Its main job is making the app installable (PWA); it keeps
// no offline shell. Only the manifest, this worker and the vendored markdown parser are
// cached; index.html, app.js, app.css and API calls always go to the network, so a
// reload never serves a stale UI.
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
