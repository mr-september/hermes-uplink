// hermes-uplink service worker. It exists to make the app installable (PWA) and caches nothing: every file is
// pinned by digest on the proxy, so a cached copy could only ever be a stale one that fails its integrity check.
// Earlier versions cached a few files; activation deletes those caches.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method === "GET" && new URL(e.request.url).origin === self.location.origin) {
    e.respondWith(fetch(e.request));
  }
});
