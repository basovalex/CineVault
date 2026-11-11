// Runs in <head> before anything else. Kept out of index.html so the page can forbid
// inline scripts (Content-Security-Policy).
(() => {
  const version = (() => {
    try { return new URL(document.currentScript?.src || "", window.location.href).searchParams.get("v") || ""; } catch { return ""; }
  })();

  // The home page waits for the first catalogue page: ask for it while app.js downloads.
  // app.js takes the answer only if it would make exactly the same request.
  if (window.location.pathname === "/") {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("cinevault.state.v1") || "{}"); } catch { saved = {}; }
    const params = new URLSearchParams({ page: String(Number(saved.catalogPage) || 1), limit: "50", sort: saved.catalogSort === "year" ? "fresh" : saved.catalogSort || "now" });
    if (saved.query) params.set("search", saved.query);
    if (saved.catalogGenre) params.set("genre", saved.catalogGenre);
    if (saved.catalogCollection) params.set("collection", saved.catalogCollection);
    const path = `/api/catalog?${params}`;
    window.__cvCatalogPrefetch = {
      path,
      answer: fetch(path, { headers: { accept: "application/json" } })
        .then((response) => response.ok ? response.arrayBuffer().then((body) => ({ body, status: response.status, headers: [...response.headers] })) : null)
        .catch(() => null),
    };
  }

  // hls.js is needed only by the built-in player: fetch it once the first screen is done.
  // It must not share the slow first seconds with the catalogue and the hero frame.
  window.addEventListener("load", () => {
    const add = () => {
      if (window.Hls || document.getElementById("hls-script")) return;
      const script = document.createElement("script");
      script.id = "hls-script";
      script.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
      script.crossOrigin = "anonymous";
      script.async = true;
      document.head.append(script);
    };
    window.setTimeout(() => { if ("requestIdleCallback" in window) window.requestIdleCallback(add, { timeout: 3000 }); else add(); }, 5000);
  });

  if ("serviceWorker" in navigator) {
    let reloadingForUpdate = false;
    // On the very first visit the worker takes control too; that is not an update.
    const updatingFromOldVersion = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadingForUpdate || !updatingFromOldVersion) return;
      reloadingForUpdate = true;
      // The player and unfinished forms are not reloaded: app.js offers a reload instead.
      window.dispatchEvent(new Event("cinevault:updateavailable"));
    });
    window.addEventListener("load", () => navigator.serviceWorker.register(`/sw.js?v=${version}`, { updateViaCache: "none" }).catch(() => {}));
  }
})();
