const SHELL_CACHE = "cinevault-shell-v33";
const MEDIA_CACHE = "cinevault-media-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.json", "/favicon.svg"];
const SHELL_PATHS = new Set(["/", "/index.html", "/styles.css", "/app.js", "/manifest.json", "/favicon.svg"]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => (key.startsWith("cinevault-shell-") && key !== SHELL_CACHE) || key === MEDIA_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/media/") || url.pathname === "/api/library" || url.pathname.includes("/api/library/episodes/") || url.pathname.startsWith("/api/catalog/downloads/")) {
    event.respondWith(fetch(event.request));
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }
  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(fetch(event.request).then((response) => {
      // Clone before returning the response: the browser may start consuming the
      // body immediately, which otherwise makes the deferred cache write fail.
      const cachedResponse = response.ok ? response.clone() : null;
      if (cachedResponse) event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, cachedResponse)).catch(() => {}));
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
