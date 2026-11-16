const SHELL_CACHE = "cinevault-shell-v211";
const API_CACHE = "cinevault-api-v1";
const MEDIA_CACHE = "cinevault-media-v1";
const SHELL = ["/", "/index.html", "/boot.js", "/styles.css", "/config.local.js", "/app.js", "/lampac-player.js", "/watch-native.js", "/accounts.js", "/manifest.json", "/favicon.svg", "/assets/fonts/onest-cyrillic.woff2", "/assets/fonts/onest-latin.woff2", "/assets/fonts/geologica-cyrillic.woff2", "/assets/fonts/geologica-latin.woff2"];
const SHELL_PATHS = new Set(SHELL);
const CATALOG_API_PATHS = new Set(["/api/catalog", "/api/catalog/index", "/api/catalog/facets"]);
// How long a fresh answer may take before the last saved copy is shown instead.
// The network request keeps running, so the saved copy is still refreshed.
const SHELL_WAIT_MS = 3000;
const API_WAIT_MS = 5000;
const API_CACHE_LIMIT = 40;

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

async function trimCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - API_CACHE_LIMIT)).map((key) => cache.delete(key)));
}

function freshOrSaved(event, cacheName, key, waitMs, fallback = () => Response.error()) {
  let copy = null;
  const network = fetch(event.request).then(async (response) => {
    // No password and no site cookie: the browser asks for the password only when the page
    // itself gets the 401, never through a worker. Step aside and send the page to the network.
    if (response.status === 401 && event.request.mode === "navigate") {
      await self.registration.unregister();
      return Response.redirect(event.request.url, 302);
    }
    // Clone before returning: the browser may start consuming the body at once.
    if (response.ok) copy = response.clone();
    return response;
  });
  event.waitUntil(network.then(async () => {
    if (!copy) return;
    const cache = await caches.open(cacheName);
    await cache.put(key, copy);
    if (cacheName === API_CACHE) await trimCache(cache);
  }).catch(() => {}));
  const saved = () => caches.open(cacheName).then((cache) => cache.match(key));
  const slow = new Promise((resolve) => setTimeout(resolve, waitMs))
    .then(saved)
    .then((hit) => hit || network);
  event.respondWith(Promise.race([network, slow]).catch(() => saved().then((hit) => hit || fallback())));
}

function isSavableCatalogRequest(request, url) {
  return request.method === "GET" && CATALOG_API_PATHS.has(url.pathname) && !url.searchParams.has("search") && !url.searchParams.has("ids");
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // TMDB images are blocked on some Russian networks, so they go through our domain.
  if (url.hostname === "image.tmdb.org" && event.request.method === "GET" && !["localhost", "127.0.0.1"].includes(self.location.hostname)) {
    event.respondWith(fetch(`/tmdb${url.pathname}`).catch(() => fetch(event.request)));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Live data goes straight from the page: on iPhone a service-worker request may not carry
  // the site password, and a refused TMDB answer left series without seasons and air dates.
  if (url.pathname.startsWith("/tmdb/3/") || (url.pathname.startsWith("/api/") && !isSavableCatalogRequest(event.request, url))) return;
  if (url.pathname.includes("/media/") || url.pathname === "/api/library" || url.pathname.includes("/api/library/episodes/") || url.pathname.startsWith("/api/catalog/downloads/")) {
    event.respondWith(fetch(event.request));
    return;
  }
  if (event.request.mode === "navigate") {
    freshOrSaved(event, SHELL_CACHE, "/index.html", SHELL_WAIT_MS);
    return;
  }
  if (SHELL_PATHS.has(url.pathname)) {
    // One saved copy per file, whatever its ?v= is, so a slow load still finds it.
    freshOrSaved(event, SHELL_CACHE, url.pathname, SHELL_WAIT_MS);
    return;
  }
  if (url.pathname === "/data/world_trending.json") {
    freshOrSaved(event, API_CACHE, url.pathname, API_WAIT_MS);
    return;
  }
  if (isSavableCatalogRequest(event.request, url)) {
    freshOrSaved(event, API_CACHE, `${url.pathname}${url.search}`, API_WAIT_MS);
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

// Notifications from the server: a new episode or a premiere from the "Напомнить" list.
self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(message.title || "Lumo Film", {
    body: message.body || "",
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/icon-192.png",
    image: message.image || undefined,
    tag: message.key || undefined,
    data: { url: message.url || "/feed/" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const open = clients.find((client) => client.url.startsWith(self.location.origin));
    if (open) return open.navigate(url).then((client) => (client || open).focus()).catch(() => open.focus());
    return self.clients.openWindow(url);
  }));
});
