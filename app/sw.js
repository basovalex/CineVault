const SHELL_CACHE = "cinevault-shell-v18";
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
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("cinevault-shell-") && key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }
  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(fetch(event.request).then((response) => {
      if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))));
    return;
  }
  if (url.pathname.includes("/media/") || url.pathname === "/api/library" || url.pathname.includes("/api/library/episodes/")) {
    if (url.pathname === "/api/library") {
      event.respondWith(fetch(event.request).then((response) => {
        if (response.ok) caches.open(MEDIA_CACHE).then((cache) => cache.put(event.request, response.clone()));
        return response;
      }).catch(() => caches.match(event.request)));
      return;
    }
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && event.request.method === "GET") {
        const copy = response.clone();
        caches.open(MEDIA_CACHE).then((cache) => cache.put(event.request, copy));
      }
      return response;
    })));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
