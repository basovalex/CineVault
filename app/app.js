(() => {
  "use strict";

  if ((window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") && window.location.port === "8080") {
    const backendUrl = new URL(window.location.href);
    backendUrl.port = "8081";
    window.location.replace(backendUrl.toString());
    return;
  }

  const TMDB_API_BASE = "https://api.themoviedb.org/3";
  const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w780";
  const RUTUBE_SAMPLE_ID = "7716bd3e665725c3c008ae7ab4ff02e2";
  const STORAGE_KEY = "cinevault.state.v1";
  const TMDB_CACHE_KEY = "cinevault.tmdb.cache.v1";
  const tmdbCredential = String(window.CINEVAULT_CONFIG?.tmdbApiKey || "").trim();
  const configuredApiBaseUrl = String(window.CINEVAULT_CONFIG?.apiBaseUrl || "").trim().replace(/\/+$/, "");
  const configuredPublicBaseUrl = String(window.CINEVAULT_CONFIG?.publicBaseUrl || "").trim();
  const viewerToken = String(window.CINEVAULT_CONFIG?.viewerToken || "").trim();
  // Account sync state (see syncAccountState): declared early, saveState runs during start-up.
  let accountSyncUser = "";
  let accountPushTimer = 0;
  let accountPushedAt = 0;
  const ACCOUNT_PUSH_GAP_MS = 15000;
  // The first catalog request after a backend idle period can take ~20 seconds
  // while its index warms up; leave enough time to avoid a false load error.
  const CATALOG_REQUEST_TIMEOUT_MS = 45 * 1000;
  const CATALOG_SLOW_HINT_MS = 9 * 1000;
  const CATALOG_LIST_CACHE_MS = 10 * 60 * 1000;
  const CATALOG_LIST_CACHE_SIZE = 14;
  const FACETS_STORAGE_KEY = "cinevault.facets.v1";
  const CATALOG_RECOVERY_INTERVAL_MS = 10 * 1000;
  const WORLD_TRENDING_FILE_TIMEOUT_MS = 6 * 1000;
  // A title counts as new only for this long after its premiere.
  const NEW_RELEASE_DAYS = 30;
  const POPULAR_MIN_VOTES = 20000;
  const POPULAR_MIN_RATING = 5.5;
  const SHORT_FILM_MINUTES = 40;
  // One stalled connection must not leave a request pending forever.
  const API_GET_TIMEOUT_MS = 25 * 1000;
  const API_GET_ATTEMPTS = 2;
  const API_GET_RETRY_DELAY_MS = 1500;
  const HLS_PLAYBACK_CONFIG = {
    enableWorker: true,
    // Do not silently downgrade to 480p just because the player is displayed
    // in a smaller window. Start at the best rendition the manifest exposes;
    // the viewer can still lower it manually when bandwidth is limited.
    capLevelToPlayerSize: false,
    startFragPrefetch: true,
    maxBufferLength: 30,
    maxMaxBufferLength: 90,
    backBufferLength: 30,
    maxBufferSize: 60 * 1000 * 1000,
    manifestLoadingTimeOut: 15000,
    levelLoadingTimeOut: 15000,
    fragLoadingTimeOut: 20000,
    levelLoadingMaxRetry: 4,
    fragLoadingMaxRetry: 6,
  };

  function apiUrl(path) {
    if (!configuredApiBaseUrl || /^https?:\/\//i.test(path)) return path;
    return new URL(path, `${configuredApiBaseUrl}/`).toString();
  }

  // Unhandled errors: tell the server (nothing personal, see tools/client_errors.py)
  // and never leave the viewer on a blank page.
  const APP_VERSION = (() => {
    try { return new URL(document.currentScript?.src || "", window.location.href).searchParams.get("v") || ""; } catch { return ""; }
  })();
  const reportedErrors = new Set();
  function reportClientError(kind, error, source = "") {
    const message = String(error?.message || error || "").slice(0, 300);
    if (!message || reportedErrors.size >= 10 || reportedErrors.has(message)) return;
    // Errors from browser extensions and other sites' scripts are not ours to fix.
    if (/^Script error\.?$/.test(message) || /ResizeObserver loop/.test(message) || /^(chrome|moz|safari(-web)?)-extension:/.test(String(source))) return;
    reportedErrors.add(message);
    const body = JSON.stringify({
      kind, message, stack: String(error?.stack || "").split("\n").slice(0, 6).join("\n"),
      source: String(source || "").replace(/[?#].*$/, ""), path: window.location.pathname, version: APP_VERSION, ua: navigator.userAgent,
    });
    try {
      const url = apiUrl("/api/client-errors");
      const queued = navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }));
      if (!queued) fetch(url, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
    } catch { /* reporting must never break the page */ }
  }
  function showCrashScreen() {
    const root = document.getElementById("page");
    if (!root || root.querySelector(".crash-state") || root.textContent.trim()) return;
    root.innerHTML = `<section class="section"><div class="empty-state crash-state" role="alert"><h2>Что-то пошло не так</h2><p>Страница не загрузилась до конца. Обычно помогает обновить её.</p><button class="primary-button" type="button" data-crash-reload>Обновить</button></div></section>`;
    root.querySelector("[data-crash-reload]")?.addEventListener("click", () => window.location.reload());
  }
  window.addEventListener("error", (event) => {
    reportClientError("error", event.error || event.message, event.filename);
    window.setTimeout(showCrashScreen, 0);
  });
  // A new version took over this tab: no notice to dismiss; the page reloads quietly the next
  // time the viewer comes back to it, unless a film is playing.
  window.addEventListener("cinevault:updateavailable", () => {
    window.__cvUpdatePending = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (!window.__cvUpdatePending || document.visibilityState !== "visible") return;
    const playing = [...document.querySelectorAll("video")].some((video) => !video.paused && !video.ended);
    if (!playing && !document.querySelector(".cv-player, .player-modal")) window.location.reload();
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason?.name === "AbortError") return;
    reportClientError("rejection", event.reason);
  });

  // index.html may have asked for the first catalogue page already; take it once if it matches.
  const posterOverrides = Object.freeze({
    "kinopoisk-5304403": "/data/posters/kinopoisk-5304403.jpg",
    // The same series on TMDB: the site's own avatar stays with it after the move to TMDB.
    "tmdb-tv-234763": "/data/posters/kinopoisk-5304403.jpg",
  });
  // Titles shown with their poster only: no wide frame on the title page or in shelves.
  const posterOnlyTitles = new Set(["kinopoisk-5304403", "tmdb-tv-234763"]);
  // Hand-picked posters replace the server's wherever a catalogue answer brings the card.
  function overrideCatalogBody(path, body) {
    if (!String(path).startsWith("/api/catalog") || !body) return body;
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    if (!Object.keys(posterOverrides).some((id) => text.includes(`"${id}"`))) return body;
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (posterOverrides[value.id]) value.posterImage = posterOverrides[value.id];
      if (posterOnlyTitles.has(value.id) && value.backdropImage) value.backdropImage = "";
      Object.values(value).forEach(visit);
    };
    try { const data = JSON.parse(text); visit(data); return JSON.stringify(data); } catch { return body; }
  }

  function takeCatalogPrefetch(path) {
    const early = window.__cvCatalogPrefetch;
    window.__cvCatalogPrefetch = null;
    if (!early || early.path !== path || configuredApiBaseUrl || viewerToken) return null;
    return early.answer.then((data) => data ? new Response(overrideCatalogBody(path, data.body), { status: data.status, headers: data.headers }) : null).catch(() => null);
  }

  // The site password (Basic Auth) is forgotten when the browser restarts. Requests that go
  // through the service worker then get 401 and the browser never asks for the password:
  // drop the worker once and reload, so the page itself asks.
  function recoverFromUnauthorized() {
    try {
      if (window.sessionStorage.getItem("cv-auth-recover")) return;
      window.sessionStorage.setItem("cv-auth-recover", "1");
    } catch { return; }
    const reload = () => window.location.reload();
    const workers = navigator.serviceWorker?.getRegistrations?.();
    if (!workers) { reload(); return; }
    workers.then((list) => Promise.all(list.map((one) => one.unregister()))).catch(() => {}).then(reload);
  }

  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (viewerToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${viewerToken}`);
    if (String(options.method || "GET").toUpperCase() !== "GET") return fetch(apiUrl(path), { ...options, headers });
    const callerSignal = options.signal;
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeout = window.setTimeout(abort, API_GET_TIMEOUT_MS);
      if (callerSignal?.aborted) abort();
      else callerSignal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetch(apiUrl(path), { ...options, headers, signal: controller.signal });
        if (response.status === 401) recoverFromUnauthorized();
        if ([204, 205, 304].includes(response.status)) return response;
        // Read the body here so the timeout and the retry also cover a stall mid-transfer.
        const body = overrideCatalogBody(path, await response.arrayBuffer());
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        if (callerSignal?.aborted || attempt >= API_GET_ATTEMPTS) throw error;
      } finally {
        window.clearTimeout(timeout);
        callerSignal?.removeEventListener("abort", abort);
      }
      await new Promise((resolve) => window.setTimeout(resolve, API_GET_RETRY_DELAY_MS));
    }
  }

  const openMediaCatalog = [
    { id: "sintel-open", kind: "movie", title: "Sintel", originalTitle: "Sintel", year: 2010, description: "Открытый фантастический фильм Blender Foundation о девушке, драконе и обещании, которое нельзя забыть.", tags: ["фантастика", "атмосферно", "на вечер"], runtime: 15, poster: "linear-gradient(145deg, #d88963, #292242)", posterImage: "https://archive.org/services/img/Sintel", providerUrl: "https://archive.org/details/Sintel", providerName: "Archive.org", providerNote: "Открытый фильм Blender Foundation · CC BY 3.0", videoUrl: "https://archive.org/download/Sintel/sintel-2048-stereo_512kb.mp4", licenseUrl: "https://creativecommons.org/licenses/by/3.0/", licenseLabel: "CC BY 3.0" },
    { id: "big-buck-bunny-open", kind: "movie", title: "Большой кролик", originalTitle: "Big Buck Bunny", year: 2008, description: "Добрая короткометражная история Blender Open Movie Project. Можно смотреть прямо в Lumo Film.", tags: ["комедия", "уютно", "на вечер"], runtime: 10, poster: "linear-gradient(145deg, #72b9df, #6b8b55)", posterImage: "https://archive.org/services/img/big-buck-bunny-640x360_202403", providerUrl: "https://archive.org/details/big-buck-bunny-640x360_202403", providerName: "Archive.org", providerNote: "Открытый фильм · Public Domain Mark 1.0", videoUrl: "https://archive.org/download/big-buck-bunny-640x360_202403/BigBuckBunny%20640x360.mp4", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/", licenseLabel: "Public Domain Mark 1.0" },
    { id: "elephants-dream-open", kind: "movie", title: "Elephants Dream", originalTitle: "Elephants Dream", year: 2006, description: "Первый открытый фильм Blender Foundation: странное путешествие по механическому миру.", tags: ["фантастика", "атмосферно", "напряжённо"], runtime: 11, poster: "linear-gradient(145deg, #b68663, #241d35)", posterImage: "https://archive.org/services/img/elephants-dream_202403", providerUrl: "https://archive.org/details/elephants-dream_202403", providerName: "Archive.org", providerNote: "Открытый фильм · Public Domain Mark 1.0", videoUrl: "https://archive.org/download/elephants-dream_202403/Elephants%20Dream.mp4", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/", licenseLabel: "Public Domain Mark 1.0" },
    { id: "gentlemen-of-fortune-rutube", kind: "movie", title: "Джентльмены удачи", originalTitle: "Джентльмены удачи", year: 1971, description: "Легендарная советская комедия в официальной публикации Киноконцерна «Мосфильм» на RUTUBE.", tags: ["комедия", "уютно", "для нас"], runtime: 88, poster: "linear-gradient(145deg, #c58b54, #4a2630)", providerUrl: "https://rutube.ru/video/8f50ed5a7841ff1418671a3c6b7440d4/", providerName: "RUTUBE · Мосфильм", providerNote: "Официальный канал Киноконцерна «Мосфильм» · встроенный просмотр", rutubeId: "8f50ed5a7841ff1418671a3c6b7440d4" }
  ];

  const seedCatalog = [
    { id: "desperate-housewives", kind: "series", title: "Отчаянные домохозяйки", originalTitle: "Desperate Housewives", year: 2004, description: "Четыре подруги, тайны Вистерия-Лейн и история, к которой хочется возвращаться сериями.", tags: ["драма", "комедия", "уютно"], seasons: [23, 24, 23, 17, 24, 23, 23, 23], runtime: 42, poster: "linear-gradient(145deg, #5a244b, #1e203e)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в Lumo Film" },
    { id: "the-mentalist", kind: "series", title: "Менталист", originalTitle: "The Mentalist", year: 2008, description: "После того как серийный убийца убил его семью, Патрик Джейн отказался от карьеры экстрасенса и использует свои способности, чтобы помогать правоохранительным органам.", tags: ["детектив", "драма", "напряжённо"], seasons: [23, 23, 24, 24, 22, 22, 13], runtime: 43, tmdbId: 5920, kinopoiskId: 412344, catalogId: 2368, poster: "linear-gradient(145deg, #a36a4f, #1b2338)", posterImage: "https://image.tmdb.org/t/p/w780/sdlnS04iwOeYzng0CAOyiycNTM3.jpg", providerUrl: "", providerName: "TMDB · метаданные", providerNote: "Метаданные, постер и список серий загружаются онлайн. Источники серий подключаются из отдельного файла Менталиста; видеопоток используется только из разрешённого источника.", episodeDataProvider: "tvmaze", tvmazeId: 116 },
    { id: "interstellar", kind: "movie", title: "Интерстеллар", originalTitle: "Interstellar", year: 2014, description: "Большая история о времени, расстоянии и связи, которая оказывается сильнее космоса.", tags: ["фантастика", "атмосферно", "на вечер"], runtime: 169, poster: "linear-gradient(145deg, #182d52, #05070f)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в Lumo Film" },
    { id: "about-time", kind: "movie", title: "Бойфренд из будущего", originalTitle: "About Time", year: 2013, description: "Тёплая романтическая история о выборе, семье и самых обычных счастливых днях.", tags: ["романтика", "уютно", "для нас"], runtime: 123, poster: "linear-gradient(145deg, #e492ad, #6c3556)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в Lumo Film" },
    { id: "the-office", kind: "series", title: "Офис", originalTitle: "The Office", year: 2005, description: "Неловкая, тёплая и очень смешная компания, к которой быстро привыкаешь.", tags: ["комедия", "смеяться", "сериал"], seasons: [6, 22, 25, 19, 28, 26, 25, 24, 25], runtime: 22, poster: "linear-gradient(145deg, #d69a55, #50352f)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в Lumo Film" },
    { id: "little-women", kind: "movie", title: "Маленькие женщины", originalTitle: "Little Women", year: 2019, description: "Красивое, душевное кино о сестрах, взрослении и доме, куда хочется возвращаться.", tags: ["драма", "уютно", "для нас"], runtime: 135, poster: "linear-gradient(145deg, #c48d76, #3e344e)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в Lumo Film" },
    { id: "knives-out", kind: "movie", title: "Достать ножи", originalTitle: "Knives Out", year: 2019, description: "Уютный детектив с яркими персонажами, тайнами и отличным темпом на один вечер.", tags: ["детектив", "на вечер", "напряжённо"], runtime: 130, poster: "linear-gradient(145deg, #7c2f37, #161a2f)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в Lumo Film" },
    { id: "the-holiday", kind: "movie", title: "Отпуск по обмену", originalTitle: "The Holiday", year: 2006, description: "Мягкая романтическая комедия для вечера, когда хочется света, снега и добрых людей.", tags: ["романтика", "смеяться", "уютно"], runtime: 136, poster: "linear-gradient(145deg, #b4d8e8, #6f4778)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в Lumo Film" },
    { id: "arrival", kind: "movie", title: "Прибытие", originalTitle: "Arrival", year: 2016, description: "Спокойная и умная фантастика о языке, времени и попытке понять друг друга.", tags: ["фантастика", "атмосферно", "напряжённо"], runtime: 116, poster: "linear-gradient(145deg, #728aa2, #1d2330)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в Lumo Film" },
    { id: "shawshank-redemption", kind: "movie", title: "Побег из Шоушенка", originalTitle: "The Shawshank Redemption", year: 1994, description: "История дружбы, надежды и внутренней свободы, которая выдерживает годы заключения.", tags: ["драма", "классика", "на вечер"], runtime: 142, poster: "linear-gradient(145deg, #5b7898, #1b2438)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" },
    { id: "green-mile", kind: "movie", title: "Зелёная миля", originalTitle: "The Green Mile", year: 1999, description: "Трогательная фантастическая драма о людях, сострадании и чуде в блоке смертников.", tags: ["драма", "фэнтези", "классика"], runtime: 189, poster: "linear-gradient(145deg, #6d8058, #27362b)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" },
    { id: "forrest-gump", kind: "movie", title: "Форрест Гамп", originalTitle: "Forrest Gump", year: 1994, description: "Добрая история о жизни, любви и человеке, который всегда продолжает идти вперёд.", tags: ["драма", "романтика", "уютно"], runtime: 142, poster: "linear-gradient(145deg, #d8a96b, #80604d)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" },
    { id: "the-matrix", kind: "movie", title: "Матрица", originalTitle: "The Matrix", year: 1999, description: "Неоновая фантастика о выборе, свободе и мире, который оказывается совсем не таким, как кажется.", tags: ["фантастика", "экшен", "напряжённо"], runtime: 136, poster: "linear-gradient(145deg, #1c7c62, #071b19)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" },
    { id: "prestige", kind: "movie", title: "Престиж", originalTitle: "The Prestige", year: 2006, description: "Мрачная и умная дуэль двух иллюзионистов, где каждый секрет требует новой жертвы.", tags: ["триллер", "драма", "детектив"], runtime: 130, poster: "linear-gradient(145deg, #5b4f65, #171620)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" },
    { id: "parasite", kind: "movie", title: "Паразиты", originalTitle: "Parasite", year: 2019, description: "Остроумная социальная драма с неожиданными поворотами и идеальным напряжением.", tags: ["драма", "триллер", "напряжённо"], runtime: 132, poster: "linear-gradient(145deg, #a8b98b, #23392d)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" },
    { id: "grand-budapest", kind: "movie", title: "Отель «Гранд Будапешт»", originalTitle: "The Grand Budapest Hotel", year: 2014, description: "Яркая, стремительная и очень уютная комедия о дружбе, отеле и исчезнувшей картине.", tags: ["комедия", "приключения", "уютно"], runtime: 100, poster: "linear-gradient(145deg, #dc86a5, #6f3e67)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" },
    { id: "lord-of-the-rings", kind: "movie", title: "Властелин колец: Братство кольца", originalTitle: "The Lord of the Rings: The Fellowship of the Ring", year: 2001, description: "Большое путешествие хоббита и его друзей через Средиземье навстречу судьбе.", tags: ["фэнтези", "приключения", "на вечер"], runtime: 178, poster: "linear-gradient(145deg, #607d61, #1d2b2a)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" },
    { id: "harry-potter-1", kind: "movie", title: "Гарри Поттер и философский камень", originalTitle: "Harry Potter and the Philosopher's Stone", year: 2001, description: "Первый вечер в Хогвартсе, дружба, тайны и магия, к которой хочется возвращаться.", tags: ["фэнтези", "семейное", "уютно"], runtime: 152, poster: "linear-gradient(145deg, #9b743f, #26203b)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Карточка готова; разрешённый источник пока не подключён" }
  ];

  const importedDesperateHousewives = {
    kinopoiskId: 160958,
    catalogId: 2205,
    description: "В центре событий — четыре современные домохозяйки, которые живут в тихом пригороде и отчаянно ищут личного счастья. Внезапное самоубийство их подруги Мэри Элис Янг оставляет всех в недоумении и заставляет искать разгадку её смерти.",
    posterImage: "https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/eb3ac70c-d99d-471c-89f2-17d1b0978837/600x900",
    providerNote: "Метаданные импортированы локально · Kinopoisk ID 160958 · catalog ID 2205 · видеопоток не подключён",
    episodePosterUrls: {
  "1": {
    "5": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7908.jpg",
    "13": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7916.jpg",
    "18": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7921.jpg"
  },
  "2": {
    "8": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7934.jpg",
    "16": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7942.jpg",
    "21": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7947.jpg"
  },
  "3": {
    "1": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7951.jpg",
    "2": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7952.jpg",
    "3": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7953.jpg",
    "4": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7954.jpg",
    "5": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7955.jpg",
    "6": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7956.jpg",
    "7": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7957.jpg",
    "8": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7958.jpg",
    "9": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7959.jpg",
    "10": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7960.jpg",
    "11": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7961.jpg",
    "12": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7962.jpg",
    "13": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7963.jpg",
    "14": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7964.jpg",
    "15": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7965.jpg",
    "16": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7966.jpg",
    "17": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7967.jpg",
    "18": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7968.jpg",
    "19": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7969.jpg",
    "20": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7970.jpg",
    "21": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7971.jpg",
    "22": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7972.jpg",
    "23": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7973.jpg"
  },
  "4": {
    "1": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7974.jpg",
    "2": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7975.jpg",
    "3": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7976.jpg",
    "4": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7977.jpg",
    "5": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7978.jpg",
    "6": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7979.jpg",
    "7": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7980.jpg",
    "8": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7981.jpg",
    "9": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7982.jpg",
    "10": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7983.jpg",
    "11": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7984.jpg",
    "12": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7985.jpg",
    "13": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7986.jpg",
    "14": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7987.jpg",
    "15": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7988.jpg",
    "16": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7989.jpg",
    "17": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7990.jpg"
  },
  "5": {
    "1": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7991.jpg",
    "2": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7992.jpg",
    "3": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7993.jpg",
    "4": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7994.jpg",
    "5": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7995.jpg",
    "6": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7996.jpg",
    "7": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7997.jpg",
    "8": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7998.jpg",
    "9": "https://video.mvapspdmpg.com/movies/files/episodes-posters/7999.jpg",
    "10": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8000.jpg",
    "11": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8001.jpg",
    "12": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8002.jpg",
    "13": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8003.jpg",
    "14": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8004.jpg",
    "15": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8005.jpg",
    "16": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8006.jpg",
    "17": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8007.jpg",
    "18": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8008.jpg",
    "19": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8009.jpg",
    "20": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8010.jpg",
    "21": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8011.jpg",
    "22": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8012.jpg",
    "23": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8013.jpg",
    "24": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8014.jpg"
  },
  "6": {
    "1": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8015.jpg",
    "2": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8016.jpg",
    "3": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8017.jpg",
    "4": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8018.jpg",
    "5": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8019.jpg",
    "6": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8020.jpg",
    "7": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8021.jpg",
    "8": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8022.jpg",
    "9": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8023.jpg",
    "10": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8024.jpg",
    "11": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8025.jpg",
    "12": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8026.jpg",
    "13": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8027.jpg",
    "14": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8028.jpg",
    "15": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8029.jpg",
    "16": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8030.jpg",
    "17": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8031.jpg",
    "18": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8032.jpg",
    "19": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8033.jpg",
    "20": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8034.jpg",
    "21": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8035.jpg",
    "22": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8036.jpg",
    "23": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8037.jpg"
  },
  "7": {
    "1": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8038.jpg"
  },
  "8": {
    "1": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8061.jpg",
    "2": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8062.jpg",
    "3": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8063.jpg",
    "4": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8064.jpg",
    "5": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8065.jpg",
    "6": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8066.jpg",
    "7": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8067.jpg",
    "8": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8068.jpg",
    "9": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8069.jpg",
    "10": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8070.jpg",
    "11": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8071.jpg",
    "12": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8072.jpg",
    "13": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8073.jpg",
    "14": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8074.jpg",
    "15": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8075.jpg",
    "16": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8076.jpg",
    "17": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8077.jpg",
    "18": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8078.jpg",
    "19": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8079.jpg",
    "20": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8080.jpg",
    "21": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8081.jpg",
    "22": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8082.jpg",
    "23": "https://video.mvapspdmpg.com/movies/files/episodes-posters/8083.jpg"
  }
},
    players: [
  {
    "type": "Alloha",
    "translations": [
      {
        "id": 73,
        "name": "Невафильм",
        "quality": "WEB-DL"
      },
      {
        "id": 96,
        "name": "TVShows",
        "quality": "WEB-DL"
      }
    ]
  },
  {
    "type": "Veoveo",
    "translations": [
      {
        "id": null,
        "name": "Русский. Дубляж. Невафильм. AAC",
        "quality": null
      },
      {
        "id": null,
        "name": "Английский. Оригинал. AAC",
        "quality": null
      }
    ]
  },
  {
    "type": "Turbo",
    "translations": [
      {
        "id": null,
        "name": null,
        "quality": null
      }
    ]
  },
  {
    "type": "Collaps",
    "translations": [
      {
        "id": null,
        "name": "Невафильм",
        "quality": "FHD (1080p)"
      },
      {
        "id": null,
        "name": "Eng.Original",
        "quality": "FHD (1080p)"
      }
    ]
  }
],
    episodeMetadata: {
  "1": {
    "1": {
      "episodeId": 1278318,
      "episodeVariantIds": [
        4330
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Pilot"
    },
    "2": {
      "episodeId": 1278319,
      "episodeVariantIds": [
        4331
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Ah, But Underneath"
    },
    "3": {
      "episodeId": 1278320,
      "episodeVariantIds": [
        4332
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Pretty Little Picture"
    },
    "4": {
      "episodeId": 1278321,
      "episodeVariantIds": [
        4333
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Who's That Woman?"
    },
    "5": {
      "episodeId": 1278322,
      "episodeVariantIds": [
        4334
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Come in, Stranger"
    },
    "6": {
      "episodeId": 1278323,
      "episodeVariantIds": [
        4335
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Running to Stand Still"
    },
    "7": {
      "episodeId": 1278324,
      "episodeVariantIds": [
        4336
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Anything You Can Do"
    },
    "8": {
      "episodeId": 1278325,
      "episodeVariantIds": [
        4337
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Guilty"
    },
    "9": {
      "episodeId": 1278326,
      "episodeVariantIds": [
        4338
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Suspicious Minds"
    },
    "10": {
      "episodeId": 1278327,
      "episodeVariantIds": [
        4339
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Come Back to Me"
    },
    "11": {
      "episodeId": 1278328,
      "episodeVariantIds": [
        4340
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Move On"
    },
    "12": {
      "episodeId": 1278329,
      "episodeVariantIds": [
        4341
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Every Day a Little Death"
    },
    "13": {
      "episodeId": 1278330,
      "episodeVariantIds": [
        4342
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Your Fault"
    },
    "14": {
      "episodeId": 1278331,
      "episodeVariantIds": [
        4343
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Love Is in the Air"
    },
    "15": {
      "episodeId": 1278332,
      "episodeVariantIds": [
        4344
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Impossible"
    },
    "16": {
      "episodeId": 1278333,
      "episodeVariantIds": [
        4345
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "The Ladies Who Lunch"
    },
    "17": {
      "episodeId": 1278334,
      "episodeVariantIds": [
        4346
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "There Won't Be Trumpets"
    },
    "18": {
      "episodeId": 1278335,
      "episodeVariantIds": [
        4347
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Children Will Listen"
    },
    "19": {
      "episodeId": 1278336,
      "episodeVariantIds": [
        4348
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Live Alone and Like It"
    },
    "20": {
      "episodeId": 1278337,
      "episodeVariantIds": [
        4349
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Fear No More"
    },
    "21": {
      "episodeId": 1278338,
      "episodeVariantIds": [
        4350
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Sunday in the Park with George"
    },
    "22": {
      "episodeId": 1278339,
      "episodeVariantIds": [
        4351
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "Goodbye for Now"
    },
    "23": {
      "episodeId": 1278340,
      "episodeVariantIds": [
        4352
      ],
      "translationIds": [
        "73",
        "96"
      ],
      "originalTitle": "One Wonderful Day"
    }
  },
  "2": {
    "1": {
      "episodeId": 1278341,
      "episodeVariantIds": [
        4353
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Next"
    },
    "2": {
      "episodeId": 1278342,
      "episodeVariantIds": [
        4354
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "You Could Drive a Person Crazy"
    },
    "3": {
      "episodeId": 1278343,
      "episodeVariantIds": [
        4355
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "You'll Never Get Away from Me"
    },
    "4": {
      "episodeId": 1278344,
      "episodeVariantIds": [
        4356
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "My Heart Belongs to Daddy"
    },
    "5": {
      "episodeId": 1278345,
      "episodeVariantIds": [
        4357
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "They Asked Me Why I Believe in You"
    },
    "6": {
      "episodeId": 1278346,
      "episodeVariantIds": [
        4358
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "I Wish I Could Forget You"
    },
    "7": {
      "episodeId": 1278347,
      "episodeVariantIds": [
        4359
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Color and Light"
    },
    "8": {
      "episodeId": 1278348,
      "episodeVariantIds": [
        4360
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Sun Won't Set"
    },
    "9": {
      "episodeId": 1278349,
      "episodeVariantIds": [
        4361
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "That's Good, That's Bad"
    },
    "10": {
      "episodeId": 1278350,
      "episodeVariantIds": [
        4362
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Coming Home"
    },
    "11": {
      "episodeId": 1278351,
      "episodeVariantIds": [
        4363
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "One More Kiss"
    },
    "12": {
      "episodeId": 1278352,
      "episodeVariantIds": [
        4364
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "We're Gonna Be All Right"
    },
    "13": {
      "episodeId": 1278353,
      "episodeVariantIds": [
        4365
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "There's Something About a War"
    },
    "14": {
      "episodeId": 1278354,
      "episodeVariantIds": [
        4366
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Silly People"
    },
    "15": {
      "episodeId": 1278355,
      "episodeVariantIds": [
        4367
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Thank You So Much"
    },
    "16": {
      "episodeId": 1278356,
      "episodeVariantIds": [
        4368
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "There Is No Other Way"
    },
    "17": {
      "episodeId": 1278357,
      "episodeVariantIds": [
        4369
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Could I Leave You?"
    },
    "18": {
      "episodeId": 1278358,
      "episodeVariantIds": [
        4370
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Everybody Says Don't"
    },
    "19": {
      "episodeId": 1278359,
      "episodeVariantIds": [
        4371
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Don't Look at Me"
    },
    "20": {
      "episodeId": 1278360,
      "episodeVariantIds": [
        4372
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "It Wasn't Meant to Happen"
    },
    "21": {
      "episodeId": 1278361,
      "episodeVariantIds": [
        4373
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "I Know Things Now"
    },
    "22": {
      "episodeId": 1278362,
      "episodeVariantIds": [
        4374
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "No One Is Alone"
    },
    "23": {
      "episodeId": 1278363,
      "episodeVariantIds": [
        4375
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Remember: Part 1"
    },
    "24": {
      "episodeId": 1278364,
      "episodeVariantIds": [
        4376
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Remember: Part 2"
    }
  },
  "3": {
    "1": {
      "episodeId": 1278365,
      "episodeVariantIds": [
        4377
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Listen to the Rain on the Roof"
    },
    "2": {
      "episodeId": 1278366,
      "episodeVariantIds": [
        4378
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "It Takes Two"
    },
    "3": {
      "episodeId": 1278367,
      "episodeVariantIds": [
        4379
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "A Weekend in the Country"
    },
    "4": {
      "episodeId": 1278368,
      "episodeVariantIds": [
        4380
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Like It Was"
    },
    "5": {
      "episodeId": 1278369,
      "episodeVariantIds": [
        4381
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Nice She Ain't"
    },
    "6": {
      "episodeId": 1278370,
      "episodeVariantIds": [
        4382
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Sweetheart, I Have to Confess"
    },
    "7": {
      "episodeId": 1278371,
      "episodeVariantIds": [
        4383
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Bang"
    },
    "8": {
      "episodeId": 1278372,
      "episodeVariantIds": [
        4384
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Children and Art"
    },
    "9": {
      "episodeId": 1278373,
      "episodeVariantIds": [
        4385
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Beautiful Girls"
    },
    "10": {
      "episodeId": 1278374,
      "episodeVariantIds": [
        4386
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Miracle Song"
    },
    "11": {
      "episodeId": 1278375,
      "episodeVariantIds": [
        4387
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "No Fits, No Fights, No Feuds"
    },
    "12": {
      "episodeId": 1278376,
      "episodeVariantIds": [
        4388
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Not While I'm Around"
    },
    "13": {
      "episodeId": 1278377,
      "episodeVariantIds": [
        4389
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Come Play Wiz Me"
    },
    "14": {
      "episodeId": 1278378,
      "episodeVariantIds": [
        4390
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "I Remember That"
    },
    "15": {
      "episodeId": 1278379,
      "episodeVariantIds": [
        4391
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Little Things You Do Together"
    },
    "16": {
      "episodeId": 1278380,
      "episodeVariantIds": [
        4392
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "My Husband, the Pig"
    },
    "17": {
      "episodeId": 1278381,
      "episodeVariantIds": [
        4393
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Dress Big"
    },
    "18": {
      "episodeId": 1278382,
      "episodeVariantIds": [
        4394
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Liaisons"
    },
    "19": {
      "episodeId": 1278383,
      "episodeVariantIds": [
        4395
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "God, That's Good"
    },
    "20": {
      "episodeId": 1278384,
      "episodeVariantIds": [
        4396
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Gossip"
    },
    "21": {
      "episodeId": 1278385,
      "episodeVariantIds": [
        4397
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Into the Woods"
    },
    "22": {
      "episodeId": 1278386,
      "episodeVariantIds": [
        4398
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "What Would We Do Without You?"
    },
    "23": {
      "episodeId": 1278387,
      "episodeVariantIds": [
        4399
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Getting Married Today"
    }
  },
  "4": {
    "1": {
      "episodeId": 1278388,
      "episodeVariantIds": [
        4400
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Now You Know"
    },
    "2": {
      "episodeId": 1278389,
      "episodeVariantIds": [
        4401
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Smiles of a Summer Night"
    },
    "3": {
      "episodeId": 1278390,
      "episodeVariantIds": [
        4402
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Game"
    },
    "4": {
      "episodeId": 1278391,
      "episodeVariantIds": [
        4403
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "If There's Anything I Can't Stand"
    },
    "5": {
      "episodeId": 1278392,
      "episodeVariantIds": [
        4404
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Art Isn't Easy"
    },
    "6": {
      "episodeId": 1278393,
      "episodeVariantIds": [
        4405
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Now I Know, Don't Be Scared"
    },
    "7": {
      "episodeId": 1278394,
      "episodeVariantIds": [
        4406
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "You Can't Judge a Book by Its Cover"
    },
    "8": {
      "episodeId": 1278395,
      "episodeVariantIds": [
        4407
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Distant Past"
    },
    "9": {
      "episodeId": 1278396,
      "episodeVariantIds": [
        4408
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Something's Coming"
    },
    "10": {
      "episodeId": 1278397,
      "episodeVariantIds": [
        4409
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Welcome to Kanagawa"
    },
    "11": {
      "episodeId": 1278398,
      "episodeVariantIds": [
        4410
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Sunday"
    },
    "12": {
      "episodeId": 1278399,
      "episodeVariantIds": [
        4411
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "In Buddy's Eyes"
    },
    "13": {
      "episodeId": 1278400,
      "episodeVariantIds": [
        4412
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Hello, Little Girl"
    },
    "14": {
      "episodeId": 1278401,
      "episodeVariantIds": [
        4413
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Opening Doors"
    },
    "15": {
      "episodeId": 1278402,
      "episodeVariantIds": [
        4414
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Mother Said"
    },
    "16": {
      "episodeId": 1278403,
      "episodeVariantIds": [
        4415
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Gun Song"
    },
    "17": {
      "episodeId": 1278404,
      "episodeVariantIds": [
        4416
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Free"
    }
  },
  "5": {
    "1": {
      "episodeId": 1278405,
      "episodeVariantIds": [
        4417
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "You're Gonna Love Tomorrow"
    },
    "2": {
      "episodeId": 1278406,
      "episodeVariantIds": [
        4418
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "We're So Happy You're So Happy"
    },
    "3": {
      "episodeId": 1278407,
      "episodeVariantIds": [
        4419
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Kids Ain't Like Everybody Else"
    },
    "4": {
      "episodeId": 1278408,
      "episodeVariantIds": [
        4420
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Back in Business"
    },
    "5": {
      "episodeId": 1278409,
      "episodeVariantIds": [
        4421
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Mirror, Mirror"
    },
    "6": {
      "episodeId": 1278410,
      "episodeVariantIds": [
        4422
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "There's Always a Woman"
    },
    "7": {
      "episodeId": 1278411,
      "episodeVariantIds": [
        4423
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "What More Do I Need?"
    },
    "8": {
      "episodeId": 1278412,
      "episodeVariantIds": [
        4424
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "City on Fire"
    },
    "9": {
      "episodeId": 1278413,
      "episodeVariantIds": [
        4425
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Me and My Town"
    },
    "10": {
      "episodeId": 1278414,
      "episodeVariantIds": [
        4426
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "A Vision's Just a Vision"
    },
    "11": {
      "episodeId": 1278415,
      "episodeVariantIds": [
        4427
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Home Is the Place"
    },
    "12": {
      "episodeId": 1278416,
      "episodeVariantIds": [
        4428
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Connect! Connect!"
    },
    "13": {
      "episodeId": 1278417,
      "episodeVariantIds": [
        4429
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Best Thing That Ever Could Have Happened"
    },
    "14": {
      "episodeId": 1278418,
      "episodeVariantIds": [
        4430
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Mama Spent Money When She Had None"
    },
    "15": {
      "episodeId": 1278419,
      "episodeVariantIds": [
        4431
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "In a World Where the Kings Are Employers"
    },
    "16": {
      "episodeId": 1278420,
      "episodeVariantIds": [
        4432
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Crime Doesn't Pay"
    },
    "17": {
      "episodeId": 1278421,
      "episodeVariantIds": [
        4433
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Story of Lucy and Jessie"
    },
    "18": {
      "episodeId": 1278422,
      "episodeVariantIds": [
        4434
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "A Spark. To Pierce the Dark."
    },
    "19": {
      "episodeId": 1278423,
      "episodeVariantIds": [
        4435
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Look Into Their Eyes and You See What They Know"
    },
    "20": {
      "episodeId": 1278424,
      "episodeVariantIds": [
        4436
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Rose's Turn"
    },
    "21": {
      "episodeId": 1278425,
      "episodeVariantIds": [
        4437
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Bargaining"
    },
    "22": {
      "episodeId": 1278426,
      "episodeVariantIds": [
        4438
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Marry Me a Little"
    },
    "23": {
      "episodeId": 1278427,
      "episodeVariantIds": [
        4439
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Everybody Says Don't"
    },
    "24": {
      "episodeId": 1278428,
      "episodeVariantIds": [
        4440
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "If It's Only in Your Head"
    }
  },
  "6": {
    "1": {
      "episodeId": 1278429,
      "episodeVariantIds": [
        4441
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Nice Is Different Than Good"
    },
    "2": {
      "episodeId": 1278430,
      "episodeVariantIds": [
        4442
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Being Alive"
    },
    "3": {
      "episodeId": 1278431,
      "episodeVariantIds": [
        4443
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Never Judge a Lady by Her Lover"
    },
    "4": {
      "episodeId": 1278432,
      "episodeVariantIds": [
        4444
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The God-Why-Don't-You-Love-Me Blues"
    },
    "5": {
      "episodeId": 1278433,
      "episodeVariantIds": [
        4445
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Everybody Ought to Have a Maid"
    },
    "6": {
      "episodeId": 1278434,
      "episodeVariantIds": [
        4446
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Don't Walk on the Grass"
    },
    "7": {
      "episodeId": 1278435,
      "episodeVariantIds": [
        4447
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Careful the Things You Say"
    },
    "8": {
      "episodeId": 1278436,
      "episodeVariantIds": [
        4448
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Coffee Cup"
    },
    "9": {
      "episodeId": 1278437,
      "episodeVariantIds": [
        4449
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Would I Think of Suicide?"
    },
    "10": {
      "episodeId": 1278438,
      "episodeVariantIds": [
        4450
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Boom Crunch"
    },
    "11": {
      "episodeId": 1278439,
      "episodeVariantIds": [
        4451
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "If..."
    },
    "12": {
      "episodeId": 1278440,
      "episodeVariantIds": [
        4452
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "You Gotta Get a Gimmick"
    },
    "13": {
      "episodeId": 1278441,
      "episodeVariantIds": [
        4453
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "How About a Friendly Shrink?"
    },
    "14": {
      "episodeId": 1278442,
      "episodeVariantIds": [
        4454
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Glamorous Life"
    },
    "15": {
      "episodeId": 1278443,
      "episodeVariantIds": [
        4455
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Lovely"
    },
    "16": {
      "episodeId": 1278444,
      "episodeVariantIds": [
        4456
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Chase"
    },
    "17": {
      "episodeId": 1278445,
      "episodeVariantIds": [
        4457
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Chromolume No. 7"
    },
    "18": {
      "episodeId": 1278446,
      "episodeVariantIds": [
        4458
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "My Two Young Men"
    },
    "19": {
      "episodeId": 1278447,
      "episodeVariantIds": [
        4459
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "We All Deserve to Die"
    },
    "20": {
      "episodeId": 1278448,
      "episodeVariantIds": [
        4460
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Epiphany"
    },
    "21": {
      "episodeId": 1278449,
      "episodeVariantIds": [
        4461
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "A Little Night Music"
    },
    "22": {
      "episodeId": 1278450,
      "episodeVariantIds": [
        4462
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Ballad of Booth"
    },
    "23": {
      "episodeId": 1278451,
      "episodeVariantIds": [
        4463
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "I Guess This Is Goodbye"
    }
  },
  "7": {
    "1": {
      "episodeId": 1278452,
      "episodeVariantIds": [
        4464
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Remember Paul?"
    },
    "2": {
      "episodeId": 1278453,
      "episodeVariantIds": [
        4465
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "You Must Meet My Wife"
    },
    "3": {
      "episodeId": 1278454,
      "episodeVariantIds": [
        4466
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Truly Content"
    },
    "4": {
      "episodeId": 1278455,
      "episodeVariantIds": [
        4467
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Thing That Counts Is What's Inside"
    },
    "5": {
      "episodeId": 1278456,
      "episodeVariantIds": [
        4468
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Let Me Entertain You"
    },
    "6": {
      "episodeId": 1278457,
      "episodeVariantIds": [
        4469
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Excited and Scared"
    },
    "7": {
      "episodeId": 1278458,
      "episodeVariantIds": [
        4470
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "A Humiliating Business"
    },
    "8": {
      "episodeId": 1278459,
      "episodeVariantIds": [
        4471
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Sorry Grateful"
    },
    "9": {
      "episodeId": 1278460,
      "episodeVariantIds": [
        4472
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Pleasant Little Kingdom"
    },
    "10": {
      "episodeId": 1278461,
      "episodeVariantIds": [
        4473
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Down the Block There's a Riot"
    },
    "11": {
      "episodeId": 1278462,
      "episodeVariantIds": [
        4474
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Assassins"
    },
    "12": {
      "episodeId": 1278463,
      "episodeVariantIds": [
        4475
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Where Do I Belong?"
    },
    "13": {
      "episodeId": 1278464,
      "episodeVariantIds": [
        4476
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "I'm Still Here"
    },
    "14": {
      "episodeId": 1278465,
      "episodeVariantIds": [
        4477
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Flashback"
    },
    "15": {
      "episodeId": 1278466,
      "episodeVariantIds": [
        4478
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Farewell Letter"
    },
    "16": {
      "episodeId": 1278467,
      "episodeVariantIds": [
        4479
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Searching"
    },
    "17": {
      "episodeId": 1278468,
      "episodeVariantIds": [
        4480
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Everything's Different, Nothing's Changed"
    },
    "18": {
      "episodeId": 1278469,
      "episodeVariantIds": [
        4481
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Moments in the Woods"
    },
    "19": {
      "episodeId": 1278470,
      "episodeVariantIds": [
        4482
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Lies Ill-Concealed"
    },
    "20": {
      "episodeId": 1278471,
      "episodeVariantIds": [
        4483
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "I'll Swallow Poison on Sunday"
    },
    "21": {
      "episodeId": 1278472,
      "episodeVariantIds": [
        4484
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Then I Really Got Scared"
    },
    "22": {
      "episodeId": 1278473,
      "episodeVariantIds": [
        4485
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "And Lots of Security..."
    },
    "23": {
      "episodeId": 1278474,
      "episodeVariantIds": [
        4486
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Come on Over for Dinner"
    }
  },
  "8": {
    "1": {
      "episodeId": 1278475,
      "episodeVariantIds": [
        4487
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Secrets That I Never Want to Know"
    },
    "2": {
      "episodeId": 1278476,
      "episodeVariantIds": [
        4488
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Making the Connection"
    },
    "3": {
      "episodeId": 1278477,
      "episodeVariantIds": [
        4489
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Watch While I Revise the World"
    },
    "4": {
      "episodeId": 1278478,
      "episodeVariantIds": [
        4490
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "School of Hard Knocks"
    },
    "5": {
      "episodeId": 1278479,
      "episodeVariantIds": [
        4491
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The Art of Making Art"
    },
    "6": {
      "episodeId": 1278480,
      "episodeVariantIds": [
        4492
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Witch's Lament"
    },
    "7": {
      "episodeId": 1278481,
      "episodeVariantIds": [
        4493
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Always in Control"
    },
    "8": {
      "episodeId": 1278482,
      "episodeVariantIds": [
        4494
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Suspicion Song"
    },
    "9": {
      "episodeId": 1278483,
      "episodeVariantIds": [
        4495
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Putting It Together"
    },
    "10": {
      "episodeId": 1278484,
      "episodeVariantIds": [
        4496
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "What's to Discuss, Old Friend"
    },
    "11": {
      "episodeId": 1278485,
      "episodeVariantIds": [
        4497
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Who Can Say What's True?"
    },
    "12": {
      "episodeId": 1278486,
      "episodeVariantIds": [
        4498
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "What's the Good of Being Good"
    },
    "13": {
      "episodeId": 1278487,
      "episodeVariantIds": [
        4499
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Is This What You Call Love?"
    },
    "14": {
      "episodeId": 1278488,
      "episodeVariantIds": [
        4500
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Get Out of My Life"
    },
    "15": {
      "episodeId": 1278489,
      "episodeVariantIds": [
        4501
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "She Needs Me"
    },
    "16": {
      "episodeId": 1278490,
      "episodeVariantIds": [
        4502
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "You Take for Granted"
    },
    "17": {
      "episodeId": 1278491,
      "episodeVariantIds": [
        4503
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Women and Death"
    },
    "18": {
      "episodeId": 1278492,
      "episodeVariantIds": [
        4504
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Any Moment"
    },
    "19": {
      "episodeId": 1278493,
      "episodeVariantIds": [
        4505
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "With So Little to Be Sure Of"
    },
    "20": {
      "episodeId": 1278494,
      "episodeVariantIds": [
        4506
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Lost My Power"
    },
    "21": {
      "episodeId": 1278495,
      "episodeVariantIds": [
        4507
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "The People Will Hear"
    },
    "22": {
      "episodeId": 1278496,
      "episodeVariantIds": [
        4508
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Give Me the Blame"
    },
    "23": {
      "episodeId": 1278497,
      "episodeVariantIds": [
        4509
      ],
      "translationIds": [
        "73"
      ],
      "originalTitle": "Finishing the Hat"
    }
  }
},
    episodeTitles: {
  "1": {
    "1": "Пилот",
    "2": "Ах, но ниже",
    "3": "Довольно маленькая картина",
    "4": "Кто эта женщина?",
    "5": "Входи, незнакомец",
    "6": "Бежать, чтобы остановиться",
    "7": "Ты можешь сделать что-нибудь?",
    "8": "Виновный",
    "9": "Подозрительные умы",
    "10": "Вернись ко мне",
    "11": "Переход",
    "12": "Каждый день - маленькая смерть",
    "13": "Ваша ошибка",
    "14": "Любовь витает в воздухе",
    "15": "Невозможно",
    "16": "Леди, которые завтракают",
    "17": "Не будет труб",
    "18": "Дети будут слушаться",
    "19": "Жить одному и радоваться этому",
    "20": "Небольшие опасения",
    "21": "Воскресенье в парке с Джорджем",
    "22": "Прости-прощай",
    "23": "Один замечательный день"
  },
  "2": {
    "1": "Далее...",
    "2": "Ты можешь свести с ума",
    "3": "Ты никогда от меня не уйдешь",
    "4": "Мое сердце навсегда с папой",
    "5": "Они спрашивают, почему я верю в тебя",
    "6": "Хотел бы я позабыть тебя",
    "7": "Цвет и яркость",
    "8": "Солнце не зайдёт",
    "9": "Это хорошо, это плохо",
    "10": "Возвращение домой",
    "11": "Еще один поцелуй",
    "12": "С нами все будет в порядке",
    "13": "Теперь кое-что о войне",
    "14": "Глупые люди",
    "15": "Большое спасибо",
    "16": "Нет другого пути",
    "17": "Можно я тебя покину?",
    "18": "Все говорят «Нет»",
    "19": "Не смотри на меня",
    "20": "Это не должно было случиться",
    "21": "Теперь я знаю",
    "22": "Никто не одинок",
    "23": "Помни: Часть 1",
    "24": "Помни: Часть 2"
  },
  "3": {
    "1": "Прислушайся, как стучит дождь по крыше",
    "2": "Нужны двое",
    "3": "Выходные за городом",
    "4": "Как это было",
    "5": "Правда, милашка?",
    "6": "Любовь моя, хочу признаться",
    "7": "Выстрел",
    "8": "Дети и искусство",
    "9": "Девочки-красавицы",
    "10": "Сказание о чуде",
    "11": "Тишь да гладь, божья благодать",
    "12": "Пока меня нет рядом",
    "13": "Приходи, поиграй со мной",
    "14": "Я это помню",
    "15": "Маленькие вещи, которые вы обычно делаете вместе",
    "16": "Мой муж свинья",
    "17": "Супер платье",
    "18": "Связи",
    "19": "Господи, как хорошо!",
    "20": "Сплетни",
    "21": "В лесной чаще",
    "22": "Что бы мы без тебя делали?",
    "23": "Сегодня свадьба"
  },
  "4": {
    "1": "Теперь ты знаешь",
    "2": "Улыбка летней ночи",
    "3": "Игра",
    "4": "Есть ли на свете то, что я не смогу вытерпеть?",
    "5": "Искусство - непростое дело",
    "6": "Теперь я знаю, не пугайся",
    "7": "Не суди о книге по её обложке",
    "8": "Далёкое прошлое",
    "9": "Что-то надвигается",
    "10": "Добро пожаловать в Канагаву",
    "11": "Воскресенье",
    "12": "Глазами друга",
    "13": "Привет, малышка",
    "14": "Открывающиеся двери",
    "15": "Мамочка сказала",
    "16": "Песня пистолета",
    "17": "Свобода"
  },
  "5": {
    "1": "Завтра ты полюбишь",
    "2": "Мы так счастливы, что Вы счастливы",
    "3": "Дети не похожи на других",
    "4": "Возвращение в бизнес",
    "5": "Зеркало, зеркало",
    "6": "Во всем замешана женщина",
    "7": "Чего ещё желать?",
    "8": "Город в огне",
    "9": "Я и мой городок",
    "10": "Представление — это всего лишь представление",
    "11": "Дом — то самое место",
    "12": "Приём! Приём!",
    "13": "Лучшее, что могло случиться",
    "14": "Мама потратила деньги, которых у неё не было",
    "15": "Мир, в котором короли работают",
    "16": "Преступление не окупается",
    "17": "История Люси и Джесси",
    "18": "Луч, пронзающий тьму",
    "19": "Посмотри в их глаза и ты увидишь, что они знают",
    "20": "Дьявол и Роуз",
    "21": "Сделка",
    "22": "Поженись на мне немножко",
    "23": "Все говорят - \"Нет\"",
    "24": "Если это только в твоей голове"
  },
  "6": {
    "1": "\"Милая\" не значит \"хорошая\"",
    "2": "Выжить",
    "3": "Не судите о даме по ее возлюбленному",
    "4": "Блюз \"Господи-почему-ты-меня-не-любишь\"",
    "5": "У каждого должна быть горничная",
    "6": "По газонам не ходить",
    "7": "Осторожнее с тем, что говоришь",
    "8": "Кофейная чашка",
    "9": "Неужели я думаю о самоубийстве?",
    "10": "Удар",
    "11": "Если бы...",
    "12": "Тебе придется пойти на хитрость",
    "13": "Как насчет симпатичного психотерапевта?",
    "14": "Очаровательная жизнь",
    "15": "Прелесть",
    "16": "Преследование",
    "17": "Хромолюм №7",
    "18": "Мои два юноши",
    "19": "Мы все заслуживаем смерти",
    "20": "Прозрение",
    "21": "Маленькая ночная серенада",
    "22": "Баллада о Буте",
    "23": "Думаю, настало время прощаться"
  },
  "7": {
    "1": "Помните Пола?",
    "2": "Вы должны познакомиться с моей женой",
    "3": "По-настоящему спокоен",
    "4": "Главное - что внутри",
    "5": "Позвольте вас развлечь",
    "6": "Страшно и интересно",
    "7": "Унижение",
    "8": "Благодарность с грустью",
    "9": "Маленькое уютное царство",
    "10": "Бунт в конце квартала",
    "11": "Убийцы",
    "12": "Потерянные",
    "13": "Я все еще здесь",
    "14": "Навязчивые воспоминания",
    "15": "Прощальное письмо",
    "16": "В поиске",
    "17": "Все по-новому, ничего не изменилось",
    "18": "Сцены в лесу",
    "19": "Плохо скрытая ложь",
    "20": "Приму яд в воскресенье",
    "21": "И тогда мне стало страшно",
    "22": "И совсем безопасно…",
    "23": "Заходите к нам на ужин"
  },
  "8": {
    "1": "Тайны, о которых я не желаю знать",
    "2": "Устанавливая связь",
    "3": "Мой взгляд на мир",
    "4": "Школа крутых ударов",
    "5": "Искусство создания искусства",
    "6": "Плач ведьмы",
    "7": "Всегда под контролем",
    "8": "Песнь подозрения",
    "9": "Вместе мы справимся",
    "10": "Нам есть что обсудить, старый знакомый",
    "11": "Кто скажет, что это правда?",
    "12": "Что хорошего в том, чтобы быть правильным",
    "13": "Это, что ты называешь любовью?",
    "14": "Убирайся из моей жизни",
    "15": "Я нужен ей",
    "16": "Принимать как должное",
    "17": "Женщины и смерть",
    "18": "В любой момент",
    "19": "Нет уверенности ни в чём",
    "20": "Теряя свои силы",
    "21": "Люди услышат",
    "22": "Отдай свою вину",
    "23": "Последний штрих"
  }
}
  };

  const defaultState = { view: "home", theme: "cinema", mood: "уютно", query: "", catalogGenre: "", catalogCollection: "", catalogMoodOnly: false, catalogPlayableOnly: false, catalogSort: "now", catalogPage: 1, favorites: [], watchlist: [], subscriptions: [], progress: {}, ratings: {}, history: [], recommendationHistory: [], tasteMemory: [], offline: {}, voiceSelections: {}, playbackSelections: {}, playerVolume: 1, playerMuted: false, rutubeUrl: "", skipSegments: true };
  const ROUTE_PATHS = Object.freeze({ home: "/", feed: "/feed/", catalog: "/catalog/", upcoming: "/upcoming/", movies: "/movies/", series: "/series/", cartoons: "/cartoons/", anime: "/anime/", library: "/library/", favorites: "/favorites/", evening: "/evening/", history: "/history/", settings: "/settings/", about: "/about/" });
  const ROUTE_VIEWS = Object.freeze(Object.fromEntries(Object.entries(ROUTE_PATHS).map(([view, path]) => [path, view])));
  let state = loadState();
  // One dark theme; older builds stored a theme choice that is no longer read.
  // «Интерес зрителей» used to mean all-time votes; it now means what people watch now.
  if (!state.catalogSortNow) { if (!state.catalogSort || state.catalogSort === "audience") state.catalogSort = "now"; state.catalogSortNow = true; saveState(); }
  // Pets and the floating assistant are gone; drop what older builds stored for them.
  if ("pets" in state || "companion" in state) { delete state.pets; delete state.companion; saveState(); }
  const initialRoute = readRouteFromLocation();
  if (initialRoute.type === "view") state.view = initialRoute.view;
  // The catalog is populated only from the current imported/backend data.
  // Keeping demo seed cards out prevents stale local entries from flashing
  // while the real catalog is being loaded.
  let catalog = [];
  // The catalogue page is paginated, while discovery needs the whole lightweight
  // index. Keep them separate so a page filter can never narrow "Для вас".
  let discoveryCatalog = [];
  let freshCatalog = [];
  let upcomingCatalog = [];
  // Cards behind "Продолжить просмотр" that are not on any loaded page.
  let progressCatalog = [];
  let lastRenderedView = "";
  let enteringTimer = null;
  // Kinopoisk "popular now" cards, ranked; feeds the hero and the top 10.
  let trendingCatalog = [];
  let worldTrendingCatalog = [];
  let savedTitlesCatalog = [];
  let remoteCatalogController = null;
  let loadedCatalogKey = "";
  let catalogRenderAll = false;
  let audienceCatalog = [];
  const importedDetailsLoading = new Set();
  const importedDetailsLoaded = new Set();
  const importedDetailsCache = new Map();
  let remoteCatalog = { page: 1, pages: 1, total: 0, facets: { genres: {} } };
  let remoteCatalogRequest = 0;
  let remoteCatalogLoading = false;
  let remoteCatalogError = false;
  let searchDraft = "";
  let searchSuggestionCatalog = [];
  // Titles met outside the current list (similar titles, a title opened by its address): they can
  // be opened, but they must not join the list the viewer searched or filtered.
  let looseTitles = [];
  function rememberLooseTitles(items) {
    looseTitles = [...new Map([...looseTitles, ...items].filter(Boolean).map((entry) => [entry.id, entry])).values()].slice(-2000);
  }
  // Episode ratings of popular series (IMDb), by catalogue id; null when there is no map to show.
  const episodeRatingsCache = new Map();
  let searchSuggestionTimer = 0;
  let searchSuggestionRequest = null;
  function withTitleOverrides(item) {
    if (!item) return item;
    const poster = posterOverrides[item.id];
    const dropFrame = posterOnlyTitles.has(item.id) && item.backdropImage;
    return poster || dropFrame ? { ...item, ...(poster ? { posterImage: poster } : {}), ...(dropFrame ? { backdropImage: "" } : {}) } : item;
  }
  function applyPosterOverrides() {
    catalog = catalog.map(withTitleOverrides);
  }
  applyPosterOverrides();
  let tmdbStatus = tmdbCredential ? "Загружаю постеры и данные TMDB…" : "TMDB-ключ не найден";
  let tmdbSyncStarted = false;
  let initialCatalogReady = false;
  // Keep the first screen coherent: show one lightweight loading state until
  // the imported catalog is ready instead of exposing the seed catalog.
  let catalogHydrating = initialRoute.type === "title" || (initialRoute.type === "view" && ["home", "catalog", "upcoming", "movies", "series", "favorites", "evening", "history"].includes(initialRoute.view));
  let lazyPosterObserver = null;
  let progressiveCatalogObserver = null;
  // The genre row stays one scrolling line until the viewer asks for all of it.
  let genreRailExpanded = false;
  let progressiveCatalogItems = [];
  let progressiveCatalogNext = 0;
  let selectedSeason = 1;
  let seasonTransitionTimer = null;
  let activeTitleId = null;
  let playerReturnContext = null;
  let episodeAssetsLoading = true;
  let episodeAssetsError = "";
  let episodeImagesLoading = false;
  const episodeAssetStates = {};
  let libraryEpisodes = [];
  let libraryHistory = [];
  let libraryStatus = "Проверяю сервер медиатеки…";
  let adminToken = String(sessionStorage.getItem("cinevault.adminToken") || "").trim();
  // Service pages (the shared library, provider checks) stay out of sight until ?admin=1
  // is opened once on this device; ?admin=0 hides them again. This is tidiness, not
  // protection: the server still asks for its own admin key.
  const ADMIN_MODE_KEY = "cinevault.admin";
  (() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("admin")) return;
    try {
      if (params.get("admin") === "1") localStorage.setItem(ADMIN_MODE_KEY, "1");
      else localStorage.removeItem(ADMIN_MODE_KEY);
    } catch (_error) { /* private mode: the flag just does not stick */ }
    params.delete("admin");
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  })();
  function isAdminMode() {
    try { return localStorage.getItem(ADMIN_MODE_KEY) === "1"; } catch (_error) { return false; }
  }
  let activeWatchRoomId = new URLSearchParams(window.location.search).get("room") || "";
  let roomOpenAttempted = false;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const app = $("#app");
  const page = $("#page");
  // Horizontal rails scroll sideways with a trackpad, but a mouse wheel on Windows only
  // scrolls up and down, and the rails hide their scrollbar. Desktop pointers get arrows.
  const railArrowsWanted = window.matchMedia("(hover: hover) and (pointer: fine)");
  function enhanceRails() {
    if (!railArrowsWanted.matches) return;
    page.querySelectorAll(".discovery-rail:not([data-rail-arrows])").forEach((rail) => {
      rail.dataset.railArrows = "1";
      const wrap = document.createElement("div");
      wrap.className = "rail-wrap";
      rail.replaceWith(wrap);
      wrap.append(rail);
      const arrows = [-1, 1].map((direction) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `rail-arrow ${direction < 0 ? "is-prev" : "is-next"}`;
        button.setAttribute("aria-label", direction < 0 ? "Прокрутить назад" : "Прокрутить вперёд");
        button.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="${direction < 0 ? "m15 5-7 7 7 7" : "m9 5 7 7-7 7"}"/></svg>`;
        button.addEventListener("click", () => rail.scrollBy({ left: direction * rail.clientWidth * 0.85, behavior: "smooth" }));
        wrap.append(button);
        return button;
      });
      const update = () => {
        arrows[0].hidden = rail.scrollLeft <= 4;
        arrows[1].hidden = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4;
      };
      rail.addEventListener("scroll", update, { passive: true });
      window.requestAnimationFrame(update);
    });
  }
  new MutationObserver(() => window.requestAnimationFrame(enhanceRails)).observe(page, { childList: true, subtree: true });
  const modalRoot = $("#modal-root");
  // Dialogs: focus moves in, Tab stays inside, the page behind is inert, and focus
  // returns where it was when the dialog closes. Esc already closes it (see keydown).
  let focusBeforeModal = null;
  const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, iframe, [tabindex]:not([tabindex="-1"])';
  new MutationObserver(() => {
    const dialog = modalRoot.querySelector(".modal");
    const behind = [$(".sidebar"), $(".main-area")].filter(Boolean);
    if (dialog) {
      behind.forEach((element) => { element.inert = true; });
      if (!dialog.contains(document.activeElement)) {
        if (!focusBeforeModal && document.activeElement && document.activeElement !== document.body) focusBeforeModal = document.activeElement;
        const first = dialog.querySelector('[data-player-choice], .modal-head ~ * button:not([disabled])') || dialog.querySelector(focusableSelector);
        (first || dialog).focus?.({ preventScroll: true });
      }
    } else {
      behind.forEach((element) => { element.inert = false; });
      const back = focusBeforeModal;
      focusBeforeModal = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    }
  }).observe(modalRoot, { childList: true, subtree: false });
  modalRoot.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const dialog = modalRoot.querySelector(".modal");
    const items = dialog ? [...dialog.querySelectorAll(focusableSelector)].filter((element) => element.getClientRects().length) : [];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

  function safePathname(pathname = window.location.pathname) {
    let decoded = pathname || "/";
    try { decoded = decodeURIComponent(decoded); } catch { /* Keep the raw path for malformed copied links. */ }
    if (decoded === "/index.html") return "/";
    return decoded.length > 1 ? decoded.replace(/\/+$/, "") + "/" : "/";
  }

  function routeForView(view) { return ROUTE_PATHS[view] || ROUTE_PATHS.catalog; }
  function routeForTitle(id) { return `/title/${encodeURIComponent(String(id))}/`; }
  function routeForPerson(id) { return `/person/${encodeURIComponent(String(id))}/`; }

  function readRouteFromLocation() {
    // Addresses published before the catalogue moved to Kinopoisk ids (the sitemap still lists them).
    // Kept inside: this runs at start-up, before constants further down the file exist.
    const TITLE_ID_ALIASES = { "the-mentalist": "kinopoisk-412344", "desperate-housewives": "kinopoisk-160958" };
    const path = safePathname();
    const titleMatch = path.match(/^\/title\/([^/]+)\/$/);
    if (titleMatch) {
      let id = "";
      try { id = decodeURIComponent(titleMatch[1]); } catch { return { type: "view", view: "missing" }; }
      const canonical = TITLE_ID_ALIASES[id] || id;
      if (canonical !== id) window.history.replaceState(window.history.state, "", routeForTitle(canonical));
      return { type: "title", id: canonical };
    }
    const personMatch = path.match(/^\/person\/(\d+)\/$/);
    if (personMatch) return { type: "person", id: personMatch[1] };
    return { type: "view", view: ROUTE_VIEWS[path] || "home" };
  }

  function routeHistoryState(route, scrollY = 0, extra = {}) {
    return {
      cinevaultRoute: true,
      route: route.type,
      view: route.view || "",
      titleId: route.id || "",
      scrollY: Math.max(0, Number(scrollY) || 0),
      catalogContext: {
        page: Math.max(1, Number(state.catalogPage) || 1),
        query: String(state.query || ""),
        genre: String(state.catalogGenre || ""),
        collection: String(state.catalogCollection || ""),
        moodOnly: Boolean(state.catalogMoodOnly),
        playableOnly: Boolean(state.catalogPlayableOnly),
        sort: String(state.catalogSort || "now"),
      },
      ...extra,
    };
  }

  function updateCurrentHistoryScroll() {
    const route = readRouteFromLocation();
    window.history.replaceState(
      { ...(window.history.state || {}), ...routeHistoryState(route, window.scrollY) },
      "",
      window.location.href,
    );
  }

  function scheduleScroll(top = 0) {
    window.requestAnimationFrame(() => window.scrollTo({ top: Math.max(0, Number(top) || 0), left: 0, behavior: "auto" }));
  }

  function restoreCatalogContext(historyState) {
    const context = historyState?.catalogContext;
    if (!context || typeof context !== "object") return;
    state.catalogPage = Math.max(1, Number(context.page) || 1);
    state.query = String(context.query || "");
    searchDraft = state.query;
    state.catalogGenre = String(context.genre || "");
    state.catalogCollection = String(context.collection || "");
    state.catalogMoodOnly = Boolean(context.moodOnly);
    state.catalogPlayableOnly = Boolean(context.playableOnly);
    state.catalogSort = String(context.sort || "now");
  }

  function restoreCatalogPosition(historyState) {
    const fallbackTop = Math.max(0, Number(historyState?.scrollY) || 0);
    const anchorId = String(historyState?.catalogAnchorId || "");
    const applyPosition = () => {
      if (readRouteFromLocation().type !== "view") return;
      if (anchorId && String(window.history.state?.catalogAnchorId || "") !== anchorId) return;
      const anchor = anchorId
        ? [...document.querySelectorAll("[data-open-title]")].find((element) => element.dataset.openTitle === anchorId)
        : null;
      const savedOffset = Number(historyState?.catalogAnchorOffset);
      if (anchor && Number.isFinite(savedOffset)) {
        const top = window.scrollY + anchor.getBoundingClientRect().top - savedOffset;
        window.scrollTo({ top: Math.max(0, top), left: 0, behavior: "auto" });
        return;
      }
      window.scrollTo({ top: fallbackTop, left: 0, behavior: "auto" });
    };
    // Browsers may perform their own delayed focus restoration after popstate.
    // Re-apply our saved position after that pass so the old pagination button
    // cannot pull the catalogue to the bottom.
    window.requestAnimationFrame(() => window.requestAnimationFrame(applyPosition));
    window.setTimeout(applyPosition, 120);
    window.setTimeout(applyPosition, 360);
  }

  function updateDocumentRoute(route, item = null) {
    const titles = { about: "О Lumo Film", missing: "Не найдено — Lumo Film", home: "Lumo Film — кино для вас", catalog: "Каталог — Lumo Film", anime: "Аниме — Lumo Film", cartoons: "Мультфильмы — Lumo Film", upcoming: "Скоро — Lumo Film", movies: "Фильмы — Lumo Film", series: "Сериалы — Lumo Film", library: "Моя медиатека — Lumo Film", favorites: "Избранное — Lumo Film", evening: "Наш вечер — Lumo Film", history: "История просмотра — Lumo Film", settings: "Настройки — Lumo Film" };
    document.title = item ? `${item.title} — Lumo Film` : (titles[route.view] || "Lumo Film — кино для вас");
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      const path = route.type === "title" ? routeForTitle(route.id) : routeForView(route.view);
      canonical.setAttribute("href", new URL(path, window.location.origin).toString());
    }
  }

  function clearCatalogScope() {
    state.query = "";
    searchDraft = "";
    state.catalogGenre = "";
    state.catalogCollection = "";
    state.catalogMoodOnly = false;
    state.catalogPlayableOnly = false;
    resetCatalogPage();
  }

  function renderRoute(route, { restoreScroll = false, replaceHistory = false, preserveCatalogFilters = false, reuseCatalogPage = false } = {}) {
    if (catalogHydrating && route.type === "title") {
      state.view = "catalog";
      renderCatalogLoading();
      updateDocumentRoute({ type: "view", view: "catalog" });
      return;
    }
    if (route.type === "person") {
      activeTitleId = null;
      renderPersonPage(route.id);
      scheduleScroll(0);
      return;
    }
    if (route.type === "title" && lampacOrigin() && !parseTmdbItemId(route.id) && (/^kinopoisk-\d+$/.test(route.id) || Number(getTitle(route.id)?.kinopoiskId || 0) > 0)) {
      const known = knownTmdbId(route.id);
      if (known) {
        window.history.replaceState(window.history.state, "", routeForTitle(known));
        return renderRoute({ type: "title", id: known }, { replaceHistory });
      }
      const legacy = getTitle(route.id);
      if (legacy && !legacy.tmdbResolveTried) {
        legacy.tmdbResolveTried = true;
        renderCatalogLoading();
        resolveTmdbId(legacy).catch(() => "").then((found) => {
          if (readRouteFromLocation().id !== route.id) return;
          if (found) { migrateTitleId(route.id, found) && saveState(); window.history.replaceState(window.history.state, "", routeForTitle(found)); renderRoute({ type: "title", id: found }, { replaceHistory }); }
          else renderRoute(route, { replaceHistory });
        });
        return;
      }
    }
    if (route.type === "title") {
      const item = getTitle(route.id);
      // A TMDB card is fetched on demand; the page shows the loader until it arrives.
      if (!item && parseTmdbItemId(route.id)) {
        renderCatalogLoading();
        loadTmdbTitle(route.id)
          .then(() => { if (readRouteFromLocation().id === route.id) renderRoute(route, { replaceHistory }); })
          .catch(() => { if (readRouteFromLocation().id === route.id) { activeTitleId = null; renderMissingPage({ title: true }); document.title = "Не найдено — Lumo Film"; } });
        return;
      }
      if (!item) {
        // Keep the address the person followed and say plainly that there is no such title.
        activeTitleId = null;
        renderMissingPage({ title: true });
        document.title = "Не найдено — Lumo Film";
        scheduleScroll(0);
        return;
      }
      if (replaceHistory) window.history.replaceState(routeHistoryState(route), "", window.location.href);
      if (item.source === "tmdb" && !item.detailed) {
        // Opened from a list: show what is known at once, then the full card.
        // A failed load is tried again once by itself, then the page offers «Повторить».
        const redraw = () => { if (activeTitleId === item.id) renderDetails(item.id); };
        loadTmdbTitle(item.id).then(redraw).catch(() => new Promise((resolve) => window.setTimeout(resolve, 2000))
          .then(() => loadTmdbTitle(item.id)).then(redraw)
          .catch(() => { item.detailFailed = true; redraw(); }));
      }
      renderDetails(item.id);
      updateDocumentRoute(route, item);
      scheduleScroll(0);
      page.focus({ preventScroll: true });
      return;
    }

    const previousView = state.view;
    const historyState = window.history.state || {};
    const catalogViews = ["catalog", "upcoming", "movies", "series", "favorites", "evening", "history"];
    if (restoreScroll && catalogViews.includes(route.view)) restoreCatalogContext(historyState);
    // Genre, search and collection are controls of one catalogue visit, not
    // application-wide settings. An explicit navigation always starts the
    // destination with its complete source set. History/detail return keeps
    // the context because the view does not change.
    if (!preserveCatalogFilters && route.view !== previousView) clearCatalogScope();
    state.view = route.view;
    // Returning from a title keeps everything already loaded further down the list.
    const keepLoadedCatalog = restoreScroll && catalogViews.includes(route.view) && catalog.length > 0 && remoteCatalog.total > 0 && loadedCatalogKey === catalogListKey();
    const shouldReloadCatalog = catalogViews.includes(route.view) && !catalogHydrating && !reuseCatalogPage && !keepLoadedCatalog;
    catalogRenderAll = keepLoadedCatalog;
    if (shouldReloadCatalog) {
      catalog = [];
      remoteCatalog = { page: 1, pages: 1, total: 0, facets: remoteCatalog.facets };
      remoteCatalogLoading = true;
      remoteCatalogError = false;
      resetCatalogPage();
    }
    saveState();
    if (replaceHistory) window.history.replaceState(routeHistoryState(route), "", window.location.href);
    render();
    catalogRenderAll = false;
    updateDocumentRoute(route);
    if (shouldReloadCatalog && !catalogHydrating) {
      loadRemoteCatalogPage(1).then(() => {
        if (restoreScroll) restoreCatalogPosition(historyState);
        else scheduleScroll(0);
      });
    } else if (keepLoadedCatalog) {
      restoreCatalogPosition(historyState);
    } else {
      scheduleScroll(restoreScroll ? historyState.scrollY : 0);
    }
    if (state.view === "history") loadLibraryData(true);
  }

  function navigateToView(view, { replace = false, preserveCatalogFilters = false } = {}) {
    const route = { type: "view", view: ROUTE_PATHS[view] ? view : "catalog" };
    updateCurrentHistoryScroll();
    const method = replace ? "replaceState" : "pushState";
    window.history[method](routeHistoryState(route), "", routeForView(route.view));
    renderRoute(route, { preserveCatalogFilters });
  }

  function rememberTasteInteraction(item, type = "opened") {
    if (!item?.id) return;
    const now = Date.now();
    const memory = Array.isArray(state.tasteMemory) ? state.tasteMemory : [];
    const previous = memory[memory.length - 1];
    if (previous?.id === item.id && previous?.type === type && now - Number(previous.at || 0) < 15000) return;
    state.tasteMemory = [...memory, { id: item.id, type, mood: state.mood, at: now }].slice(-500);
    saveState();
  }

  // The poster the viewer clicked flies into the poster of the detail page
  // (View Transitions API). Without support or with reduced motion the page
  // simply switches as before.
  function withPosterTransition(trigger, update) {
    const source = trigger?.matches(".top-ten-card, .poster-card, .landscape-card, .feature-pick")
      ? trigger.querySelector(".poster-art, .top-ten-poster, .landscape-art, img")
      : null;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!source || typeof document.startViewTransition !== "function" || reduceMotion) {
      update();
      return;
    }
    // A title with a backdrop hides its poster, so the poster grows into the
    // backdrop instead.
    const detailArt = () => [$(".detail-poster"), $(".detail-backdrop")].find((element) => element?.getClientRects().length);
    source.style.viewTransitionName = "cv-poster";
    const transition = document.startViewTransition(async () => {
      source.style.viewTransitionName = "";
      update();
      // renderRoute scrolls on the next frame; the new snapshot must already
      // show the top of the detail page.
      window.scrollTo(0, 0);
      // Give the backdrop a moment to arrive so the poster does not fly into
      // an empty frame.
      const backdrop = $(".detail-shell")?.style.getPropertyValue("--detail-backdrop").match(/url\('(.+)'\)/)?.[1];
      if (backdrop) {
        const image = new Image();
        image.src = backdrop;
        await Promise.race([image.decode().catch(() => {}), new Promise((resolve) => window.setTimeout(resolve, 400))]);
      }
      // Named only now: the detail page may have been rebuilt while waiting.
      const target = detailArt();
      if (target) target.style.viewTransitionName = "cv-poster";
    });
    transition.finished.finally(() => {
      const target = detailArt();
      if (target) target.style.viewTransitionName = "";
    });
  }

  // «Случайный» from the whole TMDB catalogue, not just the loaded page: by the catalogue's
  // kind and genre, never the same title twice in a row. «Ещё случайный» on the card goes on
  // without piling up history, so «Назад» still leads back to the list.
  let randomSession = null;
  const RANDOM_GENRES = ["комедия", "боевик", "драма", "фантастика", "триллер", "ужасы", "мелодрама", "детектив", "криминал", "приключения", "мультфильм"];
  function randomGenreIds(kind, genre) {
    if (!genre) return [];
    const valid = kind === "movie" ? TMDB_MOVIE_GENRE_IDS : TMDB_TV_GENRE_IDS;
    const ids = Object.entries(TMDB_GENRES).filter(([id, name]) => name === genre && valid.has(Number(id))).map(([id]) => id);
    if (genre === "мультфильм") ids.push("16");
    return [...new Set(ids)];
  }
  async function pickRandomTitle(session) {
    const kinds = session.type === "movie" ? ["movie"] : session.type === "tv" ? ["tv"] : ["movie", "tv"];
    const seen = new Set(session.seen);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const params = new URLSearchParams({ language: "ru-RU", include_adult: "false", sort_by: "popularity.desc", "vote_count.gte": kind === "movie" ? "300" : "100" });
      if (session.type === "anime") {
        params.set("with_genres", "16");
        params.set(kind === "tv" ? "with_origin_country" : "with_original_language", kind === "tv" ? "JP" : "ja");
      } else {
        const ids = randomGenreIds(kind, session.genre);
        if (session.genre && !ids.length) continue;
        if (ids.length) params.set("with_genres", ids.join("|"));
      }
      const first = await cvTmdb(`discover/${kind}?${params}&page=1`, 10000);
      const pages = Math.max(1, Math.min(Number(first?.total_pages || 1), 100));
      const page = 1 + Math.floor(Math.random() * pages);
      const json = page === 1 ? first : await cvTmdb(`discover/${kind}?${params}&page=${page}`, 10000).catch(() => first);
      const fresh = tmdbListItems(json, kind).filter((entry) => entry.posterImage && !seen.has(entry.id) && (session.type === "anime" || !entry.isAnime || session.genre === "мультфильм" || session.type === "all"));
      if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
    }
    return null;
  }
  async function openRandomTitle({ replace = true } = {}) {
    if (!randomSession) return;
    let item = null;
    try { item = await pickRandomTitle(randomSession); } catch {}
    if (!item) {
      $(".random-toast")?.remove();
      app.insertAdjacentHTML("beforeend", `<div class="toast random-toast" role="status"><strong>Ничего нового не нашлось</strong><span>Измените тип или жанр и попробуйте ещё раз.</span></div>`);
      window.setTimeout(() => $(".random-toast")?.remove(), 3500);
      const next = $("[data-random-next]");
      if (next) { next.disabled = false; next.querySelector("span").textContent = "Ещё случайный"; }
      return;
    }
    rememberLooseTitles([item]);
    randomSession.seen = [...randomSession.seen, item.id].slice(-200);
    randomSession.currentId = item.id;
    if (!replace) { openTitleRoute(item.id); return; }
    const previous = window.history.state || {};
    const route = { type: "title", id: item.id };
    window.history.replaceState(routeHistoryState(route, 0, { returnView: previous.returnView || "catalog", hasPreviousView: Boolean(previous.hasPreviousView) }), "", routeForTitle(item.id));
    renderRoute(route);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function randomBarMarkup(item) {
    if (!randomSession || randomSession.currentId !== item.id) return "";
    const types = [["all", "Всё"], ["movie", "Фильмы"], ["tv", "Сериалы"], ["anime", "Аниме"]];
    const genres = randomSession.type === "anime" ? [] : [["", "Любой жанр"], ...RANDOM_GENRES.map((genre) => [genre, genre[0].toUpperCase() + genre.slice(1)])];
    return `<section class="random-bar" aria-label="Случайный выбор"><div class="random-bar-head"><span class="random-bar-title">${uiIcon("dice")}Случайный выбор</span><button class="primary-button random-bar-next" type="button" data-random-next>${uiIcon("dice")}<span>Ещё случайный</span></button></div><div class="random-bar-chips">${types.map(([value, label]) => `<button class="genre-pill${randomSession.type === value ? " is-active" : ""}" type="button" data-random-type="${value}">${label}</button>`).join("")}</div>${genres.length ? `<div class="random-bar-chips">${genres.map(([value, label]) => `<button class="genre-pill${randomSession.genre === value ? " is-active" : ""}" type="button" data-random-genre="${escapeHtml(value)}">${escapeHtml(label)}</button>`).join("")}</div>` : ""}</section>`;
  }

  function openTitleRoute(id, { recommendation = false, trigger: clicked = null } = {}) {
    const item = getTitle(id);
    if (!item) return;
    rememberTasteInteraction(item, recommendation ? "recommendation_opened" : "opened");
    hideSearchSuggestions();
    const returnView = ROUTE_PATHS[state.view] ? state.view : "catalog";
    updateCurrentHistoryScroll();
    const trigger = clicked || [...document.querySelectorAll("[data-open-title]")]
      .find((element) => element.dataset.openTitle === item.id);
    const triggerOffset = trigger?.getBoundingClientRect().top;
    window.history.replaceState(
      {
        ...(window.history.state || {}),
        catalogAnchorId: item.id,
        catalogAnchorOffset: Number.isFinite(triggerOffset) ? triggerOffset : null,
      },
      "",
      window.location.href,
    );
    const route = { type: "title", id: item.id };
    window.history.pushState(
      routeHistoryState(route, 0, { returnView, hasPreviousView: true }),
      "",
      routeForTitle(item.id),
    );
    withPosterTransition(clicked, () => renderRoute(route));
  }

  function returnFromDetails() {
    const historyState = window.history.state || {};
    if (historyState.hasPreviousView) {
      window.history.back();
      return;
    }
    navigateToView(historyState.returnView || "catalog", { replace: true });
  }

  function shouldHandleLink(event, target) {
    return !(target instanceof HTMLAnchorElement) || (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey);
  }

  // Navigation is static on the shell but some view buttons are rendered into
  // #page. Delegate once so both variants keep working after every render and
  // on touch devices without accumulating duplicate listeners.
  app.addEventListener("click", (event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const detailLink = element.closest("[data-open-title]");
    if (detailLink && app.contains(detailLink) && shouldHandleLink(event, detailLink)) {
      event.preventDefault();
      openTitleRoute(detailLink.dataset.openTitle, { trigger: detailLink });
      return;
    }
    const personLink = element.closest("[data-open-person]");
    if (personLink && app.contains(personLink) && shouldHandleLink(event, personLink)) {
      event.preventDefault();
      updateCurrentHistoryScroll();
      const route = { type: "person", id: personLink.dataset.openPerson };
      window.history.pushState(routeHistoryState(route, 0, { hasPreviousView: true }), "", routeForPerson(route.id));
      renderRoute(route);
      return;
    }
    const backLink = element.closest("[data-back-from-detail]");
    if (backLink && app.contains(backLink) && shouldHandleLink(event, backLink)) {
      event.preventDefault();
      returnFromDetails();
      return;
    }
    const target = element.closest("[data-view]");
    if (!target || !app.contains(target) || !shouldHandleLink(event, target)) return;
    event.preventDefault();
    const nextView = String(target.dataset.view || "").trim();
    if (nextView) {
      const leftPlayer = closeOpenPlayer({ leavingToView: true });
      if (nextView !== state.view) resetCatalogPage();
      navigateToView(nextView, { replace: leftPlayer });
    }
  });

  app.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-random-next], [data-random-type], [data-random-genre]") : null;
    if (!target || !randomSession) return;
    if (target.dataset.randomType !== undefined) { randomSession.type = target.dataset.randomType; if (randomSession.type === "anime") randomSession.genre = ""; }
    if (target.dataset.randomGenre !== undefined) randomSession.genre = target.dataset.randomGenre;
    const next = $("[data-random-next]");
    if (next) { next.disabled = true; next.querySelector("span").textContent = "Подбираю…"; }
    openRandomTitle({ replace: true });
  });

  app.addEventListener("click", (event) => {
    const retry = event.target instanceof Element ? event.target.closest("[data-retry-title]") : null;
    if (!retry) return;
    const item = getTitle(retry.dataset.retryTitle);
    if (!item) return;
    item.detailFailed = false;
    renderDetails(item.id);
    loadTmdbTitle(item.id).then(() => { if (activeTitleId === item.id) renderDetails(item.id); })
      .catch(() => { item.detailFailed = true; if (activeTitleId === item.id) renderDetails(item.id); });
  });

  app.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-catalog-retry]") : null;
    if (!target || !app.contains(target)) return;
    loadRemoteCatalogPage(Number(state.catalogPage) || 1);
  });

  window.addEventListener("popstate", () => {
    if (ignoreNextPopstate) { ignoreNextPopstate = false; return; }
    if (closeOpenPlayer()) return;
    renderRoute(readRouteFromLocation(), { restoreScroll: true });
  });

  async function loadImportedCatalog() {
    // Get the first useful page before starting optional feeds. Concurrent
    // 100 KB–1.5 MB responses contend for SQLite, CPU and bandwidth on the
    // small home server, turning a ~1 second page request into 5–10 seconds.
    await loadRemoteCatalogPage(Number(state.catalogPage) || 1, { initial: true });
    const refreshHome = () => {
      if (initialCatalogReady && state.view === "home" && !activeTitleId) { renderHome(); hydrateLazyPosters(); }
    };
    window.setTimeout(() => {
      void (async () => {
        await Promise.all([loadRemoteCatalogFacets(), loadTrendingCatalog()]);
        refreshHome();
        await loadSavedTitlesCatalog();
        refreshHome();
        await loadRemoteFreshCatalog();
        refreshHome();
        await Promise.all([loadAudienceCatalog(), loadUpcomingCatalog()]);
        refreshHome();
        await loadRemoteDiscoveryCatalog();
        refreshHome();
        // Optional external signal must never delay the catalogue or local feeds.
        loadWorldTrendingCatalog().then(refreshHome);
      })();
    }, 0);
  }

  // Taste is built from everything the viewer saved or watched, including
  // titles that are in none of the lists loaded for this page.
  async function loadSavedTitlesCatalog() {
    const progressIds = Object.entries(state.progress || {}).map(([key, record]) => record?.titleId || String(key).replace(/-s\d+e\d+$|-alt$|-embed$/, ""));
    const allIds = displayTitleIds([...state.favorites, ...state.history, ...state.watchlist, ...progressIds].map(String)).slice(0, 120);
    const tmdbIds = allIds.filter((id) => parseTmdbItemId(id));
    const ids = allIds.filter((id) => !parseTmdbItemId(id)).slice(0, 100);
    const loaded = (await Promise.all(tmdbIds.map((id) => loadTmdbTitle(id).catch(() => null)))).filter(Boolean);
    for (let start = 0; start < ids.length; start += 50) {
      try {
        const params = new URLSearchParams({ ids: ids.slice(start, start + 50).join(","), limit: "50" });
        const response = await apiFetch(`/api/catalog?${params}`, { cache: "no-store", headers: { accept: "application/json" } });
        if (!response.ok) continue;
        const payload = await response.json();
        if (Array.isArray(payload.items)) loaded.push(...payload.items);
      } catch {}
    }
    savedTitlesCatalog = loaded;
  }

  async function loadAudienceCatalog() {
    try {
      const response = await apiFetch("/api/catalog?collection=audience&sort=audience&limit=50", { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload.items)) audienceCatalog = payload.items;
    } catch {}
  }

  async function loadUpcomingCatalog() {
    try {
      const response = await apiFetch('/api/catalog?collection=upcoming&limit=30', { cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload.items)) upcomingCatalog = payload.items;
    } catch { /* Keep the last successful result. */ }
  }

  let worldTrendingFile = null;
  function ensureWorldTrending() {
    worldTrendingFile ||= (async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), WORLD_TRENDING_FILE_TIMEOUT_MS);
      try {
        const response = await fetch("/data/world_trending.json", { headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) return false;
        const payload = await response.json();
        const movies = Array.isArray(payload.movies) ? payload.movies : [];
        const series = Array.isArray(payload.series) ? payload.series : [];
        const merged = [];
        for (let index = 0; index < Math.max(movies.length, series.length); index += 1) {
          if (movies[index]) merged.push(movies[index]);
          if (series[index]) merged.push(series[index]);
        }
        worldTrendingCatalog = merged;
        return merged.length > 0;
      } catch {
        return false;
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return worldTrendingFile;
  }

  // Going back to a list or a filter already seen shows it at once.
  const catalogListCache = new Map();
  function catalogListCacheable() {
    return ["catalog", "movies", "series", "upcoming", "evening"].includes(state.view);
  }
  function rememberCatalogList(key) {
    catalogListCache.delete(key);
    catalogListCache.set(key, { at: Date.now(), catalog, remote: { page: remoteCatalog.page, pages: remoteCatalog.pages, total: remoteCatalog.total } });
    if (catalogListCache.size > CATALOG_LIST_CACHE_SIZE) catalogListCache.delete(catalogListCache.keys().next().value);
  }

  function catalogListKey() {
    return JSON.stringify([state.view, state.query, state.catalogGenre, state.catalogCollection, state.catalogSort, state.catalogMoodOnly, state.catalogPlayableOnly, state.view === "upcoming" ? state.upcomingSort || "await" : ""]);
  }

  async function loadWorldTrendingCatalog() {
    if (await ensureWorldTrending()) return;
    if (!tmdbCredential) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
      const headers = { accept: "application/json" };
      const requests = [1, 2, 3, 4, 5].map(async (page) => {
        const url = new URL(`${TMDB_API_BASE}/trending/all/week`);
        url.searchParams.set("page", String(page));
        if (tmdbCredential.startsWith("eyJ")) headers.Authorization = `Bearer ${tmdbCredential}`;
        else url.searchParams.set("api_key", tmdbCredential);
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`TMDB ${response.status}`);
        return response.json();
      });
      const pages = await Promise.all(requests);
      const records = pages.flatMap((page) => Array.isArray(page.results) ? page.results : [])
        .filter((item) => (item.media_type === "movie" || item.media_type === "tv") && Number.isInteger(item.id));
      if (!records.length) return;
      const groups = [records.slice(0, 50), records.slice(50, 100)].filter((group) => group.length);
      const payloads = await Promise.all(groups.map(async (group) => {
        const params = new URLSearchParams({ tmdb_ids: group.map((item) => item.id).join(","), limit: "50" });
        const response = await apiFetch(`/api/catalog?${params}`, { cache: "no-store", headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`Каталог ${response.status}`);
        return response.json();
      }));
      const lookup = new Map(payloads.flatMap((payload) => Array.isArray(payload.items) ? payload.items : []).map((item) => [`${item.kind}:${item.tmdbId}`, item]));
      const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
      const seen = new Set();
      worldTrendingCatalog = records.map((record) => lookup.get(`${record.media_type === "tv" ? "series" : "movie"}:${record.id}`))
        .filter((item) => item && item.posterImage && (!item.premiere || item.premiere <= today) && !seen.has(item.id) && seen.add(item.id));
    } catch {
      worldTrendingCatalog = [];
    } finally { window.clearTimeout(timer); }
  }

  async function loadRemoteDiscoveryCatalog() {
    try {
      // The home recommendations use at most 150 candidates; avoid shipping
      // the other 350 full records on every page load.
      const response = await apiFetch("/api/catalog/index?limit=150", { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) return;
      const payload = await response.json();
      if (!Array.isArray(payload.items)) return;
      discoveryCatalog = payload.items.map(withTitleOverrides);
    } catch {
      // The current catalogue page remains a useful fallback when the index is unavailable.
    }
  }

  async function loadTrendingCatalog() {
    try {
      const response = await apiFetch("/api/catalog?collection=trending&sort=popular&limit=50", { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload.items)) trendingCatalog = payload.items.map(withTitleOverrides);
    } catch {}
  }

  async function loadRemoteFreshCatalog() {
    try {
      const loadKind = async (kind) => {
        try {
          const response = await apiFetch(`/api/catalog?collection=new&type=${kind}&sort=new&limit=50`, { cache: "no-store", headers: { accept: "application/json" } });
          if (!response.ok) return [];
          const payload = await response.json();
          return Array.isArray(payload.items) ? payload.items : [];
        } catch { return []; }
      };
      const [movies, series] = await Promise.all([loadKind("movie"), loadKind("series")]);
      const balanced = [];
      for (let index = 0; index < Math.max(movies.length, series.length); index += 1) {
        if (movies[index]) balanced.push(movies[index]);
        if (series[index]) balanced.push(series[index]);
      }
      freshCatalog = balanced.map(withTitleOverrides);
    } catch {
      freshCatalog = [];
    }
  }

  async function ensureCatalogTitle(titleId) {
    const id = String(titleId || "").trim();
    if (!id) return null;
    if (parseTmdbItemId(id)) {
      const known = getTitle(id);
      if (known?.detailed) return known;
      try { return await loadTmdbTitle(id); } catch { return known || null; }
    }
    let item = getTitle(id);
    if (!item) {
      try {
        const params = new URLSearchParams({ ids: id, limit: "1" });
        const response = await apiFetch(`/api/catalog?${params}`, { cache: "no-store", headers: { accept: "application/json" } });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const loaded = Array.isArray(payload.items) ? payload.items[0] : null;
        if (loaded) {
          item = mergeCachedImportedDetails(loaded);
          rememberLooseTitles([item]);
        }
      } catch {}
    }
    if (item?.kinopoiskId) {
      await loadImportedTitleDetails(item);
      item = getTitle(id) || item;
    }
    return item || null;
  }

  async function loadRemoteCatalogPage(pageNumber = 1, { initial = false, quiet = false, append = false } = {}) {
    const requestId = ++remoteCatalogRequest;
    remoteCatalogController?.abort();
    const listKey = catalogListKey();
    if (!append && pageNumber === 1 && catalogListCacheable()) {
      const remembered = catalogListCache.get(listKey);
      if (remembered && Date.now() - remembered.at < CATALOG_LIST_CACHE_MS) {
        catalog = remembered.catalog;
        remoteCatalog = { ...remembered.remote, facets: remoteCatalog.facets };
        state.catalogPage = remembered.remote.page;
        remoteCatalogLoading = false;
        remoteCatalogError = false;
        loadedCatalogKey = listKey;
        if (initial || state.view !== "home") render();
        return;
      }
    }
    try {
      // «Избранное»: the last added first.
      const savedIds = state.view === "favorites" ? displayTitleIds([...state.favorites].reverse()) : state.view === "history" ? displayTitleIds(state.history) : null;
      if (savedIds && !savedIds.length) {
        catalog = [];
        remoteCatalog = { page: 1, pages: 1, total: 0, facets: remoteCatalog.facets };
        remoteCatalogLoading = false;
        if (initial || state.view !== "home") render();
        return;
      }
      if (lampacOrigin() && !savedIds && !state.query && ["catalog", "movies", "series", "upcoming"].includes(state.view)) {
        // The catalogue as Lampa's sections: TMDB discover by kind, genre and sort.
        remoteCatalogLoading = true;
        remoteCatalogError = false;
        if (!initial && !quiet && catalog.length) renderCatalogView();
        const kinds = state.view === "movies" || state.view === "upcoming" ? ["movie"] : state.view === "series" ? ["tv"] : ["movie", "tv"];
        const answers = await Promise.all(kinds.map((kind) => cvTmdb(tmdbDiscoverPath(kind, pageNumber), 12000).catch(() => null)));
        if (requestId !== remoteCatalogRequest) return;
        const lists = answers.map((json, index) => tmdbListItems(json, kinds[index]));
        const found = [];
        for (let index = 0; index < Math.max(0, ...lists.map((list) => list.length)); index += 1) lists.forEach((list) => { if (list[index]) found.push(list[index]); });
        rememberLooseTitles(found);
        const base = append ? catalog : [];
        catalog = [...new Map([...base, ...found].map((entry) => [entry.id, entry])).values()];
        loadedCatalogKey = catalogListKey();
        // TMDB serves up to 500 pages of a list: the catalogue keeps loading while there are any.
        const pages = Math.min(500, Math.max(1, ...answers.map((json) => Number(json?.total_pages || 1))));
        remoteCatalog = { page: pageNumber, pages, total: answers.reduce((sum, json) => sum + Number(json?.total_results || 0), 0), facets: remoteCatalog.facets };
        state.catalogPage = pageNumber;
        remoteCatalogLoading = false;
        if (!append && (initial || state.view !== "home")) render();
        // A next page is appended by loadMoreCatalog in portions; a full render would rebuild every card.
        return;
      }
      if (lampacOrigin() && state.query && !savedIds) {
        // Full search on TMDB, page by page, as Lampa does.
        remoteCatalogLoading = true;
        remoteCatalogError = false;
        if (!initial && !quiet && catalog.length) renderCatalogView();
        const json = await tmdbSearchMulti(state.query, pageNumber, 12000);
        if (requestId !== remoteCatalogRequest) return;
        const wanted = state.view === "movies" ? "movie" : state.view === "series" ? "series" : "";
        const found = tmdbListItems(json).filter((entry) => !wanted || entry.kind === wanted);
        rememberLooseTitles(found);
        const base = append ? catalog : [];
        catalog = [...new Map([...base, ...found].map((entry) => [entry.id, entry])).values()];
        loadedCatalogKey = catalogListKey();
        remoteCatalog = { page: Number(json.page || pageNumber), pages: Math.min(Number(json.total_pages || 1), 20), total: Number(json.total_results || found.length), facets: remoteCatalog.facets };
        state.catalogPage = remoteCatalog.page;
        remoteCatalogLoading = false;
        if (!append && (initial || state.view !== "home")) render();
        // A next page is appended by loadMoreCatalog in portions; a full render would rebuild every card.
        return;
      }
      const params = new URLSearchParams({ page: String(pageNumber), limit: "50", sort: state.catalogSort === "year" ? "fresh" : state.catalogSort || "now" });
      if (state.query) params.set("search", state.query);
      if (savedIds) params.set("ids", savedIds.join(","));
      if (state.catalogGenre) params.set("genre", state.catalogGenre);
      if (state.view === "movies" || state.view === "series") params.set("type", state.view === "movies" ? "movie" : "series");
      if (state.catalogCollection) params.set("collection", state.catalogCollection);
      else if (state.view === "upcoming") {
        params.set("collection", "upcoming");
        if (state.upcomingSort === "soon") params.set("sort", "soon");
      }
      remoteCatalogLoading = true;
      remoteCatalogError = false;
      // Paging keeps the current cards on screen (dimmed) until the next
      // page arrives instead of re-rendering mid-load.
      if (!initial && !quiet && catalog.length) renderCatalogView();
      const controller = new AbortController();
      remoteCatalogController = controller;
      const timeout = window.setTimeout(() => controller.abort(), CATALOG_REQUEST_TIMEOUT_MS);
      const slowHint = window.setTimeout(() => {
        const shell = $(".catalog-loading-shell");
        if (shell && !shell.querySelector("[data-catalog-slow]")) shell.insertAdjacentHTML("beforeend", `<p data-catalog-slow>Сервер долго не отвечает. Если включён VPN, стоит сменить страну или отключить его.</p>`);
      }, CATALOG_SLOW_HINT_MS);
      let response;
      try {
        const early = takeCatalogPrefetch(`/api/catalog?${params}`);
        response = (early && await early) || await apiFetch(`/api/catalog?${params}`, { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
      } finally {
        window.clearTimeout(timeout);
        window.clearTimeout(slowHint);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (requestId !== remoteCatalogRequest) return;
      const imported = payload.items;
      if (!Array.isArray(imported)) throw new Error("Invalid catalog response");
      const incoming = imported.map((entry) => {
        const isImportedDesperateHousewives = Number(entry.catalogId || 0) === 2205 || Number(entry.kinopoiskId || 0) === 160958;
        const prepared = isImportedDesperateHousewives ? { ...entry, posterImage: importedDesperateHousewives.posterImage, episodePosterUrls: importedDesperateHousewives.episodePosterUrls } : entry;
        return mergeCachedImportedDetails(prepared);
      });
      let fresh = incoming;
      if (savedIds) {
        // Saved TMDB cards are not in the server catalogue: load them here and keep the saved order.
        const tmdbItems = (await Promise.all(savedIds.filter((id) => parseTmdbItemId(id)).slice(0, 60).map((id) => {
          const known = getTitle(id);
          return known?.source === "tmdb" ? Promise.resolve(known) : loadTmdbTitle(id).catch(() => null);
        }))).filter(Boolean);
        if (requestId !== remoteCatalogRequest) return;
        const order = new Map(savedIds.map((id, index) => [String(id), index]));
        fresh = [...incoming, ...tmdbItems].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
        payload.total = Number(payload.total || 0) + tmdbItems.length;
      }
      // The list follows the chosen sort only; «what people watch now» lives on the home page.
      const base = append ? catalog : [];
      catalog = [...new Map([...base, ...fresh].map((entry) => [entry.id, entry])).values()];
      loadedCatalogKey = catalogListKey();
      remoteCatalog = { page: payload.page, pages: payload.pages, total: payload.total, facets: remoteCatalog.facets };
      state.catalogPage = payload.page;
      remoteCatalogLoading = false;
      remoteCatalogError = false;
      applyPosterOverrides();
      if (catalogListCacheable()) rememberCatalogList(listKey);
      if (!append && (initial || state.view !== "home")) render();
    } catch (error) {
      if (requestId !== remoteCatalogRequest) return;
      remoteCatalogLoading = false;
      remoteCatalogError = true;
      if (!append && (initial || state.view !== "home")) render();
      scheduleCatalogRecovery();
    }
  }

  // Once the server answers again, a full reload also restores the home feeds
  // that failed together with the catalogue.
  let catalogRecoveryTimer = 0;
  function scheduleCatalogRecovery() {
    if (catalogRecoveryTimer || catalog.length) return;
    catalogRecoveryTimer = window.setTimeout(async () => {
      catalogRecoveryTimer = 0;
      try {
        const response = await apiFetch("/api/health", { cache: "no-store" });
        // The server is back: ask again in place instead of reloading the whole page.
        if (response.ok) { loadRemoteCatalogPage(Number(state.catalogPage) || 1, { quiet: true }); return; }
      } catch {}
      scheduleCatalogRecovery();
    }, CATALOG_RECOVERY_INTERVAL_MS);
  }
  // Genre counts depend on the tab: "Фильмы" and "Сериалы" count only their kind.
  const facetsByKind = new Map();
  for (const kind of ["", "movie", "series"]) {
    try {
      const saved = JSON.parse(localStorage.getItem(`${FACETS_STORAGE_KEY}:${kind}`) || "null");
      if (saved) facetsByKind.set(kind, saved);
    } catch {}
  }
  function facetsKind() { return state.view === "movies" ? "movie" : state.view === "series" ? "series" : ""; }
  function currentFacets() { return facetsByKind.get(facetsKind()) || null; }
  async function loadRemoteCatalogFacets(kind = facetsKind()) {
    try {
      const query = kind ? `?type=${encodeURIComponent(kind)}` : "";
      const response = await apiFetch(`/api/catalog/facets${query}`, { cache: "no-store", headers: { accept: "application/json" } });
      if (response.ok) {
        facetsByKind.set(kind, await response.json());
        if (!kind) remoteCatalog.facets = facetsByKind.get("");
        try { localStorage.setItem(`${FACETS_STORAGE_KEY}:${kind}`, JSON.stringify(facetsByKind.get(kind))); } catch {}
      }
    } catch {}
    if (kind !== facetsKind()) return;
    const route = readRouteFromLocation();
    if (route.type === "view" && ["catalog", "movies", "series", "evening"].includes(route.view)) {
      const genreList = $(".genre-list");
      if (genreList) genreList.innerHTML = catalogGenreButtonsMarkup(catalogGenreOptions());
    }
  }

  function mergeCachedImportedDetails(item) {
    const kinopoiskId = String(item?.kinopoiskId || item?.kinopoisk_id || "").trim();
    const details = kinopoiskId ? importedDetailsCache.get(kinopoiskId) : null;
    return details ? { ...details, ...item } : item;
  }

  async function loadImportedTitleDetails(item) {
    const kinopoiskId = String(item?.kinopoiskId || "").trim();
    if (!kinopoiskId) return;
    const cachedDetails = importedDetailsCache.get(kinopoiskId);
    if (cachedDetails) {
      Object.assign(item, cachedDetails, item);
      importedDetailsLoaded.add(kinopoiskId);
      return;
    }
    if (importedDetailsLoaded.has(kinopoiskId) || importedDetailsLoading.has(kinopoiskId)) return;
    importedDetailsLoading.add(kinopoiskId);
    try {
      const response = await apiFetch(`/api/catalog/imported/${encodeURIComponent(kinopoiskId)}`, { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const details = await response.json();
      importedDetailsCache.set(kinopoiskId, details);
      catalog = catalog.map((entry) => entry.id === item.id ? { ...details, ...entry } : entry);
      discoveryCatalog = discoveryCatalog.map((entry) => entry.id === item.id ? { ...details, ...entry } : entry);
      upcomingCatalog = upcomingCatalog.map((entry) => entry.id === item.id ? { ...details, ...entry } : entry);
      looseTitles = looseTitles.map((entry) => entry.id === item.id ? { ...details, ...entry } : entry);
      importedDetailsLoaded.add(kinopoiskId);
      if (activeTitleId === item.id) renderDetails(item.id);
    } catch {
      // Keep the lightweight card usable if the full source payload is unavailable.
    } finally {
      importedDetailsLoading.delete(kinopoiskId);
    }
  }

  function loadState() {
    try {
      const loaded = { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
      // Filters describe a temporary catalogue visit. Never restore an old
      // genre/search into a new session or into unrelated routes such as Home.
      loaded.query = "";
      loaded.catalogGenre = "";
      loaded.catalogCollection = "";
      loaded.catalogPage = 1;
      // Interest: ratings gathered per year of the title's life.
      loaded.catalogSort = "now";
      loaded.catalogPage = 1;
      // These legacy filters are intentionally no longer part of the catalog UI.
      loaded.catalogMoodOnly = false;
      loaded.catalogPlayableOnly = false;
      if (loaded.catalogCollection === "mood") loaded.catalogCollection = "";
      return loaded;
    } catch { return { ...defaultState, catalogMoodOnly: false, catalogPlayableOnly: false }; }
  }

  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); scheduleAccountPush(); }

  // Favourites, watchlist, history and "continue watching" follow the account across devices.
  // The server merges what each device sends; the newer record wins and removals are kept as marks.
  function accountSyncPayload() {
    const now = Date.now();
    const marks = state.savedMarks && typeof state.savedMarks === "object" ? state.savedMarks : {};
    const payload = { history: {}, progress: state.progress || {}, historyRemoved: state.historyRemoved || {} };
    ["favorites", "watchlist", "subscriptions"].forEach((name) => {
      const current = new Set((state[name] || []).map(String));
      const list = { ...(marks[name] || {}) };
      current.forEach((id) => { if (!list[id]?.on) list[id] = { on: true, at: now }; });
      Object.keys(list).forEach((id) => { if (list[id].on && !current.has(id)) list[id] = { on: false, at: now }; });
      payload[name] = list;
    });
    state.savedMarks = { favorites: payload.favorites, watchlist: payload.watchlist, subscriptions: payload.subscriptions };
    const seen = state.historyAt && typeof state.historyAt === "object" ? state.historyAt : {};
    (state.history || []).forEach((id, index, list) => { payload.history[id] = Number(seen[id]) || list.length - index; });
    return payload;
  }
  function applyAccountState(merged) {
    const ordered = (marks) => Object.entries(marks || {}).filter(([, mark]) => mark?.on).sort((a, b) => a[1].at - b[1].at).map(([id]) => id);
    state.savedMarks = { favorites: merged.favorites || {}, watchlist: merged.watchlist || {}, subscriptions: merged.subscriptions || {} };
    state.favorites = ordered(merged.favorites);
    state.subscriptions = ordered(merged.subscriptions);
    state.watchlist = ordered(merged.watchlist);
    state.historyRemoved = merged.historyRemoved || state.historyRemoved || {};
    state.historyAt = merged.history || {};
    state.history = Object.entries(state.historyAt).sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 100);
    state.progress = merged.progress || {};
  }
  // Points the account saved from players (before this sync existed, or on the apps) join "continue watching".
  async function importAccountProgress(accounts) {
    try {
      const { entries = [], contexts = [] } = await accounts.api("history");
      const solo = new Set(contexts.filter((context) => context.kind === "solo").map((context) => context.id));
      entries.filter((entry) => solo.has(entry.context_id) && String(entry.edition || "").startsWith("alloha:")).reverse().forEach((entry) => {
        const key = `${entry.title_id}-alt`;
        const at = Number(entry.updated_at || 0) * 1000;
        if ((state.progress[key]?.updatedAt || 0) >= at) return;
        if (Number(state.historyRemoved?.[entry.title_id] || 0) >= at) return;
        state.progress[key] = { titleId: entry.title_id, providerId: entry.edition, player: "alternative", translationId: String(entry.edition).replace(/^alloha:/, ""),
          seasonNumber: entry.season || null, episodeNumber: entry.episode || null, position: Number(entry.position || 0), duration: Number(entry.duration || 0), completed: Boolean(entry.completed), updatedAt: at };
        state.history = [entry.title_id, ...state.history.filter((id) => id !== entry.title_id)].slice(0, 100);
        state.historyAt = { ...(state.historyAt || {}), [entry.title_id]: Math.max(Number(state.historyAt?.[entry.title_id]) || 0, at) };
      });
    } catch { /* history is a bonus: the site state still syncs */ }
  }
  async function syncAccountState() {
    const accounts = window.CineVaultAccounts;
    const user = accounts?.user;
    if (!user || isShowcase() || accountSyncUser === user.id) return;
    accountSyncUser = user.id;
    try {
      // Another account used this browser before: its list must not leak into this one.
      const foreign = state.syncedAccount && state.syncedAccount !== user.id;
      if (foreign) { state.favorites = []; state.watchlist = []; state.subscriptions = []; state.history = []; state.historyAt = {}; state.historyRemoved = {}; state.progress = {}; state.savedMarks = {}; }
      await importAccountProgress(accounts);
      const { state: merged } = await accounts.api("site-state", { state: accountSyncPayload() });
      applyAccountState(merged);
      state.syncedAccount = user.id;
      accountPushedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (activeTitleId) renderDetails(activeTitleId);
      else render();
      // Records synced from other devices may still name Kinopoisk cards.
      migrateLegacyTitles();
    } catch { accountSyncUser = ""; }
  }
  function pushAccountState(keepalive = false) {
    window.clearTimeout(accountPushTimer);
    accountPushTimer = 0;
    const accounts = window.CineVaultAccounts;
    if (!accounts?.user || accounts.user.id !== accountSyncUser || state.syncedAccount !== accountSyncUser || isShowcase()) return;
    accountPushedAt = Date.now();
    const headers = { "Content-Type": "application/json", accept: "application/json", "X-CineVault-CSRF": accounts.csrf || "" };
    if (viewerToken) headers.Authorization = `Bearer ${viewerToken}`;
    fetch("/api/account/site-state", { method: "POST", headers, credentials: "same-origin", keepalive, body: JSON.stringify({ state: accountSyncPayload() }) }).catch(() => {});
  }
  function scheduleAccountPush() {
    if (!accountSyncUser || accountPushTimer) return;
    accountPushTimer = window.setTimeout(() => pushAccountState(), Math.max(1000, ACCOUNT_PUSH_GAP_MS - (Date.now() - accountPushedAt)));
  }
  window.addEventListener("cinevault:account", (event) => { if (event.detail?.user) syncAccountState(); else accountSyncUser = ""; });
  window.addEventListener("pagehide", () => { if (accountPushTimer) pushAccountState(true); });
  window.setTimeout(() => window.CineVaultAccounts?.ready?.then(() => syncAccountState()), 0);

  // Watch progress belongs to this browser: "Продолжить просмотр" differs per device.
  async function loadCatalogProgress() {
    await loadProgressTitles();
  }

  async function loadProgressTitles() {
    const ids = [...new Set(Object.values(state.progress).filter((progress) => !progress?.completed).map((progress) => String(progress?.titleId || "")).filter(Boolean))]
      .filter((id) => !getTitle(id)).slice(0, 50);
    if (!ids.length) return;
    try {
      const params = new URLSearchParams({ ids: ids.join(","), limit: "50" });
      const response = await apiFetch(`/api/catalog?${params}`, { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload.items)) progressCatalog = payload.items.map(withTitleOverrides);
    } catch {}
  }
  function loadMetadataCache() { try { return JSON.parse(localStorage.getItem(TMDB_CACHE_KEY) || "{}"); } catch { return {}; } }
  function saveMetadataCache(cache) { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(cache)); }
  // Episode titles and stills of the one locally imported series; fetched only when it is in view.
  async function loadEpisodeAssets() {
    if (!catalog.some((entry) => Number(entry.catalogId || 0) === 2205)) { episodeAssetsLoading = false; return; }
    episodeAssetsLoading = true;
    try {
      const [metadataResponse, stillsResponse] = await Promise.all([
        fetch("./data/desperate_housewives_episodes.json", { cache: "no-store", headers: { accept: "application/json" } }),
        fetch("./data/desperate_housewives_tmdb_stills.json", { cache: "no-store", headers: { accept: "application/json" } }),
      ]);
      if (!metadataResponse.ok || !stillsResponse.ok) throw new Error(`HTTP ${metadataResponse.status}/${stillsResponse.status}`);
      const [rows, stillSeasons] = await Promise.all([metadataResponse.json(), stillsResponse.json()]);
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("Пустой список серий");
      const item = catalog.find((entry) => Number(entry.catalogId || 0) === 2205);
      if (!item) throw new Error("Сериал не найден");
      const episodePosterUrls = {};
      const episodeTitles = {};
      const episodeOriginalTitles = {};
      (Array.isArray(stillSeasons) ? stillSeasons : []).forEach((seasonData) => {
        const season = String(Number(seasonData.season));
        if (!episodePosterUrls[season]) episodePosterUrls[season] = {};
        (seasonData.episodes || []).forEach((episodeData) => {
          const episode = String(Number(episodeData.episode));
          const stillUrl = episodeData.still_url || (episodeData.still_path ? `${TMDB_IMAGE_BASE}${episodeData.still_path}` : "");
          if (stillUrl) episodePosterUrls[season][episode] = stillUrl;
        });
      });
      rows.forEach((row) => {
        const season = String(Number(row.season));
        const episode = String(Number(row.episode));
        if (!episodePosterUrls[season]) episodePosterUrls[season] = {};
        if (!episodeTitles[season]) episodeTitles[season] = {};
        if (!episodeOriginalTitles[season]) episodeOriginalTitles[season] = {};
        if (row.poster && !episodePosterUrls[season][episode]) episodePosterUrls[season][episode] = row.poster;
        if (row.title) episodeTitles[season][episode] = row.title;
        if (row.original_title) episodeOriginalTitles[season][episode] = row.original_title;
      });
      item.episodePosterUrls = episodePosterUrls;
      item.episodeTitles = { ...item.episodeTitles, ...episodeTitles };
      item.episodeOriginalTitles = episodeOriginalTitles;
      episodeAssetsError = "";
    } catch (error) {
      episodeAssetsError = "Не удалось загрузить изображения серий.";
    } finally {
      episodeAssetsLoading = false;
      episodeImagesLoading = true;
      if (activeTitleId) renderDetails(activeTitleId);
    }
  }
  function episodeAssetStateFor(item) {
    return episodeAssetStates[item.id] || { loading: false, error: "" };
  }
  async function loadOnlineEpisodeAssets(item) {
    // One attempt per title: a failed load must not start another on every redraw.
    if (item?.kind !== "series" || episodeAssetStates[item.id]) return;
    const assetState = episodeAssetStates[item.id] = { loading: true, error: "", loaded: false };
    if (item.source === "tmdb") return loadTmdbEpisodeAssets(item, assetState);
    try {
      const metadataFile = item.episodeDataFile || "";
      // Stills found on TMDB (tools/fill_episode_stills.py) beat the catalogue's own pictures, which are often of other titles.
      const stillsRequest = fetch(`/data/stills/${encodeURIComponent(item.id)}.json`, { headers: { accept: "application/json" } })
        .then((response) => response.ok ? response.json() : {}).catch(() => ({}));
      let localRows = [];
      if (metadataFile) {
        const metadataResponse = await fetch(metadataFile, { cache: "no-store", headers: { accept: "application/json" } }).catch(() => null);
        localRows = metadataResponse?.ok ? await metadataResponse.json().catch(() => []) : [];
      }
      const stills = await stillsRequest;
      const endpoint = item.episodeDataProvider === "tvmaze"
        ? `/api/catalog/title/tvmaze/series/${encodeURIComponent(item.tvmazeId)}`
        : "";
      let payload = null;
      if (endpoint) {
        try {
          let response = await fetch(endpoint, { cache: "no-store", headers: { accept: "application/json" } });
          payload = response.ok ? await response.json() : null;
          if (!payload) {
            response = await fetch(`https://api.tvmaze.com/shows/${encodeURIComponent(item.tvmazeId)}?embed=episodes`, { cache: "force-cache", headers: { accept: "application/json" } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            payload = await response.json();
          }
        } catch (error) {
          if (!Array.isArray(localRows) || !localRows.length) throw error;
        }
      }
      const episodes = payload?._embedded?.episodes;
      const backendEpisodes = payload?.seasons?.flatMap((season) => (season.episodes || []).map((episode) => ({ ...episode, season: season.number }))) || [];
      const sourceEpisodeMap = new Map();
      [...(Array.isArray(episodes) ? episodes : []), ...backendEpisodes, ...(Array.isArray(localRows) ? localRows : [])].forEach((episode) => {
        const key = `${Number(episode.season || 0)}-${Number(episode.number || episode.episode || 0)}`;
        if (key !== "0-0") sourceEpisodeMap.set(key, episode);
      });
      const sourceEpisodes = [...sourceEpisodeMap.values()];
      const episodeTitles = {};
      const episodeOriginalTitles = {};
      const episodePosterUrls = {};
      const allowEpisodePosters = item.episodePosterPolicy !== "series-poster";
      sourceEpisodes.forEach((episode) => {
        const season = String(Number(episode.season || 0));
        const number = String(Number(episode.number || episode.episode || 0));
        if (Number(season) < 1 || Number(number) < 1) return;
        if (!episodeTitles[season]) episodeTitles[season] = {};
        if (!episodeOriginalTitles[season]) episodeOriginalTitles[season] = {};
        if (!episodePosterUrls[season]) episodePosterUrls[season] = {};
        const title = episode.name || episode.title || "";
        if (title) episodeTitles[season][number] = title;
        if (episode.original_title) episodeOriginalTitles[season][number] = episode.original_title;
        else if (episode.name) episodeOriginalTitles[season][number] = episode.name;
        const image = episode.image?.original || episode.image?.medium || episode.image || episode.poster || "";
        if (image && allowEpisodePosters) episodePosterUrls[season][number] = image;
      });
      Object.entries(stills && typeof stills === "object" ? stills : {}).forEach(([season, episodes]) => {
        if (!episodes || typeof episodes !== "object") return;
        if (!episodePosterUrls[season]) episodePosterUrls[season] = {};
        Object.entries(episodes).forEach(([number, url]) => { if (/^https:\/\/image\.tmdb\.org\//.test(String(url))) episodePosterUrls[season][number] = url; });
      });
      if (sourceEpisodes.length) {
        item.episodeTitles = episodeTitles;
        item.episodeOriginalTitles = episodeOriginalTitles;
      }
      item.episodePosterUrls = episodePosterUrls;
      assetState.loaded = true;
    } catch (error) {
      assetState.error = "Не удалось загрузить список серий.";
    } finally {
      assetState.loading = false;
      if (activeTitleId === item.id) renderDetails(item.id);
    }
  }
  function librarySkipSegments(item, duration = 0) {
    const title = `${item.title || ""} ${item.original_title || item.originalTitle || ""}`.toLowerCase();
    if (!title.includes("отчаянные домохозяйки") && !title.includes("desperate housewives")) return [];
    const episode = Number(item.episode || 0);
    const preset = {
      18: { recapTo: 40, introFrom: 169, introTo: 208, creditsFrom: 2582 },
      19: { recapTo: 40, introFrom: 204, introTo: 243, creditsFrom: 2579 },
      20: { recapTo: 42, introFrom: 174, introTo: 222, creditsFrom: 2562 },
      21: { recapTo: 42, introFrom: 223, introTo: 268, creditsFrom: 2572 },
    }[episode] || { recapTo: 40, introFrom: 170, introTo: 220, creditsFrom: 0 };
    const segments = [
      { key: "recap", from: 0, to: preset.recapTo, label: "повтор прошлых событий", button: "Пропустить повтор", auto: true },
      { key: "intro", from: preset.introFrom, to: preset.introTo, label: "заставка и титры", button: "Пропустить заставку", auto: true },
    ];
    if (preset.creditsFrom && duration > preset.creditsFrom) segments.push({ key: "credits", from: preset.creditsFrom, to: duration, label: "финальные титры", button: "Пропустить титры", auto: false });
    return segments;
  }
  async function loadLibraryData(shouldRender = true) {
    try {
      const response = await apiFetch("/api/library", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      // Episode progress is kept in this browser, like the rest of the watch history.
      const localEpisodeProgress = state.episodeProgress || {};
      libraryEpisodes = (Array.isArray(payload.items) ? payload.items : []).map((item) => ({ ...item, progress: localEpisodeProgress[item.id] || null }));
      libraryHistory = libraryEpisodes.filter((item) => item.progress)
        .sort((a, b) => String(b.progress.updatedAt || "").localeCompare(String(a.progress.updatedAt || "")));
      mergeLibraryIntoCatalog();
      libraryStatus = `Общий backend-каталог: ${libraryEpisodes.length} ${libraryEpisodes.length === 1 ? "серия" : "серий"}.`;
    } catch (error) {
      libraryStatus = "Сервер медиатеки не подключён. Запусти media_library_server.py.";
    }
    if (shouldRender && typeof render === "function") render();
  }
  function mergeLibraryIntoCatalog() {
    const groups = new Map();
    let progressChanged = false;
    libraryEpisodes.forEach((episode) => {
      const key = episode.title_id || episode.metadata_external_id || episode.title;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(episode);
    });
    groups.forEach((episodes) => {
      const first = episodes[0];
      const externalId = String(first.metadata_external_id || first.metadata?.external_id || "");
      const titleNeedle = String(first.title || "").trim().toLowerCase();
      const originalNeedle = String(first.original_title || first.metadata?.original_title || "").trim().toLowerCase();
      const existing = catalog.find((entry) => (externalId && String(entry.tmdbId || "") === externalId) || (titleNeedle && [entry.title, entry.originalTitle].map((value) => String(value || "").trim().toLowerCase()).includes(titleNeedle)) || (originalNeedle && [entry.title, entry.originalTitle].map((value) => String(value || "").trim().toLowerCase()).includes(originalNeedle)));
      const isImportedDesperateHousewives = Number(existing?.catalogId || 0) === 2205;
      const metadataSeasons = Array.isArray(first.metadata?.seasons) ? first.metadata.seasons.map((season) => Number(season.episode_count || 0)) : [];
      const maxSeason = Math.max(1, ...episodes.map((episode) => Number(episode.season || 1)));
      const maxEpisode = Math.max(1, ...episodes.map((episode) => Number(episode.episode || 1)));
      const merged = {
        ...(existing || {}),
        id: existing?.id || `library-${first.title_id}`,
        kind: first.kind || existing?.kind || "series",
        title: first.title || existing?.title || "Без названия",
        originalTitle: first.original_title || first.metadata?.original_title || existing?.originalTitle || first.title,
        year: first.year || first.metadata?.year || existing?.year,
        description: isImportedDesperateHousewives ? existing.description : first.overview || first.metadata?.overview || existing?.description || "Описания пока нет.",
        posterImage: isImportedDesperateHousewives ? existing.posterImage : first.poster_url || first.metadata?.poster_url || existing?.posterImage || "",
        seasons: isImportedDesperateHousewives ? existing.seasons : metadataSeasons.length ? metadataSeasons : existing?.seasons?.length ? existing.seasons : Array.from({ length: maxSeason }, (_, index) => index === maxSeason - 1 ? maxEpisode : 1),
        tags: [...new Set([...(existing?.tags || []), "медиатека", "для нас"])],
        providerName: episodes.some((episode) => episode.source_type === "external_embed") ? "Внешний плеер" : "Lumo Film",
        providerNote: episodes.some((episode) => episode.source_type === "external_embed") ? "Видео открывается у источника." : "Видео хранится на сервере Lumo Film.",
        providerUrl: "",
        libraryEpisodes: episodes,
      };
      if (existing) catalog = catalog.map((entry) => entry.id === existing.id ? merged : entry);
      else catalog = [...catalog, merged];
      episodes.forEach((episode) => {
        if (!episode.progress) return;
        const contentId = `${merged.id}-s${episode.season || 1}e${episode.episode || 1}`;
        state.progress[contentId] = { titleId: merged.id, seasonNumber: episode.season || 1, episodeNumber: episode.episode || 1, position: episode.progress.position, duration: episode.progress.duration, completed: episode.progress.completed, updatedAt: Date.parse(episode.progress.updatedAt || "") || Date.now() };
        progressChanged = true;
      });
    });
    if (progressChanged) saveState();
  }
  function tmdbRequest(path, params = {}) {
    const url = new URL(`${TMDB_API_BASE}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const headers = { accept: "application/json" };
    if (tmdbCredential.split(".").length === 3 || tmdbCredential.length > 100) headers.Authorization = `Bearer ${tmdbCredential}`;
    else url.searchParams.set("api_key", tmdbCredential);
    return fetch(url, { headers }).then((response) => { if (!response.ok) throw new Error(`TMDB ${response.status}`); return response.json(); });
  }
  async function fetchTmdbDetails(item) {
    const searchPath = item.kind === "series" ? "/search/tv" : "/search/movie";
    const searchParams = { query: item.originalTitle, language: "ru-RU", include_adult: "false", page: "1" };
    if (item.kind === "movie") searchParams.year = String(item.year);
    const search = item.tmdbId ? { results: [{ id: item.tmdbId }] } : await tmdbRequest(searchPath, searchParams);
    const result = item.tmdbId ? search.results[0] : (search.results || []).find((entry) => {
      const releaseYear = Number(String(entry.release_date || entry.first_air_date || "").slice(0, 4));
      return !releaseYear || Math.abs(releaseYear - item.year) <= 1;
    }) || search.results?.[0];
    if (!result?.id) throw new Error(`TMDB title not found: ${item.originalTitle}`);
    const detailsPath = item.kind === "series" ? `/tv/${result.id}` : `/movie/${result.id}`;
    const details = await tmdbRequest(detailsPath, { language: "ru-RU", append_to_response: "videos" });
    const trailer = details.videos?.results?.find((video) => video.site === "YouTube" && video.type === "Trailer" && video.official) || details.videos?.results?.find((video) => video.site === "YouTube" && video.type === "Trailer");
    const seasons = item.kind === "series" ? details.seasons?.filter((season) => season.season_number > 0).map((season) => season.episode_count).filter((count) => count > 0) : item.seasons;
    return {
      tmdbId: details.id,
      description: details.overview || item.description,
      posterImage: details.poster_path ? `${TMDB_IMAGE_BASE}${details.poster_path}` : "",
      backdropImage: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : "",
      seasons: seasons?.length ? seasons : item.seasons,
      runtime: item.kind === "movie" ? (details.runtime || item.runtime) : (details.episode_run_time?.[0] || item.runtime),
      rating: Number(details.vote_average || result.vote_average || 0),
      trailerUrl: trailer?.key ? `https://www.youtube.com/watch?v=${trailer.key}` : ""
    };
  }
  async function syncCatalogFromTmdb() {
    if (!tmdbCredential || tmdbSyncStarted) return;
    tmdbSyncStarted = true;
    const cache = loadMetadataCache();
    let synced = 0;
    const results = [];
    const queue = [...seedCatalog];
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        try {
          const cached = cache[item.id];
          const update = cached || await fetchTmdbDetails(item);
          catalog = catalog.map((entry) => entry.id === item.id && !String(entry.providerName || "").startsWith("Kinopoisk") ? { ...entry, ...update } : entry);
          looseTitles = looseTitles.map((entry) => entry.id === item.id && !String(entry.providerName || "").startsWith("Kinopoisk") ? { ...entry, ...update } : entry);
          cache[item.id] = update;
          synced += 1;
          results.push({ status: "fulfilled" });
          scheduleCatalogRefresh();
        } catch (error) {
          results.push({ status: "rejected", reason: error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
    saveMetadataCache(cache);
    const failed = results.filter((result) => result.status === "rejected").length;
    tmdbStatus = failed ? `TMDB: загружено ${synced} из ${seedCatalog.length}, остальные оставлены локально` : `TMDB: постеры и данные обновлены (${synced})`;
    if (libraryEpisodes.length) mergeLibraryIntoCatalog();
    if (initialCatalogReady) render();
  }
  function hdrezkaResultMarkup(items) {
    if (!items.length) return `<p class="muted small">Ничего не найдено.</p>`;
    return `<div class="hdrezka-results">${items.map((item, index) => `<article class="hdrezka-result"><div><strong>${escapeHtml(item.title || "Без названия")}</strong><small>${escapeHtml([item.entity, item.year, item.genre].filter(Boolean).join(" · "))}</small></div><button class="secondary-button" data-hdrezka-probe="${index}" type="button">Проверить fixture</button></article>`).join("")}</div>`;
  }
  async function runHdrezkaSearch() {
    const input = $("#hdrezka-query");
    const feedback = $("#hdrezka-feedback");
    const results = $("#hdrezka-results");
    const query = input?.value?.trim() || "";
    if (!query) { feedback.textContent = "Введи название фильма или сериала."; results.innerHTML = ""; return; }
    feedback.textContent = "Ищу в локальном LegalDemoProvider…";
    results.innerHTML = "";
    try {
      const response = await apiFetch(`/api/hdrezka/search?q=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      feedback.textContent = `Найдено: ${payload.items.length}. Используются только локальные fixtures.`;
      results.innerHTML = hdrezkaResultMarkup(payload.items);
      bindHdrezkaProbeButtons(query);
    } catch (error) {
      feedback.textContent = `Тест не выполнен: ${error.message}`;
      results.innerHTML = "";
    }
  }
  function bindHdrezkaProbeButtons(query) {
    $$('[data-hdrezka-probe]').forEach((button) => button.addEventListener("click", async () => {
      const feedback = $("#hdrezka-feedback");
      feedback.textContent = "Проверяю локальный HLS-fixture…";
      try {
        const season = Math.max(1, Number($("#hdrezka-season")?.value || 1));
        const episode = Math.max(1, Number($("#hdrezka-episode")?.value || 1));
        const response = await apiFetch(`/api/hdrezka/probe?q=${encodeURIComponent(query)}&index=${button.dataset.hdrezkaProbe}&season=${season}&episode=${episode}`, { headers: { accept: "application/json" } });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        feedback.textContent = payload.has_player ? `Локальный тестовый поток найден${payload.kind === "series" ? ` для S${payload.season}E${payload.episode}` : ""}: ${payload.qualities.join(", ")}. Внешние ссылки не используются.` : "Локальный fixture не найден.";
      } catch (error) {
        feedback.textContent = `Проверка карточки не прошла: ${error.message}`;
      }
    }));
  }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
  // Small renditions for blurred placeholders and card grids.
  function previewImageUrl(value) {
    return String(value || "")
      .replace(/\/1344x756([?#].*)?$/i, "/678x380$1")
      .replace(/^(https?:\/\/avatars\.mds\.yandex\.net\/get-kinopoisk-image\/[^/]+\/[^/]+\/)(?:\d+x\d+|orig)([?#].*)?$/i, (_match, prefix, suffix = "") => `${prefix}300x450${suffix}`)
      .replace(/(image\.tmdb\.org\/t\/p\/|^\/tmdb\/t\/p\/)(?:w\d+|original)\//i, "$1w342/");
  }
  // Show a blurred small copy at once, then sharpen when the full image loads.
  const sharpBackgrounds = new Set();
  function progressiveBackground(element, property, fullUrl) {
    if (!element || !fullUrl) return;
    element._backgroundRequest = fullUrl;
    const apply = (url) => element.style.setProperty(property, `url('${url.replace(/'/g, "%27")}')`);
    if (sharpBackgrounds.has(fullUrl)) { apply(fullUrl); element.classList.add("is-sharp"); return; }
    const full = new Image();
    full.decoding = "async";
    full.onload = () => {
      sharpBackgrounds.add(fullUrl);
      element.dispatchEvent(new Event("cv:frame-settled"));
      if (element._backgroundRequest !== fullUrl) return;
      apply(fullUrl);
      element.classList.remove("is-blurred");
      element.classList.add("is-sharp");
    };
    // Browsers judge the first screen by the sharp frame (a small copy counts as small on
    // dense screens), so the sharp one is asked for at once and before anything else.
    full.fetchPriority = "high";
    full.onerror = () => element.dispatchEvent(new Event("cv:frame-settled"));
    full.src = fullUrl;
    element.classList.add("is-blurred");
  }
  // TMDB posters: the browser picks the size for the card's width and the screen's density
  // (sharp on Retina, light on phones); off-screen cards still load only when scrolled to.
  const TMDB_SIZED = /^(.*\/t\/p\/)(?:w\d+|original)(\/.+)$/;
  function tmdbPosterSrcset(url) {
    const match = String(url || "").match(TMDB_SIZED);
    if (!match) return "";
    return ` srcset="${escapeHtml(`${match[1]}w342${match[2]}`)} 342w, ${escapeHtml(`${match[1]}w500${match[2]}`)} 500w, ${escapeHtml(`${match[1]}w780${match[2]}`)} 780w" sizes="(max-width: 720px) 42vw, 230px"`;
  }
  function highResolutionPosterUrl(value) {
    return String(value || "").replace(
      /^(https?:\/\/avatars\.mds\.yandex\.net\/get-kinopoisk-image\/[^/]+\/[^/]+\/)\d+x\d+([?#].*)?$/i,
      (_match, prefix, suffix = "") => `${prefix}600x900${suffix}`,
    );
  }
  function removeAdminTokenFields(root = document) {
    $$('input[name="admin_token"], #library-admin-token', root).forEach((input) => {
      input.closest("label")?.remove();
    });
  }
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainingSeconds = total % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
      : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  function formatDuration(seconds) { return formatTime(seconds); }
  function restorePlaybackPosition(video, position, duration) {
    const target = Number(position || 0);
    if (!video || !Number.isFinite(target) || target <= 0) return false;
    const apply = () => {
      const mediaDuration = Number(video.duration || duration || 0);
      if (video.readyState < 1 || !mediaDuration) return;
      const safeTarget = Math.min(target, Math.max(0, mediaDuration - 0.25));
      if (Math.abs(Number(video.currentTime || 0) - safeTarget) > 0.25) video.currentTime = safeTarget;
    };
    apply();
    video.addEventListener("loadeddata", apply, { once: true });
    video.addEventListener("canplay", apply, { once: true });
    window.setTimeout(apply, 250);
    return true;
  }
  const resumeProtectionAt = new WeakMap();
  function protectResumePosition(video, position, duration) {
    const saved = Number(position || 0);
    if (!video || video.seeking || saved < 5 || Number(video.currentTime || 0) >= 1) return false;
    const lastAttempt = Number(resumeProtectionAt.get(video) || 0);
    if (Date.now() - lastAttempt < 500) return true;
    resumeProtectionAt.set(video, Date.now());
    restorePlaybackPosition(video, saved, duration);
    return true;
  }
  function bindSeekTimePreview(range, rangeWrap) {
    const preview = rangeWrap?.querySelector(".player-seek-time");
    if (!range || !rangeWrap || !preview) return;
    let hideTimer = null;
    const update = () => {
      const maximum = Number(range.max);
      const value = Number(range.value);
      const ratio = Number.isFinite(maximum) && maximum > 0 && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value / maximum))
        : 0;
      preview.textContent = formatTime(value);
      preview.style.setProperty("--seek-ratio", String(ratio));
      rangeWrap.classList.add("is-seeking");
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => rangeWrap.classList.remove("is-seeking"), 850);
    };
    const hide = () => {
      if (hideTimer) window.clearTimeout(hideTimer);
      rangeWrap.classList.remove("is-seeking");
    };
    range.addEventListener("input", update);
    range.addEventListener("pointerdown", update);
    range.addEventListener("change", () => {
      update();
      hideTimer = window.setTimeout(hide, 350);
    });
    range.addEventListener("blur", hide);
    range.addEventListener("pointercancel", hide);
  }
  function updatePlayerBuffer(video, duration, rangeWrap, bufferStatus) {
    if (!video || !rangeWrap || !bufferStatus) return;
    const total = Number(duration || video.duration || 0);
    let bufferedEnd = 0;
    try {
      const buffered = video.buffered;
      const current = Number(video.currentTime || 0);
      for (let index = buffered.length - 1; index >= 0; index -= 1) {
        const start = buffered.start(index);
        const end = buffered.end(index);
        if (current + 0.25 >= start && current <= end + 0.25) { bufferedEnd = end; break; }
        if (!bufferedEnd) bufferedEnd = end;
      }
    } catch {}
    const percent = total > 0 ? Math.min(100, Math.max(0, (bufferedEnd / total) * 100)) : 0;
    rangeWrap.style.setProperty("--buffered-percent", `${percent}%`);
    bufferStatus.textContent = bufferedEnd > 0 ? `Прогружено: ${formatTime(bufferedEnd)}${total > 0 ? ` из ${formatTime(total)} · ${Math.round(percent)}%` : ""}` : "Загружается…";
  }
  function formatRuntime(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) return "";
    const rounded = Math.round(value);
    return rounded >= 60 ? `${Math.floor(rounded / 60)} ч ${rounded % 60 ? `${rounded % 60} мин` : ""}`.trim() : `${rounded} мин`;
  }
  function posterStyle(item) { return item.posterImage ? `background-image:linear-gradient(180deg, transparent 38%, rgba(0,0,0,.18)),url(${escapeHtml(highResolutionPosterUrl(item.posterImage))});background-size:cover;background-position:center` : `--poster:${item.poster}`; }
  function posterTitleArt(item) { return item.posterImage ? "" : `<span class="poster-title-art">${escapeHtml(item.title)}</span>`; }
  function catalogRatingLabel(item) {
    const value = Number(item.ratingKinopoisk ?? item.rating);
    if (!Number.isFinite(value) || value <= 0) return "";
    return `${item.ratingKinopoisk != null ? "КП" : "TMDB"} ${value.toFixed(1)}`;
  }
  function extractRutubeVideoId(value) { const match = String(value || "").match(/rutube\.ru\/(?:video|play\/embed)\/([a-z0-9]+)(?:[/?#\s"']|$)/i); return match?.[1] || null; }
  // Russian plural: countWord(2, "сезон", "сезона", "сезонов") gives "2 сезона".
  function countWord(count, one, few, many) {
    const number = Math.abs(Number(count) || 0);
    const tail = number % 100;
    const last = number % 10;
    const word = tail >= 11 && tail <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
    return `${number} ${word}`;
  }
  // "2 сезон, 4 серия" where the site used to print S02E04.
  function episodeTag(season, episode) { return `${Number(season) || 1} сезон, ${Number(episode) || 1} серия`; }
  // One icon set for the whole site: 24px grid, 2px line, currentColor (docs/DESIGN.md).
  function uiIcon(name) {
    const paths = {
      play: '<path d="M8 5.5v13l10-6.5L8 5.5Z" fill="currentColor" stroke="none"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/>',
      bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
      check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
      heart: '<path d="M20.8 8.7c0 5-8.8 10.3-8.8 10.3S3.2 13.7 3.2 8.7A4.6 4.6 0 0 1 12 6.2a4.6 4.6 0 0 1 8.8 2.5Z"/>',
      "heart-filled": '<path d="M20.8 8.7c0 5-8.8 10.3-8.8 10.3S3.2 13.7 3.2 8.7A4.6 4.6 0 0 1 12 6.2a4.6 4.6 0 0 1 8.8 2.5Z" fill="currentColor"/>',
      star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" fill="currentColor" stroke="none"/>',
      info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>',
      "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
      "arrow-left": '<path d="M19 12H5M11 6l-6 6 6 6"/>',
      external: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>',
      close: '<path d="m7 7 10 10M17 7 7 17"/>',
      calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    };
    return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
  }
  function playerIcon(name) {
    const paths = {
      play: '<path d="M8 5.5v13l10-6.5L8 5.5Z" fill="currentColor" stroke="none"/>',
      pause: '<path d="M8 6v12M16 6v12" fill="none"/>',
      back: '<path d="M8 7V4L3.5 8.5 8 13v-3a6 6 0 1 1-1.3 7.2" fill="none"/><path d="M13.5 8.5v4.5l3.5-2.25-3.5-2.25Z" fill="currentColor" stroke="none"/>',
      forward: '<path d="M16 7V4l4.5 4.5L16 13v-3a6 6 0 1 0 1.3 7.2" fill="none"/><path d="M10.5 8.5V13L7 10.75l3.5-2.25Z" fill="currentColor" stroke="none"/>',
      volume: '<path d="M4 10h4l5-4v12l-5-4H4v-4Z" fill="none"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" fill="none"/>',
      muted: '<path d="M4 10h4l5-4v12l-5-4H4v-4Z" fill="none"/><path d="m16 10 4 4m0-4-4 4" fill="none"/>',
      settings: '<circle cx="12" cy="12" r="3" fill="none"/><path d="m19.2 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.2a2 2 0 0 1-4 0v-.2a2 2 0 0 0-3.4-1.4l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1A2 2 0 0 0 4 12a2 2 0 0 0-.6-1.4l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1A2 2 0 0 0 9.6 6.4v-.2a2 2 0 0 1 4 0v.2A2 2 0 0 0 17 7.8l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a2 2 0 0 0 0 3.4Z" fill="none"/>',
      close: '<path d="m7 7 10 10M17 7 7 17" fill="none"/>',
      together: '<circle cx="9" cy="9" r="3" fill="none"/><circle cx="16.5" cy="10.5" r="2.5" fill="none"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M14 19.5a4.5 4.5 0 0 1 6.5-3.9" fill="none"/>',
      fullscreen: '<path d="M8 4H4v4m12-4h4v4M8 20H4v-4m16 0v4h-4" fill="none"/>',
      loading: '<circle cx="12" cy="12" r="7" fill="none" stroke-dasharray="28 16"/>',
    };
    return `<svg class="player-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || paths.play}</svg>`;
  }
  function setPlayerPlayButton(button, isPlaying, isLoading = null) {
    if (!button) return;
    if (isLoading == null) isLoading = !button.closest(".player-modal")?.querySelector(".video-loading")?.hidden;
    const label = isLoading ? "Видео загружается" : isPlaying ? "Пауза" : "Воспроизвести";
    button.innerHTML = playerIcon(isLoading ? "loading" : isPlaying ? "pause" : "play");
    button.classList.toggle("is-loading", isLoading);
    button.setAttribute("aria-busy", String(isLoading));
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  function playerSettingsMarkup(prefix, controls) {
    return `<div class="player-settings" data-player-settings><button class="player-control-button player-settings-button" id="${prefix}-settings" type="button" aria-expanded="false" aria-controls="${prefix}-settings-panel" aria-label="Настройки плеера" title="Настройки">${playerIcon("settings")}</button><div class="player-settings-panel" id="${prefix}-settings-panel" role="group" aria-label="Настройки плеера" hidden>${controls}<p class="player-settings-empty">Настройки появятся после загрузки видео.</p></div></div>`;
  }
  function playerFullscreenButtonMarkup(prefix) {
    return `<button class="player-control-button" id="${prefix}-fullscreen" type="button" aria-label="Полный экран" title="Полный экран">${playerIcon("fullscreen")}</button>`;
  }
  function playerToolbarMarkup(prefix, settingsControls) {
    return `<div class="player-toolbar player-toolbar-compact player-toolbar-cinematic"><div class="player-actions"><button class="player-control-button player-skip-button" id="${prefix}-back" type="button" aria-label="Назад на 10 секунд" title="Назад на 10 секунд">${playerIcon("back")}<small aria-hidden="true">10</small></button><button class="player-play-button" id="${prefix}-play" type="button" aria-label="Воспроизвести" title="Воспроизвести">${playerIcon("play")}</button><button class="player-control-button player-skip-button" id="${prefix}-forward" type="button" aria-label="Вперёд на 10 секунд" title="Вперёд на 10 секунд">${playerIcon("forward")}<small aria-hidden="true">10</small></button></div><div class="player-utility-actions"><button class="player-control-button player-room-button" id="${prefix}-room" type="button" aria-label="Совместный просмотр" title="Начать совместный просмотр">${playerIcon("together")}</button>${playerVolumeMarkup(prefix)}${playerFullscreenButtonMarkup(prefix)}${playerSettingsMarkup(prefix, settingsControls)}</div></div>`;
  }
  function bindPlayerSettings(prefix) {
    const root = $(`#${prefix}-settings`)?.closest("[data-player-settings]");
    const button = $(`#${prefix}-settings`);
    const panel = $(`#${prefix}-settings-panel`);
    if (!root || !button || !panel) return () => {};
    const close = (restoreFocus = false) => {
      if (panel.hidden) return;
      panel.hidden = true;
      root.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
      if (restoreFocus) button.focus({ preventScroll: true });
    };
    const toggle = () => {
      const open = panel.hidden;
      panel.hidden = !open;
      root.classList.toggle("is-open", open);
      button.setAttribute("aria-expanded", String(open));
    };
    const onKeydown = (event) => {
      if (event.key !== "Escape" || panel.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onModalClick = (event) => { if (!root.contains(event.target)) close(); };
    button.addEventListener("click", toggle);
    root.addEventListener("keydown", onKeydown);
    modalRoot.addEventListener("click", onModalClick);
    updatePlayerSettingsState(prefix);
    return () => {
      button.removeEventListener("click", toggle);
      root.removeEventListener("keydown", onKeydown);
      modalRoot.removeEventListener("click", onModalClick);
    };
  }
  function updatePlayerSettingsState(prefix) {
    const root = $(`#${prefix}-settings`)?.closest("[data-player-settings]");
    if (!root) return;
    root.classList.toggle("has-options", [...root.querySelectorAll(".player-select")].some((control) => !control.hidden));
  }
  function isHlsUrl(value) { return /\.m3u8(?:$|[?#])/i.test(String(value || "")); }
  function hlsTrackControlsMarkup(prefix, { includeAudio = true } = {}) {
    return `<label class="player-select" id="${prefix}-hls-quality-wrap" hidden><span>Качество</span><select id="${prefix}-hls-quality" aria-label="Качество"></select></label>${includeAudio ? `<label class="player-select" id="${prefix}-hls-audio-wrap" hidden><span>Озвучка</span><select id="${prefix}-hls-audio" aria-label="Озвучка"></select></label>` : ""}<label class="player-select" id="${prefix}-hls-subtitle-wrap" hidden><span>Субтитры</span><select id="${prefix}-hls-subtitle" aria-label="Субтитры"></select></label>`;
  }
  function setSelectOptions(select, options, selectedValue) {
    if (!select) return;
    select.replaceChildren(...options.map((option) => {
      const node = document.createElement("option");
      node.value = String(option.value);
      node.textContent = String(option.label);
      return node;
    }));
    if (options.some((option) => String(option.value) === String(selectedValue))) select.value = String(selectedValue);
  }
  function hlsTrackKey(track, fallback = "") {
    const name = String(track?.name || "").trim().toLocaleLowerCase().replace(/^\d+[\s.:-]+/, "").replace(/\s+/g, " ");
    const lang = String(track?.lang || "").trim().toLocaleLowerCase();
    // Provider masters repeat the same named rendition for every VIDEO quality.
    // The visible name normally already includes the language, so keying by it
    // prevents 1080/720/480 copies from appearing as separate voice options.
    return name || lang || String(fallback);
  }
  function hlsTrackLabel(track, fallback) {
    const name = String(track?.name || "").trim();
    const lang = String(track?.lang || "").trim();
    return name && lang && !name.toLocaleLowerCase().includes(lang.toLocaleLowerCase()) ? `${name} · ${lang}` : name || lang || fallback;
  }
  function hlsQualityTier(level) {
    const width = Number(level?.width || 0);
    const height = Number(level?.height || 0);
    // Letterboxed films often expose an FHD-width picture such as 1920×800.
    // Use the conventional player tiers rather than presenting the cropped
    // active-picture height as a misleading "800p" choice.
    if (width >= 1920 || height >= 1080) return { key: "1080p", label: "1080p", rank: 1080 };
    if (width >= 1280 || height >= 720) return { key: "720p", label: "720p", rank: 720 };
    if (width >= 854 || height >= 480) return { key: "480p", label: "480p", rank: 480 };
    return { key: "360p", label: "360p", rank: 360 };
  }
  function bindHlsTrackControls(hls, prefix, { preferredAudioKey = "", preferredAudioLabel = "", onAudioPreferenceChange = null, preserveVolume = null } = {}) {
    const qualityWrap = $(`#${prefix}-hls-quality-wrap`);
    const qualitySelect = $(`#${prefix}-hls-quality`);
    const audioWrap = $(`#${prefix}-hls-audio-wrap`);
    const audioSelect = $(`#${prefix}-hls-audio`);
    const subtitleWrap = $(`#${prefix}-hls-subtitle-wrap`);
    const subtitleSelect = $(`#${prefix}-hls-subtitle`);
    const audioNotice = $(`#${prefix}-audio-notice`);
    let preferredSubtitleKey = "";
    let selectedQuality = null;

    const uniqueTracks = (tracks) => {
      const seen = new Set();
      return (Array.isArray(tracks) ? tracks : []).map((track, index) => ({ track, index, key: hlsTrackKey(track, String(index)) })).filter((entry) => {
        if (seen.has(entry.key)) return false;
        seen.add(entry.key);
        return true;
      });
    };
    const updateQuality = () => {
      const unique = new Map();
      (hls.levels || []).forEach((level, index) => {
        const tier = hlsQualityTier(level);
        const bitrate = Number(level?.bitrate || 0);
        const current = unique.get(tier.key);
        if (!current || bitrate > current.bitrate) unique.set(tier.key, { value: index, label: tier.label, rank: tier.rank, bitrate });
      });
      const levels = [...unique.values()].sort((a, b) => b.rank - a.rank || b.bitrate - a.bitrate);
      const best = levels[0];
      if (selectedQuality === null && best) {
        selectedQuality = best.value;
        hls.currentLevel = best.value;
      }
      const activeQuality = selectedQuality === null ? (hls.autoLevelEnabled ? -1 : hls.currentLevel) : selectedQuality;
      setSelectOptions(qualitySelect, [{ value: -1, label: "Авто" }, ...levels], activeQuality);
      if (qualityWrap) qualityWrap.hidden = levels.length < 2;
      updatePlayerSettingsState(prefix);
    };
    const updateAudio = () => {
      const tracks = uniqueTracks(hls.audioTracks);
      const current = tracks.find((entry) => entry.index === hls.audioTrack);
      if (!preferredAudioKey) preferredAudioKey = current?.key || tracks[0]?.key || "";
      const preferred = tracks.find((entry) => entry.key === preferredAudioKey);
      const active = preferred || current || tracks[0];
      if (preferred && preferred.index !== hls.audioTrack) {
        const volume = preserveVolume?.();
        hls.audioTrack = preferred.index;
        volume?.restore?.();
      }
      setSelectOptions(audioSelect, tracks.map((entry) => ({ value: entry.index, label: hlsTrackLabel(entry.track, `Дорожка ${entry.index + 1}`) })), preferred?.index ?? current?.index ?? tracks[0]?.index);
      if (audioWrap) audioWrap.hidden = tracks.length < 2;
      if (audioNotice) {
        const fallback = Boolean(preferredAudioKey && !preferred && active);
        audioNotice.hidden = !fallback;
        audioNotice.textContent = fallback ? `Озвучка «${preferredAudioLabel || preferredAudioKey}» недоступна в этой серии. Включена «${hlsTrackLabel(active.track, `Дорожка ${active.index + 1}`)}».` : "";
      }
      updatePlayerSettingsState(prefix);
    };
    const updateSubtitles = () => {
      const tracks = uniqueTracks(hls.subtitleTracks);
      const current = tracks.find((entry) => entry.index === hls.subtitleTrack);
      const preferred = tracks.find((entry) => entry.key === preferredSubtitleKey);
      setSelectOptions(subtitleSelect, [{ value: -1, label: "Выкл." }, ...tracks.map((entry) => ({ value: entry.index, label: hlsTrackLabel(entry.track, `Субтитры ${entry.index + 1}`) }))], preferred?.index ?? current?.index ?? -1);
      if (subtitleWrap) subtitleWrap.hidden = tracks.length === 0;
      updatePlayerSettingsState(prefix);
    };
    const onQualityChange = () => {
      selectedQuality = Number(qualitySelect.value);
      hls.currentLevel = selectedQuality;
    };
    const onAudioChange = () => {
      const index = Number(audioSelect.value);
      preferredAudioKey = hlsTrackKey(hls.audioTracks?.[index], String(index));
      preferredAudioLabel = hlsTrackLabel(hls.audioTracks?.[index], `Дорожка ${index + 1}`);
      const volume = preserveVolume?.();
      hls.audioTrack = index;
      volume?.restore?.();
      onAudioPreferenceChange?.({ key: preferredAudioKey, label: preferredAudioLabel });
    };
    const onSubtitleChange = () => {
      const index = Number(subtitleSelect.value);
      preferredSubtitleKey = index >= 0 ? hlsTrackKey(hls.subtitleTracks?.[index], String(index)) : "";
      hls.subtitleDisplay = index >= 0;
      hls.subtitleTrack = index;
    };
    qualitySelect?.addEventListener("change", onQualityChange);
    audioSelect?.addEventListener("change", onAudioChange);
    subtitleSelect?.addEventListener("change", onSubtitleChange);
    const events = window.Hls?.Events || {};
    [[events.MANIFEST_PARSED, updateQuality], [events.LEVELS_UPDATED, updateQuality], [events.AUDIO_TRACKS_UPDATED, updateAudio], [events.AUDIO_TRACK_SWITCHED, updateAudio], [events.SUBTITLE_TRACKS_UPDATED, updateSubtitles], [events.SUBTITLE_TRACK_SWITCH, updateSubtitles]].forEach(([eventName, handler]) => { if (eventName) hls.on(eventName, handler); });
    updateQuality();
    updateAudio();
    updateSubtitles();
    return () => {
      qualitySelect?.removeEventListener("change", onQualityChange);
      audioSelect?.removeEventListener("change", onAudioChange);
      subtitleSelect?.removeEventListener("change", onSubtitleChange);
    };
  }
  function createHlsPlayer(video, sourceUrl, prefix, onManifest, onError, config = HLS_PLAYBACK_CONFIG, controls = {}) {
    if (!isHlsUrl(sourceUrl) || !window.Hls || !window.Hls.isSupported()) return null;
    const hls = new window.Hls(config);
    const cleanupControls = bindHlsTrackControls(hls, prefix, controls);
    const destroy = hls.destroy.bind(hls);
    hls.destroy = () => { cleanupControls(); destroy(); };
    if (onManifest) hls.on(window.Hls.Events.MANIFEST_PARSED, onManifest);
    if (onError) hls.on(window.Hls.Events.ERROR, onError);
    hls.loadSource(sourceUrl);
    hls.attachMedia(video);
    return hls;
  }
  function playerVolumeMarkup(idPrefix) { return `<div class="player-volume"><button class="player-control-button player-volume-mute" id="${idPrefix}-mute" type="button" aria-label="Выключить звук" title="Выключить звук">${playerIcon("volume")}</button><label class="player-volume-level"><span class="sr-only">Громкость</span><input id="${idPrefix}-volume" type="range" min="0" max="100" value="${Math.round(Math.min(1, Math.max(0, Number(state.playerVolume ?? 1))) * 100)}" step="1" aria-label="Громкость"></label></div>`; }
  function bindPlayerVolumeControl(video, idPrefix) {
    const volume = $(`#${idPrefix}-volume`);
    const mute = $(`#${idPrefix}-mute`);
    if (!video || !volume || !mute) return () => {};
    const initialVolume = Math.min(1, Math.max(0, Number(state.playerVolume ?? 1)));
    video.volume = Number.isFinite(initialVolume) ? initialVolume : 1;
    video.muted = Boolean(state.playerMuted);
    const update = () => {
      const percent = Math.round((video.muted ? 0 : video.volume) * 100);
      volume.value = String(percent);
      mute.innerHTML = playerIcon(percent === 0 ? "muted" : "volume");
      mute.setAttribute("aria-label", percent === 0 ? "Включить звук" : "Выключить звук");
      mute.title = mute.getAttribute("aria-label");
      state.playerVolume = Math.min(1, Math.max(0, Number(video.volume || 0)));
      state.playerMuted = Boolean(video.muted);
      saveState();
    };
    const onVolumeInput = () => {
      const next = Number(volume.value) / 100;
      video.volume = next;
      video.muted = next === 0;
      update();
    };
    const onMuteClick = () => {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
      update();
    };
    volume.addEventListener("input", onVolumeInput);
    mute.addEventListener("click", onMuteClick);
    video.addEventListener("volumechange", update);
    update();
    return () => {
      volume.removeEventListener("input", onVolumeInput);
      mute.removeEventListener("click", onMuteClick);
      video.removeEventListener("volumechange", update);
    };
  }
  function playerVolumeSnapshot(video) {
    const volume = Number(video?.volume ?? state.playerVolume ?? 1);
    const muted = Boolean(video?.muted ?? state.playerMuted);
    return { restore: () => { if (!video) return; video.volume = volume; video.muted = muted; } };
  }
  function bindPlayerLoadingState(video, loading, playButton) {
    if (!video || !loading) return () => {};
    let busy = !loading.hidden;
    const setBusy = (nextBusy, label = "") => {
      busy = Boolean(nextBusy) && !video.paused && !video.ended;
      loading.hidden = !busy;
      loading.setAttribute("aria-label", label || "Загрузка видео");
      setPlayerPlayButton(playButton, !video.paused && !video.ended, busy);
    };
    const start = () => { if (!video.paused && !video.ended) setBusy(true, "Загрузка видео"); };
    const wait = () => { if (!video.paused && !video.ended) setBusy(true, "Видео подгружается"); };
    const ready = () => setBusy(false);
    const pause = () => setBusy(false);
    ["loadstart", "stalled", "seeking"].forEach((eventName) => video.addEventListener(eventName, start));
    video.addEventListener("waiting", wait);
    ["canplay", "playing", "error", "ended"].forEach((eventName) => video.addEventListener(eventName, ready));
    video.addEventListener("pause", pause);
    setBusy(busy);
    return () => {
      ["loadstart", "stalled", "seeking"].forEach((eventName) => video.removeEventListener(eventName, start));
      video.removeEventListener("waiting", wait);
      ["canplay", "playing", "error", "ended"].forEach((eventName) => video.removeEventListener(eventName, ready));
      video.removeEventListener("pause", pause);
    };
  }
  function libraryEpisodeFor(item, season = null, episode = null) {
    const localEpisodes = item?.libraryEpisodes || [];
    if (!localEpisodes.length) return null;
    const exact = localEpisodes.find((candidate) => candidate.status === "ready" && (season == null || candidate.season === season) && (episode == null || candidate.episode === episode));
    return exact || localEpisodes.filter((candidate) => candidate.status === "ready").sort((a, b) => Date.parse(b.progress?.updatedAt || "") - Date.parse(a.progress?.updatedAt || "") || Number(b.episode || 0) - Number(a.episode || 0))[0] || null;
  }
  function titlePlaybackSelection(item) {
    state.playbackSelections = state.playbackSelections && typeof state.playbackSelections === "object" ? state.playbackSelections : {};
    return state.playbackSelections[item?.id] || {};
  }
  function selectedHlsAudioKey(item) { return String(titlePlaybackSelection(item).hlsAudio || ""); }
  function episodeVoiceMarkup() {
    // The preferred voice is selected once on the title card and applied to
    // every episode that exposes that voice. Keep episode cards quiet.
    return "";
  }
  function watchRoomTargetKey(item, season, episode) {
    const titleId = String(item?.title_id || item?.titleId || item?.id || "").trim();
    const localEpisode = item?.title_id && item?.id && item.id !== item.title_id;
    return localEpisode ? String(item.id) : `${titleId}-s${Number(season) || 0}e${Number(episode) || 0}`;
  }
  function watchRoomTitleId(item) { return String(item?.title_id || item?.titleId || item?.id || "").trim(); }
  function watchRoomLink(roomId) {
    const url = new URL(configuredPublicBaseUrl || window.location.href);
    url.search = "";
    url.searchParams.set("room", roomId);
    return url.toString();
  }
  function isLoopbackHost() { return window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"; }
  function showWatchRoomEntryError(message) {
    if (document.querySelector("#watch-room-entry-error")) return;
    const localHint = isLoopbackHost()
      ? "Сейчас открыт локальный адрес 127.0.0.1. На другом устройстве он указывает на само устройство. Откройте Lumo Film через внешний SSH-адрес и передайте ссылку комнаты оттуда."
      : "Проверьте подключение к сайту. Можно вернуться в каталог и открыть карточку заново.";
    page.insertAdjacentHTML("afterbegin", `<section id="watch-room-entry-error" class="notice watch-room-entry-error" role="alert"><strong>Не удалось открыть совместный просмотр</strong><p>${escapeHtml(message)}</p><p>${escapeHtml(localHint)}</p><p class="small">Комната: <code>${escapeHtml(activeWatchRoomId)}</code></p></section>`);
  }
  function setWatchRoomInUrl(roomId) {
    activeWatchRoomId = String(roomId || "");
    const url = new URL(window.location.href);
    if (activeWatchRoomId) url.searchParams.set("room", activeWatchRoomId);
    else url.searchParams.delete("room");
    const route = readRouteFromLocation();
    window.history.replaceState(
      { ...(window.history.state || {}), ...routeHistoryState(route, window.scrollY) },
      "",
      url,
    );
  }
  async function copyWatchRoomLink(roomId) {
    const link = watchRoomLink(roomId);
    if (!navigator.clipboard?.writeText) return false;
    try { await navigator.clipboard.writeText(link); return true; }
    catch { return false; }
  }
  const nativeWatchRooms = new Map();
  async function createWatchRoom(item, season, episode, playback = {}) {
    if (!await window.CineVaultAccounts?.requireLogin()) throw new Error("Для совместного просмотра войдите в аккаунт.");
    const isLocalEpisode = Boolean(item?.source_type && item?.id);
    const payload = {
      protocol: 3, provider: "cinevault", sync_mode: "verified",
      episode_id: isLocalEpisode && item.source_type !== "external_embed" ? item.id : "",
      title_id: watchRoomTitleId(item),
      target_key: watchRoomTargetKey(item, season || item?.season, episode || item?.episode),
      season: Number(season || item?.season || 0),
      episode: Number(episode || item?.episode || 0),
      position: Math.max(0, Number(playback.position || 0)),
      translation: String(playback.translation || ""),
      playing: Boolean(playback.playing),
    };
    const response = await apiFetch("/api/watch/rooms", { method: "POST", headers: { "content-type": "application/json", "X-CineVault-CSRF": window.CineVaultAccounts.csrf }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    try { localStorage.setItem(`cinevault.room.${result.room_id}.host`, result.host_token); }
    catch { throw new Error("Не удалось сохранить роль ведущего в браузере."); }
    nativeWatchRooms.set(result.room_id, result.state);
    return { ...result, link: watchRoomLink(result.room_id) };
  }
  async function loadWatchRoom(roomId) {
    const response = await apiFetch(`/api/watch/rooms/${encodeURIComponent(roomId)}`, { headers: { accept: "application/json" }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  async function openWatchRoomFromUrl() {
    if (!activeWatchRoomId || roomOpenAttempted) return;
    const roomId = activeWatchRoomId;
    let room;
    try {
      room = await loadWatchRoom(roomId);
    } catch (error) {
      roomOpenAttempted = true;
      showWatchRoomEntryError(error?.message || "Сервер комнаты недоступен.");
      return;
    }
    const roomState = room.state || {};
    if (roomState.provider === "cinevault" && roomState.protocol === 3) nativeWatchRooms.set(roomId, roomState);
    if (roomState.ended) {
      roomOpenAttempted = true;
      showWatchRoomEntryError("Комната завершена или срок приглашения истёк. Вернитесь к карточке и создайте новую.");
      return;
    }
    const targetKey = String(roomState.target_key || "");
    const titleId = String(roomState.title_id || targetKey.replace(/-s\d+e\d+$/, "") || "");
    // A room can point to a file from the shared local library. Those titles are
    // intentionally not required to exist in the imported metadata catalog.
    // Resolve the concrete library episode before falling back to a catalog card.
    const season = Number(roomState.season || 1);
    const episode = Number(roomState.episode || 1);
    const localEpisode = libraryEpisodes.find((candidate) => candidate.id === roomState.episode_id || (candidate.title_id === titleId && Number(candidate.season) === season && Number(candidate.episode) === episode));
    if (localEpisode) return openLibraryPlayer(localEpisode, roomId);
    const item = getTitle(titleId) || await ensureCatalogTitle(titleId);
    if (!item) {
      roomOpenAttempted = true;
      showWatchRoomEntryError("Фильма из этой комнаты нет в каталоге.");
      return;
    }
    roomOpenAttempted = true;
    if (String(roomState.translation || "").startsWith("l:") && lampacOrigin()) return openLampacRoom(item, roomState, roomId);
    showWatchRoomEntryError("Эта комната создана в прежнем плеере, которого больше нет. Попросите прислать новое приглашение.");
  }
  function installWatchRoomSync({ roomId, video, item, season, episode, roomStatus, onEpisodeChange, onLeave }) {
    if (!roomId || !video) return null;
    if (nativeWatchRooms.has(roomId)) return new window.CineVaultNativeRoom({roomId, video, item, season, episode, roomStatus, onEpisodeChange, request: apiFetch, shareLink: watchRoomLink, onLeave});
    let disposed = false;
    let lastSeq = -1;
    let currentSeason = Number(season || 0);
    let currentEpisode = Number(episode || 0);
    let suppressUntil = 0;
    let localActionUntil = 0;
    let pendingPublishes = 0;
    let publishTimer = null;
    let mediaReady = Number(video.readyState || 0) >= 1;
    let pendingRoomState = null;
    const setRoomStatus = (message, isError = false) => { if (roomStatus) { roomStatus.textContent = message; roomStatus.classList.toggle("is-error", isError); } };
    const isApplying = () => suppressUntil > Date.now();
    const publish = async (changes = {}) => {
      if (disposed || isApplying()) return null;
      localActionUntil = Date.now() + 1600;
      pendingPublishes += 1;
      const payload = { position: Number(video.currentTime || 0), playing: !video.paused && !video.ended, season: currentSeason, episode: currentEpisode, target_key: watchRoomTargetKey(item, currentSeason, currentEpisode), title_id: watchRoomTitleId(item), ...changes };
      try {
        const response = await apiFetch(`/api/watch/rooms/${encodeURIComponent(roomId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        lastSeq = Math.max(lastSeq, Number(result.state?.seq || 0));
        setRoomStatus(`Совместный просмотр · ${result.share_code || "комната"}`);
        return result;
      } catch (error) { setRoomStatus(`Совместный просмотр недоступен: ${error.message}`, true); return null; }
      finally { pendingPublishes = Math.max(0, pendingPublishes - 1); localActionUntil = Math.max(localActionUntil, Date.now() + 600); }
    };
    const publishEpisode = async (nextSeason, nextEpisode) => { currentSeason = Number(nextSeason || 0); currentEpisode = Number(nextEpisode || 0); return publish({ season: currentSeason, episode: currentEpisode, position: 0, playing: false, target_key: watchRoomTargetKey(item, currentSeason, currentEpisode) }); };
    const apply = (room) => {
      if (pendingPublishes > 0 || Date.now() < localActionUntil) return;
      const remoteState = room?.state || {};
      const seq = Number(remoteState.seq || 0);
      if (!Number.isFinite(seq) || seq <= lastSeq) return;
      // HLS replaces the media source while it is loading. Seeking before
      // loadedmetadata is therefore discarded by some browsers and produced
      // the visible jump back to 0:00 after joining a room.
      if (!mediaReady) {
        pendingRoomState = room;
        setRoomStatus("Совместный просмотр · жду готовность видео…");
        return;
      }
      lastSeq = seq;
      const remoteSeason = Number(remoteState.season || currentSeason || 0);
      const remoteEpisode = Number(remoteState.episode || currentEpisode || 0);
      if (remoteSeason && remoteEpisode && (remoteSeason !== currentSeason || remoteEpisode !== currentEpisode)) { currentSeason = remoteSeason; currentEpisode = remoteEpisode; setRoomStatus(`Переключаю на сезон ${remoteSeason}, серию ${remoteEpisode}…`); onEpisodeChange?.(remoteSeason, remoteEpisode); return; }
      const updatedAt = Date.parse(remoteState.updated_at || "");
      const elapsed = remoteState.playing && Number.isFinite(updatedAt) ? Math.max(0, (Date.now() - updatedAt) / 1000) : 0;
      const targetPosition = Math.max(0, Number(remoteState.position || 0) + elapsed);
      suppressUntil = Date.now() + 700;
      if (Math.abs(Number(video.currentTime || 0) - targetPosition) > 0.7 && Number.isFinite(targetPosition)) video.currentTime = targetPosition;
      if (remoteState.playing && video.paused) video.play().catch(() => {});
      if (!remoteState.playing && !video.paused) video.pause();
      setRoomStatus(`Совместный просмотр · синхронизировано ${formatTime(targetPosition)}`);
    };
    const onMediaReady = () => {
      mediaReady = true;
      if (!pendingRoomState) return;
      const room = pendingRoomState;
      pendingRoomState = null;
      apply(room);
    };
    video.addEventListener("loadedmetadata", onMediaReady);
    let eventSource = null;
    let fallbackInterval = null;
    const poll = async () => { if (!disposed) { try { apply(await loadWatchRoom(roomId)); } catch (error) { setRoomStatus(`Совместный просмотр недоступен: ${error.message}`, true); } } };
    const startFallback = () => {
      if (fallbackInterval || disposed) return;
      fallbackInterval = window.setInterval(poll, 2500);
      poll();
    };
    if (window.EventSource) {
      eventSource = new EventSource(`/api/watch/rooms/${encodeURIComponent(roomId)}/events`);
      eventSource.onopen = () => { setRoomStatus("Совместный просмотр · подключено"); if (fallbackInterval) { window.clearInterval(fallbackInterval); fallbackInterval = null; } };
      eventSource.onmessage = (event) => { try { apply(JSON.parse(event.data)); } catch {} };
      eventSource.onerror = () => { setRoomStatus("Совместный просмотр · переподключение…", true); startFallback(); };
    } else startFallback();
    setRoomStatus("Совместный просмотр · подключаюсь…");
    return { publish, publishEpisode, isApplying, schedulePublish: () => { window.clearTimeout(publishTimer); publishTimer = window.setTimeout(() => publish(), 120); }, dispose: () => { disposed = true; eventSource?.close(); if (fallbackInterval) window.clearInterval(fallbackInterval); window.clearTimeout(publishTimer); video.removeEventListener("loadedmetadata", onMediaReady); } };
  }
  function sourceErrorCardMarkup(statusCode, fallback) {
    const expired = Number(statusCode) === 410;
    const title = expired ? "Видео нужно обновить" : "Не удалось подключить видео";
    const detail = expired ? "Ссылка на это видео устарела. Попробуйте открыть его снова." : fallback;
    return `<div class="video-error-icon" aria-hidden="true">!</div><div class="video-error-copy"><strong>${title}</strong><p>${detail}</p></div>`;
  }
  function showSourceErrorCard(element, statusCode, fallback) {
    if (!element) return;
    element.innerHTML = sourceErrorCardMarkup(statusCode, fallback);
    element.hidden = false;
  }
  function toggleVideoPlayback(video, onBlocked = null) {
    if (!video) return;
    if (video.paused || video.ended) {
      const playPromise = video.play();
      playPromise?.catch?.(() => onBlocked?.());
    } else {
      video.pause();
    }
  }
  function bindVideoPlaybackControls(video, playButton, playOverlay, onBlocked = null) {
    if (!video) return;
    const sync = () => {
      const isPlaying = !video.paused && !video.ended;
      if (playButton) {
        const isLoading = !video.closest(".video-frame")?.querySelector(".video-loading")?.hidden;
        setPlayerPlayButton(playButton, isPlaying, isLoading);
      }
      if (playOverlay) {
        playOverlay.hidden = isPlaying;
        playOverlay.setAttribute("aria-label", isPlaying ? "Пауза" : "Воспроизвести");
      }
    };
    const toggle = () => { if (video.dataset.roomLocked !== "true") toggleVideoPlayback(video, onBlocked); };
    playButton?.addEventListener("click", toggle);
    playOverlay?.addEventListener("click", toggle);
    video.addEventListener("click", (event) => { if (event.target === video) toggle(); });
    ["play", "pause", "ended"].forEach((eventName) => video.addEventListener(eventName, sync));
    sync();
  }
  function rememberPlayerContext() {
    playerReturnContext = { titleId: activeTitleId, view: state.view, season: selectedSeason };
    // The player is a page of its own: the browser's Back button leaves it.
    if (!window.history.state?.cvPlayerOpen) window.history.pushState({ ...(window.history.state || {}), cvPlayerOpen: true }, "", window.location.href);
  }
  let ignoreNextPopstate = false;
  let playerLeavingToView = false;
  function closeOpenPlayer({ leavingToView = false } = {}) {
    const closeButton = modalRoot.querySelector('.player-modal:not(.trailer-modal) [id$="-close"]');
    if (!closeButton) return false;
    playerLeavingToView = leavingToView;
    if (leavingToView) playerReturnContext = null;
    closeButton.click();
    playerLeavingToView = false;
    return true;
  }
  function decoratePlayerTitle() {
    const heading = modalRoot.querySelector(".player-modal:not(.trailer-modal) .modal-head h2:not([data-title-art])");
    if (!heading) return;
    heading.dataset.titleArt = "1";
    const item = getTitle(playerReturnContext?.titleId || activeTitleId);
    if (!item?.logoImage || !heading.textContent.includes(item.title)) return;
    const text = heading.textContent;
    const suffix = text.replace(item.title, "").trim();
    const logo = new Image();
    logo.className = "player-title-logo";
    logo.alt = item.title;
    logo.decoding = "async";
    logo.onerror = () => { heading.textContent = text; };
    logo.src = item.logoImage;
    heading.replaceChildren(logo);
    if (suffix) heading.append(Object.assign(document.createElement("small"), { textContent: suffix }));
  }
  new MutationObserver(decoratePlayerTitle).observe(modalRoot, { childList: true, subtree: true });

  function returnFromPlayer() {
    const context = playerReturnContext;
    playerReturnContext = null;
    modalRoot.innerHTML = "";
    if (!playerLeavingToView && window.history.state?.cvPlayerOpen) {
      ignoreNextPopstate = true;
      window.history.back();
    }
    if (context?.titleId && getTitle(context.titleId)) {
      selectedSeason = Math.max(1, Number(context.season || 1));
      renderDetails(context.titleId);
      return;
    }
    if (context?.view) state.view = context.view;
    render();
  }
  function requestPlayerFullscreen(video) {
    const player = video?.closest(".player-modal") || video;
    if (!player) return;
    const enterNativeVideoFullscreen = () => {
      if (typeof video?.webkitEnterFullscreen === "function") {
        try { video.webkitEnterFullscreen(); return true; } catch {}
      }
      return false;
    };
    if (video?.webkitDisplayingFullscreen) { video.webkitExitFullscreen?.(); return; }
    if (document.fullscreenElement === player || document.fullscreenElement === video || (player.classList?.contains("player-cinematic") && document.fullscreenElement)) { document.exitFullscreen?.().catch?.(() => {}); return; }
    if (player.classList?.contains("player-cinematic") && typeof document.documentElement.requestFullscreen === "function") {
      document.documentElement.requestFullscreen().catch(() => { enterNativeVideoFullscreen(); });
      return;
    }
    if (typeof player.requestFullscreen === "function") {
      player.requestFullscreen().catch(() => { enterNativeVideoFullscreen(); });
      return;
    }
    if (typeof player.webkitRequestFullscreen === "function") {
      try { player.webkitRequestFullscreen(); return; } catch {}
    }
    // iOS Safari does not support fullscreen on arbitrary containers.
    enterNativeVideoFullscreen();
  }
  function installPlayerFullscreenControls(player) {
    if (!player || player.dataset.fullscreenControls === "true") return;
    player.dataset.fullscreenControls = "true";
    const fullscreenButton = player.querySelector('[id$="-fullscreen"]');
    const video = player.querySelector("video");
    const backdrop = player.closest(".modal-backdrop");
    let hideControlsTimer = null;
    const isDocumentCinematicFullscreen = () => player.classList.contains("player-cinematic") && [document.documentElement, document.body].includes(document.fullscreenElement);
    const hasPlayerFullscreen = () => document.fullscreenElement === player || document.fullscreenElement === video || isDocumentCinematicFullscreen();
    const isFullscreen = () => hasPlayerFullscreen() || Boolean(video?.webkitDisplayingFullscreen);
    const updateFullscreenButton = (active) => {
      if (!fullscreenButton) return;
      const label = active ? "Выйти из полного экрана" : "Полный экран";
      fullscreenButton.innerHTML = playerIcon("fullscreen");
      fullscreenButton.setAttribute("aria-label", label);
      fullscreenButton.title = label;
    };
    const clearHideTimer = () => {
      if (!hideControlsTimer) return;
      window.clearTimeout(hideControlsTimer);
      hideControlsTimer = null;
    };
    const canAutoHide = () => hasPlayerFullscreen() && !player.querySelector(":focus-visible") && !player.querySelector(".player-settings.is-open");
    const scheduleHide = () => {
      clearHideTimer();
      if (!canAutoHide()) return;
      hideControlsTimer = window.setTimeout(() => {
        hideControlsTimer = null;
        if (canAutoHide()) player.classList.add("player-controls-hidden");
      }, 2200);
    };
    const reveal = () => {
      player.classList.remove("player-controls-hidden");
      scheduleHide();
    };
    const onFullscreenChange = () => {
      const active = isFullscreen();
      backdrop?.classList.toggle("player-fullscreen-active", active);
      updateFullscreenButton(active);
      if (active) reveal();
      else { clearHideTimer(); player.classList.remove("player-controls-hidden"); }
    };
    player._exitFullscreen = () => {
      if (video?.webkitDisplayingFullscreen) { video.webkitExitFullscreen?.(); return; }
      if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
    };
    ["pointermove", "pointerdown", "touchstart", "keydown", "focusin"].forEach((eventName) => player.addEventListener(eventName, reveal, { passive: eventName === "touchstart" }));
    player.addEventListener("focusout", scheduleHide);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    video?.addEventListener("webkitbeginfullscreen", onFullscreenChange);
    const onWebkitEndFullscreen = () => { if (video) video.controls = false; onFullscreenChange(); };
    video?.addEventListener("webkitendfullscreen", onWebkitEndFullscreen);
    const onFullscreenButtonClick = () => requestPlayerFullscreen(video);
    fullscreenButton?.addEventListener("click", onFullscreenButtonClick);
    const onDoubleClick = (event) => { if (event.target === video) requestPlayerFullscreen(video); };
    player.addEventListener("dblclick", onDoubleClick);
    // The watch action enters document fullscreen before the asynchronous source refresh
    // creates this player, so its fullscreenchange event may already have fired.
    onFullscreenChange();
    player._removeFullscreenControls = () => {
      clearHideTimer();
      backdrop?.classList.remove("player-fullscreen-active");
      player.classList.remove("player-controls-hidden");
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      video?.removeEventListener("webkitbeginfullscreen", onFullscreenChange);
      video?.removeEventListener("webkitendfullscreen", onWebkitEndFullscreen);
      fullscreenButton?.removeEventListener("click", onFullscreenButtonClick);
      ["pointermove", "pointerdown", "touchstart", "keydown", "focusin"].forEach((eventName) => player.removeEventListener(eventName, reveal));
      player.removeEventListener("focusout", scheduleHide);
      player.removeEventListener("dblclick", onDoubleClick);
    };
  }
  function requestEmbedFullscreen(frame) {
    const player = frame?.closest(".player-modal");
    if (!player) return;
    if (document.fullscreenElement === player) {
      document.exitFullscreen?.().catch?.(() => {});
      return;
    }
    if (typeof player.requestFullscreen === "function") {
      player.requestFullscreen().catch(() => frame?.focus?.());
      return;
    }
    if (typeof player.webkitRequestFullscreen === "function") {
      try { player.webkitRequestFullscreen(); return; } catch {}
    }
    // On iPhone, the external provider's own fullscreen control is the fallback.
    frame?.focus?.();
  }
  function installEmbedFullscreenControls(player) {
    if (!player || player.dataset.embedFullscreenControls === "true") return;
    player.dataset.embedFullscreenControls = "true";
    const frame = player.querySelector("iframe");
    const fullscreenButton = player.querySelector('[id$="-fullscreen"]');
    const backdrop = player.closest(".modal-backdrop");
    const update = () => {
      const active = document.fullscreenElement === player;
      backdrop?.classList.toggle("player-fullscreen-active", active);
      if (fullscreenButton) {
        const label = active ? "Выйти из полного экрана" : "Полный экран";
        fullscreenButton.setAttribute("aria-label", label);
        fullscreenButton.title = label;
      }
    };
    const click = () => requestEmbedFullscreen(frame);
    fullscreenButton?.addEventListener("click", click);
    document.addEventListener("fullscreenchange", update);
    player._exitFullscreen = () => { if (document.fullscreenElement === player) document.exitFullscreen?.().catch?.(() => {}); };
    player._removeEmbedFullscreenControls = () => {
      fullscreenButton?.removeEventListener("click", click);
      document.removeEventListener("fullscreenchange", update);
      backdrop?.classList.remove("player-fullscreen-active");
    };
    update();
  }
  // Lampac finds a title by its TMDB, Kinopoisk or IMDb id; titles not out yet stay unplayable.
  function hasPlayableSource(item) {
    if (libraryEpisodeFor(item)) return true;
    if (!item || !lampacOrigin() || awaitingPremierePlayback(item)) return false;
    return Boolean(Number(item.tmdbId || 0) || Number(item.kinopoiskId || item.kinopoisk_id || 0) || item.imdbId);
  }
  function hasOwnEpisodeSources(item) {
    return Boolean(item?.libraryEpisodes?.length);
  }
  // A card from a list has no seasons yet: say they are loading instead of «0 сезонов».
  function seasonsLabel(item) {
    const count = titleSeasonList(item).length;
    if (count) return countWord(count, "сезон", "сезона", "сезонов");
    if (item?.source === "tmdb" && !item.detailed) return item.detailFailed ? "сезоны не загрузились" : "загружаю сезоны…";
    return "сезоны неизвестны";
  }
  function titleSeasonList(item) {
    return (item?.seasons || []).map((count, index) => ({ number: index + 1, episodes: Array.from({ length: count }, (_, episode) => episode + 1) }));
  }

  // Lampac (prototype): a self-hosted server that finds the title on many sources and
  // returns seasons, voices and direct streams. Lumo Film only draws them and plays the
  // stream in its own player. On by default for local and home-network hosts; elsewhere
  // set localStorage "cinevault.lampacOrigin" to its address, or to "off" to disable.
  const LAMPAC_ORIGIN_KEY = "cinevault.lampacOrigin";
  const LAMPAC_CHOICE_KEY = "cinevault.lampacChoice";
  const LAMPAC_PROBE_TIMEOUT_MS = 15000;
  // Order: a per-browser override, then the server's /config.local.js (production),
  // then a Lampac on port 9118 of the same machine for local and home-network runs.
  function lampacOrigin() {
    try {
      const saved = localStorage.getItem(LAMPAC_ORIGIN_KEY);
      if (saved === "off") return "";
      if (saved) return saved.replace(/\/+$/, "");
    } catch {}
    const configured = String(window.CINEVAULT_CONFIG?.lampacOrigin || "").trim();
    if (configured) return configured.replace(/\/+$/, "");
    const host = location.hostname;
    const home = host === "localhost" || host === "127.0.0.1" || /^(192\.168|10)\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
    return home ? `${location.protocol}//${host}:9118` : "";
  }
  // The public Lampac lets in only known device ids (accsdb); the site has its own,
  // given by the server, never written into the code.
  function lampacUid() {
    return String(window.CINEVAULT_CONFIG?.lampacUid || "").trim();
  }
  function withLampacUid(url) {
    const uid = lampacUid();
    if (!uid || !url) return url;
    try {
      const target = new URL(url, lampacOrigin());
      if (target.origin !== new URL(lampacOrigin()).origin || !/^\/(lite|lifeevents)/.test(target.pathname)) return url;
      if (!target.searchParams.has("uid")) target.searchParams.set("uid", uid);
      return target.href;
    } catch {
      return url;
    }
  }
  // Source and voice are remembered per title, as in Lampa; the last choice anywhere
  // is the fallback for a title opened for the first time.
  function lampacChoiceStore() {
    try { return JSON.parse(localStorage.getItem(LAMPAC_CHOICE_KEY) || "{}") || {}; } catch { return {}; }
  }
  function lampacChoice(titleId = "") {
    const store = lampacChoiceStore();
    const own = titleId && store.titles ? store.titles[titleId] : null;
    return own ? { ...own, own: true } : { source: store.source, voice: store.voice };
  }
  function rememberLampacChoice(choice, titleId = "") {
    const store = lampacChoiceStore();
    const next = { ...store, ...choice, titles: { ...(store.titles || {}) } };
    if (titleId) next.titles[titleId] = { ...(next.titles[titleId] || {}), ...choice, at: Date.now() };
    const ids = Object.keys(next.titles);
    if (ids.length > 500) ids.sort((a, b) => (next.titles[a].at || 0) - (next.titles[b].at || 0)).slice(0, ids.length - 500).forEach((id) => delete next.titles[id]);
    try { localStorage.setItem(LAMPAC_CHOICE_KEY, JSON.stringify(next)); } catch {}
  }
  async function lampacJson(url, timeout = LAMPAC_PROBE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const target = new URL(withLampacUid(new URL(url, lampacOrigin()).href));
      target.searchParams.set("rjson", "true");
      const response = await fetch(target, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = (await response.text()).trim();
      return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null;
    } finally {
      window.clearTimeout(timer);
    }
  }
  function lampacQuery(item) {
    const params = new URLSearchParams({
      kinopoisk_id: String(item.kinopoiskId || item.kinopoisk_id || ""),
      title: item.title || "",
      original_title: item.originalTitle || item.title || "",
      year: String(item.year || ""),
      serial: item.kind === "series" ? "1" : "0",
    });
    if (item.imdbId) params.set("imdb_id", item.imdbId);
    if (item.tmdbId) params.set("id", item.tmdbId);
    return params;
  }
  // The list of sources, as Lampa gets it: "life" mode answers at once with a key, then
  // /lifeevents is polled and every source is handed over the moment it is found, instead
  // of waiting 7-10 s for the slowest one. Falls back to the one-shot list.
  async function lampacSourceList(item, onEntries, isClosed = () => false, onProgress = () => {}) {
    const query = lampacQuery(item);
    const seen = new Set();
    const hand = (entries) => {
      const fresh = (entries || []).filter((entry) => {
        const id = String(entry.balanser || entry.name || entry.url);
        if (entry.show === false || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (fresh.length) onEntries(fresh);
    };
    try {
      const start = await lampacJson(`/lite/events?${query}&life=true`, 10000);
      if (start?.memkey) {
        const deadline = Date.now() + 25000;
        for (let delay = 300; Date.now() < deadline && !isClosed(); delay = Math.min(1200, delay + 250)) {
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          const answer = await lampacJson(`/lifeevents?memkey=${encodeURIComponent(start.memkey)}&${query}`, 10000).catch(() => null);
          if (!answer) continue;
          const online = Array.isArray(answer) ? answer : (answer.online || []);
          hand(online);
          if (Number(answer.tasks) > 0) onProgress(Math.min(online.length, answer.tasks), answer.tasks);
          if (answer.ready) break;
        }
        if (seen.size || isClosed()) return seen.size;
      } else if (start) {
        hand(Array.isArray(start) ? start : start.online);
        if (seen.size) return seen.size;
      }
    } catch {}
    if (isClosed()) return seen.size;
    const answer = await lampacJson(`/lite/events?${query}&life=false`, 30000).catch(() => null);
    hand(Array.isArray(answer) ? answer : answer?.online);
    return seen.size;
  }
  // A source either answers with the title itself or with a list of look-alikes;
  // a look-alike is taken only when its year matches, never guessed.
  async function lampacResolve(url, item) {
    let node = await lampacJson(url, 10000);
    for (let hop = 0; node?.type === "similar" && hop < 2; hop += 1) {
      const year = String(item.year || "");
      const match = (node.data || []).find((entry) => year && String(entry.year || "") === year);
      if (!match?.url) return null;
      node = await lampacJson(match.url, 10000);
    }
    return node && ["movie", "season", "episode"].includes(node.type) && (node.data || []).length ? node : null;
  }
  // "play" carries the link itself; "call" has to be asked and answers with every
  // quality and the subtitles, as Lampa does. Its ready "stream" is the fallback.
  async function lampacStream(entry) {
    const pack = (source) => ({
      stream: withLampacUid(source?.url || ""),
      qualities: source?.quality && typeof source.quality === "object" ? Object.fromEntries(Object.entries(source.quality).map(([label, link]) => [label, withLampacUid(link)])) : {},
      subtitles: Array.isArray(source?.subtitles) ? source.subtitles.filter((sub) => sub?.url).map((sub) => ({ label: sub.label || sub.name || "", url: sub.url })) : [],
    });
    if (entry.method === "play") return pack(entry);
    try {
      const answer = await lampacJson(entry.url);
      if (answer?.url) return pack(answer);
    } catch {}
    return { stream: withLampacUid(entry.stream || ""), qualities: {}, subtitles: [] };
  }
  function lampacNumber(entry, fallback) {
    const value = Number(entry?.s ?? entry?.id ?? String(entry?.name || "").match(/\d+/)?.[0]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
  // Quality as a line count: "1080p" -> 1080, "4K" -> 2160.
  function lampacLines(label) {
    const text = String(label || "");
    if (/4k|uhd/i.test(text)) return 2160;
    if (/2k/i.test(text)) return 1440;
    return Number(text.match(/(\d{3,4})p?/i)?.[1] || 0);
  }
  function lampacQualityLabel(lines) {
    if (lines >= 2000) return "4K";
    if (lines >= 1400) return "2K";
    return lines ? `${lines}p` : "";
  }
  // By width, so letterboxed films (3840x1600) still count as 4K.
  function lampacLinesFromPlaylist(text) {
    const widths = [...String(text || "").matchAll(/RESOLUTION=(\d+)x(\d+)/g)].map((match) => Number(match[1]));
    const width = Math.max(0, ...widths);
    if (width >= 3800) return 2160;
    if (width >= 2500) return 1440;
    if (width >= 1900) return 1080;
    if (width >= 1260) return 720;
    if (width >= 840) return 480;
    return width ? 360 : 0;
  }
  function lampacEntryLines(entry) {
    const listed = entry?.quality && typeof entry.quality === "object" ? Object.keys(entry.quality) : [];
    return Math.max(lampacLines(entry?.maxquality), ...listed.map(lampacLines), 0);
  }
  // Best quality a source gives: its own labels first, else the first video's playlist.
  async function lampacSourceQuality(node) {
    let entries = node.data || [];
    if (node.type === "season") {
      const first = await lampacJson(entries[0]?.url);
      entries = first?.type === "episode" ? first.data || [] : [];
    }
    const labelled = Math.max(0, ...entries.map(lampacEntryLines));
    if (labelled) return labelled;
    const entry = entries[0];
    if (entry?.method === "call") {
      const answer = await lampacJson(entry.url).catch(() => null);
      const listed = answer?.quality && typeof answer.quality === "object" ? Object.keys(answer.quality) : [];
      const lines = Math.max(0, ...listed.map(lampacLines));
      if (lines) return lines;
    }
    const stream = entry && (entry.stream || (entry.method === "play" ? entry.url : ""));
    if (!stream || !isHlsUrl(stream)) return 0;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(stream, { signal: controller.signal, cache: "no-store" });
      return response.ok ? lampacLinesFromPlaylist(await response.text()) : 0;
    } finally {
      window.clearTimeout(timer);
    }
  }

  // TMDB, as Lampa uses it: on the public site through the server's /tmdb/3 route
  // (behind the site password, the key stays on the server), elsewhere directly.
  const cvTmdbCache = new Map();
  function cvTmdbLocal() {
    const host = location.hostname;
    return host === "localhost" || host === "127.0.0.1" || /^(192\.168|10)\./.test(host);
  }
  async function cvTmdb(path, timeout = 8000) {
    if (cvTmdbCache.has(path)) return cvTmdbCache.get(path);
    const run = async (url, headers = {}) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: controller.signal, credentials: "same-origin" });
        if (!response.ok) throw new Error(`TMDB ${response.status}`);
        return await response.json();
      } finally {
        window.clearTimeout(timer);
      }
    };
    const direct = () => {
      if (!tmdbCredential) throw new Error("нет ключа TMDB");
      const url = new URL(`https://api.themoviedb.org/3/${path}`);
      const bearer = tmdbCredential.startsWith("eyJ");
      if (!bearer) url.searchParams.set("api_key", tmdbCredential);
      return run(url, bearer ? { Authorization: `Bearer ${tmdbCredential}` } : {});
    };
    const request = (cvTmdbLocal() ? direct() : run(`/tmdb/3/${path}`).catch(direct))
      .catch((error) => { cvTmdbCache.delete(path); throw error; });
    cvTmdbCache.set(path, request);
    return request;
  }
  // The show on TMDB: its real seasons (a source may glue a spin-off on as an extra season,
  // like «Декстер: Новая кровь» as season 9) and, per season, episode names and stills.
  async function cvTmdbShow(item) {
    if (item?.kind !== "series") return null;
    let id = Number(item.tmdbId || 0);
    if (!id) {
      const query = encodeURIComponent(item.originalTitle || item.title || "");
      const found = await cvTmdb(`search/tv?query=${query}&language=ru-RU${item.year ? `&first_air_date_year=${Number(item.year)}` : ""}`);
      let match = (found.results || [])[0];
      if (!match && item.year) {
        const loose = await cvTmdb(`search/tv?query=${query}&language=ru-RU`);
        match = (loose.results || []).find((entry) => Math.abs(Number(String(entry.first_air_date || "").slice(0, 4)) - Number(item.year)) <= 1);
      }
      id = Number(match?.id || 0);
    }
    if (!id) return null;
    const details = await cvTmdb(`tv/${id}?language=ru-RU`);
    const seasons = (details.seasons || []).filter((season) => season.season_number > 0 && season.episode_count > 0);
    return { id, maxSeason: Math.max(0, ...seasons.map((season) => season.season_number)), seasons };
  }
  async function cvTmdbEpisodes(showId, season) {
    const data = await cvTmdb(`tv/${showId}/season/${season}?language=ru-RU`);
    const map = {};
    (data.episodes || []).forEach((episode) => {
      map[episode.episode_number] = {
        name: String(episode.name || "").replace(/^(Эпизод|Серия|Episode)\s*\d+$/i, "").trim(),
        still: episode.still_path ? `${cvTmdbLocal() ? "https://image.tmdb.org/t/p" : "/tmdb/t/p"}/w300${episode.still_path}` : "",
      };
    });
    return map;
  }

  // ---- TMDB catalogue, as Lampa: cards, seasons, people and shelves all come from TMDB.
  // A TMDB card has the same shape as a catalogue card, so pages and shelves draw it as is.
  const TMDB_GENRES = {
    28: "боевик", 12: "приключения", 16: "мультфильм", 35: "комедия", 80: "криминал", 99: "документальный", 18: "драма",
    10751: "семейный", 14: "фэнтези", 36: "история", 27: "ужасы", 10402: "музыка", 9648: "детектив", 10749: "мелодрама",
    878: "фантастика", 10770: "телефильм", 53: "триллер", 10752: "военный", 37: "вестерн",
    10759: "боевик", 10762: "детский", 10763: "новости", 10764: "реалити-шоу", 10765: "фантастика", 10766: "мыльная опера",
    10767: "ток-шоу", 10768: "военный",
  };
  const TMDB_COUNTRIES = {
    US: "США", GB: "Великобритания", RU: "Россия", FR: "Франция", DE: "Германия", IT: "Италия", ES: "Испания", JP: "Япония",
    KR: "Южная Корея", CN: "Китай", CA: "Канада", AU: "Австралия", IN: "Индия", SE: "Швеция", DK: "Дания", NO: "Норвегия",
    BE: "Бельгия", NL: "Нидерланды", IE: "Ирландия", NZ: "Новая Зеландия", MX: "Мексика", BR: "Бразилия", TR: "Турция",
    PL: "Польша", UA: "Украина", BY: "Беларусь", KZ: "Казахстан", CZ: "Чехия", FI: "Финляндия", AT: "Австрия", CH: "Швейцария",
    HK: "Гонконг", TW: "Тайвань", TH: "Таиланд", AR: "Аргентина", IS: "Исландия", HU: "Венгрия", RO: "Румыния",
  };
  function tmdbImage(path, size = "w500") {
    if (!path) return "";
    return `${cvTmdbLocal() ? "https://image.tmdb.org/t/p" : "/tmdb/t/p"}/${size}${path}`;
  }
  // The film's own title art (TMDB «logos»), Russian first, then English or a wordless one, as the big
  // services show «Кольца власти» or «Одиссея». The text title stays until the picture has loaded,
  // so a slow or blocked image host never leaves the hero without a name.
  const titleLogoUrls = new Map();
  const titleLogoReady = new Set();
  // A catalogue card that is not a TMDB one (history, «Продолжить», the old Kinopoisk catalogue) is found on TMDB
  // by its stored tmdbId or by name and year, so «Гравити Фолз» and «Во все тяжкие» get their logos too.
  async function tmdbRefFor(id) {
    const parsed = parseTmdbItemId(id);
    if (parsed) return parsed;
    const item = getTitle(id);
    if (!item || !["movie", "series"].includes(item.kind)) return null;
    const type = item.kind === "series" ? "tv" : "movie";
    let tmdbId = Number(item.tmdbId || 0);
    if (!tmdbId) {
      const query = encodeURIComponent(item.originalTitle || item.title || "");
      const yearKey = type === "tv" ? "first_air_date_year" : "year";
      const found = await cvTmdb(`search/${type}?query=${query}&language=ru-RU${item.year ? `&${yearKey}=${Number(item.year)}` : ""}`, 6000).catch(() => null);
      tmdbId = Number(found?.results?.[0]?.id || 0);
    }
    return tmdbId ? { kind: item.kind, tmdbId } : null;
  }
  function titleLogoUrl(id, title = "") {
    if (!id || !(parseTmdbItemId(id) || getTitle(id))) return Promise.resolve("");
    // Holds a finished answer (a string) or the request still on its way: always hand back a promise.
    if (titleLogoUrls.has(id)) return Promise.resolve(titleLogoUrls.get(id));
    const job = tmdbRefFor(id).then((parsed) => parsed ? cvTmdb(`${parsed.kind === "series" ? "tv" : "movie"}/${parsed.tmdbId}/images?include_image_language=ru,en,null`, 6000) : null)
      .then(async (data) => {
        const fromTmdb = pickTitleLogo(data, title);
        if (fromTmdb.russian) return fromTmdb.url;
        // No Russian lettering on TMDB: Kinopoisk has one for most films (through our server, which remembers it).
        const ref = await tmdbRefFor(id).catch(() => null);
        const item = getTitle(id);
        const kp = Number(item?.kinopoiskId || item?.kinopoisk_id || 0);
        if (ref || kp) {
          const params = new URLSearchParams({ type: ref?.kind === "series" || item?.kind === "series" ? "tv" : "movie" });
          if (ref?.tmdbId) params.set("tmdb", ref.tmdbId);
          if (kp) params.set("kp", kp);
          const answer = await apiFetch(`/api/title-logo?${params}`, { headers: { accept: "application/json" } }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
          const url = String(answer?.url || "");
          if (url) return /^https:\/\/image\.tmdb\.org\/t\/p\/\w+(\/.+)$/.test(url) ? tmdbImage(url.replace(/^https:\/\/image\.tmdb\.org\/t\/p\/\w+/, ""), "w500") : url;
        }
        return fromTmdb.url;
      })
      .catch(() => "");
    titleLogoUrls.set(id, job);
    return job;
  }
  function pickTitleLogo(data, title) {
    // An English logo only for a title that is in Latin letters in Russian too («Stick»): «Полтора шпиона»
    // must not show up as «Central Intelligence». Otherwise Russian, a wordless one, or the text title.
    const latin = Boolean(title) && !/[а-яё]/i.test(title);
    const rank = (logo) => ({ ru: 0, en: latin ? 1 : 3 })[logo.iso_639_1] ?? 2;
    const best = (data?.logos || []).filter((logo) => logo.file_path && !/\.svg$/i.test(logo.file_path) && (logo.iso_639_1 !== "en" || latin))
      .sort((left, right) => rank(left) - rank(right) || (right.vote_average || 0) - (left.vote_average || 0))[0];
    return { url: best ? tmdbImage(best.file_path, "w500") : "", russian: best?.iso_639_1 === "ru" || (latin && Boolean(best)) };
  }
  function titleLogoMarkup(id, title) {
    const known = titleLogoUrls.get(id);
    return typeof known === "string" && titleLogoReady.has(known) ? `<img class="title-logo" src="${escapeHtml(known)}" alt="${escapeHtml(title)}" decoding="async">` : escapeHtml(title);
  }
  // Whether the heading should wait (blank, its place kept) for a logo that may come: not when the answer is known.
  function titleLogoPending(id) {
    if (!parseTmdbItemId(id) && !getTitle(id)) return false;
    const known = titleLogoUrls.get(id);
    return !(typeof known === "string" && (known === "" || titleLogoReady.has(known)));
  }
  // Fetches the logo and its picture ahead, so the hero's next picks switch with no text flash.
  function prefetchTitleLogos(items) {
    (items || []).slice(0, 8).forEach((item) => titleLogoUrl(item?.id, item?.title).then((url) => {
      if (!item?.id) return;
      titleLogoUrls.set(item.id, url);
      if (!url || titleLogoReady.has(url)) return;
      const image = new Image();
      image.onload = () => titleLogoReady.add(url);
      image.src = url;
    }));
  }
  // A logo starts loading the moment a card is pointed at or touched, so the title page opens with it ready.
  ["pointerover", "focusin", "touchstart"].forEach((type) => document.addEventListener(type, (event) => {
    const card = event.target?.closest?.("[data-open-title]");
    const id = card?.dataset.openTitle;
    if (!id || titleLogoUrls.has(id)) return;
    const title = getTitle(id)?.title || "";
    titleLogoUrl(id, title).then((url) => {
      titleLogoUrls.set(id, url);
      if (!url || titleLogoReady.has(url)) return;
      const image = new Image();
      image.onload = () => titleLogoReady.add(url);
      image.src = url;
    });
  }, { passive: true, capture: true }));
  function hydrateTitleLogos(root = document) {
    root.querySelectorAll?.("[data-logo-for]").forEach((heading) => {
      const id = heading.dataset.logoFor;
      if (heading.querySelector(".title-logo")) { heading.classList.remove("is-logo-pending"); return; }
      // The text shows only if no logo comes within a moment; otherwise the logo appears in its place directly.
      const reveal = () => { if (!heading.querySelector(".title-logo")) heading.classList.remove("is-logo-pending"); };
      const fallback = window.setTimeout(reveal, 1200);
      titleLogoUrl(id, heading.textContent).then((url) => {
        titleLogoUrls.set(id, url);
        if (!url) { window.clearTimeout(fallback); reveal(); return; }
        const image = new Image();
        image.className = "title-logo is-entering";
        image.alt = heading.textContent;
        image.decoding = "async";
        image.onerror = () => { window.clearTimeout(fallback); reveal(); };
        image.onload = () => {
          titleLogoReady.add(url);
          if (!heading.isConnected || heading.dataset.logoFor !== id) return;
          window.clearTimeout(fallback);
          heading.replaceChildren(image);
          heading.classList.remove("is-logo-pending");
          heading.classList.add("has-logo");
          requestAnimationFrame(() => image.classList.remove("is-entering"));
        };
        image.src = url;
      });
    });
  }
  // «15 ноября» (this year) or «15 ноября 2027»; «сегодня»/«завтра» close by, as Lampa says it.
  function airDateLabel(date) {
    const value = String(date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    if (value === today) return "сегодня";
    if (value === tomorrow) return "завтра";
    const parsed = new Date(`${value}T00:00:00Z`);
    const sameYear = value.slice(0, 4) === today.slice(0, 4);
    return parsed.toLocaleDateString("ru-RU", { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).replace(/\s*г\.$/, "");
  }
  function episodeAirDate(item, season, episode) {
    return item?.episodeAirDates?.[String(season)]?.[String(episode)] || "";
  }
  function tmdbItemId(kind, tmdbId) {
    return `tmdb-${kind === "series" ? "tv" : "movie"}-${tmdbId}`;
  }
  function parseTmdbItemId(id) {
    const match = String(id || "").match(/^tmdb-(movie|tv)-(\d+)$/);
    return match ? { kind: match[1] === "tv" ? "series" : "movie", tmdbId: Number(match[2]) } : null;
  }
  function tmdbAgeRating(raw) {
    const pick = (list, field) => {
      for (const country of ["RU", "US"]) {
        const found = (list || []).find((entry) => entry.iso_3166_1 === country);
        const value = field(found);
        if (value) return value;
      }
      return "";
    };
    const raw16 = raw.content_ratings
      ? pick(raw.content_ratings.results, (entry) => entry?.rating)
      : pick(raw.release_dates?.results, (entry) => (entry?.release_dates || []).map((date) => date.certification).find(Boolean));
    const number = Number(String(raw16).match(/\d+/)?.[0] || 0);
    if (number) return String(number);
    return { G: "0", PG: "6", "PG-13": "12", R: "18", "NC-17": "18", "TV-Y": "0", "TV-Y7": "6", "TV-G": "0", "TV-PG": "12", "TV-14": "16", "TV-MA": "18" }[raw16] || "";
  }
  var tmdbRussianTitleCache = null;
  function tmdbRussianTitles() {
    if (tmdbRussianTitleCache) return tmdbRussianTitleCache;
    try { tmdbRussianTitleCache = JSON.parse(localStorage.getItem("cinevault.ruTitles.v1") || "{}") || {}; } catch { tmdbRussianTitleCache = {}; }
    return tmdbRussianTitleCache;
  }
  function rememberTmdbRussianTitle(id, title) {
    const titles = tmdbRussianTitles();
    if (titles[id] === title) return;
    titles[id] = title;
    const keys = Object.keys(titles);
    if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach((key) => delete titles[key]);
    try { localStorage.setItem("cinevault.ruTitles.v1", JSON.stringify(titles)); } catch {}
  }
  // «Бегущие по краю 2», «Ведьмак 3 сезон»: TMDB finds the show, not its season, so a query
  // that finds nothing is asked again without the trailing number.
  async function tmdbSearchMulti(query, pageNumber = 1, timeout = 8000) {
    const ask = (text) => cvTmdb(`search/multi?query=${encodeURIComponent(text)}&language=ru-RU&include_adult=false&page=${pageNumber}`, timeout);
    const json = await ask(query);
    const bare = String(query).replace(/[\s:,.-]+(\d{1,2}(\s*(сезон|season|часть|part))?|(сезон|season|часть|part)\s*\d{1,2})\s*$/i, "").trim();
    if (Number(json?.total_results || 0) > 0 || !bare || bare === String(query).trim()) return json;
    return ask(bare);
  }
  function tmdbIsAnime(raw, genres) {
    const animated = genres.includes("мультфильм") || (raw.genre_ids || []).includes(16) || (raw.genres || []).some((genre) => genre?.id === 16);
    const japanese = String(raw.original_language || "") === "ja" || (raw.origin_country || []).includes("JP");
    return animated && japanese;
  }
  function tmdbToItem(raw, kindHint = "") {
    const type = raw.media_type || kindHint;
    const kind = type === "tv" || type === "series" || (!type && raw.first_air_date !== undefined) ? "series" : "movie";
    const date = String(raw.release_date || raw.first_air_date || "");
    const genres = Array.isArray(raw.genres) ? raw.genres.map((genre) => TMDB_GENRES[genre.id] || String(genre.name || "").toLowerCase()) : (raw.genre_ids || []).map((id) => TMDB_GENRES[id]).filter(Boolean);
    const item = {
      id: tmdbItemId(kind, raw.id),
      tmdbId: Number(raw.id),
      source: "tmdb",
      kind,
      title: raw.title || raw.name || raw.original_title || raw.original_name || "",
      originalTitle: raw.original_title || raw.original_name || "",
      originalLanguage: String(raw.original_language || ""),
      year: Number(date.slice(0, 4)) || 0,
      premiere: date,
      description: raw.overview || "",
      posterImage: tmdbImage(raw.poster_path, "w500"),
      backdropImage: tmdbImage(raw.backdrop_path, "w1280"),
      // Japanese animation (in Japanese or made in Japan) is anime, not «мультфильм».
      genres: [...new Set(tmdbIsAnime(raw, genres) ? genres.map((genre) => (genre === "мультфильм" ? "аниме" : genre)) : genres)],
      isAnime: tmdbIsAnime(raw, genres),
      rating: Number(raw.vote_count || 0) >= 5 ? Math.round(Number(raw.vote_average || 0) * 10) / 10 : 0,
      votes: Number(raw.vote_count || 0),
      popularity: Number(raw.popularity || 0),
    };
    // TMDB often has no Russian name for anime and new shows, only a Russian alternative
    // title (Кинопоиск's one). Use it and remember it for list cards that come without it.
    if (!/[а-яё]/i.test(item.title)) {
      const alternatives = [...(raw.alternative_titles?.results || []), ...(raw.alternative_titles?.titles || [])].filter((entry) => entry.iso_3166_1 === "RU" && /[а-яё]/i.test(entry.title || ""));
      const russian = (alternatives.find((entry) => !entry.type) || alternatives[0])?.title || tmdbRussianTitles()[item.id] || "";
      if (russian) {
        item.title = russian;
        if (alternatives.length) rememberTmdbRussianTitle(item.id, russian);
      }
    }
    if (raw.runtime) item.runtime = raw.runtime;
    else if (raw.episode_run_time?.length) item.runtime = raw.episode_run_time[0];
    if (Array.isArray(raw.seasons)) item.seasons = raw.seasons.filter((season) => season.season_number > 0 && season.episode_count > 0).map((season) => season.episode_count);
    if (raw.external_ids?.imdb_id || raw.imdb_id) item.imdbId = raw.external_ids?.imdb_id || raw.imdb_id;
    if (raw.credits) {
      item.actors = (raw.credits.cast || []).slice(0, 15).map((person) => person.name);
      item.people = (raw.credits.cast || []).slice(0, 20).map((person) => ({ id: person.id, name: person.name, role: person.character || "", photo: tmdbImage(person.profile_path, "w185") }));
      item.directors = (raw.credits.crew || []).filter((person) => person.job === "Director").map((person) => person.name).slice(0, 4);
      item.producers = (raw.credits.crew || []).filter((person) => person.job === "Producer" || person.job === "Executive Producer").map((person) => person.name).slice(0, 4);
    }
    if (!item.directors?.length && raw.created_by?.length) item.directors = raw.created_by.map((person) => person.name);
    if (raw.production_countries?.length) item.countries = raw.production_countries.map((country) => TMDB_COUNTRIES[country.iso_3166_1] || country.name);
    else if (raw.origin_country?.length) item.countries = raw.origin_country.map((code) => TMDB_COUNTRIES[code] || code);
    if (raw.tagline) item.tagline = raw.tagline;
    const age = tmdbAgeRating(raw);
    if (age) item.ageRating = age;
    if (raw.status) item.tmdbStatus = raw.status;
    const nextEpisode = raw.next_episode_to_air;
    if (nextEpisode?.air_date) item.nextEpisode = { season: nextEpisode.season_number, episode: nextEpisode.episode_number, name: nextEpisode.name || "", airDate: nextEpisode.air_date };
    return item;
  }
  const tmdbTitleLoads = new Map();
  function loadTmdbTitle(id) {
    const parsed = parseTmdbItemId(id);
    if (!parsed) return Promise.resolve(null);
    if (tmdbTitleLoads.has(id)) return tmdbTitleLoads.get(id);
    const kindPath = parsed.kind === "series" ? "tv" : "movie";
    const extra = parsed.kind === "series" ? "credits,external_ids,content_ratings,alternative_titles" : "credits,external_ids,release_dates,alternative_titles";
    const request = cvTmdb(`${kindPath}/${parsed.tmdbId}?language=ru-RU&append_to_response=${extra}`, 10000)
      .then((raw) => {
        const item = withTitleOverrides(tmdbToItem(raw, parsed.kind));
        item.detailed = true;
        // A short copy from a list may already be on screen: complete it in place.
        const known = getTitle(id);
        if (known && known !== item) Object.assign(known, item);
        // Episodes looked up before the seasons were known are looked up again.
        if (episodeAssetStates[id] && !Object.keys((known || item).episodeAirDates || {}).length) delete episodeAssetStates[id];
        rememberLooseTitles([known || item]);
        return known || item;
      })
      .catch((error) => { tmdbTitleLoads.delete(id); throw error; });
    tmdbTitleLoads.set(id, request);
    return request;
  }
  function tmdbListItems(json, kindHint = "") {
    return (json?.results || [])
      .filter((raw) => (raw.media_type || kindHint) !== "person" && (raw.poster_path || raw.backdrop_path))
      .map((raw) => withTitleOverrides(tmdbToItem(raw, kindHint)));
  }

  // ---- Moving Kinopoisk cards to TMDB. Each old id is matched once by title and year
  // (remembered), then every saved record that names it is renamed: progress, history,
  // favourites, ratings, chosen voices. Old addresses open the TMDB card.
  const TMDB_MAP_KEY = "cinevault.tmdbMap.v1";
  const KNOWN_TMDB_IDS = Object.freeze({ "kinopoisk-5304403": "tmdb-tv-234763", "kinopoisk-412344": "tmdb-tv-5920", "kinopoisk-277537": "tmdb-tv-1405" });
  function tmdbMap() {
    try { return JSON.parse(localStorage.getItem(TMDB_MAP_KEY) || "{}") || {}; } catch { return {}; }
  }
  function rememberTmdbMap(oldId, newId) {
    const map = tmdbMap();
    map[oldId] = newId;
    try { localStorage.setItem(TMDB_MAP_KEY, JSON.stringify(map)); } catch {}
  }
  function knownTmdbId(oldId) {
    return KNOWN_TMDB_IDS[oldId] || tmdbMap()[oldId] || "";
  }
  async function resolveTmdbId(item) {
    if (!item) return "";
    if (item.source === "tmdb" || parseTmdbItemId(item.id)) return item.id;
    const known = knownTmdbId(item.id);
    if (known) return known;
    let found = "";
    if (Number(item.tmdbId || 0) > 0) found = tmdbItemId(item.kind, item.tmdbId);
    const kindPath = item.kind === "series" ? "tv" : "movie";
    const year = Number(item.year || 0);
    const yearParam = year ? `&${item.kind === "series" ? "first_air_date_year" : "year"}=${year}` : "";
    for (const query of [...new Set([item.originalTitle, item.title].filter(Boolean))]) {
      if (found) break;
      for (const withYear of [true, false]) {
        const json = await cvTmdb(`search/${kindPath}?query=${encodeURIComponent(query)}&language=ru-RU${withYear ? yearParam : ""}`).catch(() => null);
        const match = (json?.results || []).find((entry) => {
          const entryYear = Number(String(entry.release_date || entry.first_air_date || "").slice(0, 4));
          return !year || !entryYear || Math.abs(entryYear - year) <= 1;
        });
        if (match) { found = tmdbItemId(item.kind, match.id); break; }
        if (!yearParam) break;
      }
    }
    if (found) rememberTmdbMap(item.id, found);
    return found;
  }
  function renameTitleKey(key, oldId, newId) {
    if (key === oldId) return newId;
    if (key.startsWith(`${oldId}-`)) return `${newId}${key.slice(oldId.length)}`;
    return key;
  }
  // Copies, never moves: the old record stays for the iOS app (it still knows Kinopoisk ids)
  // and as a safety copy in every account; the site shows each title once (see displayTitleId).
  function migrateTitleId(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return false;
    let changed = false;
    const copyObject = (object, isNewer = () => false) => {
      if (!object || typeof object !== "object" || Array.isArray(object)) return object;
      const next = { ...object };
      Object.entries(object).forEach(([key, value]) => {
        const target = renameTitleKey(key, oldId, newId);
        if (target === key) return;
        if (!(target in next) || isNewer(next[target], value)) {
          next[target] = value && typeof value === "object" && !Array.isArray(value) ? { ...value, ...(value.titleId === oldId ? { titleId: newId } : {}) } : value;
          changed = true;
        }
      });
      return next;
    };
    const copyList = (list) => {
      if (!Array.isArray(list) || !list.includes(oldId) || list.includes(newId)) return list;
      changed = true;
      const index = list.indexOf(oldId);
      return [...list.slice(0, index), newId, ...list.slice(index)];
    };
    state.progress = copyObject(state.progress, (current, incoming) => Number(incoming?.updatedAt || 0) > Number(current?.updatedAt || 0));
    ["favorites", "watchlist", "history", "recommendationHistory"].forEach((name) => { state[name] = copyList(state[name]); });
    ["historyAt", "historyRemoved", "ratings", "voiceSelections", "playbackSelections", "offline"].forEach((name) => { state[name] = copyObject(state[name]); });
    const choice = lampacChoiceStore();
    if (choice.titles?.[oldId] && !choice.titles[newId]) {
      choice.titles[newId] = { ...choice.titles[oldId] };
      try { localStorage.setItem(LAMPAC_CHOICE_KEY, JSON.stringify(choice)); } catch {}
    }
    return changed;
  }
  // The id the site shows for a saved record: a moved Kinopoisk card is shown as its TMDB card.
  function displayTitleId(id) {
    return knownTmdbId(String(id || "")) || String(id || "");
  }
  function displayTitleIds(ids) {
    return [...new Set((ids || []).map(displayTitleId).filter(Boolean))];
  }
  // Removing a TMDB card from a list also removes the old Kinopoisk record it was copied from.
  function withoutTitle(list, id) {
    return (list || []).filter((entry) => entry !== id && displayTitleId(entry) !== id);
  }
  function legacyTitleIds() {
    const ids = new Set();
    // Base title of a record key: "<id>", "<id>-s2e7", "<id>-alt", "<id>-embed".
    const add = (id) => {
      const base = String(id || "").replace(/-s\d+e\d+$|-alt$|-embed$/, "");
      if (base && !parseTmdbItemId(base) && !/^(rutube|library|local)-/.test(base)) ids.add(base);
    };
    Object.keys(state.progress || {}).forEach(add);
    Object.values(state.progress || {}).forEach((record) => add(record?.titleId));
    ["favorites", "watchlist", "history"].forEach((name) => (state[name] || []).forEach(add));
    return [...ids];
  }
  let legacyMigration = null;
  function migrateLegacyTitles() {
    if (!lampacOrigin()) return Promise.resolve();
    if (legacyMigration) return legacyMigration;
    legacyMigration = (async () => {
      let changed = false;
      for (const oldId of legacyTitleIds()) {
        let newId = knownTmdbId(oldId);
        if (!newId) {
          const item = getTitle(oldId) || await ensureCatalogTitle(oldId).catch(() => null);
          // Only cards of the Kinopoisk catalogue move; own library files keep their ids.
          if (!item || !(Number(item.kinopoiskId || 0) > 0 || /^kinopoisk-\d+$/.test(oldId))) continue;
          newId = await resolveTmdbId(item).catch(() => "");
        }
        if (newId && migrateTitleId(oldId, newId)) changed = true;
      }
      if (changed) {
        saveState();
        if (state.view === "home" && readRouteFromLocation().type !== "title") render();
      }
    })().finally(() => { legacyMigration = null; });
    return legacyMigration;
  }

  function lampacProgressKey(item, season, episode) {
    return season ? `${item.id}-s${season}e${episode}` : item.id;
  }
  function lampacSavedPosition(item, season, episode) {
    const record = state.progress[lampacProgressKey(item, season, episode)];
    return record && !record.completed ? Number(record.position || 0) : 0;
  }
  function lampacSourceUrl(entry, item) {
    const url = new URL(entry.url, lampacOrigin());
    lampacQuery(item).forEach((value, key) => { if (!url.searchParams.has(key)) url.searchParams.set(key, value); });
    return url.href;
  }
  // The room keeps "what we watch", never a link: links are personal and short-lived,
  // so every viewer asks Lampac for their own. Format "l:<source>|<voice>", 80 chars max.
  function lampacRoomEdition(sourceId, voice) {
    return `l:${sourceId}|${voice || ""}`.slice(0, 80);
  }

  // Opens the Lumo Film player on a Lampac list (a voice's episodes, or a film's voices)
  // and wires progress and the shared room to it.
  function startLampacPlayer(item, list, index, first, { voiceName = "", isMovie = false, sourceId = "", roomId = "", voices = null, seasons = null } = {}) {
    const target = list[index];
    let voice = voiceName;
    let roomSync = null;
    let currentRoom = "";
    rememberHistory(item.id);
    // Intro and credits marks come from IntroDB by IMDb id (our server asks and caches).
    let imdbLookup = null;
    const imdbFor = () => imdbLookup || (imdbLookup = (async () => {
      if (item.imdbId) return item.imdbId;
      const parsed = parseTmdbItemId(item.id);
      if (item.kind === "series") {
        const show = await cvTmdbShow(item);
        return show ? (await cvTmdb(`tv/${show.id}/external_ids`))?.imdb_id || "" : "";
      }
      const movieId = Number(item.tmdbId || 0) || (parsed?.kind === "movie" ? parsed.tmdbId : 0);
      return movieId ? (await cvTmdb(`movie/${movieId}/external_ids`))?.imdb_id || "" : "";
    })().catch(() => ""));
    const skipSegmentsFor = async (entry) => {
      const imdb = await imdbFor();
      if (!imdb) return [];
      const params = new URLSearchParams({ imdb, season: String(isMovie ? 0 : Number(entry.s || 0)), episode: String(isMovie ? 0 : Number(entry.e || 0)) });
      const response = await apiFetch(`/api/skip-segments?${params}`, { headers: { accept: "application/json" } });
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data.segments) ? data.segments : [];
    };
    const episodes = list.map((entry, position) => ({ label: entry.label, note: entry.title || entry.note || "", name: entry.title || "", still: entry.still || "", s: entry.s, e: entry.e, current: position === index, startAt: lampacSavedPosition(item, entry.s, entry.e) }));
    const player = window.CineVaultPlayer.open({
      title: item.title,
      artwork: item.posterImage ? highResolutionPosterUrl(item.posterImage) : "",
      voice,
      stream: first.stream,
      qualities: first.qualities,
      subtitles: first.subtitles,
      startAt: roomId ? 0 : lampacSavedPosition(item, target.s, target.e),
      handoff: { source: sourceId, voice: voiceName },
      listTitle: isMovie ? "Озвучка" : "Серии",
      isMovie,
      seasons: isMovie ? [] : (seasons || []).filter((entry) => entry?.url).map((entry, position) => ({ number: lampacNumber(entry, position + 1), label: entry.name || "", url: entry.url })),
      // Another season of this source, in the voice being watched when it has one.
      loadSeason: isMovie ? null : async (number) => {
        const entry = (seasons || []).find((one, position) => lampacNumber(one, position + 1) === Number(number));
        if (!entry?.url) return null;
        let node = await lampacJson(entry.url, 15000);
        const same = (node?.voice || []).find((one) => one.name === voice && !one.active && one.url);
        if (same) node = await lampacJson(same.url, 15000).catch(() => node);
        if (node?.type !== "episode" || !node.data?.length) return null;
        const fresh = node.data.map((one, position) => {
          const e = Number(one.e || position + 1);
          return { entry: one, s: Number(one.s || number), e, label: one.name || `${e} серия`, note: "" };
        });
        const names = await Promise.race([
          cvTmdbShow(item).then((show) => (show ? cvTmdbEpisodes(show.id, Number(number)) : null)).catch(() => null),
          new Promise((resolve) => window.setTimeout(() => resolve(null), 3000)),
        ]);
        const shown = fresh.map((one) => ({ label: one.label, name: names?.[one.e]?.name || "", note: names?.[one.e]?.name || "", still: names?.[one.e]?.still || "", s: one.s, e: one.e, current: false, startAt: lampacSavedPosition(item, one.s, one.e) }));
        const activeVoice = (node.voice || []).find((one) => one.active)?.name || voice;
        return {
          episodes: shown,
          apply: () => {
            list.splice(0, list.length, ...fresh);
            episodes.splice(0, episodes.length, ...shown);
            voice = activeVoice;
          },
        };
      },
      voices: (voices || []).filter((one) => one?.name).map((one) => ({ name: one.name, url: one.url || "", active: Boolean(one.active) })),
      // Another voice of this source: its episode list replaces this one in place, so the
      // next episodes and the list follow the new voice; the same episode keeps playing.
      onVoice: isMovie ? null : async (choice, now) => {
        if (!choice.url) throw new Error("нет ссылки");
        const node = await lampacJson(choice.url, 15000);
        if (node?.type !== "episode" || !node.data?.length) throw new Error("нет серии");
        const fresh = node.data.map((entry, position) => {
          const s = Number(entry.s || now.s || 1);
          const e = Number(entry.e || position + 1);
          return { entry, s, e, label: entry.name || `${e} серия`, note: "" };
        });
        const at = fresh.findIndex((entry) => entry.s === Number(now.s) && entry.e === Number(now.e));
        if (at < 0) throw new Error("нет серии");
        const next = await lampacStream(fresh[at].entry);
        if (!next.stream) throw new Error("нет ссылки");
        const known = new Map(episodes.map((entry) => [`${entry.s}:${entry.e}`, entry]));
        list.splice(0, list.length, ...fresh);
        episodes.splice(0, episodes.length, ...fresh.map((entry, position) => {
          const old = known.get(`${entry.s}:${entry.e}`) || {};
          return { label: entry.label, note: old.name || "", name: old.name || "", still: old.still || "", s: entry.s, e: entry.e, current: position === at, startAt: lampacSavedPosition(item, entry.s, entry.e) };
        }));
        voice = choice.name;
        rememberLampacChoice({ source: sourceId, voice }, item.id);
        return { ...next, index: at, voices: (node.voice || []).filter((one) => one?.name).map((one) => ({ name: one.name, url: one.url || "", active: Boolean(one.active) })) };
      },
      keepPosition: isMovie,
      autoNext: !isMovie,
      episodes,
      segments: skipSegmentsFor,
      resolve: async (position) => {
        const entry = list[position];
        const next = await lampacStream(entry.entry);
        if (isMovie) { voice = entry.label; rememberLampacChoice({ voice }, item.id); }
        return { ...next, voice: isMovie ? entry.label : voice };
      },
      onProgress: ({ position, duration, completed, s, e }) => {
        if (!duration) return;
        state.progress[lampacProgressKey(item, s, e)] = { titleId: item.id, providerId: "lampac", ...(s ? { seasonNumber: s, episodeNumber: e } : {}), position, duration, completed: completed || duration - position < 60, updatedAt: Date.now() };
        saveState();
      },
      onEpisodeChange: (s, e) => { if (roomSync?.isHost !== false) roomSync?.publishEpisode?.(s, e)?.catch?.(() => {}); },
      onRoom: async () => {
        if (currentRoom) {
          const copied = await copyWatchRoomLink(currentRoom);
          player.toast(copied ? "Приглашение скопировано" : "Ссылка на комнату — в адресной строке");
          return;
        }
        try {
          const now = player.current();
          const created = await createWatchRoom(item, now.s, now.e, { position: Number(player.video.currentTime || 0), playing: !player.video.paused, translation: lampacRoomEdition(sourceId, voice) });
          attachRoom(created.room_id);
          setWatchRoomInUrl(created.room_id);
          const copied = await copyWatchRoomLink(created.room_id);
          player.toast(copied ? "Комната создана, приглашение скопировано" : "Комната создана, ссылка — в адресной строке");
        } catch (error) {
          player.toast(error.message || "Комнату создать не удалось");
        }
      },
      onChooseSource: () => openLampacChooser(item, { season: target.s || null, episode: target.e || null }),
      onClose: () => {
        if (roomSync) { roomSync.leave ? roomSync.leave() : roomSync.dispose(); setWatchRoomInUrl(""); }
        roomSync = null;
        player.video.removeEventListener("play", onPlay);
        player.video.removeEventListener("pause", onPause);
        player.video.removeEventListener("seeking", onSeeking);
        if (activeTitleId === item.id) renderDetails(getTitleFromPage());
      },
    });
    // Names and stills for the episode list and the next-episode card, like Lampa; they may
    // arrive after the player has opened, the player reads them when it shows them.
    if (!isMovie) {
      cvTmdbShow(item).then((show) => {
        if (!show) return;
        [...new Set(episodes.map((entry) => entry.s).filter(Boolean))].forEach((seasonNumber) => {
          cvTmdbEpisodes(show.id, seasonNumber).then((names) => {
            episodes.forEach((entry) => {
              const info = entry.s === seasonNumber ? names?.[entry.e] : null;
              if (!info) return;
              if (info.name && !entry.name) { entry.name = info.name; entry.note = info.name; }
              if (info.still && !entry.still) entry.still = info.still;
            });
          }).catch(() => {});
        });
      }).catch(() => {});
    }
    const onPlay = () => { if (roomSync && !roomSync.isApplying()) roomSync.publish({ playing: true }); };
    const onPause = () => { if (roomSync && !roomSync.isApplying() && !player.video.seeking) roomSync.publish({ position: Number(player.video.currentTime || 0), playing: false }); };
    // Sent when the seek starts: waiting for "seeked" let the room pull the host back first.
    const onSeeking = () => { if (roomSync && !roomSync.isApplying()) roomSync.schedulePublish(); };
    player.video.addEventListener("play", onPlay);
    player.video.addEventListener("pause", onPause);
    player.video.addEventListener("seeking", onSeeking);
    function attachRoom(id) {
      roomSync?.dispose();
      currentRoom = id;
      const now = player.current();
      roomSync = installWatchRoomSync({
        roomId: id,
        video: player.video,
        item,
        season: now.s,
        episode: now.e,
        roomStatus: player.roomSlot,
        onEpisodeChange: (s, e) => player.playEpisode(s, e),
        onLeave: () => { roomSync = null; currentRoom = ""; player.roomSlot.hidden = true; player.video.dataset.roomLocked = "false"; setWatchRoomInUrl(""); },
      });
    }
    if (roomId) attachRoom(roomId);
    return player;
  }

  // An invitation link to a Lampac room: find the same source, voice, season and episode.
  async function openLampacRoom(item, roomState, roomId) {
    const [sourceId, voice = ""] = String(roomState.translation || "").slice(2).split("|");
    const season = Number(roomState.season || 0);
    const episode = Number(roomState.episode || 0);
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal player-choice-modal" role="dialog" aria-modal="true" aria-label="Совместный просмотр"><div class="eyebrow">Совместный просмотр</div><h2>${escapeHtml(item.title)}</h2><div class="lampac-status" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>Подключаю тот же источник и озвучку…</span></div></section></div>`;
    const fail = (text) => { modalRoot.innerHTML = ""; showWatchRoomEntryError(text); };
    try {
      let source = null;
      await lampacSourceList(item, (entries) => {
        source = source || entries.find((entry) => String(entry.balanser || entry.name || entry.url) === sourceId) || null;
      }, () => Boolean(source));
      if (!source) return fail("Источника из комнаты сейчас нет в Lampac.");
      let node = await lampacResolve(lampacSourceUrl(source, item), item);
      if (!node) return fail("Источник из комнаты не нашёл этот фильм.");
      let list;
      let index = 0;
      const isMovie = node.type === "movie";
      if (isMovie) {
        list = node.data.map((entry, position) => ({ entry, label: entry.translate || entry.title || `Вариант ${position + 1}` }));
        index = Math.max(0, list.findIndex((entry) => entry.label === voice));
      } else {
        if (node.type === "season") {
          const seasonEntry = node.data.find((entry, position) => lampacNumber(entry, position + 1) === season) || node.data[0];
          node = await lampacJson(seasonEntry.url);
        }
        const wantedVoice = (node?.voice || []).find((entry) => entry.name === voice && !entry.active && entry.url);
        if (wantedVoice) node = await lampacJson(wantedVoice.url);
        if (node?.type !== "episode" || !node.data?.length) return fail("В источнике нет этой серии.");
        list = node.data.map((entry, position) => {
          const s = Number(entry.s || season || 1);
          const e = Number(entry.e || position + 1);
          return { entry, s, e, label: entry.name || `${e} серия` };
        });
        index = Math.max(0, list.findIndex((entry) => entry.s === season && entry.e === episode));
      }
      const first = await lampacStream(list[index].entry);
      if (!first.stream) return fail("Источник не отдал видео.");
      modalRoot.innerHTML = "";
      startLampacPlayer(item, list, index, first, { voiceName: voice, isMovie, sourceId, roomId });
    } catch (error) {
      fail(`Lampac не ответил: ${error.message || "ошибка"}.`);
    }
  }


  // Quality before the start, as in Lampa. The choice is the player's own memory
  // ("cinevault.playerPrefs".lines): picked once here or in the player, kept for good.
  const PLAYER_PREFS_KEY = "cinevault.playerPrefs";
  const QUALITY_STEPS = [[2160, "4K"], [1440, "2K"], [1080, "1080p"], [720, "720p"], [480, "480p"]];
  function wantedQualityLines() {
    try { return Number(JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) || "{}").lines) || 0; } catch { return 0; }
  }
  function qualityPickMarkup(maxLines) {
    const top = Number(maxLines) || 2160;
    const steps = QUALITY_STEPS.filter(([lines]) => lines <= Math.max(top, 480));
    const wanted = wantedQualityLines();
    const chip = (lines, label) => `<button class="genre-pill${wanted === lines ? " is-active" : ""}" type="button" data-quality-pick="${lines}" aria-pressed="${wanted === lines}">${label}</button>`;
    return `<div class="lampac-label">Качество</div><div class="lampac-qualities" role="group" aria-label="Качество">${chip(0, "Авто")}${steps.map(([lines, label]) => chip(lines, label)).join("")}</div>`;
  }
  function bindQualityPick(root) {
    root.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-quality-pick]") : null;
      if (!button) return;
      const lines = Number(button.dataset.qualityPick) || null;
      try {
        const prefs = JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) || "{}") || {};
        localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify({ ...prefs, lines }));
      } catch {}
      root.querySelectorAll("[data-quality-pick]").forEach((other) => {
        const on = other === button;
        other.classList.toggle("is-active", on);
        other.setAttribute("aria-pressed", String(on));
      });
    });
  }
  function lampacSkeleton() {
    const bar = (cls) => `<span class="lampac-skeleton ${cls}"></span>`;
    return `<div class="lampac-skeletons" aria-hidden="true">${bar("is-start")}${bar("is-label")}<div class="lampac-skeleton-row">${bar("is-chip")}${bar("is-chip")}${bar("is-chip")}</div>${bar("is-label")}<div class="lampac-skeleton-row">${bar("is-chip")}${bar("is-chip")}${bar("is-chip")}${bar("is-chip")}</div></div>`;
  }

  function openLampacChooser(item, { season = null, episode = null } = {}) {
    const saved = lampacChoice(item.id);
    const series = item.kind === "series";
    const progress = progressForTitle(item);
    let wantSeason = Number(season || progress?.seasonNumber || 1);
    let wantEpisode = Number(episode || progress?.episodeNumber || 0);
    // A series opens in two steps: first season and episode (from TMDB, instant), then source
    // and voice. Sources are searched in the background while the episode is being picked.
    // Coming from a specific episode on the page skips straight to the second step.
    let step = series && !episode ? "episode" : "source";
    // Real seasons and episode names come from TMDB, looked up while sources are searched.
    const tmdbShow = series ? cvTmdbShow(item).catch(() => null) : Promise.resolve(null);
    const tmdbShowSoon = () => Promise.race([tmdbShow, new Promise((resolve) => window.setTimeout(() => resolve(null), 4000))]);
    const sources = [];
    const pending = new Map();
    let active = "";
    let token = 0;
    let closed = false;
    let finished = false;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal player-choice-modal lampac-modal" role="dialog" aria-modal="true" aria-labelledby="lampac-title"><div class="modal-head"><div><div class="eyebrow">Где смотреть</div><h2 id="lampac-title">${escapeHtml(item.title)}</h2></div><button class="icon-button" id="lampac-close" type="button" aria-label="Закрыть">${uiIcon("close")}</button></div><div class="lampac-step" id="lampac-step" hidden></div><div class="lampac-picked" id="lampac-picked" hidden></div><div class="lampac-label lampac-sources-label">Источник</div><div class="lampac-sources" id="lampac-sources" role="tablist" aria-label="Источники"></div><div class="lampac-status is-busy" id="lampac-status" role="status" aria-live="polite"><span class="loading-spinner" aria-hidden="true"></span><span>Ищу источники…</span></div><div class="lampac-body" id="lampac-body">${lampacSkeleton()}</div></section></div>`;
    const sourcesRoot = $("#lampac-sources");
    const stepRoot = $("#lampac-step");
    const pickedRoot = $("#lampac-picked");
    const modalBox = $(".lampac-modal");
    const statusRoot = $("#lampac-status");
    const body = $("#lampac-body");
    const close = () => { closed = true; modalRoot.innerHTML = ""; };
    $("#lampac-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
    const setStatus = (text, { busy = false, share = null } = {}) => {
      statusRoot.hidden = !text;
      statusRoot.classList.toggle("is-busy", Boolean(text && busy));
      statusRoot.innerHTML = text ? `${busy ? `<span class="loading-spinner" aria-hidden="true"></span>` : ""}<span>${text}</span>${share === null ? "" : `<span class="lampac-progress" aria-hidden="true"><i style="width:${Math.round(share * 100)}%"></i></span>`}` : "";
    };
    // Something the viewer asked for is loading: the pressed button spins, the rest of the
    // window is dimmed and locked, and after a while it says the source is just slow.
    let busyDone = null;
    const busy = (trigger, text) => {
      busyDone?.();
      body.classList.add("is-loading");
      body.setAttribute("aria-busy", "true");
      trigger?.classList.add("is-loading");
      setStatus(text, { busy: true });
      const slow = window.setTimeout(() => {
        if (busyDone === done) setStatus(`${text} <em class="lampac-slow">Источник отвечает медленно. Можно подождать или выбрать другой источник выше.</em>`, { busy: true });
      }, 7000);
      const done = () => {
        window.clearTimeout(slow);
        body.classList.remove("is-loading");
        body.removeAttribute("aria-busy");
        trigger?.classList.remove("is-loading");
        if (busyDone === done) busyDone = null;
      };
      busyDone = done;
      return done;
    };
    const renderSources = () => {
      sourcesRoot.innerHTML = sources.map((source) => `<button class="filter-button${source.id === active ? " is-active" : ""}" type="button" role="tab" aria-selected="${source.id === active}" data-lampac-source="${escapeHtml(source.id)}">${escapeHtml(source.name)}${source.lines ? `<span class="lampac-quality" title="Лучшее качество у этого источника; у отдельных озвучек и серий может быть ниже">до ${lampacQualityLabel(source.lines)}</span>` : ""}</button>`).join("") + (pending.size ? `<span class="filter-button lampac-pending" title="${escapeHtml([...pending.values()].join(", "))}"><span class="loading-spinner" aria-hidden="true"></span>${sources.length ? "Проверяю ещё" : "Проверяю"} ${countWord(pending.size, "источник", "источника", "источников")}…</span>` : "");
      const note = stepRoot.querySelector("[data-lampac-bg]");
      if (note) note.innerHTML = lampacBackgroundNote();
      const current = sourcesRoot.querySelector(".is-active");
      if (current && sourcesRoot.scrollWidth > sourcesRoot.clientWidth) {
        const left = current.offsetLeft - sourcesRoot.offsetLeft;
        if (left < sourcesRoot.scrollLeft || left + current.offsetWidth > sourcesRoot.scrollLeft + sourcesRoot.clientWidth) sourcesRoot.scrollLeft = Math.max(0, left - 16);
      }
    };
    const progressKey = (seasonNumber, episodeNumber) => lampacProgressKey(item, seasonNumber, episodeNumber);
    const play = async (list, index, { voiceName = "", isMovie = false, trigger = null, voices = null, seasons = null } = {}) => {
      const mine = ++token;
      const done = busy(trigger, `Открываю видео: ${escapeHtml(list[index].label)}${voiceName && !isMovie ? `, ${escapeHtml(voiceName)}` : ""}…`);
      try {
        const first = await lampacStream(list[index].entry);
        if (closed || mine !== token) return;
        done();
        if (!first.stream) throw new Error("источник не отдал ссылку");
        rememberLampacChoice({ source: active, voice: voiceName || "" }, item.id);
        modalRoot.innerHTML = "";
        closed = true;
        startLampacPlayer(item, list, index, first, { voiceName, isMovie, sourceId: active, voices, seasons });
      } catch (error) {
        if (closed || mine !== token) return;
        done();
        setStatus(`Видео не открылось: ${escapeHtml(error.message || "ошибка")}. Попробуйте другую озвучку или источник.`);
      }
    };
    const sourceName = () => sources.find((source) => source.id === active)?.name || "";
    const resumeNote = (seasonNumber, episodeNumber) => {
      const record = state.progress[progressKey(seasonNumber, episodeNumber)];
      if (!record?.duration) return "";
      if (record.completed) return "Просмотрено";
      // A few seconds in is not a real stop: the film was only opened.
      if (Number(record.position || 0) < 15) return "";
      return `Остановились на ${formatTime(record.position)}`;
    };
    // A film: pick a voice (the one chosen before is preselected), then one "Смотреть"
    // button starts it. Picking only selects, so the button is the single way to play.
    const renderMovie = (node) => {
      const voices = node.data;
      const list = voices.map((entry, index) => ({ entry, label: entry.translate || entry.title || `Вариант ${index + 1}`, note: [...new Set([entry.maxquality, entry.voice_name].filter(Boolean))].join(" · ") }));
      const remembered = list.findIndex((entry) => saved.voice && entry.label === saved.voice);
      let chosen = Math.max(0, remembered);
      const resume = resumeNote(null, null);
      const resuming = resume && resume !== "Просмотрено";
      const startLabel = () => `${resuming ? "Продолжить" : "Смотреть"} · ${escapeHtml(list[chosen].label)}`;
      body.innerHTML = `<button class="primary-button lampac-start" type="button" data-lampac-start>${playerIcon("play")}<span data-start-label>${startLabel()}</span><em>${escapeHtml(sourceName())}</em>${resuming ? `<small>${escapeHtml(resume)}</small>` : ""}</button>${qualityPickMarkup(sources.find((one) => one.id === active)?.lines)}<div class="lampac-label">Озвучка</div><div class="lampac-voices" role="radiogroup" aria-label="Озвучка">${list.map((entry, index) => `<button class="lampac-voice${index === chosen ? " is-active" : ""}" type="button" role="radio" aria-checked="${index === chosen}" data-lampac-voice-pick="${index}"><span class="lampac-voice-mark" aria-hidden="true"></span><span class="lampac-voice-copy"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.note || "Качество выбирается в плеере")}</small></span>${index === remembered ? `<span class="player-choice-badge">Вы выбирали</span>` : ""}</button>`).join("")}</div>`;
      const start = body.querySelector("[data-lampac-start]");
      start.addEventListener("click", () => play(list, chosen, { voiceName: list[chosen].label, isMovie: true, trigger: start }));
      body.querySelectorAll("[data-lampac-voice-pick]").forEach((button) => {
        button.addEventListener("click", () => {
          chosen = Number(button.dataset.lampacVoicePick);
          body.querySelectorAll("[data-lampac-voice-pick]").forEach((other) => {
            const on = other === button;
            other.classList.toggle("is-active", on);
            other.setAttribute("aria-checked", String(on));
          });
          start.querySelector("[data-start-label]").innerHTML = startLabel();
        });
        button.addEventListener("dblclick", () => start.click());
      });
      start.focus();
    };
    const renderEpisodes = (node, seasons, seasonNumber) => {
      const voices = Array.isArray(node.voice) ? node.voice : [];
      const activeVoice = voices.find((voice) => voice.active)?.name || "";
      const list = node.data.map((entry, index) => {
        const s = Number(entry.s || seasonNumber);
        const e = Number(entry.e || index + 1);
        return { entry, s, e, label: entry.name || `${e} серия`, note: resumeNote(s, e) };
      });
      // Episode names and stills from TMDB: tooltips here, names and the next-episode card in the player.
      tmdbShow.then((show) => (show ? cvTmdbEpisodes(show.id, seasonNumber) : null)).then((names) => {
        if (!names) return;
        list.forEach((entry, position) => {
          const info = names[entry.e];
          if (!info) return;
          entry.title = info.name;
          entry.still = info.still;
          const button = body.querySelector(`[data-lampac-episode="${position}"]`);
          if (button && info.name) button.title = `${entry.label}: ${info.name}`;
        });
      }).catch(() => {});
      // Where to start: the episode stopped on (or the next after a finished one), else the first.
      const picked = series && step === "source" && wantEpisode > 0;
      let start = list.findIndex((entry) => entry.s === wantSeason && entry.e === wantEpisode);
      if (picked && start < 0) {
        const voiceTabsMissing = voices.length > 1 ? `<div class="lampac-label">Другие озвучки этого источника</div><div class="season-tabs lampac-tabs">${voices.map((voice, index) => `<button class="filter-button${voice.active ? " is-active" : ""}" type="button" data-lampac-voice="${index}">${escapeHtml(voice.name)}</button>`).join("")}</div>` : "";
        body.innerHTML = `<p class="player-choice-empty">В этом источнике${activeVoice ? ` с озвучкой «${escapeHtml(activeVoice)}»` : ""} нет ${wantEpisode} серии ${wantSeason} сезона. Выберите другую озвучку или источник выше.</p>${voiceTabsMissing}`;
        body.querySelectorAll("[data-lampac-voice]").forEach((button) => button.addEventListener("click", () => {
          const voice = voices[Number(button.dataset.lampacVoice)];
          rememberLampacChoice({ voice: voice.name }, item.id);
          if (voice.url) loadNode(voice.url, seasons, seasonNumber, { trigger: button, text: `Переключаю озвучку на «${escapeHtml(voice.name)}»…` });
        }));
        return;
      }
      const startRecord = start >= 0 ? state.progress[progressKey(list[start].s, list[start].e)] : null;
      if (!picked && start >= 0 && startRecord?.completed && list[start + 1]) start += 1;
      const resuming = start >= 0 && Boolean(resumeNote(list[start].s, list[start].e));
      if (start < 0) start = 0;
      const startNote = resumeNote(list[start].s, list[start].e);
      const startButton = `<button class="primary-button lampac-start" type="button" data-lampac-start>${playerIcon("play")}<span>${resuming && startNote !== "Просмотрено" ? "Продолжить" : "Смотреть"} · ${seasons.length > 1 ? `${list[start].s} сезон, ` : ""}${escapeHtml(list[start].label)}${activeVoice ? `, ${escapeHtml(activeVoice)}` : ""}</span><em>${escapeHtml(sourceName())}</em>${startNote && startNote !== "Просмотрено" ? `<small>${escapeHtml(startNote)}</small>` : ""}</button>${qualityPickMarkup(sources.find((one) => one.id === active)?.lines)}`;
      const seasonTabs = seasons.length > 1 ? `<div class="lampac-label">Сезон</div><div class="season-tabs lampac-tabs">${seasons.map((entry, index) => `<button class="filter-button${lampacNumber(entry, index + 1) === seasonNumber ? " is-active" : ""}" type="button" data-lampac-season="${index}">${escapeHtml(entry.name || `${index + 1} сезон`)}</button>`).join("")}</div>` : "";
      const voiceTabs = voices.length ? `<div class="lampac-label">Озвучка</div><div class="season-tabs lampac-tabs">${voices.map((voice, index) => `<button class="filter-button${voice.active ? " is-active" : ""}" type="button" data-lampac-voice="${index}">${escapeHtml(voice.name)}${voice.active ? `<span class="lampac-quality" data-voice-quality hidden></span>` : ""}</button>`).join("")}</div>` : "";
      const episodes = list.map((entry, index) => {
        const record = state.progress[progressKey(entry.s, entry.e)];
        const share = record?.duration ? Math.min(100, (record.position / record.duration) * 100) : 0;
        const classes = ["lampac-episode", index === start ? "is-current" : "", record?.completed ? "is-watched" : ""].filter(Boolean).join(" ");
        return `<button class="${classes}" type="button" data-lampac-episode="${index}" title="Смотреть: ${escapeHtml(entry.label)}"><span class="lampac-episode-play" aria-hidden="true">${playerIcon("play")}</span><span>${escapeHtml(entry.label)}</span>${share && !record.completed ? `<i style="width:${share.toFixed(1)}%"></i>` : ""}</button>`;
      }).join("");
      body.innerHTML = picked ? `${startButton}${voiceTabs}` : `${startButton}${voiceTabs}${seasonTabs}<div class="lampac-label">Серии — нажмите, чтобы смотреть</div><div class="lampac-episodes">${episodes}</div>`;
      body.querySelector("[data-lampac-start]").addEventListener("click", (event) => play(list, start, { voiceName: activeVoice, trigger: event.currentTarget, voices, seasons }));
      // The source badge is its best; what this voice really gives is checked on its first episode.
      const qualityMark = body.querySelector("[data-voice-quality]");
      if (qualityMark && list[0]) {
        const mine = token;
        lampacSourceQuality({ type: "episode", data: [list[0].entry] }).then((lines) => {
          if (!lines || mine !== token || !qualityMark.isConnected) return;
          qualityMark.textContent = lampacQualityLabel(lines);
          qualityMark.hidden = false;
        }).catch(() => {});
      }
      body.querySelectorAll("[data-lampac-season]").forEach((button) => button.addEventListener("click", () => {
        const index = Number(button.dataset.lampacSeason);
        loadNode(seasons[index].url, seasons, lampacNumber(seasons[index], index + 1), { trigger: button, text: `Загружаю серии: ${escapeHtml(button.textContent.trim())}…` });
      }));
      body.querySelectorAll("[data-lampac-voice]").forEach((button) => button.addEventListener("click", () => {
        const voice = voices[Number(button.dataset.lampacVoice)];
        rememberLampacChoice({ voice: voice.name }, item.id);
        if (voice.url) loadNode(voice.url, seasons, seasonNumber, { trigger: button, text: `Переключаю озвучку на «${escapeHtml(voice.name)}»…` });
      }));
      body.querySelectorAll("[data-lampac-episode]").forEach((button) => button.addEventListener("click", () => {
        if (picked) return;
        play(list, Number(button.dataset.lampacEpisode), { voiceName: activeVoice, trigger: button, voices, seasons });
      }));
      body.querySelector("[data-lampac-start]").focus();
    };
    // A source's episode list opens on its default voice; switch once to the one chosen before.
    const loadNode = async (url, seasons, seasonNumber, { preferSavedVoice = false, trigger = null, text = "Загружаю серии и озвучки…" } = {}) => {
      const mine = ++token;
      const done = busy(trigger, text);
      try {
        let node = await lampacJson(url);
        if (preferSavedVoice && node?.type === "episode" && saved.voice) {
          const voice = (node.voice || []).find((entry) => entry.name === saved.voice && !entry.active && entry.url);
          if (voice) node = await lampacJson(voice.url);
        }
        if (closed || mine !== token) return;
        done();
        setStatus("");
        if (node?.type === "episode" && node.data?.length) return renderEpisodes(node, seasons, seasonNumber);
        if (node?.type === "season" && node.data?.length) return openSeasons(node);
        body.innerHTML = `<p class="player-choice-empty">Здесь пусто. Выберите другой источник.</p>`;
      } catch {
        if (closed || mine !== token) return;
        done();
        setStatus("Источник не ответил. Выберите другой источник выше или нажмите ещё раз.");
      }
    };
    const openSeasons = async (node) => {
      const mine = token;
      const show = await tmdbShowSoon();
      if (closed || mine !== token) return;
      const fitting = show?.maxSeason ? node.data.filter((entry, position) => lampacNumber(entry, position + 1) <= show.maxSeason) : node.data;
      const seasons = fitting.length ? fitting : node.data;
      const index = Math.max(0, seasons.findIndex((entry, position) => lampacNumber(entry, position + 1) === wantSeason));
      loadNode(seasons[index].url, seasons, lampacNumber(seasons[index], index + 1), { preferSavedVoice: true });
    };
    const lampacBackgroundNote = () => {
      if (pending.size || !finished) return `<span class="loading-spinner" aria-hidden="true"></span><span>Пока выбираете — ищу источники и озвучки${sources.length ? `: уже ${countWord(sources.length, "источник", "источника", "источников")}` : "…"}</span>`;
      return sources.length ? `<span class="lampac-bg-ready" aria-hidden="true">✓</span><span>Готово: ${countWord(sources.length, "источник", "источника", "источников")}</span>` : `<span>Источники не нашли этот сериал.</span>`;
    };
    const episodeLabel = (s, e, name = "") => `${s} сезон, ${e} серия${name ? ` «${escapeHtml(name)}»` : ""}`;
    const showPicked = (s, e, name = "") => {
      if (!series || !e) return;
      pickedRoot.hidden = false;
      pickedRoot.innerHTML = `<div><small>Шаг 2 из 2 · источник и озвучка</small><strong data-picked-label>${episodeLabel(s, e, name)}</strong></div><button class="secondary-button lampac-change" type="button" data-lampac-change>Сменить серию</button>`;
      pickedRoot.querySelector("[data-lampac-change]").addEventListener("click", () => showEpisodeStep(s));
      if (!name) tmdbShow.then((show) => (show ? cvTmdbEpisodes(show.id, s) : null)).then((names) => {
        const label = pickedRoot.querySelector("[data-picked-label]");
        if (names?.[e]?.name && label && wantSeason === s && wantEpisode === e) label.innerHTML = episodeLabel(s, e, names[e].name);
      }).catch(() => {});
    };
    const goToSource = (s, e, name = "") => {
      wantSeason = s;
      wantEpisode = e;
      step = "source";
      stepRoot.hidden = true;
      stepRoot.innerHTML = "";
      modalBox.classList.remove("is-episode-step");
      showPicked(s, e, name);
      if (active) select(active);
      else body.innerHTML = lampacSkeleton();
      if (!active) setStatus(sources.length ? "" : "Ищу источники…", { busy: !sources.length });
    };
    const showEpisodeStep = async (seasonToShow = wantSeason) => {
      step = "episode";
      token += 1;
      busyDone?.();
      modalBox.classList.add("is-episode-step");
      pickedRoot.hidden = true;
      stepRoot.hidden = false;
      stepRoot.innerHTML = `<div class="lampac-step-head"><small>Шаг 1 из 2</small><strong>Выберите серию</strong></div>${lampacSkeleton()}<p class="lampac-bg-note" data-lampac-bg>${lampacBackgroundNote()}</p>`;
      const show = await tmdbShow;
      if (closed || step !== "episode") return;
      if (!show?.seasons?.length) { goToSource(wantSeason, wantEpisode || 0); return; }
      const seasonsList = show.seasons;
      const current = seasonsList.some((one) => one.season_number === seasonToShow) ? seasonToShow : seasonsList[0].season_number;
      const resumeS = Number(progress?.seasonNumber || 0);
      const resumeE = Number(progress?.episodeNumber || 0);
      const resumeRecord = resumeS && resumeE ? state.progress[progressKey(resumeS, resumeE)] : null;
      let resume = "";
      if (resumeS && resumeE && !resumeRecord?.completed) {
        resume = `<button class="primary-button lampac-start" type="button" data-lampac-pick="${resumeS}:${resumeE}">${playerIcon("play")}<span>Продолжить · ${resumeS} сезон, ${resumeE} серия</span>${resumeNote(resumeS, resumeE) ? `<small>${escapeHtml(resumeNote(resumeS, resumeE))}</small>` : ""}</button>`;
      } else if (resumeS && resumeE) {
        const inSeason = Number(seasonsList.find((one) => one.season_number === resumeS)?.episode_count || 0);
        const nextSeason = seasonsList.find((one) => one.season_number > resumeS);
        const [nextS, nextE] = resumeE < inSeason ? [resumeS, resumeE + 1] : nextSeason ? [nextSeason.season_number, 1] : [0, 0];
        if (nextS) resume = `<button class="primary-button lampac-start" type="button" data-lampac-pick="${nextS}:${nextE}">${playerIcon("play")}<span>Дальше · ${nextS} сезон, ${nextE} серия</span><small>${resumeS} сезон, ${resumeE} серия просмотрена</small></button>`;
      }
      const tabs = seasonsList.length > 1 ? `<div class="lampac-label">Сезон</div><div class="lampac-season-row">${seasonsList.map((one) => `<button class="filter-button${one.season_number === current ? " is-active" : ""}" type="button" data-lampac-step-season="${one.season_number}">${one.season_number} сезон</button>`).join("")}</div>` : "";
      const count = Number(seasonsList.find((one) => one.season_number === current)?.episode_count || 0);
      const cells = (names = {}) => Array.from({ length: count }, (unused, position) => {
        const e = position + 1;
        const record = state.progress[progressKey(current, e)];
        const share = record?.duration ? Math.min(100, (record.position / record.duration) * 100) : 0;
        const name = names[e]?.name || "";
        const classes = ["lampac-step-episode", current === resumeS && e === resumeE ? "is-current" : "", record?.completed ? "is-watched" : ""].filter(Boolean).join(" ");
        return `<button class="${classes}" type="button" data-lampac-pick="${current}:${e}" data-name="${escapeHtml(name)}"><b>${e}</b><span>${name ? escapeHtml(name) : `${e} серия`}</span>${share && !record.completed ? `<i style="width:${share.toFixed(1)}%"></i>` : ""}</button>`;
      }).join("");
      const paint = (names) => {
        stepRoot.innerHTML = `<div class="lampac-step-head"><small>Шаг 1 из 2</small><strong>Выберите серию</strong></div>${resume}${tabs}<div class="lampac-label">${current} сезон · ${countWord(count, "серия", "серии", "серий")}</div><div class="lampac-step-episodes">${cells(names)}</div><p class="lampac-bg-note" data-lampac-bg>${lampacBackgroundNote()}</p>`;
        const row = stepRoot.querySelector(".lampac-season-row");
        const on = row?.querySelector(".is-active");
        if (row && on) row.scrollLeft = Math.max(0, on.offsetLeft - row.offsetLeft - row.clientWidth / 2 + on.offsetWidth / 2);
        stepRoot.querySelectorAll("[data-lampac-step-season]").forEach((button) => button.addEventListener("click", () => showEpisodeStep(Number(button.dataset.lampacStepSeason))));
        stepRoot.querySelectorAll("[data-lampac-pick]").forEach((button) => button.addEventListener("click", () => {
          const [s, e] = button.dataset.lampacPick.split(":").map(Number);
          goToSource(s, e, button.dataset.name || "");
        }));
      };
      paint({});
      const names = await cvTmdbEpisodes(show.id, current).catch(() => null);
      if (names && !closed && step === "episode" && stepRoot.querySelector(`[data-lampac-pick^="${current}:"]`)) paint(names);
    };
    const select = (id) => {
      const source = sources.find((entry) => entry.id === id);
      if (!source) return;
      active = id;
      token += 1;
      busyDone?.();
      renderSources();
      if (step === "episode") return;
      setStatus(finished ? "" : `Ищу ещё источники… найдено ${sources.length}`, { busy: !finished });
      if (source.node.type === "movie") renderMovie(source.node);
      else if (source.node.type === "season") { body.innerHTML = lampacSkeleton(); busy(null, `Загружаю серии и озвучки: ${escapeHtml(source.name)}…`); openSeasons(source.node); }
      else renderEpisodes(source.node, [], wantSeason);
    };
    sourcesRoot.addEventListener("click", (event) => {
      const button = event.target.closest("[data-lampac-source]");
      if (button) select(button.dataset.lampacSource);
    });
    if (step === "episode") showEpisodeStep();
    else showPicked(wantSeason, wantEpisode);
    // While sources are being checked the viewer sees how far it got, not a frozen spinner.
    const search = { done: 0, total: 0, over: false, startedAt: Date.now() };
    const showSearch = () => {
      if (search.over || finished || closed) return;
      if (active && !statusRoot.textContent.startsWith("Ищу") && !statusRoot.textContent.startsWith("Проверяю") && !statusRoot.hidden) return;
      const share = search.total ? search.done / search.total : null;
      const counted = search.total ? `проверено ${search.done} из ${search.total}` : "";
      const text = sources.length
        ? `Ищу ещё источники… найдено ${sources.length}${counted ? `, ${counted}` : ""}`
        : search.total && search.done >= search.total ? "Жду ответа от источников…" : `Проверяю источники${counted ? `: ${search.done} из ${search.total}` : "…"}`;
      const slowNote = !sources.length && Date.now() - search.startedAt > 8000 ? ` <em class="lampac-slow">Источники иногда отвечают до полуминуты — окно не зависло.</em>` : "";
      setStatus(text + slowNote, { busy: true, share });
    };
    window.setTimeout(() => { if (!sources.length) showSearch(); }, 8500);
    (async () => {
      const lookups = [];
      const lookup = async (entry) => {
        const id = String(entry.balanser || entry.name || entry.url);
        pending.set(id, entry.name || id);
        renderSources();
        try {
          // The list gives bare source addresses; the title's ids go on top, as Lampa does.
          const url = new URL(entry.url, lampacOrigin());
          lampacQuery(item).forEach((value, key) => { if (!url.searchParams.has(key)) url.searchParams.set(key, value); });
          const node = await lampacResolve(url.href, item);
          pending.delete(id);
          if (closed) return;
          if (!node) { renderSources(); return; }
          const source = { id, name: entry.name || id, node, lines: 0 };
          sources.push(source);
          renderSources();
          lampacSourceQuality(node).then((lines) => {
            if (!lines || closed) return;
            source.lines = lines;
            renderSources();
          }).catch(() => {});
          if (!active || (id === saved.source && !body.dataset.touched)) select(id);
          else showSearch();
        } catch {
          pending.delete(id);
          if (!closed) renderSources();
        }
      };
      const listed = await lampacSourceList(item, (entries) => {
        entries.forEach((entry) => lookups.push(lookup(entry)));
      }, () => closed, (done, total) => { search.done = done; search.total = total; showSearch(); }).catch(() => 0);
      search.over = true;
      if (closed) return;
      if (!listed) {
        finished = true;
        setStatus("Сервер с источниками не отвечает.");
        body.innerHTML = `<button class="secondary-button" type="button" data-lampac-retry>Повторить</button>`;
        body.querySelector("[data-lampac-retry]").addEventListener("click", () => { closed = true; openLampacChooser(item, { season, episode }); });
        return;
      }
      await Promise.all(lookups);
      if (closed) return;
      finished = true;
      renderSources();
      if (!sources.length) {
        setStatus("");
        body.innerHTML = `<p class="player-choice-empty">Ни один источник пока не нашёл «${escapeHtml(item.title)}». Новинки обычно появляются в течение нескольких дней.</p><button class="secondary-button" type="button" data-lampac-retry>Повторить</button>`;
        body.querySelector("[data-lampac-retry]").addEventListener("click", () => { closed = true; openLampacChooser(item, { season, episode }); });
      } else if (statusRoot.textContent.startsWith("Ищу ещё")) {
        setStatus("");
      }
    })();
    body.addEventListener("click", () => { body.dataset.touched = "1"; });
    bindQualityPick(body);
    sourcesRoot.addEventListener("click", () => { body.dataset.touched = "1"; });
  }





  // Rutube trailers come from the server (works without VPN); YouTube ones
  // come from TMDB in the browser, which needs a VPN in Russia.
  async function rutubeTrailers(item) {
    const params = new URLSearchParams({ title: item.title || "", original: item.originalTitle || "", year: String(item.year || "") });
    const response = await apiFetch(`/api/trailers?${params}`, { headers: { accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return (payload.items || []).map((trailer) => ({ ...trailer, label: trailer.author || "Rutube" }));
  }
  async function tmdbRequest(path) {
    if (!tmdbCredential) throw new Error("нет ключа TMDB");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
      const bearer = tmdbCredential.startsWith("eyJ");
      const url = new URL(`https://api.themoviedb.org/3/${path}`);
      if (!bearer) url.searchParams.set("api_key", tmdbCredential);
      const response = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${tmdbCredential}`, accept: "application/json" } : { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { window.clearTimeout(timer); }
  }
  async function youtubeTrailers(item) {
    const kind = item.kind === "series" ? "tv" : "movie";
    let tmdbId = Number(item.tmdbId || 0);
    if (!tmdbId) {
      const query = encodeURIComponent(item.originalTitle || item.title || "");
      const yearParam = item.year ? `&${kind === "tv" ? "first_air_date_year" : "year"}=${Number(item.year)}` : "";
      const found = await cvTmdb(`search/${kind}?query=${query}${yearParam}&language=ru-RU`);
      tmdbId = Number(found.results?.[0]?.id || 0);
    }
    if (!tmdbId) return [];
    const [ru, en] = await Promise.all([
      cvTmdb(`${kind}/${tmdbId}/videos?language=ru-RU`).catch(() => ({})),
      cvTmdb(`${kind}/${tmdbId}/videos?language=en-US`).catch(() => ({})),
    ]);
    const seen = new Set();
    const all = [...(ru.results || []), ...(en.results || [])];
    return all
      // Trailers only: no teasers, clips, featurettes or vertical shorts.
      // Trailers first; a film that is not out yet often has only a teaser, then that is shown.
      .filter((video) => video.site === "YouTube" && /^[\w-]{6,20}$/.test(video.key)
        && (video.type === "Trailer" || (video.type === "Teaser" && !all.some((other) => other.site === "YouTube" && other.type === "Trailer")))
        && !/#?shorts?\b|tv spot|реакция|reaction|обзор|review/i.test(String(video.name || ""))
        && (video.type === "Teaser" || !/тизер|teaser/i.test(String(video.name || "")))
        && !seen.has(video.key) && seen.add(video.key))
      .sort((a, b) => (b.iso_639_1 === "ru") - (a.iso_639_1 === "ru") || (b.type === "Trailer") - (a.type === "Trailer") || (b.official === true) - (a.official === true) || Number(b.size || 0) - Number(a.size || 0))
      .slice(0, 4)
      .map((video) => ({ id: video.key, title: video.name, label: video.iso_639_1 === "ru" ? "YouTube · русский" : "YouTube · оригинал", embedUrl: `https://www.youtube-nocookie.com/embed/${video.key}?autoplay=1&rel=0&modestbranding=1` }));
  }

  async function openTrailer(item, source = state.trailerSource === "youtube" ? "youtube" : "rutube") {
    if (!item) return;
    state.trailerSource = source;
    saveState();
    const tab = (id, label) => `<button class="${source === id ? "is-active" : ""}" data-trailer-source="${id}" type="button" role="tab" aria-selected="${source === id}">${label}</button>`;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal trailer-modal" role="dialog" aria-modal="true" aria-labelledby="trailer-title"><div class="modal-head"><div><div class="eyebrow">Трейлер</div><h2 id="trailer-title">${escapeHtml(item.title)}</h2></div><div class="trailer-head-actions"><div class="trailer-sources" role="tablist" aria-label="Источник трейлера">${tab("rutube", "Rutube")}${tab("youtube", "YouTube")}</div><button class="icon-button" id="trailer-close" type="button" aria-label="Закрыть">${uiIcon("close")}</button></div></div><div class="provider-frame external-embed-frame trailer-frame" id="trailer-frame"><div class="trailer-status"><span class="loading-spinner" aria-hidden="true"></span> Ищу трейлер…</div></div><div class="trailer-alternatives" id="trailer-alternatives"></div></section></div>`;
    let closed = false;
    const close = () => { closed = true; modalRoot.innerHTML = ""; };
    $("#trailer-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
    $$("[data-trailer-source]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.trailerSource === source) return;
      closed = true;
      openTrailer(item, button.dataset.trailerSource);
    }));
    const searchQuery = encodeURIComponent(`${item.title} ${item.year || ""} трейлер`.trim());
    const fallback = (note) => `<div class="trailer-status"><p>${note}</p><div class="hero-actions"><a class="secondary-button" href="https://rutube.ru/search/?query=${searchQuery}" target="_blank" rel="noopener noreferrer">Искать на Rutube${uiIcon("external")}</a><a class="secondary-button" href="https://www.youtube.com/results?search_query=${searchQuery}" target="_blank" rel="noopener noreferrer">Искать на YouTube${uiIcon("external")}</a></div></div>`;
    let trailers = [];
    try {
      trailers = source === "youtube" ? await youtubeTrailers(item) : await rutubeTrailers(item);
    } catch {
      if (!closed) $("#trailer-frame").innerHTML = fallback(source === "youtube" ? "YouTube недоступен. Включите VPN или выберите Rutube." : "Не удалось найти трейлер.");
      return;
    }
    if (closed) return;
    if (!trailers.length) {
      $("#trailer-frame").innerHTML = fallback("Трейлер не нашёлся автоматически.");
      return;
    }
    const show = (index) => {
      $("#trailer-frame").innerHTML = `<iframe title="Трейлер: ${escapeHtml(item.title)}" src="${escapeHtml(trailers[index].embedUrl)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      $$("[data-trailer-index]").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.trailerIndex) === index));
    };
    $("#trailer-alternatives").innerHTML = trailers.length > 1 ? trailers.map((trailer, index) => `<button class="trailer-option" data-trailer-index="${index}" type="button"><strong>${escapeHtml(trailer.title)}</strong><small>${escapeHtml(trailer.label)}${trailer.duration ? ` · ${formatTime(trailer.duration)}` : ""}</small></button>`).join("") : "";
    $$("[data-trailer-index]").forEach((button) => button.addEventListener("click", () => show(Number(button.dataset.trailerIndex))));
    show(0);
  }


  // The one way into watching: own library files play in the library player, everything
  // else opens the Lampac window (source, voice, season, episode) and its player.
  function openWatch(item, { season = null, episode = null } = {}) {
    if (!item) return;
    rememberTasteInteraction(item, "played");
    const seasonNumber = season != null ? Number(season) : null;
    const episodeNumber = episode != null ? Number(episode) : null;
    const localEpisode = libraryEpisodeFor(item, seasonNumber, episodeNumber);
    if (localEpisode) return openLibraryPlayer(localEpisode);
    if (isShowcase() || !lampacOrigin() || !hasPlayableSource(item)) return openTrailer(item);
    openLampacChooser(item, { season: seasonNumber, episode: episodeNumber });
  }
  function watchButton(item, label = "Смотреть") {
    if (hasPlayableSource(item)) return `<button class="primary-button" data-play-media="${escapeHtml(item.id)}" type="button">${escapeHtml(label)}</button>`;
    return "";
  }
  function playbackPreferencesMarkup(item) {
    return "";
  }
  // Home shelves are intentionally fetched separately from the current
  // catalogue page. Include them here as well, otherwise a fresh card can be
  // rendered as a link but its click has no in-memory item to open.
  function getTitle(id) {
    return catalog.find((item) => item.id === id)
      || upcomingCatalog.find((item) => item.id === id)
      || discoveryCatalog.find((item) => item.id === id)
      || freshCatalog.find((item) => item.id === id)
      || worldTrendingCatalog.find((item) => item.id === id)
      || savedTitlesCatalog.find((item) => item.id === id)
      || searchSuggestionCatalog.find((item) => item.id === id)
      || looseTitles.find((item) => item.id === id)
      || audienceCatalog.find((item) => item.id === id)
      || progressCatalog.find((item) => item.id === id)
      || trendingCatalog.find((item) => item.id === id);
  }
  function getTitleForProgress(id, progress) { return getTitle(progress?.titleId || id) || getTitle(String(id).split("-s")[0]); }
  // Players keep episode progress differently: one record per episode ("<id>-s2e7"),
  // or one record per title that names the episode (Alloha "<id>-alt"). The episode
  // list and the season picker read all of them, newest first.
  function episodeProgressEntries(item) {
    const prefix = `${item.id}-`;
    return Object.entries(state.progress || {})
      .map(([key, progress]) => {
        if (!progress || (progress.titleId !== item.id && !key.startsWith(prefix))) return null;
        const fromKey = key.startsWith(prefix) ? key.slice(prefix.length).match(/^s(\d+)e(\d+)$/) : null;
        const episode = Number(progress.episodeNumber) || Number(fromKey?.[2]) || 0;
        if (episode <= 0) return null;
        return { key, season: Number(progress.seasonNumber) || Number(fromKey?.[1]) || 1, episode, progress };
      })
      .filter(Boolean)
      .sort((left, right) => Number(right.progress.updatedAt || 0) - Number(left.progress.updatedAt || 0));
  }

  function progressForTitle(item) {
    const direct = state.progress[item.id];
    if (direct) return { ...direct, contentId: item.id };
    return Object.entries(state.progress).map(([contentId, progress]) => ({ ...progress, contentId })).filter((progress) => progress.titleId === item.id || progress.contentId?.startsWith(`${item.id}-s`)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }
  function hasSharedHistory(item) {
    const historyIds = new Set(libraryHistory.map((entry) => entry.id));
    return state.history.includes(item.id) || Boolean(item.libraryEpisodes?.some((episode) => historyIds.has(episode.id)));
  }
  function rememberHistory(id) {
    const titleId = String(id || "").trim();
    if (!titleId) return;
    state.history = [titleId, ...state.history.filter((entry) => entry !== titleId)].slice(0, 100);
    state.historyAt = { ...(state.historyAt || {}), [titleId]: Date.now() };
  }
  function persistAndRender() { saveState(); render(); }
  // A menu of our own instead of a native <select>: Chrome on Windows would not open
  // the native list here, and this one looks and behaves the same everywhere.
  const CATALOG_SORTS = [["now", "Популярное"], ["audience", "Больше всего оценок"], ["rating", "По рейтингу"], ["year", "Сначала новые"], ["title", "По алфавиту"]];
  function catalogSortMenuMarkup() {
    if (state.catalogCollection === "upcoming") return '<span class="studio-sort-button">По числу ожидающих</span>';
    const current = CATALOG_SORTS.find(([value]) => value === state.catalogSort) || CATALOG_SORTS[0];
    const options = CATALOG_SORTS.map(([value, label]) => `<button type="button" role="option" aria-selected="${value === current[0]}" data-catalog-sort-value="${value}">${label}</button>`).join("");
    return `<div class="studio-sort" data-catalog-sort-menu><button class="studio-sort-button" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Сортировка: ${current[1]}" data-catalog-sort-toggle>${current[1]}</button><div class="studio-sort-list" role="listbox" aria-label="Сортировка" hidden>${options}</div></div>`;
  }
  function bindCatalogSortMenu() {
    const menu = $("[data-catalog-sort-menu]");
    if (!menu) return;
    const toggle = menu.querySelector("[data-catalog-sort-toggle]");
    const list = menu.querySelector(".studio-sort-list");
    const setOpen = (open) => {
      list.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) {
        list.querySelector('[aria-selected="true"]')?.focus();
        window.setTimeout(() => document.addEventListener("click", closeOnOutside), 0);
      } else {
        document.removeEventListener("click", closeOnOutside);
      }
    };
    const closeOnOutside = (event) => { if (!menu.contains(event.target)) setOpen(false); };
    toggle.addEventListener("click", () => setOpen(list.hidden));
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !list.hidden) { setOpen(false); toggle.focus(); }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !list.hidden) {
        const buttons = [...list.querySelectorAll("button")];
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        event.preventDefault();
      }
    });
    list.querySelectorAll("[data-catalog-sort-value]").forEach((button) => button.addEventListener("click", () => {
      setOpen(false);
      if (state.catalogSort === button.dataset.catalogSortValue) return;
      state.catalogSort = button.dataset.catalogSortValue;
      resetCatalogPage();
      saveState();
      loadRemoteCatalogPage(1);
    }));
  }
  function renderCatalogLoading() {
    const posters = Array.from({ length: 12 }, () => `<span class="skeleton skeleton-poster"></span>`).join("");
    page.innerHTML = `<section class="page-skeleton" role="status" aria-live="polite"><span class="sr-only">Загружаю страницу…</span><span class="skeleton skeleton-title"></span><span class="skeleton skeleton-line"></span><div class="skeleton-chips">${Array.from({ length: 6 }, () => `<span class="skeleton skeleton-chip"></span>`).join("")}</div><div class="skeleton-grid">${posters}</div></section>`;
  }


  function hydrateLazyPosters() {
    if (lazyPosterObserver) lazyPosterObserver.disconnect();
    const nodes = $$("[data-lazy-poster]");
    if (!nodes.length) return;
    const load = (node) => {
      const url = node.dataset.lazyPoster;
      if (!url || node.dataset.posterLoaded) return;
      node.style.backgroundImage = `linear-gradient(180deg, transparent 38%, rgba(0,0,0,.18)), url(${JSON.stringify(url)})`;
      node.dataset.posterLoaded = "true";
      node.removeAttribute("data-lazy-poster");
    };
    if (!("IntersectionObserver" in window)) {
      nodes.forEach(load);
      return;
    }
    lazyPosterObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      load(entry.target);
      lazyPosterObserver?.unobserve(entry.target);
    }), { rootMargin: "300px 0px" });
    nodes.forEach((node) => lazyPosterObserver.observe(node));
  }
  let catalogPaging = false;
  function scrollToCatalogResults() {
    const results = $("#catalog-results");
    if (!results) return;
    // Leave room for the fixed top bar on desktop.
    const headerOffset = window.matchMedia("(min-width: 1051px)").matches ? (parseFloat(getComputedStyle(app).getPropertyValue("--header-h")) || 0) : 0;
    const top = Math.max(0, results.getBoundingClientRect().top + window.scrollY - headerOffset - 24);
    window.scrollTo({ top, behavior: "smooth" });
    results.focus({ preventScroll: true });
  }
  function scheduleCatalogRefresh() {
    if (scheduleCatalogRefresh.pending) return;
    scheduleCatalogRefresh.pending = true;
    window.requestAnimationFrame(() => {
      scheduleCatalogRefresh.pending = false;
      if (initialCatalogReady) render();
    });
  }
  function appendCatalogBatch() {
    const grid = $("#catalog-results");
    if (!grid || progressiveCatalogNext >= progressiveCatalogItems.length) return;
    const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
    const next = Math.min(Math.ceil((progressiveCatalogNext + 12) / columns) * columns, progressiveCatalogItems.length);
    const markup = progressiveCatalogItems.slice(progressiveCatalogNext, next).map((item) => poster(item)).join("");
    // Batches go before the full-width sentinel so rows stay unbroken.
    const sentinel = $("#catalog-lazy-sentinel");
    if (sentinel) sentinel.insertAdjacentHTML("beforebegin", markup);
    else grid.insertAdjacentHTML("beforeend", markup);
    progressiveCatalogNext = next;
    hydrateLazyPosters();
    if (progressiveCatalogNext >= progressiveCatalogItems.length) {
      progressiveCatalogObserver?.disconnect();
      progressiveCatalogObserver = null;
      $("#catalog-lazy-sentinel")?.remove();
      recheckCatalogAutoMore();
    }
  }
  function hydrateProgressiveCatalog() {
    progressiveCatalogObserver?.disconnect();
    progressiveCatalogObserver = null;
    const sentinel = $("#catalog-lazy-sentinel");
    if (!sentinel || progressiveCatalogNext >= progressiveCatalogItems.length) return;
    if (!("IntersectionObserver" in window)) {
      appendCatalogBatch();
      return;
    }
    progressiveCatalogObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      appendCatalogBatch();
      if (progressiveCatalogNext < progressiveCatalogItems.length) {
        // A sentinel still in range sends no new event unless it is watched afresh.
        progressiveCatalogObserver.unobserve(sentinel);
        progressiveCatalogObserver.observe(sentinel);
      }
    }, { rootMargin: "700px 0px" });
    progressiveCatalogObserver.observe(sentinel);
  }
  function switchSeason(nextSeason) {
    const next = Math.max(1, Number(nextSeason) || 1);
    if (next === selectedSeason && !seasonTransitionTimer) return;
    clearTimeout(seasonTransitionTimer);
    const currentList = $(".episode-list");
    const renderNextSeason = () => {
      selectedSeason = next;
      episodeImagesLoading = true;
      seasonTransitionTimer = null;
      renderDetails(getTitleFromPage());
    };
    if (!currentList) return renderNextSeason();
    currentList.classList.add("is-season-leaving");
    seasonTransitionTimer = window.setTimeout(renderNextSeason, 150);
  }

  function discoveryItems() {
    return [...new Map([...worldTrendingCatalog, ...freshCatalog, ...(discoveryCatalog.length ? discoveryCatalog : catalog)].map((item) => [item.id, item])).values()];
  }

  // Today's picks for the home hero: stable for a day instead of a
  // new random title on every render.
  let homeFeatureIndex = 0;
  function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  }
  // Once the hero has shown its picks, it keeps them until the page reloads:
  // feeds that arrive later must not swap the film (and its large image) under the viewer.
  let frozenFeatureIds = null;
  let homeShelvesReleased = false;
  function homeFeaturePicks(count = 5) {
    if (lampacOrigin() && tmdbHome) {
      // As in Lampa: the day's trends with a frame and a description, unwatched first — and, when there is a
      // history, three of the five are picked for the viewer from what they watched (changing daily).
      const trends = (tmdbHome.find((row) => row.key === "trend-day")?.items || []).filter((item) => item.backdropImage && String(item.description || "").length >= 60);
      const unseen = trends.filter((item) => !hasSharedHistory(item));
      const pool = (unseen.length >= count ? unseen : trends).slice(0, 12);
      const seed = new Date().toISOString().slice(0, 10);
      const daily = [...pool].sort((left, right) => stableHash(`${seed}:${left.id}`) - stableHash(`${seed}:${right.id}`));
      const personal = (personalRecs?.top || []).filter((item) => item.backdropImage && String(item.description || "").length >= 60).slice(0, 10)
        .sort((left, right) => stableHash(`${seed}:${left.id}`) - stableHash(`${seed}:${right.id}`)).slice(0, 3);
      const mixed = [...personal, ...daily.filter((item) => !personal.some((one) => one.id === item.id))].slice(0, count);
      if (mixed.length) return mixed;
    }
    // Until the day's trends arrive there is nothing real to show: a placeholder frame, not a film
    // from the old catalogue (it flashed «Бойцовский клуб» and the like for a second).
    if (lampacOrigin() && !tmdbHome) return [];
    if (frozenFeatureIds) {
      const kept = frozenFeatureIds.map((id) => getTitle(id)).filter(Boolean);
      if (kept.length === frozenFeatureIds.length) return kept;
    }
    const seen = new Set();
    const source = [...worldTrendingCatalog, ...freshCatalog, ...trendingCatalog, ...discoveryItems()].filter((item) => item && !seen.has(item.id) && seen.add(item.id));
    const credible = source.filter(isCredibleRecommendation);
    const eligible = credible.length ? credible : source;
    const unseen = eligible.filter((item) => !hasSharedHistory(item));
    const ranked = sortPersonalRecommendations(unseen.length ? unseen : eligible);
    const withBackdrop = ranked.filter((item) => item.backdropImage && String(item.description || "").length >= 60);
    const complete = withBackdrop.length >= count ? withBackdrop : ranked.filter((item) => item.posterImage && String(item.description || "").length >= 60);
    const pool = (complete.length >= count ? complete : ranked).slice(0, 24);
    const seed = new Date().toISOString().slice(0, 10);
    const daily = [...pool].sort((left, right) => stableHash(`${seed}:${left.id}`) - stableHash(`${seed}:${right.id}`));
    const picks = rotatingFreshItems(daily, count, 0, 150);
    if (picks.length >= Math.min(count, 3)) frozenFeatureIds = picks.map((item) => item.id);
    return picks;
  }

  function featureWatchAction(item, resumable = false) {
    if (!hasPlayableSource(item)) return "";
    return `<button class="primary-button feature-play" data-play-media="${escapeHtml(item.id)}" type="button">${playerIcon("play")}<span>${resumable ? "Продолжить просмотр" : "Смотреть"}</span></button>`;
  }


  function itemMetaLine(item) {
    const length = item.kind === "series" ? (item.seasons?.length ? countWord(item.seasons.length, "сезон", "сезона", "сезонов") : "Сериал") : formatRuntime(item.runtime);
    return [item.year, ...genresForItem(item).slice(0, 2), length].filter(Boolean);
  }

  function ratingStar(item) {
    const rating = catalogRatingValue(item);
    return rating ? `<span class="rating-star">${uiIcon("star")}${rating.toFixed(1)}</span>` : "";
  }

  // Calendar dates are compared in the catalog's configured UTC+5 timezone;
  // a year alone is never converted to an invented day of release.
  function upcomingPremiere(item, now = new Date()) {
    const today = new Date(now.getTime() + 5 * 3600000).toISOString().slice(0, 10);
    const raw = String(item?.premiere || '').trim();
    if (/^\d{4}$/.test(raw) && raw > today.slice(0, 4)) return `Ожидается в ${raw} году`;
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(raw) && raw > today.slice(0, 7)) {
      const date = new Date(`${raw}-01T00:00:00Z`);
      return `Ожидается: ${new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const date = new Date(`${raw}T00:00:00Z`);
      if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw && raw > today) {
        const region = item.premiereRegion ? ` · ${item.premiereRegion}` : '';
        return `Премьера ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)}${region}`;
      }
      return '';
    }
    if (!raw && Number(item?.year) > Number(today.slice(0, 4))) return `Ожидается в ${Number(item.year)} году`;
    return '';
  }

  function awaitingPremierePlayback(item) {
    const tracked = Array.isArray(state.anticipatedPremieres) && state.anticipatedPremieres.includes(item?.id);
    return Boolean((upcomingPremiere(item) || tracked) && !libraryEpisodeFor(item) && item?.playbackVerified !== true);
  }

  function isNewRelease(item) {
    const premiere = Date.parse(String(item?.premiere || ""));
    if (!Number.isFinite(premiere)) return false;
    const age = Date.now() - premiere;
    return age >= 0 && age <= NEW_RELEASE_DAYS * 24 * 60 * 60 * 1000;
  }


  function homeFeatureMarkup(picks) {
    picks = picks.map((item) => String(item.backdropImage || '').includes('/2a0000019ac9a31de3b4565f65a725a0fdd3/') ? { ...item, backdropImage: '' } : item);
    const pick = picks[Math.min(homeFeatureIndex, picks.length - 1)] || picks[0];
    if (!pick) return lampacOrigin() && !tmdbHome ? `<section class="home-feature is-placeholder" aria-busy="true" aria-label="Загружаю"><span class="skeleton home-feature-skel-kicker"></span><span class="skeleton home-feature-skel-title"></span><span class="skeleton home-feature-skel-line"></span><span class="skeleton home-feature-skel-button"></span></section>` : "";
    const poster = pick.posterImage ? highResolutionPosterUrl(pick.posterImage) : "";
    const backdrop = pick.backdropImage || "";
    const imdb = Number(pick.imdbRating || 0);
    const age = Number(pick.ageRating || 0) > 0 ? `${Number(pick.ageRating)}+` : "";
    const favorite = state.favorites.includes(pick.id);
    const progress = progressForTitle(pick);
    const resumable = progress && !progress.completed && progress.duration > 0;
    const chip = upcomingPremiere(pick) ? "Скоро" : resumable ? "Вы остановились здесь" : pick.personalBecause ? `Похоже на «${pick.personalBecause}»` : pick.popularRank && pick.popularRank <= 10 ? `№${pick.popularRank} в популярном сейчас` : isNewRelease(pick) ? "Новинка" : "В тренде сегодня";
    const known = titleLogoUrls.get(pick.id);
    const hasLogo = typeof known === "string" && titleLogoReady.has(known);
    prefetchTitleLogos(picks);
    const title = `<h1 id="home-feature-title" class="feature-title${hasLogo ? " has-logo" : ""}${titleLogoPending(pick.id) ? " is-logo-pending" : ""}${pick.title.length > 24 ? " is-long" : ""}" data-logo-for="${escapeHtml(pick.id)}">${titleLogoMarkup(pick.id, pick.title)}</h1>`;
    // Less to read: rating, year, one genre, length — the picture and the logo say the rest.
    const line = itemMetaLine(pick);
    const meta = [ratingStar(pick), ...[line[0], line.length > 2 ? line[1] : "", line[line.length - 1]].filter((value, index, list) => value && list.indexOf(value) === index).map((value) => `<span>${escapeHtml(value)}</span>`), age ? `<span class="feature-age">${escapeHtml(age)}</span>` : ""].filter(Boolean).join("");
    const activeIndex = Math.max(0, picks.indexOf(pick));
    const nextIndex = (activeIndex + 1) % picks.length;
    const thumbs = picks.length > 1 ? `<div class="feature-pager"><span class="feature-pager-label">Далее в подборке</span><button class="feature-next" data-feature-pick="${nextIndex}" type="button">${escapeHtml(picks[nextIndex].title)}</button><div class="feature-picks" role="tablist" aria-label="Рекомендации на сегодня">${picks.map((item, index) => `<button class="feature-pick${index === activeIndex ? " is-active" : ""}" data-feature-pick="${index}" type="button" role="tab" aria-selected="${index === activeIndex}" aria-label="${escapeHtml(item.title)}"></button>`).join("")}</div></div>` : "";
    return `<section class="home-feature${backdrop ? " has-backdrop" : ""}" aria-labelledby="home-feature-title" data-feature-image="${escapeHtml(backdrop || poster)}"><div class="feature-backdrop" aria-hidden="true"></div><div class="feature-body"><div class="feature-copy"><span class="feature-chip">${escapeHtml(chip)}</span>${title}<div class="feature-meta">${meta}</div>${pick.description ? `<p class="feature-description">${escapeHtml(pick.description)}</p>` : ""}<div class="hero-actions">${featureWatchAction(pick, resumable)}<button class="secondary-button feature-icon-button" data-favorite="${escapeHtml(pick.id)}" type="button" aria-label="${favorite ? "В избранном" : "В избранное"}" title="${favorite ? "В избранном" : "В избранное"}">${uiIcon(favorite ? "check" : "plus")}</button><a class="secondary-button feature-icon-button" href="${routeForTitle(pick.id)}" data-open-title="${escapeHtml(pick.id)}" aria-label="Подробнее" title="Подробнее">${uiIcon("info")}</a></div></div>${!backdrop && poster ? `<a class="feature-poster" href="${routeForTitle(pick.id)}" data-open-title="${escapeHtml(pick.id)}" aria-hidden="true" tabindex="-1"><img src="${escapeHtml(poster)}" alt="" decoding="async"></a>` : ""}</div>${thumbs}</section>`;
  }

  function landscapeArt(item) {
    // Tiles and continue cards are at most ~340px wide: the reduced frame is plenty.
    const art = item.backdropImage ? previewImageUrl(item.backdropImage) : (item.posterImage ? previewImageUrl(highResolutionPosterUrl(item.posterImage)) : "");
    return art ? `<img class="${item.backdropImage ? "" : "is-poster"}" src="${escapeHtml(art)}" alt="" loading="lazy" decoding="async" fetchpriority="low">` : `<span class="landscape-fallback" style="${posterStyle(item)}"></span>`;
  }

  function continueCard(item, progress) {
    const ratio = progress.duration > 0 ? Math.min(1, progress.position / progress.duration) : 0;
    const episode = progress.episodeNumber ? episodeTag(progress.seasonNumber, progress.episodeNumber) : "";
    const action = `data-play-media="${escapeHtml(item.id)}"`;
    const episodeAttrs = progress.episodeNumber ? ` data-resume-season="${Number(progress.seasonNumber) || 1}" data-episode="${Number(progress.episodeNumber)}"` : "";
    return `<button class="landscape-card continue-card" ${action}${episodeAttrs} type="button"><div class="landscape-art">${landscapeArt(item)}<span class="landscape-play" aria-hidden="true">${playerIcon("play")}</span><div class="landscape-overlay"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(episode || (item.kind === "series" ? "Сериал" : "Фильм"))}</small>${progress.untracked ? "" : `<div class="continue-progress"><span>${formatTime(progress.position)}</span><i style="--progress:${Math.round(ratio * 100)}%"></i><span>${progress.duration ? formatTime(progress.duration) : ""}</span></div>`}</div></div></button>`;
  }

  function topTenShelf(items) {
    if (items.length < 5) return "";
    const description = worldTrendingCatalog.length >= 10 ? "Что смотрят в мире на этой неделе" : "По числу оценок на IMDb и Кинопоиске";
    return `<section class="discovery-shelf top-ten-shelf" aria-labelledby="shelf-top10"><div class="section-header discovery-shelf-header"><div><h2 id="shelf-top10">Топ-10</h2><p>${escapeHtml(description)}</p></div></div><div class="discovery-rail top-ten-rail">${items.slice(0, 10).map((item, index) => `<a class="top-ten-card" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}" aria-label="${index + 1}. ${escapeHtml(item.title)}"><span class="top-ten-number" aria-hidden="true">${index + 1}</span><span class="top-ten-poster">${item.posterImage ? `<img src="${escapeHtml(previewImageUrl(highResolutionPosterUrl(item.posterImage)))}" alt="" loading="lazy" decoding="async" fetchpriority="low">` : `<span style="${posterStyle(item)}"></span>`}</span></a>`).join("")}</div></section>`;
  }

  const HOME_GENRES = [["драма", "Драма"], ["комедия", "Комедия"], ["триллер", "Триллер"], ["фантастика", "Фантастика"], ["мелодрама", "Мелодрама"], ["ужасы", "Ужасы"], ["мультфильм", "Мультфильмы"], ["детектив", "Детектив"]];
  function genreTilesShelf() {
    const pool = [...trendingCatalog, ...discoveryItems()];
    const used = new Set();
    const tiles = HOME_GENRES.map(([genre, label]) => {
      const cover = pool.find((item) => !used.has(item.id) && item.backdropImage && genresForItem(item).includes(genre))
        || pool.find((item) => !used.has(item.id) && item.posterImage && genresForItem(item).includes(genre));
      if (!cover) return "";
      used.add(cover.id);
      return `<button class="genre-tile" data-home-genre="${escapeHtml(genre)}" type="button">${landscapeArt(cover)}<span class="genre-tile-copy"><strong>${escapeHtml(label)}</strong><small>Открыть</small></span></button>`;
    }).filter(Boolean);
    if (tiles.length < 4) return "";
    return `<section class="discovery-shelf" aria-labelledby="shelf-genres"><div class="section-header discovery-shelf-header"><div><h2 id="shelf-genres">Жанры</h2></div></div><div class="genre-tiles">${tiles.join("")}</div></section>`;
  }

  function recommendation() {
    const source = discoveryItems();
    const credible = source.filter(isCredibleRecommendation);
    const eligible = credible.length ? credible : source;
    const unseen = eligible.filter((item) => !hasSharedHistory(item));
    const candidates = unseen.length ? unseen : eligible;
    const ranked = sortPersonalRecommendations(candidates);
    const pool = ranked.slice(0, Math.min(24, ranked.length));
    return pool[Math.floor(Math.random() * pool.length)] || source[0];
  }

  function poster(item, extra = "") {
    const progress = progressForTitle(item);
    const progressPct = progress ? Math.min(100, Math.round((progress.position / progress.duration) * 100)) : 0;
    const genres = genresForItem(item).slice(0, 3);
    const meta = [item.year, genres[0] || (item.kind === "series" ? (item.seasons?.length ? countWord(item.seasons.length, "сезон", "сезона", "сезонов") : "") : formatRuntime(item.runtime))].filter(Boolean);
    const rating = catalogRatingValue(item);
    const posterAttrs = item.posterImage ? ` style="--poster:${escapeHtml(item.poster || "linear-gradient(145deg, #5c3b63, #221b31)")}"` : ` style="${posterStyle(item)}"`;
    const posterImage = item.posterImage ? `<img class="poster-art-image" src="${escapeHtml(previewImageUrl(highResolutionPosterUrl(item.posterImage)))}"${tmdbPosterSrcset(item.posterImage)} alt="" loading="lazy" decoding="async" fetchpriority="low" aria-hidden="true">` : "";
    const upcoming = upcomingPremiere(item);
    const premiereLabel = upcoming ? String(upcoming).replace(/^Премьера\s+/, "").split(" · ")[0].replace(/\s+г\.$/, "") : "";
    return `<a class="poster-card ${extra}" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}" aria-label="Открыть ${escapeHtml(item.title)}"><div class="poster-art"${posterAttrs}>${posterImage}${posterTitleArt(item)}${!upcoming && rating ? `<span class="poster-rating">${rating.toFixed(1)}</span>` : ""}${progress ? `<span class="progress-bar" style="--progress:${progressPct}%"><i></i></span>` : ""}</div><div class="poster-card-copy"><strong>${escapeHtml(item.title)}</strong>${upcoming ? `<small class="premiere-date" title="${escapeHtml(upcoming)}">${escapeHtml(premiereLabel)}</small>` : ''}<div class="poster-card-meta">${meta.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div><p class="poster-card-description">${escapeHtml(item.description || "Описания пока нет.")}</p><div class="poster-card-tags">${genres.map((genre) => `<span>#${escapeHtml(genre)}</span>`).join("")}</div></div></a>`;
  }

  function resumePoster(item, progress) {
    const progressPct = Math.min(100, Math.round((progress.position / progress.duration) * 100));
    const episodeText = progress.episodeNumber ? episodeTag(progress.seasonNumber, progress.episodeNumber) : "";
    const playbackAttr = `data-play-media="${escapeHtml(item.id)}"`;
    const episodeAttrs = progress.episodeNumber ? `data-resume-season="${Number(progress.seasonNumber) || 1}" data-episode="${Number(progress.episodeNumber)}"` : "";
    const posterAttrs = item.posterImage ? ` style="--poster:${escapeHtml(item.poster || "linear-gradient(145deg, #5c3b63, #221b31)")}"` : ` style="${posterStyle(item)}"`;
    const posterImage = item.posterImage ? `<img class="poster-art-image" src="${escapeHtml(highResolutionPosterUrl(item.posterImage))}" alt="" loading="lazy" decoding="async" aria-hidden="true">` : "";
    return `<button class="poster-card" ${playbackAttr} ${episodeAttrs} type="button"><div class="poster-art"${posterAttrs}>${posterImage}${posterTitleArt(item)}<span class="progress-bar" style="--progress:${progressPct}%"><i></i></span></div><strong>${escapeHtml(item.title)}</strong><small>${item.kind === "series" ? episodeText || countWord(item.seasons.length, "сезон", "сезона", "сезонов") : `${item.year} · ${formatTime(progress.position)} из ${formatTime(progress.duration)}`}</small></button>`;
  }

  // Пункты меню, которые не помещаются до поиска, уходят в «Ещё» (сначала самые редкие).
  function setupHeaderNavFit() {
    const sidebar = $(".sidebar");
    const navList = $(".sidebar .nav-list");
    const topbar = $(".topbar");
    if (!sidebar || !navList || !topbar) return;
    const hideOrder = ["history", "upcoming", "anime", "cartoons", "feed", "series", "movies", "catalog"];
    const items = hideOrder.map((view) => navList.querySelector(`:scope > .nav-item[data-view="${view}"]`)).filter(Boolean);
    const moreWrap = document.createElement("div");
    moreWrap.className = "nav-more";
    moreWrap.hidden = true;
    moreWrap.innerHTML = `<button class="nav-item nav-more-button" type="button" aria-haspopup="true" aria-expanded="false"><span>Ещё</span><svg class="nav-more-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="nav-more-menu" role="menu" hidden></div>`;
    navList.append(moreWrap);
    const moreButton = moreWrap.querySelector("button");
    const menu = moreWrap.querySelector(".nav-more-menu");
    const setOpen = (open) => {
      menu.hidden = !open;
      moreButton.setAttribute("aria-expanded", String(open));
    };
    moreButton.addEventListener("click", (event) => { event.stopPropagation(); setOpen(menu.hidden); });
    menu.addEventListener("click", () => setOpen(false));
    document.addEventListener("click", (event) => { if (!moreWrap.contains(event.target)) setOpen(false); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !menu.hidden) { setOpen(false); moreButton.focus(); } });

    const syncMenu = (hidden) => {
      const views = new Set(hidden.map((item) => item.dataset.view));
      menu.innerHTML = Array.from(navList.querySelectorAll(":scope > .nav-item[data-view]"))
        .filter((item) => views.has(item.dataset.view))
        .map((item) => `<a class="nav-more-link" role="menuitem" href="${escapeHtml(item.getAttribute("href") || "/")}" data-view="${escapeHtml(item.dataset.view)}">${escapeHtml((item.querySelector(".nav-label-wide") || item.querySelector("span"))?.textContent.trim() || item.getAttribute("aria-label") || "")}</a>`)
        .join("");
      moreWrap.hidden = hidden.length === 0;
      moreWrap.dataset.views = Array.from(views).join(" ");
      syncMoreActive();
    };
    const syncMoreActive = () => {
      const views = String(moreWrap.dataset.views || "").split(" ");
      moreButton.classList.toggle("is-active", views.includes(state.view));
      menu.querySelectorAll("[data-view]").forEach((link) => link.classList.toggle("is-active", link.dataset.view === state.view));
    };
    let fitTimer = 0;
    const fit = () => {
      fitTimer = 0;
      items.forEach((item) => item.classList.remove("is-overflow"));
      const wide = window.matchMedia("(min-width: 1101px)").matches;
      if (!wide) { setOpen(false); syncMenu([]); return; }
      const limit = () => topbar.getBoundingClientRect().left - 16;
      const navRight = () => navList.getBoundingClientRect().right;
      moreWrap.hidden = true;
      if (navRight() <= limit()) { syncMenu([]); return; }
      moreWrap.hidden = false;
      const hidden = [];
      for (const item of items) {
        if (navRight() <= limit()) break;
        item.classList.add("is-overflow");
        hidden.push(item);
      }
      syncMenu(hidden);
    };
    const schedule = () => { clearTimeout(fitTimer); fitTimer = setTimeout(fit, 30); };
    if ("ResizeObserver" in window) { const observer = new ResizeObserver(schedule); observer.observe(topbar); observer.observe(sidebar); }
    window.addEventListener("resize", schedule);
    document.fonts?.ready.then(schedule);
    headerNavSync = syncMoreActive;
    fit();
  }
  var headerNavSync = null;

  function render() {
    // A background refresh (catalogue, library, account) must not replace an open title
    // page with the section it was opened from: it redraws the title instead.
    const here = readRouteFromLocation();
    if (here.type === "title" && activeTitleId && activeTitleId === here.id && getTitle(here.id)) {
      headerNavSync?.();
      renderDetails(activeTitleId);
      return;
    }
    activeTitleId = null;
    headerNavSync?.();
    $("#search").value = searchDraft;
    $$(".nav-item[data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === state.view);
      button.classList.toggle("is-section", String(button.dataset.section || "").split(" ").includes(state.view));
    });
    if (catalogHydrating && ["home", "catalog", "upcoming", "movies", "series", "favorites", "evening", "history"].includes(state.view) && !(SECTION_PAGES[state.view] && lampacOrigin())) {
      renderCatalogLoading();
      return;
    }
    const viewChanged = lastRenderedView !== state.view;
    lastRenderedView = state.view;
    if (viewChanged) {
      page.classList.remove("is-entering");
      void page.offsetWidth;
      page.classList.add("is-entering");
      window.clearTimeout(enteringTimer);
      enteringTimer = window.setTimeout(() => page.classList.remove("is-entering"), 1200);
    }
    if (state.view === "home") renderHome();
    else if (state.view === "feed") renderFeedPage();
    else if (SECTION_PAGES[state.view] && lampacOrigin()) renderSectionPage(state.view);
    else if (["catalog", "upcoming", "movies", "series", "favorites", "evening", "history"].includes(state.view)) renderCatalogView();
    else if (state.view === "library") { if (isAdminMode()) renderLibraryView(); else renderMissingPage(); }
    else if (state.view === "settings") renderSettings();
    else if (state.view === "missing") renderMissingPage();
    else if (state.view === "about") renderAboutPage();
    hydrateLazyPosters();
    page.focus({ preventScroll: true });
  }

  function renderHome() {
    const picks = homeFeaturePicks();
    // One card per title with its latest episode, as in Lampa; old Kinopoisk records that
    // already have a TMDB copy are not shown twice.
    const continueItems = Object.entries(state.progress)
      .filter(([contentId, progress]) => !knownTmdbId(String(progress?.titleId || contentId).replace(/-s\d+e\d+$|-alt$|-embed$/, "")))
      .map(([contentId, progress]) => ({ item: getTitleForProgress(contentId, progress), progress: { ...progress, contentId } }))
      .filter((entry) => entry.item && !entry.progress.completed && isRealProgress(entry.progress))
      .sort((a, b) => b.progress.updatedAt - a.progress.updatedAt)
      .filter((entry, index, list) => list.findIndex((other) => other.item.id === entry.item.id) === index);
    const continueShelf = continueItems.length ? `<section class="discovery-shelf" aria-labelledby="shelf-continue"><div class="section-header discovery-shelf-header"><div><h2 id="shelf-continue">Продолжить просмотр</h2></div><button class="text-button" data-view="history" type="button">Вся история${uiIcon("arrow-right")}</button></div><div class="discovery-rail landscape-rail">${continueItems.slice(0, 12).map(({ item, progress }) => continueCard(item, progress)).join("")}</div></section>` : "";
    const moodStrip = `<section class="home-mood-strip" aria-label="Настроение"><span class="home-mood-label">Настроение вечера</span><div class="mood-row" role="group" aria-label="Настроение">${["уютно", "романтично", "смеяться", "напряжённо"].map((mood) => `<button class="mood-button ${state.mood === mood ? "is-active" : ""}" data-mood="${mood}" type="button" aria-pressed="${state.mood === mood}">${escapeHtml(moodDefinition(mood)?.shortLabel || mood)}</button>`).join("")}</div></section>`;
    const shelves = [
      continueShelf,
      discoveryShelf({ id: "upcoming", collectionId: "upcoming", title: "Скоро", description: "Самые ожидаемые премьеры", items: upcomingCatalog.slice(0, 12) }),
      discoveryShelf({ id: "fresh-movies", collectionId: "new", collectionView: "movies", title: "Недавние фильмы", description: "Фильмы этого и прошлого года", items: rotatingFreshItems(freshCatalog.filter((item) => item.kind === "movie"), 12) }),
      discoveryShelf({ id: "fresh-series", collectionId: "new", collectionView: "series", title: "Недавние сериалы", description: "Сериалы этого и прошлого года", items: rotatingFreshItems(freshCatalog.filter((item) => item.kind === "series"), 12) }),
      topTenShelf(worldTrendingCatalog.length >= 10 ? worldTrendingCatalog : audienceCatalog),
      discoveryShelf({ id: "audience", title: "Любимые зрителями", description: "По числу оценок на IMDb и Кинопоиске", items: rotatingFreshItems(audienceCatalog, 12, undefined, 40) }),
      discoveryShelf({ id: "personal", eyebrow: "", title: "Для вас", description: recommendationProfile().genres.size ? "По жанрам и людям из избранного и просмотренного" : "Идеи со всего мира, которые могут понравиться", items: personalCollectionItems(12) }),
      genreTilesShelf(),
      moodStrip,
      `<div id="home-mood-results">${homeMoodMarkup()}</div>`,
      discoveryShelf({ id: "thrill", title: "Захватывающие истории", description: "Триллеры, детективы и боевики", items: collectionItems("thrill", 12) }),
      discoveryShelf({ id: "romance", title: "Для двоих", description: "Романтика и лёгкие истории", items: collectionItems("romance", 12) }),
      discoveryShelf({ id: "evening", eyebrow: "", title: "На один вечер", description: "Фильмы, которые удобно включить сегодня.", items: collectionItems("evening", 12) }),
      discoveryShelf({ id: "anime", eyebrow: "", title: "Аниме", description: "Сериалы и фильмы с жанром «аниме».", items: collectionItems("anime", 12) }),
    ].filter(Boolean).join("");
    const lampaShelves = lampacOrigin() ? tmdbHomeShelves(continueShelf) : null;
    page.innerHTML = `${homeFeatureMarkup(picks)}<div class="home-shelves">${lampaShelves ?? shelves}</div>`;
    if (lampaShelves !== null) bindTmdbHomeMore();
    const feature = $(".home-feature");
    // The shelves wait (at most 2.5 s) until the hero frame is in, so their posters do not
    // share the first seconds of a slow connection with it.
    const shelfBlock = $(".home-shelves");
    if (feature && shelfBlock && !homeShelvesReleased) {
      shelfBlock.classList.add("is-waiting");
      const release = () => { homeShelvesReleased = true; $(".home-shelves")?.classList.remove("is-waiting"); };
      feature.addEventListener("cv:frame-settled", release, { once: true });
      window.setTimeout(release, 2500);
    }
    progressiveBackground(feature, "--feature-image", feature?.dataset.featureImage);
    bindPageActions();
    bindFeatureAutoplay(feature);
  }

  function selectHomeFeature(index) {
    const feature = $(".home-feature");
    const picks = homeFeaturePicks();
    if (!feature || !picks.length) return;
    homeFeatureIndex = Math.max(0, Math.min(Number(index) || 0, picks.length - 1));
    const template = document.createElement("template");
    template.innerHTML = homeFeatureMarkup(picks);
    const next = template.content.querySelector(".home-feature");
    const copy = next?.querySelector(".feature-copy");
    const currentCopy = feature.querySelector(".feature-copy");
    if (!copy || !currentCopy) return;
    currentCopy.replaceWith(copy);
    const currentPoster = feature.querySelector(".feature-poster");
    const nextPoster = next.querySelector(".feature-poster");
    if (currentPoster && nextPoster) currentPoster.replaceWith(nextPoster);
    else if (currentPoster) currentPoster.remove();
    else if (nextPoster) feature.querySelector(".feature-body")?.append(nextPoster);
    feature.classList.toggle("has-backdrop", next.classList.contains("has-backdrop"));
    feature.classList.remove("is-sharp", "is-blurred");
    feature.dataset.featureImage = next.dataset.featureImage || "";
    feature._backgroundRequest = feature.dataset.featureImage;
    feature.style.removeProperty("--feature-image");
    progressiveBackground(feature, "--feature-image", feature.dataset.featureImage);
    const pager = next.querySelector(".feature-pager");
    const currentPager = feature.querySelector(".feature-pager");
    if (pager && currentPager) {
      currentPager.replaceWith(pager);
      bindPageActions(pager);
      bindFeatureAutoplay(feature);
    }
    bindPageActions(copy);
  }

  // On a phone the hero is swiped left and right, as a carousel.
  function bindFeatureSwipe(feature = $(".home-feature")) {
    if (!feature || feature.dataset.swipe) return;
    feature.dataset.swipe = "1";
    let startX = 0, startY = 0;
    feature.addEventListener("touchstart", (event) => { startX = event.touches[0].clientX; startY = event.touches[0].clientY; }, { passive: true });
    feature.addEventListener("touchend", (event) => {
      const dx = event.changedTouches[0].clientX - startX;
      const dy = event.changedTouches[0].clientY - startY;
      const total = homeFeaturePicks().length;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5 || total < 2) return;
      selectHomeFeature((homeFeatureIndex + (dx < 0 ? 1 : total - 1)) % total);
    }, { passive: true });
  }
  // The active segment fills in eight seconds, then the next pick takes its place.
  function bindFeatureAutoplay(feature = $(".home-feature")) {
    bindFeatureSwipe(feature);
    const picks = feature?.querySelector(".feature-picks");
    if (!picks || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    picks.addEventListener("animationend", (event) => {
      if (!event.target.classList?.contains("is-active") || state.view !== "home" || document.hidden) return;
      const total = homeFeaturePicks().length;
      if (total > 1) selectHomeFeature((homeFeatureIndex + 1) % total);
    });
  }

  function homeMoodMarkup() {
    return discoveryShelf({ id: "mood", eyebrow: "", title: moodDefinition().title, description: moodDefinition().description, items: collectionItems("mood", 12) });
  }

  function selectMood(mood) {
    if (!Object.hasOwn(moodDefinitions, mood) || state.mood === mood) return;
    state.mood = mood;
    saveState();
    const results = state.view === "home" && $("#home-mood-results");
    if (!results) { render(); return; }
    // Keep the hero, other rails, their images and the focused mood button intact.
    $$('[data-mood]').forEach((button) => {
      const selected = button.dataset.mood === mood;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    results.innerHTML = homeMoodMarkup();
    $('[data-open-collection]', results)?.addEventListener("click", () => openCatalogCollection("mood"));
    hydrateLazyPosters();
  }

  const catalogGenreAliases = { "экшен": "боевик", "семейное": "семейный", "романтика": "мелодрама" };
  const catalogNonGenres = new Set(["для нас", "уютно", "романтично", "смеяться", "напряжённо", "атмосферно", "на вечер", "классика", "сериал", "фильм", "медиатека"]);
  // Mood filters use real catalog genres. Editorial tags remain useful for copy,
  // but must not be the only reason a large imported catalog matches.
  const catalogMoodTags = {
    "уютно": ["комедия", "семейный", "мультфильм", "приключения", "фэнтези", "мелодрама"],
    "романтично": ["мелодрама", "комедия", "драма"],
    "смеяться": ["комедия", "мультфильм", "семейный"],
    "напряжённо": ["триллер", "детектив", "ужасы", "криминал", "боевик"],
  };
  const moodDefinitions = Object.freeze({
    "уютно": { shortLabel: "Уютно", title: "Уютное на вечер", description: "Тёплые истории, приключения и фильмы, которые не хочется спешить выключать." },
    "романтично": { shortLabel: "Романтика", title: "Для двоих", description: "Мелодрамы, романтические комедии и красивые истории о людях." },
    "смеяться": { shortLabel: "Посмеяться", title: "Чтобы посмеяться", description: "Комедии, мультфильмы и лёгкие фильмы для отдыха." },
    "напряжённо": { shortLabel: "Напряжённо", title: "Держит в напряжении", description: "Триллеры, детективы и истории с сильной интригой." },
  });
  const catalogCollections = Object.freeze([
    { id: "new", title: "Последний год", description: "Вышедшие фильмы и сериалы этого и прошлого года" },
    { id: "audience", title: "Любимые зрителями", description: "Больше всего оценок зрителей" },
  ]);

  function normalizeCatalogGenre(value) {
    const normalized = String(value || "").trim().toLocaleLowerCase("ru-RU");
    return catalogGenreAliases[normalized] || normalized;
  }

  function genresForItem(item) {
    const source = Array.isArray(item?.genres) && item.genres.length ? item.genres : (Array.isArray(item?.tags) ? item.tags : []);
    return [...new Set(source.map(normalizeCatalogGenre).filter((genre) => genre && !catalogNonGenres.has(genre)))];
  }

  function itemDiscoveryTags(item) {
    return new Set([
      ...genresForItem(item),
      ...(Array.isArray(item?.tags) ? item.tags : []).map(normalizeCatalogGenre),
    ].filter(Boolean));
  }

  function moodDefinition(mood = state.mood) { return moodDefinitions[mood] || moodDefinitions["уютно"]; }

  function moodScore(item, mood = state.mood) {
    const tags = itemDiscoveryTags(item);
    const matches = (catalogMoodTags[mood] || [mood]).filter((tag) => tags.has(normalizeCatalogGenre(tag))).length;
    return matches * 12 + confidenceCatalogRating(item) * .45 + Math.max(0, Number(item.year || 0) - 2000) * .015;
  }

  function itemLocalInterest(item) {
    return (state.favorites.includes(item.id) ? 3 : 0) + (hasSharedHistory(item) ? 2 : 0) + (state.watchlist.includes(item.id) ? 1 : 0);
  }

  function matchesCollection(item, collectionId = state.catalogCollection) {
    const tags = itemDiscoveryTags(item);
    if (collectionId === "upcoming") return Boolean(upcomingPremiere(item));
    if (collectionId === "new") return !upcomingPremiere(item) && Number(item.year || 0) >= new Date().getFullYear() - 1 && Number(item.year || 0) <= new Date().getFullYear();
    if (!collectionId || collectionId === "popular") return true;
    if (collectionId === "mood") return (catalogMoodTags[state.mood] || []).some((tag) => tags.has(normalizeCatalogGenre(tag)));
    if (collectionId === "evening") return item.kind === "movie" && (!item.runtime || Number(item.runtime) <= 155);
    if (collectionId === "romance") return ["мелодрама", "комедия", "драма"].some((tag) => tags.has(tag));
    if (collectionId === "thrill") return ["триллер", "детектив", "ужасы", "криминал", "боевик"].some((tag) => tags.has(tag));
    if (collectionId === "anime") return tags.has("аниме");
    return true;
  }

  function discoveryScore(item, collectionId = "popular") {
    const base = confidenceCatalogRating(item) * 3 + audienceScore(item) + Math.max(0, Number(item.year || 0) - 2000) * .04 + itemLocalInterest(item) * 2;
    if (collectionId === "mood") return base + moodScore(item) * 3;
    if (collectionId === "romance") return base + moodScore(item, "романтично") * 2;
    if (collectionId === "thrill") return base + moodScore(item, "напряжённо") * 2;
    if (collectionId === "evening") return base + (item.kind === "movie" ? 3 : 0);
    return base;
  }

  function sortDiscoveryItems(items, collectionId = "popular") {
    return [...items].sort((left, right) => discoveryScore(right, collectionId) - discoveryScore(left, collectionId) || confidenceCatalogRating(right) - confidenceCatalogRating(left) || Number(right.year || 0) - Number(left.year || 0) || String(left.title || "").localeCompare(String(right.title || ""), "ru"));
  }

  function recommendationInteractionWeight(item) {
    const progress = progressForTitle(item);
    const progressRatio = progress?.duration > 0 ? Number(progress.position || 0) / Number(progress.duration) : 0;
    let weight = 0;
    if (state.favorites.includes(item.id)) weight += 6;
    if (state.watchlist.includes(item.id)) weight += 2;
    if (progress?.completed || progressRatio >= .8) weight += 5;
    if (progressRatio >= .2 && progressRatio < .8) weight += 1;
    return weight;
  }

  function addProfileValues(profileMap, values, weight) {
    const list = Array.isArray(values) ? values : values ? [values] : [];
    for (const value of list) {
      const normalized = normalizeCatalogGenre(value);
      if (normalized) profileMap.set(normalized, (profileMap.get(normalized) || 0) + weight);
    }
  }

  function recommendationProfile() {
    const profile = { genres: new Map(), actors: new Map(), directors: new Map(), countries: new Map(), kinds: new Map(), years: [], runtimes: [] };
    [...new Map([...discoveryItems(), ...savedTitlesCatalog].map((item) => [item.id, item])).values()].forEach((item) => {
      const weight = recommendationInteractionWeight(item);
      if (!weight) return;
      addProfileValues(profile.genres, genresForItem(item), weight);
      addProfileValues(profile.actors, item.actors, weight * .9);
      addProfileValues(profile.directors, item.directors, weight * 1.2);
      addProfileValues(profile.countries, item.countries, weight * .45);
      const kind = String(item.kind || "").trim();
      if (kind) profile.kinds.set(kind, (profile.kinds.get(kind) || 0) + weight);
      if (Number(item.year)) profile.years.push({ value: Number(item.year), weight });
      if (Number(item.runtime)) profile.runtimes.push({ value: Number(item.runtime), weight });
    });
    const now = Date.now();
    const memory = Array.isArray(state.tasteMemory) ? state.tasteMemory : [];
    memory.forEach((entry) => {
      const item = getTitle(entry?.id);
      if (!item) return;
      const ageDays = Math.max(0, (now - Number(entry.at || now)) / (24 * 60 * 60 * 1000));
      const freshness = Math.max(.35, 1 - ageDays / 120);
      // Opening a card or starting a player is not evidence that it was liked.
      if (!["favorite", "watchlist"].includes(entry.type)) return;
      const baseWeight = entry.type === "favorite" ? 5 : 2;
      const weight = baseWeight * freshness;
      addProfileValues(profile.genres, genresForItem(item), weight);
      addProfileValues(profile.actors, item.actors, weight * .8);
      addProfileValues(profile.directors, item.directors, weight * 1.1);
      addProfileValues(profile.countries, item.countries, weight * .4);
      const kind = String(item.kind || "").trim();
      if (kind) profile.kinds.set(kind, (profile.kinds.get(kind) || 0) + weight);
      if (Number(item.year)) profile.years.push({ value: Number(item.year), weight });
      if (Number(item.runtime)) profile.runtimes.push({ value: Number(item.runtime), weight });
    });
    return profile;
  }

  function profileOverlap(values, profileMap) {
    const list = Array.isArray(values) ? values : values ? [values] : [];
    return list.reduce((score, value) => score + (profileMap.get(normalizeCatalogGenre(value)) || 0), 0);
  }

  function weightedAverage(values) {
    const totalWeight = values.reduce((sum, entry) => sum + entry.weight, 0);
    return totalWeight ? values.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight : 0;
  }

  function personalRecommendationScore(item, profile) {
    const genreScore = profileOverlap(genresForItem(item), profile.genres) * 4.5;
    const actorScore = profileOverlap(item.actors, profile.actors) * 2;
    const directorScore = profileOverlap(item.directors, profile.directors) * 2.4;
    const countryScore = profileOverlap(item.countries, profile.countries) * .8;
    const kindScore = (profile.kinds.get(String(item.kind || "").trim()) || 0) * .7;
    const averageYear = weightedAverage(profile.years);
    const averageRuntime = weightedAverage(profile.runtimes);
    const yearScore = averageYear && Number(item.year) ? Math.max(0, 4 - Math.abs(Number(item.year) - averageYear) / 12) : 0;
    const runtimeScore = averageRuntime && Number(item.runtime) ? Math.max(0, 2 - Math.abs(Number(item.runtime) - averageRuntime) / 45) : 0;
    const moodScoreValue = 0; // Mood belongs only to its own shelf.
    const offTaste = profile.genres.size && !profileOverlap(genresForItem(item), profile.genres) ? -20 : 0;
    const qualityScore = confidenceCatalogRating(item) * .45 + audienceScore(item) * .35;
    const tags = new Set(genresForItem(item).map(normalizeCatalogGenre));
    const isChildLike = tags.has("мультфильм") || tags.has("детский") || tags.has("аниме");
    const childInterest = ["мультфильм", "детский", "аниме", "семейный"].reduce((sum, tag) => sum + (profile.genres.get(tag) || 0), 0);
    const adultInterest = [...profile.genres.entries()].filter(([tag]) => !["мультфильм", "детский", "аниме", "семейный"].includes(tag)).reduce((sum, [, value]) => sum + value, 0);
    const childBiasCorrection = isChildLike && (childInterest === 0 || adultInterest > childInterest * 1.25) ? -24 : 0;
    const age = new Date().getFullYear() - Number(item.year || 0);
    const recencyScore = age >= 0 && age <= 1 ? 12 : age <= 3 && age >= 0 ? 5 : 0;
    return genreScore + actorScore + directorScore + countryScore + kindScore + yearScore + runtimeScore + moodScoreValue + qualityScore + childBiasCorrection + offTaste + recencyScore;
  }

  function sortPersonalRecommendations(items) {
    const profile = recommendationProfile();
    return [...items].sort((left, right) => personalRecommendationScore(right, profile) - personalRecommendationScore(left, profile) || discoveryScore(right, "mood") - discoveryScore(left, "mood") || String(left.title || "").localeCompare(String(right.title || ""), "ru"));
  }

  function collectionItems(collectionId, limit = 8) {
    const matching = discoveryItems().filter((item) => matchesCollection(item, collectionId));
    const solid = matching.filter(isPopularEnough);
    // The strongest three stay; the rest change every day among the best three dozen.
    return rotatingFreshItems(sortDiscoveryItems(solid.length >= limit ? solid : matching, collectionId), limit, undefined, 36);
  }

  // A stable daily rotation leaves the most relevant cards in place while
  // allowing other recent candidates to appear without reshuffling on reload.
  function rotatingFreshItems(items, limit = 12, day = Math.floor((Date.now() + 5 * 3600000) / 86400000), poolSize = 40) {
    const pool = items.slice(0, poolSize);
    if (pool.length <= limit) return pool;
    const head = pool.slice(0, 3);
    const tail = pool.slice(3);
    const offset = ((day * 7) % tail.length + tail.length) % tail.length;
    const ordered = head.concat(tail.slice(offset), tail.slice(0, offset));
    return ordered.slice(0, limit);
  }

  function personalCollectionItems(limit = 8) {
    const source = [...new Map([...worldTrendingCatalog, ...freshCatalog, ...audienceCatalog, ...discoveryItems()].map((item) => [item.id, item])).values()];
    const eligible = source.filter(isCredibleRecommendation);
    const unseen = eligible.filter((item) => {
      const progress = progressForTitle(item);
      return !hasSharedHistory(item) && !progress?.completed && !(progress?.duration > 0 && progress.position / progress.duration >= .8);
    });
    const ranked = sortPersonalRecommendations(unseen.length ? unseen : eligible);
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentIds = new Set((Array.isArray(state.recommendationHistory) ? state.recommendationHistory : [])
      .filter((entry) => Number(entry?.at || 0) > weekAgo)
      .map((entry) => String(entry?.id || entry))
      .filter(Boolean));
    const freshPool = ranked.filter((item) => !recentIds.has(item.id));
    return rotatingFreshItems(freshPool.length >= limit ? freshPool : ranked, limit);
  }

  function catalogCollectionDefinition(collectionId = state.catalogCollection) {
    return catalogCollections.find((collection) => collection.id === collectionId) || null;
  }

  // Search answers with titles, not with every card whose description contains the letters:
  // "лед" must find «Лёд 2», not «Последний богатырь». Same rules as the server.
  function searchWords(value) {
    return String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").match(/[\p{L}\p{N}]+/gu) || [];
  }
  // 0 whole title, 1 starts with it, 2 whole words, 3 starts the title, 4 each word starts one,
  // 5 inside a word (only when nothing better exists), null no match.
  function titleTier(tokens, title) {
    const words = searchWords(title);
    if (!tokens.length || !words.length) return null;
    const phrase = tokens.join(" ");
    const text = words.join(" ");
    if (text === phrase) return 0;
    if (text.startsWith(`${phrase} `)) return 1;
    if (` ${text} `.includes(` ${phrase} `)) return 2;
    if (text.startsWith(phrase)) return 3;
    if (tokens.every((token) => words.some((word) => word.startsWith(token)))) return 4;
    if (tokens.every((token) => text.includes(token))) return 5;
    return null;
  }
  function personMatches(tokens, names) {
    return (names || []).some((name) => {
      const words = searchWords(name);
      return words.length && tokens.every((token) => words.some((word) => word.startsWith(token)));
    });
  }
  function searchMatches(query = state.query, items = catalog) {
    const tokens = searchWords(query);
    if (!tokens.length) return [];
    const scored = [];
    items.forEach((item, position) => {
      const tiers = [titleTier(tokens, item.title), titleTier(tokens, item.originalTitle)].filter((tier) => tier !== null);
      if (tiers.length) scored.push({ item, tier: Math.min(...tiers), position });
    });
    let hits = scored;
    if (hits.length && Math.min(...hits.map((entry) => entry.tier)) <= 4) hits = hits.filter((entry) => entry.tier <= 4);
    if (!hits.length) {
      // A person's name only when no title fits.
      hits = items.map((item, position) => ({ item, tier: 6, position }))
        .filter(({ item }) => personMatches(tokens, item.actors) || personMatches(tokens, item.directors));
    }
    const popular = sortDiscoveryItems(hits.map((entry) => entry.item), "popular");
    const popularOrder = new Map(popular.map((item, index) => [item.id, index]));
    hits.sort((a, b) => a.tier - b.tier
      || (a.tier <= 1 ? String(a.item.title).localeCompare(String(b.item.title), "ru") || (Number(a.item.year) || 0) - (Number(b.item.year) || 0) : popularOrder.get(a.item.id) - popularOrder.get(b.item.id)));
    return hits.map((entry) => entry.item);
  }

  function discoveryShelf({ id, collectionId = id, collectionView = "catalog", eyebrow, title, description, items }) {
    // Shelves are the shop window: a card without a poster stays in the catalogue, not here.
    const withPosters = items.filter((item) => item?.posterImage);
    if (withPosters.length >= 4) items = withPosters;
    if (!items.length) return "";
    return `<section class="discovery-shelf" aria-labelledby="shelf-${escapeHtml(id)}"><div class="section-header discovery-shelf-header"><div>${eyebrow ? `<div class="section-kicker">${escapeHtml(eyebrow)}</div>` : ""}<h2 id="shelf-${escapeHtml(id)}">${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><button class="text-button" data-open-collection="${escapeHtml(collectionId)}" data-collection-view="${escapeHtml(collectionView)}" type="button">Все${uiIcon("arrow-right")}</button></div><div class="discovery-rail" aria-label="${escapeHtml(title)}">${items.map((item) => poster(item, "discovery-poster")).join("")}</div></section>`;
  }

  function catalogViewMatches(item) {
    if (state.view === "movies") return item.kind === "movie";
    if (state.view === "series") return item.kind === "series";
    if (state.view === "favorites") return state.favorites.includes(item.id);
    if (state.view === "evening") return state.watchlist.includes(item.id);
    if (state.view === "history") return hasSharedHistory(item);
    return true;
  }

  function catalogGenreOptions() {
    if (lampacOrigin()) {
      // TMDB genres of the section, as in Lampa's filter.
      const valid = state.view === "movies" ? [TMDB_MOVIE_GENRE_IDS] : state.view === "series" ? [TMDB_TV_GENRE_IDS] : [TMDB_MOVIE_GENRE_IDS, TMDB_TV_GENRE_IDS];
      const names = [...new Set(Object.entries(TMDB_GENRES).filter(([id]) => valid.some((set) => set.has(Number(id)))).map(([, name]) => name))];
      return names.filter((name) => !["новости", "ток-шоу", "мыльная опера", "телефильм"].includes(name)).sort((a, b) => a.localeCompare(b, "ru")).map((genre) => ({ genre, count: 1 }));
    }
    const facets = currentFacets();
    if (!facets && facetsKind() && !facetsByKind.has(`loading:${facetsKind()}`)) {
      facetsByKind.set(`loading:${facetsKind()}`, true);
      loadRemoteCatalogFacets().finally(() => facetsByKind.delete(`loading:${facetsKind()}`));
    }
    const remoteGenres = (facets || (facetsKind() ? null : remoteCatalog.facets))?.genres;
    if (remoteGenres && Object.keys(remoteGenres).length) {
      return Object.entries(remoteGenres)
        .map(([genre, count]) => ({ genre, count }))
        .sort((left, right) => right.count - left.count || left.genre.localeCompare(right.genre, "ru"));
    }
    const counts = new Map();
    const sourceItems = discoveryCatalog.length ? discoveryCatalog : catalog;
    sourceItems.filter((item) => catalogViewMatches(item) && matchesCollection(item)).forEach((item) => genresForItem(item).forEach((genre) => counts.set(genre, (counts.get(genre) || 0) + 1)));
    const selectedGenre = normalizeCatalogGenre(state.catalogGenre);
    if (selectedGenre && !counts.has(selectedGenre)) counts.set(selectedGenre, 0);
    // Counted from a partial list these are wrong, so no number until the real one arrives.
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ru"))
      .map(([genre]) => ({ genre, count: 0 }));
  }

  function genreHue(genre) { let hash = 0; for (const char of genre) hash = (hash * 31 + char.codePointAt(0)) % 360; return hash; }
  // Genre tiles take a still from a popular title of that genre.
  function genreCoverMap(genres) {
    const pool = [...worldTrendingCatalog, ...audienceCatalog, ...trendingCatalog, ...discoveryItems(), ...catalog];
    const used = new Set();
    const pick = (genre, field) => pool.find((item) => !used.has(item.id) && item[field] && genresForItem(item).includes(genre));
    const covers = new Map();
    genres.forEach((genre) => {
      const item = pick(genre, "backdropImage") || pick(genre, "posterImage");
      if (!item) return;
      used.add(item.id);
      covers.set(genre, item.backdropImage ? { url: previewImageUrl(item.backdropImage), poster: false } : { url: previewImageUrl(highResolutionPosterUrl(item.posterImage)), poster: true });
    });
    return covers;
  }
  function catalogGenreButtonsMarkup(genreOptions) {
    const selectedGenre = normalizeCatalogGenre(state.catalogGenre);
    const label = (genre) => genre.charAt(0).toLocaleUpperCase("ru-RU") + genre.slice(1);
    const chip = (genre, text) => `<button class="genre-pill ${selectedGenre === genre ? "is-active" : ""}" data-catalog-genre="${escapeHtml(genre)}" type="button" aria-pressed="${selectedGenre === genre}">${escapeHtml(text)}</button>`;
    return chip("", "Все") + genreOptions.map(({ genre }) => chip(genre, label(genre))).join("");
  }



  function catalogRatingValue(item) {
    const value = Number(item?.ratingKinopoisk ?? item?.rating ?? item?.imdbRating ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  function confidenceCatalogRating(item) {
    const rating = catalogRatingValue(item);
    if (!rating) return 0;
    const votes = Math.max(0, Number(item?.voteCount || 0));
    return (rating * votes + 6.8 * 25000) / (votes + 25000);
  }

  function audienceScore(item) {
    const votes = Math.max(0, Number(item?.voteCount || 0)) + Math.max(0, Number(item?.imdbVoteCount || 0));
    return Math.log10(1 + votes);
  }

  // Same measure as the server sort "now": the world audience (IMDb votes) per year of the
  // title's life, Kinopoisk votes with a small weight, weak titles held back.
  function nowInterest(item) {
    const votes = Math.max(0, Number(item?.imdbVoteCount || 0)) + Math.max(0, Number(item?.voteCount || 0)) * .15;
    const age = Math.max(1, new Date().getFullYear() - Number(item?.year || 0) + 1);
    const rating = Number(item?.imdbRating || 0) || catalogRatingValue(item);
    return votes / age * (rating > 0 && rating < 6 ? .4 : 1);
  }

  function isPopularEnough(item) {
    if (worldTrendingCatalog.some((entry) => entry.id === item?.id)) return true;
    if (item?.kind === "movie" && Number(item.runtime) > 0 && Number(item.runtime) < SHORT_FILM_MINUTES) return false;
    const votes = Number(item?.voteCount || 0) + Number(item?.imdbVoteCount || 0);
    const rating = catalogRatingValue(item);
    return votes >= POPULAR_MIN_VOTES && (!rating || rating >= POPULAR_MIN_RATING);
  }

  function isCredibleRecommendation(item) {
    return Boolean(item?.posterImage) && isPopularEnough(item);
  }

  function sortCatalogItems(items) {
    if (state.view === "history") {
      const historyPosition = new Map(state.history.map((id, index) => [String(id), index]));
      const latestViewedAt = (item) => {
        const timestamps = [];
        Object.entries(state.progress || {}).forEach(([contentId, progress]) => {
          if (progress?.titleId === item.id || contentId === item.id || contentId.startsWith(`${item.id}-s`)) {
            const timestamp = Number(progress?.updatedAt || 0);
            if (timestamp > 0) timestamps.push(timestamp);
          }
        });
        (item.libraryEpisodes || []).forEach((episode) => {
          const timestamp = Date.parse(episode.progress?.updatedAt || "");
          if (Number.isFinite(timestamp)) timestamps.push(timestamp);
        });
        return timestamps.length ? Math.max(...timestamps) : 0;
      };
      return [...items].sort((left, right) => latestViewedAt(right) - latestViewedAt(left)
        || (historyPosition.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) - (historyPosition.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER)
        || String(left.title || "").localeCompare(String(right.title || ""), "ru"));
    }
    const sort = ["now", "audience", "rating", "year", "title"].includes(state.catalogSort) ? state.catalogSort : "now";
    return [...items].sort((left, right) => {
      if (sort === "now") return nowInterest(right) - nowInterest(left) || confidenceCatalogRating(right) - confidenceCatalogRating(left);
      if (sort === "audience") return audienceScore(right) - audienceScore(left) || confidenceCatalogRating(right) - confidenceCatalogRating(left);
      if (sort === "title") return String(left.title || "").localeCompare(String(right.title || ""), "ru");
      if (sort === "year") return Number(right.year || 0) - Number(left.year || 0) || catalogRatingValue(right) - catalogRatingValue(left);
      return confidenceCatalogRating(right) - confidenceCatalogRating(left) || Number(right.year || 0) - Number(left.year || 0);
    });
  }

  function filteredCatalog() {
    if (remoteCatalog.total) return catalog;
    const query = String(state.query || "").trim();
    const queryHits = query ? new Set(searchMatches(query).map((item) => item.id)) : null;
    const selectedGenre = normalizeCatalogGenre(state.catalogGenre);
    const items = catalog.filter((item) => {
      const tags = itemDiscoveryTags(item);
      const genres = genresForItem(item);
      const queryOkay = !queryHits || queryHits.has(item.id);
      const genreOkay = !selectedGenre || genres.includes(selectedGenre);
      return catalogViewMatches(item) && matchesCollection(item) && queryOkay && genreOkay;
    });
    // Catalog sorting is a user choice. Discovery ranking is still used for
    // recommendation shelves, but must not silently override this control in
    // a collection such as "Под настроение".
    return sortCatalogItems(items);
  }

  const catalogPageSize = 50;
  function catalogPagination(items) {
    if (remoteCatalog.total) {
      const currentPage = Math.min(Math.max(Number(remoteCatalog.page) || 1, 1), Math.max(1, remoteCatalog.pages));
      return { currentPage, totalPages: Math.max(1, remoteCatalog.pages), start: (currentPage - 1) * 50, end: Math.min(currentPage * 50, remoteCatalog.total), items };
    }
    const totalPages = Math.max(1, Math.ceil(items.length / catalogPageSize));
    const currentPage = Math.min(Math.max(Number(state.catalogPage) || 1, 1), totalPages);
    const start = (currentPage - 1) * catalogPageSize;
    return {
      currentPage,
      totalPages,
      start,
      end: Math.min(start + catalogPageSize, items.length),
      items: items.slice(start, start + catalogPageSize),
    };
  }

  function resetCatalogPage() {
    state.catalogPage = 1;
  }

  function resetCatalogFilters() {
    state.view = "catalog";
    state.query = "";
    searchDraft = "";
    state.catalogGenre = "";
    state.catalogCollection = "";
    state.catalogMoodOnly = false;
    state.catalogPlayableOnly = false;
    state.catalogSort = "now";
    resetCatalogPage();
    const search = $("#search");
    if (search) search.value = "";
    saveState();
    renderCatalogView();
  }

  // "Последний год" is a list of releases, so it opens newest first.
  function sortForCatalogCollection(collectionId, currentSort) {
    if (collectionId === "new") return "year";
    return currentSort === "year" ? "now" : currentSort;
  }

  function openCatalogCollection(collectionId, collectionView = "catalog") {
    if (collectionId === "upcoming") {
      state.catalogCollection = "";
      state.catalogSort = "now";
      state.catalogMoodOnly = false;
      state.catalogGenre = "";
      state.query = "";
      searchDraft = "";
      resetCatalogPage();
      saveState();
      navigateToView("upcoming", { preserveCatalogFilters: true });
      return;
    }
    state.catalogCollection = collectionId;
    state.catalogSort = collectionId === "new" ? "year" : collectionId === "audience" ? "audience" : "now";
    state.catalogMoodOnly = false;
    state.catalogGenre = "";
    state.query = "";
    searchDraft = "";
    resetCatalogPage();
    saveState();
    navigateToView(["movies", "series"].includes(collectionView) ? collectionView : "catalog", { preserveCatalogFilters: true });
  }

  // Opening a player and closing it at once is not "watching".
  const MIN_WATCHED_SECONDS = 3;
  function isRealProgress(progress) { return Boolean(progress) && (progress.completed || progress.untracked === true || Number(progress.position || 0) >= MIN_WATCHED_SECONDS); }

  // History as a list: one row per title, newest activity first.
  function historyEntries() {
    const byTitle = new Map();
    Object.entries(state.progress || {}).forEach(([contentId, progress]) => {
      if (!isRealProgress(progress)) return;
      const titleId = String(progress.titleId || contentId.replace(/-(?:s\d+e\d+|alt)$/, ""));
      const current = byTitle.get(titleId);
      if (!current || Number(progress.updatedAt || 0) > Number(current.progress.updatedAt || 0)) byTitle.set(titleId, { titleId, contentId, progress });
    });
    const entries = [...byTitle.values()].sort((left, right) => Number(right.progress.updatedAt || 0) - Number(left.progress.updatedAt || 0));
    state.history.forEach((titleId) => { if (!byTitle.has(String(titleId))) entries.push({ titleId: String(titleId), contentId: "", progress: null }); });
    return entries.map((entry) => ({ ...entry, item: getTitle(entry.titleId) })).filter((entry) => entry.item);
  }
  function historyDayLabel(timestamp) {
    if (!timestamp) return "Ранее";
    const day = new Date(timestamp); day.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86_400_000);
    return diff <= 0 ? "Сегодня" : diff === 1 ? "Вчера" : diff < 7 ? "На этой неделе" : "Ранее";
  }
  function historyRow({ item, progress }) {
    const position = Number(progress?.position || 0);
    const duration = Number(progress?.duration || 0);
    const ratio = duration > 0 ? Math.min(1, position / duration) : 0;
    const done = progress?.completed || ratio >= .95;
    const episode = progress?.episodeNumber ? episodeTag(progress.seasonNumber, progress.episodeNumber) : "";
    const player = progress?.translationName ? `Озвучка: ${progress.translationName}` : "";
    const left = duration > position ? Math.round((duration - position) / 60) : 0;
    const when = progress?.updatedAt ? new Date(progress.updatedAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
    const action = !progress ? `data-play-media="${escapeHtml(item.id)}"` : `data-play-media="${escapeHtml(item.id)}"${progress.episodeNumber ? ` data-resume-season="${Number(progress.seasonNumber) || 1}" data-episode="${Number(progress.episodeNumber)}"` : ""}`;
    const status = !progress || progress.untracked ? "" : done ? "Просмотрено" : `${formatTime(position)}${duration ? ` из ${formatTime(duration)}` : ""}${left ? ` · осталось ${left} мин` : ""}`;
    return `<article class="history-row"><a class="history-art" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)}">${landscapeArt(item)}${progress && !done ? `<span class="history-progress" style="--progress:${Math.round(ratio * 100)}%"><i></i></span>` : ""}</a><div class="history-copy"><a class="history-title" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}">${escapeHtml(item.title)}</a><div class="history-meta">${[episode, item.year, ...genresForItem(item).slice(0, 2)].filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>${player ? `<div class="history-player">${escapeHtml(player)}</div>` : ""}${status ? `<div class="history-status">${escapeHtml(status)}</div>` : ""}</div><div class="history-side">${when ? `<time>${escapeHtml(when)}</time>` : ""}<div class="history-actions"><button class="primary-button" ${action} type="button">${playerIcon("play")}<span>${progress && !done ? "Продолжить" : "Смотреть"}</span></button><button class="secondary-button history-remove" data-history-remove="${escapeHtml(item.id)}" type="button" aria-label="Убрать из истории" title="Убрать из истории">${uiIcon("close")}</button></div></div></article>`;
  }
  function renderHistoryView() {
    const entries = historyEntries();
    let lastGroup = "";
    const rows = entries.map((entry) => {
      const group = historyDayLabel(Number(entry.progress?.updatedAt || 0));
      const heading = group !== lastGroup ? `<h2 class="history-group">${group}</h2>` : "";
      lastGroup = group;
      return heading + historyRow(entry);
    }).join("");
    page.innerHTML = `<div class="page-heading"><div><h1>История просмотра</h1><p class="muted">Последнее просмотренное — сверху. Продолжить можно с того же места.</p></div></div>${sectionSwitchMarkup()}${entries.length ? `<div class="history-list">${rows}</div>` : `<section class="empty-state"><h2>Здесь пока пусто</h2><p>Начните смотреть фильм или сериал — он появится в истории.</p><a class="primary-button" href="${routeForView("catalog")}" data-view="catalog">Открыть каталог</a></section>${emptyRecommendationsShelf()}`}`;
    bindPageActions();
    $$("[data-history-remove]").forEach((button) => button.addEventListener("click", () => removeFromHistory(button.dataset.historyRemove)));
  }
  function removeFromHistory(titleId) {
    Object.entries(state.progress || {}).forEach(([contentId, progress]) => {
      if (String(progress?.titleId || "") !== titleId && contentId !== titleId && !contentId.startsWith(`${titleId}-`)) return;
      delete state.progress[contentId];
    });
    state.history = state.history.filter((id) => id !== titleId);
    if (state.historyAt) delete state.historyAt[titleId];
    // The account keeps a removal mark, otherwise the next sync brings the title back.
    state.historyRemoved = { ...(state.historyRemoved || {}), [titleId]: Date.now() };
    saveState();
    pushAccountState();
    renderHistoryView();
  }

  function catalogMoreMarkup(items, pagination) {
    if (!items.length) return "";
    if (pagination.currentPage < pagination.totalPages) {
      return `<section class="catalog-more" aria-label="Продолжение каталога"><nav class="catalog-pagination" aria-label="Листать каталог"><button class="primary-button catalog-more-button" data-catalog-page="${pagination.currentPage + 1}" type="button"><span>Показать ещё</span></button></nav></section>`;
    }
    return remoteCatalog.total > 0 ? `<p class="catalog-end-state" role="status">Это весь список.</p>` : "";
  }

  // Cards held back to the next load keep every row full while more can arrive.
  function wholeCatalogRows(items) {
    const grid = $("#catalog-results");
    const pagination = catalogPagination(items);
    if (!grid || pagination.currentPage >= pagination.totalPages) return items;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
    if (columns < 2 || items.length < columns) return items;
    return items.slice(0, items.length - (items.length % columns));
  }

  function loadMoreCatalog(button) {
    const nextPage = Number(button?.dataset.catalogPage);
    // A filter that is still loading owns the request: paging the old list would cancel it.
    if (catalogPaging || remoteCatalogLoading || loadedCatalogKey !== catalogListKey() || !Number.isInteger(nextPage) || nextPage < 2) return;
    const listKey = catalogListKey();
    const pageBefore = remoteCatalog.page;
    catalogPaging = true;
    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = `<span class="loading-spinner" aria-hidden="true"></span><span>Загружаю…</span>`;
    loadRemoteCatalogPage(nextPage, { quiet: true, append: true }).finally(() => {
      catalogPaging = false;
      const grid = $("#catalog-results");
      if (catalogListKey() !== listKey || !grid) return;
      const items = filteredCatalog();
      progressiveCatalogItems = wholeCatalogRows(items);
      if (progressiveCatalogNext < progressiveCatalogItems.length && !$("#catalog-lazy-sentinel")) grid.insertAdjacentHTML("beforeend", `<div id="catalog-lazy-sentinel" class="catalog-lazy-sentinel" aria-hidden="true"></div>`);
      const panel = $(".catalog-more");
      if (panel) panel.outerHTML = catalogMoreMarkup(items, catalogPagination(items));
      // After a failed load the button stays for a manual retry instead of looping.
      bindCatalogMoreButton({ autoLoad: remoteCatalog.page !== pageBefore });
      hydrateProgressiveCatalog();
    });
  }

  let catalogAutoMoreObserver = null;
  function bindCatalogMoreButton({ autoLoad = true } = {}) {
    catalogAutoMoreObserver?.disconnect();
    catalogAutoMoreObserver = null;
    const button = $("[data-catalog-page]");
    if (!button) return;
    button.addEventListener("click", () => loadMoreCatalog(button));
    if (!autoLoad || !("IntersectionObserver" in window)) return;
    catalogAutoMoreObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && catalogCardsAllShown()) loadMoreCatalog(button);
    }, { rootMargin: "1600px 0px" });
    catalogAutoMoreObserver.observe(button);
  }

  // The button sits right after the drawn cards, so it is near the screen long
  // before the viewer reaches the end of what is loaded. Scrolling decides.
  function catalogCardsAllShown() {
    return progressiveCatalogNext >= progressiveCatalogItems.length;
  }

  function recheckCatalogAutoMore() {
    const button = $("[data-catalog-page]");
    if (!catalogAutoMoreObserver || !button) return;
    catalogAutoMoreObserver.unobserve(button);
    catalogAutoMoreObserver.observe(button);
  }

  function renderCatalogView() {
    if (remoteCatalogLoading && !catalog.length) {
      renderCatalogLoading();
      return;
    }
    if (state.view === "history") {
      renderHistoryView();
      return;
    }
    if (remoteCatalogError && !catalog.length) {
      page.innerHTML = `<section class="catalog-loading-shell" role="alert"><div><div class="eyebrow">Lumo Film</div><h1>Сервер не отвечает</h1><p>Если включён VPN, стоит сменить страну или отключить его. Сайт подключится сам, как только связь появится.</p><button class="primary-button" data-catalog-retry type="button">Повторить</button></div></section>`;
      return;
    }
    const items = filteredCatalog();
    const pagination = catalogPagination(items);
    if (state.catalogPage !== pagination.currentPage) state.catalogPage = pagination.currentPage;
    const pageItems = pagination.items;
    progressiveCatalogObserver?.disconnect();
    progressiveCatalogObserver = null;
    progressiveCatalogItems = pageItems;
    const firstBatch = catalogRenderAll ? pageItems.length : 16;
    progressiveCatalogNext = Math.min(firstBatch, pageItems.length);
    const genreOptions = catalogGenreOptions();
    const selectedGenre = normalizeCatalogGenre(state.catalogGenre);
    const collection = catalogCollectionDefinition();
    const hasFilters = Boolean(state.query || selectedGenre || collection || state.view !== "catalog");
    const title = state.view === "upcoming" ? "Скоро" : state.view === "favorites" ? "Избранное" : state.view === "evening" ? "Наш вечер" : state.view === "history" ? "История просмотра" : state.view === "movies" ? "Фильмы" : state.view === "series" ? "Сериалы" : state.query ? `Результаты для «${escapeHtml(state.query)}»` : collection ? collection.title : "Каталог";
    const subtitle = state.view === "upcoming" ? "Ожидаемые премьеры, отдельно от фильмов, которые уже вышли." : state.view === "evening" ? "То, что хочется посмотреть вместе." : state.view === "history" ? "То, к чему можно вернуться в любой момент." : state.view === "favorites" ? "Фильмы и сериалы, отложенные на потом." : collection?.id === "mood" ? moodDefinition().description : collection ? collection.description : "Поиск по названию, актёрам и жанрам.";
    const genreButtons = catalogGenreButtonsMarkup(genreOptions);
    const collectionButtons = [`<button class="studio-tab ${collection ? "" : "is-active"}" data-catalog-collection="" type="button" aria-pressed="${collection ? "false" : "true"}">Все</button>`, ...catalogCollections.map((entry) => `<button class="studio-tab ${collection?.id === entry.id ? "is-active" : ""}" data-catalog-collection="${escapeHtml(entry.id)}" type="button" aria-pressed="${collection?.id === entry.id ? "true" : "false"}" title="${escapeHtml(entry.description)}">${escapeHtml(entry.title)}</button>`)].join("");
    const activeFilters = [collection ? `Подборка: ${collection.title}` : "", selectedGenre ? `Жанр: ${selectedGenre}` : ""].filter(Boolean).join(" · ");
    const emptyCopy = state.view === "upcoming" ? "Премьеры появятся здесь, как только станут известны даты." : state.query ? `По запросу «${escapeHtml(state.query)}» ничего не найдено. Стоит изменить запрос или сбросить фильтры.` : "С такими фильтрами ничего нет. Сброс фильтров вернёт весь каталог.";
    const savedView = state.view === "favorites" || state.view === "history";
    const savedViewEmpty = state.view === "favorites"
      ? { title: "В избранном пока пусто", copy: "Кнопка «В избранное» на странице фильма или сериала добавит его сюда.", action: "Открыть каталог" }
      : { title: "История просмотра пока пуста", copy: "Здесь появится всё начатое — чтобы вернуться в любой момент.", action: "Открыть каталог" };
    const paginationMarkup = catalogMoreMarkup(items, pagination);
    const genreFilterMarkup = `<div class="genre-rail-wrap${genreRailExpanded ? " is-expanded" : ""}"><div class="genre-list genre-rail" role="group" aria-label="Фильтр по жанру">${genreButtons}</div><button class="genre-rail-toggle" data-genre-toggle type="button" aria-expanded="${genreRailExpanded}">${genreRailExpanded ? "Свернуть" : "Все жанры"}</button></div>`;
    const catalogMarkup = items.length ? `<div class="poster-grid" id="catalog-results" tabindex="-1">${pageItems.slice(0, firstBatch).map((item) => poster(item)).join("")}${pageItems.length > firstBatch ? `<div id="catalog-lazy-sentinel" class="catalog-lazy-sentinel" aria-hidden="true"></div>` : ""}</div>${paginationMarkup}` : state.view === "upcoming" ? `<section class="empty-state"><h2>Премьер пока нет</h2><p>${emptyCopy}</p><a class="primary-button" href="${routeForView("home")}" data-view="home">На главную</a></section>` : `<div class="empty-state"><h2>${savedView ? savedViewEmpty.title : "Ничего не подошло"}</h2><p>${savedView ? savedViewEmpty.copy : emptyCopy}</p>${savedView ? `<a class="primary-button" href="${routeForView("catalog")}" data-view="catalog">${savedViewEmpty.action}</a>` : '<button class="primary-button" data-catalog-reset type="button">Сбросить фильтры</button>'}</div>${savedView ? emptyRecommendationsShelf() : ""}`;
    const savedViewMarkup = `<div class="page-heading"><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div>${sectionSwitchMarkup()}${catalogMarkup}`;
    page.innerHTML = state.view === "upcoming" ? `<div class="page-heading"><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div>${sectionSwitchMarkup()}<div class="upcoming-sort" role="group" aria-label="Порядок премьер">${[["await", "Самые ожидаемые"], ["soon", "Ближайшие"]].map(([value, label]) => `<button class="genre-pill${(state.upcomingSort || "await") === value ? " is-active" : ""}" data-upcoming-sort="${value}" type="button" aria-pressed="${(state.upcomingSort || "await") === value}">${label}</button>`).join("")}</div>${catalogMarkup}` : savedView ? savedViewMarkup : `<div class="page-heading"><div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div>${sectionSwitchMarkup()}<section class="catalog-controls catalog-studio" aria-label="Подобрать фильм"><div class="studio-top"><div class="studio-tabs" role="group" aria-label="Подборки каталога">${collectionButtons}</div><div class="studio-actions">${catalogSortMenuMarkup()}<button class="text-button studio-random" data-catalog-random type="button"${items.length ? "" : " disabled"} title="Открыть случайный фильм из выдачи">Случайный</button></div></div>${genreFilterMarkup}<div class="catalog-result-row">${activeFilters ? `<span>${escapeHtml(activeFilters)}</span>` : ""}${remoteCatalogLoading ? `<span class="catalog-loading-status" role="status" aria-live="polite"><span class="loading-spinner" aria-hidden="true"></span> Обновляю карточки…</span>` : ""}${hasFilters ? `<button class="text-button" data-catalog-reset type="button">Сбросить фильтры</button>` : ""}</div></section>${catalogMarkup}`;
    const liveStatus = $("#catalog-live-status");
    if (liveStatus) window.requestAnimationFrame(() => { liveStatus.textContent = "Каталог обновлён."; });
    progressiveCatalogItems = wholeCatalogRows(pageItems);
    bindPageActions();
    hydrateProgressiveCatalog();
  }

  function libraryStatusLabel(item) {
    if (item.status === "ready") return "Готово к HLS-просмотру";
    if (item.status === "processing" || item.status === "queued") return "Готовлю HLS через FFmpeg…";
    if (item.status === "error") return `Ошибка обработки: ${escapeHtml(item.error || "проверь FFmpeg")}`;
    return "Исходник сохранён";
  }

  function libraryEpisodeMarkup(item) {
    const progress = item.progress;
    const duration = Number(progress?.duration || 0);
    const position = Number(progress?.position || 0);
    const progressPct = duration > 0 ? Math.min(100, Math.round(position / duration * 100)) : 0;
    const seriesLabel = item.kind === "series" ? `S${String(item.season || 1).padStart(2, "0")}E${String(item.episode || 1).padStart(2, "0")}` : "Фильм";
    const sourceLabel = item.source_type === "external_embed" ? "Ссылка на просмотр" : "";
    const externalLinkAction = item.source_type === "external_embed" && item.embed_url ? `<a class="secondary-button" href="${escapeHtml(item.embed_url)}" target="_blank" rel="noopener noreferrer">Открыть ссылку${uiIcon("external")}</a>` : "";
    const episodeMeta = [seriesLabel, sourceLabel, progress && !progress.completed ? `продолжить с ${formatTime(position)}` : ""].filter(Boolean).join(" · ");
    return `<article class="library-episode"><div class="library-episode-art"><span>${uiIcon("play")}</span><small>${seriesLabel}</small><i style="--progress:${progressPct}%"></i></div><div class="library-episode-copy"><div class="eyebrow">${escapeHtml(item.title)}</div><h3>${escapeHtml(item.episode_title)}</h3><p class="muted small">${escapeHtml(episodeMeta)}</p><div class="library-episode-actions">${item.status === "ready" ? `<button class="primary-button" data-library-play="${item.id}" type="button">${progress && !progress.completed ? "Продолжить" : "Смотреть"}</button>${externalLinkAction}<button class="secondary-button" data-library-room="${item.id}" type="button">Совместный просмотр</button>` : `<button class="secondary-button" data-library-refresh type="button">Обновить статус</button>`}</div></div></article>`;
  }

  function catalogSearchMarkup() {
    return `<section class="catalog-picker"><div><div class="eyebrow">Metadata catalog</div><h2>Выбрать существующий сериал или фильм</h2><p class="muted small">Начни вводить название — backend найдёт карточку TMDB и заполнит название, оригинальное название, год, описание, постер и сезоны.</p></div><form id="catalog-search-form" class="catalog-search-form"><input id="catalog-search-query" required maxlength="120" placeholder="Например, Отчаянные домохозяйки"><select id="catalog-search-kind"><option value="series">Сериал</option><option value="movie">Фильм</option></select><button class="secondary-button" type="submit">Найти</button></form><p id="catalog-search-feedback" class="muted small" aria-live="polite"></p><div id="catalog-search-results" class="catalog-search-results"></div></section>`;
  }

  function catalogResultMarkup(item) {
    return `<article class="catalog-result"><div class="catalog-result-poster" style="${item.poster_url ? `background-image:url(${escapeHtml(item.poster_url)})` : ""}"></div><div class="catalog-result-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml([item.original_title, item.year, item.kind === "series" ? "Сериал" : "Фильм", item.provider].filter(Boolean).join(" · "))}</small><p>${escapeHtml(item.overview || "Описание будет загружено после выбора")}</p></div><button class="secondary-button" data-catalog-select="${escapeHtml(item.external_id)}" data-catalog-kind="${escapeHtml(item.kind)}" data-catalog-provider="${escapeHtml(item.provider || "tmdb")}" type="button">Выбрать</button></article>`;
  }

  async function runCatalogSearch(event) {
    event?.preventDefault();
    const query = $("#catalog-search-query")?.value.trim() || "";
    const kind = $("#catalog-search-kind")?.value || "series";
    const feedback = $("#catalog-search-feedback");
    const results = $("#catalog-search-results");
    if (!query) return;
    feedback.textContent = "Ищу карточки в TMDB через backend…";
    results.innerHTML = "";
    try {
      const response = await apiFetch(`/api/catalog/search?q=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}`, { headers: { accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      feedback.textContent = `Найдено вариантов: ${payload.items.length}. Выбери нужную карточку.`;
      results.innerHTML = payload.items.map(catalogResultMarkup).join("") || `<p class="muted small">Ничего не найдено.</p>`;
      bindPageActions();
    } catch (error) { feedback.textContent = `Каталог недоступен: ${error.message}. Проверь CINEVAULT_TMDB_API_TOKEN на backend.`; }
  }

  async function selectCatalogTitle(externalId, kind, provider = "tmdb") {
    const feedback = $("#catalog-search-feedback");
    try {
      feedback.textContent = "Загружаю полную карточку и сезоны…";
      const response = await apiFetch(`/api/catalog/title/${encodeURIComponent(provider)}/${encodeURIComponent(kind)}/${encodeURIComponent(externalId)}`, { headers: { accept: "application/json" } });
      const metadata = await response.json();
      if (!response.ok) throw new Error(metadata.error || `HTTP ${response.status}`);
      const titleInputs = $$('[data-library-title]');
      const metadataInput = $("#library-metadata");
      titleInputs.forEach((input) => { input.value = metadata.title || ""; });
      if (metadataInput) metadataInput.value = JSON.stringify(metadata);
      feedback.textContent = `Выбрано: ${metadata.title}. Теперь укажи сезон/серию и добавь файл или внешний embed.`;
    } catch (error) { feedback.textContent = `Карточку не удалось загрузить: ${error.message}`; }
  }

  // On tablets and phones the bottom menu has four items; these chips reach the rest.
  function sectionSwitchMarkup() {
    const mine = ["favorites", "history", "settings"].includes(state.view);
    const views = mine
      ? [["favorites", "Избранное"], ["history", "История"], ["settings", "Настройки"]]
      : [["catalog", "Всё"], ["movies", "Фильмы"], ["series", "Сериалы"], ["cartoons", "Мультфильмы"], ["anime", "Аниме"], ["upcoming", "Скоро"]];
    return `<nav class="section-switch" aria-label="Разделы">${views.map(([view, label]) => `<a class="genre-pill${state.view === view ? " is-active" : ""}" href="${routeForView(view)}" data-view="${view}"${state.view === view ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  }

  // An empty list still offers something to start with.
  let emptyRecommendationsRequested = false;
  function emptyRecommendationsShelf() {
    if (!audienceCatalog.length && !emptyRecommendationsRequested) {
      emptyRecommendationsRequested = true;
      const view = state.view;
      loadAudienceCatalog().then(() => { if (audienceCatalog.length && state.view === view && !activeTitleId) render(); });
    }
    const items = (audienceCatalog.length ? audienceCatalog : discoveryItems()).filter((item) => item.posterImage).slice(0, 12);
    return discoveryShelf({ id: "empty-picks", collectionId: "audience", title: "Можно начать с этого", description: "Любимые зрителями", items });
  }

  // Showcase: a ready-made account for showing the product. The viewer's own favourites,
  // history and progress are put aside and come back untouched when it is switched off.
  const SHOWCASE_KEY = "cinevault.showcase";
  const SHOWCASE_BACKUP_KEY = "cinevault.showcase.backup";
  function isShowcase() { try { return localStorage.getItem(SHOWCASE_KEY) === "1"; } catch { return false; } }
  async function setShowcase(enabled) {
    if (enabled === isShowcase()) return;
    if (!enabled) {
      try {
        const saved = JSON.parse(localStorage.getItem(SHOWCASE_BACKUP_KEY) || "null");
        if (saved) Object.assign(state, { favorites: saved.favorites || [], history: saved.history || [], progress: saved.progress || {}, watchlist: saved.watchlist || [] });
        localStorage.removeItem(SHOWCASE_BACKUP_KEY);
        localStorage.removeItem(SHOWCASE_KEY);
      } catch { /* storage is unavailable: nothing was put aside */ }
      saveState();
      return;
    }
    if (!audienceCatalog.length) await loadAudienceCatalog();
    const pool = [...new Map([...worldTrendingCatalog, ...audienceCatalog, ...catalog].filter((item) => item?.posterImage && item.backdropImage).map((item) => [item.id, item])).values()];
    if (pool.length < 6) return;
    try {
      localStorage.setItem(SHOWCASE_BACKUP_KEY, JSON.stringify({ favorites: state.favorites, history: state.history, progress: state.progress, watchlist: state.watchlist }));
      localStorage.setItem(SHOWCASE_KEY, "1");
    } catch { return; }
    const now = Date.now();
    const watching = pool.slice(0, 4);
    const progress = {};
    watching.forEach((item, index) => {
      const duration = item.kind === "series" ? 2700 : Math.max(5400, Number(item.runtime || 110) * 60);
      const position = Math.round(duration * [0.42, 0.68, 0.23, 0.81][index]);
      const key = item.kind === "series" ? `${item.id}-s1e${index + 2}` : item.id;
      progress[key] = { titleId: item.id, seasonNumber: item.kind === "series" ? 1 : null, episodeNumber: item.kind === "series" ? index + 2 : null, position, duration, completed: false, updatedAt: now - index * 3600000 };
    });
    state.progress = progress;
    state.history = watching.map((item) => item.id);
    state.favorites = pool.slice(4, 14).map((item) => item.id);
    state.watchlist = [];
    saveState();
  }

  // «О Lumo Film»: what the product is, for the person it is shown to.
  function renderAboutPage() {
    const posters = [...new Map([...worldTrendingCatalog, ...audienceCatalog, ...catalog].filter((item) => item?.posterImage).map((item) => [item.id, item])).values()].slice(0, 18);
    if (posters.length < 6 && !audienceCatalog.length) loadAudienceCatalog().then(() => { if (state.view === "about") renderAboutPage(); });
    const wall = posters.map((item) => `<span class="about-poster"><img src="${escapeHtml(previewImageUrl(highResolutionPosterUrl(item.posterImage)))}" alt="" loading="lazy" decoding="async"></span>`).join("");
    const features = [
      ["play", "Свой плеер", "Качество, перемотка, пропуск заставок и продолжение с того же места на любом устройстве."],
      ["star", "Что смотрят в мире", "Каталог фильмов и сериалов с рейтингами Кинопоиска и IMDb, подборки на каждый день и по вашему вкусу."],
      ["heart", "Избранное и история", "Всё начатое и отложенное — под рукой, с отметкой, где вы остановились."],
      ["check", "Смотреть вместе", "Общая комната: пауза и перемотка у всех одновременно, даже в разных городах."],
      ["info", "Везде", "Сайт ставится как приложение, есть приложения для iPhone, Android и Android TV с управлением с пульта."],
      ["close", "Без лишнего", "Без рекламы в собственном плеере и с расширением, которое убирает её у внешних источников."],
    ].map(([icon, title, text]) => `<article class="about-feature">${uiIcon(icon)}<h3>${title}</h3><p>${text}</p></article>`).join("");
    page.innerHTML = `<section class="about-hero"><div class="about-wall" aria-hidden="true">${wall}</div><div class="about-copy"><span class="feature-chip">О продукте</span><h1>Lumo Film — кинотеатр дома</h1><p>Фильмы и сериалы в одном месте: найти, начать и продолжить на любом экране.</p><div class="hero-actions"><a class="primary-button" href="${routeForView("catalog")}" data-view="catalog">Открыть каталог</a><a class="secondary-button" href="/" data-view="home">На главную</a></div></div></section><section class="section"><div class="section-header"><div><h2>Что умеет</h2></div></div><div class="about-features">${features}</div></section>`;
  }

  function renderMissingPage({ title = false } = {}) {
    page.innerHTML = title
      ? `<section class="section"><div class="empty-state"><h2>Такого фильма или сериала нет</h2><p>Возможно, ссылка устарела. Его можно поискать в каталоге.</p><div class="hero-actions"><a class="primary-button" href="${routeForView("catalog")}" data-view="catalog">Открыть каталог</a><a class="secondary-button" href="/" data-view="home">На главную</a></div></div></section>`
      : `<section class="section"><div class="empty-state"><h2>Такой страницы нет</h2><p>Возможно, ссылка устарела.</p><a class="primary-button" href="/" data-view="home">На главную</a></div></section>`;
  }

  function renderLibraryView() {
    page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Shared backend library</div><h1>Общий каталог</h1><p class="muted">Фильмы и серии устанавливаются один раз на backend. Все пользователи смотрят общий HLS-поток, а текущий MVP сохраняет продолжение в браузере.</p></div><span class="library-status">${escapeHtml(libraryStatus)}</span></div>${catalogSearchMarkup()}<section class="library-upload-card kinopoisk-import-card"><div><div class="section-kicker">Kinopoisk</div><h2>Добавить фильм или сериал</h2><p class="muted small">Вставь ID или ссылку на карточку. Lumo Film добавит карточку с метаданными без поиска видео. Поток обновится, когда откроешь карточку.</p></div><form id="kinopoisk-import-form" class="library-upload-form"><label>Админский ключ<input name="kinopoisk_admin_token" type="password" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN (локально необязательно)"></label><label for="kinopoisk-import-input">Kinopoisk ID или ссылка<input id="kinopoisk-import-input" name="kinopoisk" required autocomplete="off" placeholder="Например, 689 или https://www.kinopoisk.ru/film/689/"></label><button class="primary-button" type="submit">Добавить в каталог</button><p id="kinopoisk-import-feedback" class="muted small" role="status" aria-live="polite"></p></form></section><section class="library-upload-card"><div><h2>Админский импорт</h2><p class="muted small">Для всего сезона можно выбрать папку целиком. Система сама разберёт <code>S01E01</code> или <code>Season 01/01.mp4</code>; обычным пользователям импорт не нужен.</p></div><form id="library-upload-form" class="library-upload-form"><input id="library-metadata" name="metadata" type="hidden" value="{}"><label>Админский ключ<input id="library-admin-token" type="password" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><label>Название тайтла<input name="title" data-library-title required maxlength="200" placeholder="Выбери карточку выше"></label><div class="library-upload-row"><label>Сезон<input name="season" type="number" min="0" value="1"></label><label>Серия<input name="episode" type="number" min="0" value="1"></label><label class="library-upload-wide">Название серии<input name="episode_title" maxlength="200" placeholder="Для одного файла"></label></div><label>Файлы или папка сезона<input name="file" type="file" required multiple webkitdirectory directory accept="video/*,.mkv,.avi"></label><button class="primary-button" type="submit">Импортировать выбранные серии</button><p id="library-upload-feedback" class="muted small" aria-live="polite"></p></form></section><section class="library-upload-card"><div><h2>Добавить RUTUBE-видео</h2><p class="muted small">Вставь ссылку RUTUBE вида <code>https://rutube.ru/video/...</code> или <code>/play/embed/...</code>. Lumo Film откроет официальный RUTUBE-плеер и не забирает прямой поток.</p></div><form id="library-external-form" class="library-upload-form"><label>Админский ключ<input name="admin_token" type="password" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><label>Название тайтла<input name="title" data-library-title required maxlength="200" placeholder="Например, Отчаянные домохозяйки"></label><div class="library-upload-row"><label>Сезон<input name="season" type="number" min="0" value="1"></label><label>Серия<input name="episode" type="number" min="0" value="1"></label><label class="library-upload-wide">Название серии<input name="episode_title" maxlength="200" placeholder="Например, Пилотная серия"></label></div><label>Ссылка RUTUBE<textarea name="embed_url" required rows="3" placeholder="https://rutube.ru/video/... или https://rutube.ru/play/embed/..."></textarea></label><button class="primary-button" type="submit">Подключить RUTUBE-плеер</button><p id="library-external-feedback" class="muted small" aria-live="polite"></p></form></section><section class="library-upload-card"><div><h2>Импорт JSON озвучек</h2><p class="muted small">Для фильма загрузи варианты с полями <code>data → translations → m3u8/name/quality</code>. Также поддерживаются <code>hlsUrl</code>, <code>filepath</code>, <code>url</code>, <code>sources</code> и <code>videoSources</code>. Система добавит или обновит карточку по Kinopoisk ID и сохранит только стабильные разрешённые HLS-ссылки.</p></div><form id="library-source-json-form" class="library-upload-form"><label>Админский ключ<input name="admin_token" type="password" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><div class="library-upload-row"><label>Kinopoisk ID<input name="kinopoisk_id" type="number" min="1" required placeholder="258687"></label><label>Тип<select name="kind"><option value="movie">Фильм</option><option value="series">Сериал</option></select></label><label class="library-upload-wide">Название (необязательно)<input name="title" maxlength="200" placeholder="Если карточки ещё нет"></label></div><label>Дополнительные метаданные (необязательно)<textarea name="metadata" rows="4" placeholder='{"title":"Интерстеллар","year":2014,"poster_url":"https://..."}'></textarea></label><label>JSON-файл источника<input name="source_json" type="file" required accept=".json,application/json"></label><button class="primary-button" type="submit">Добавить озвучки в каталог</button><p id="library-source-json-feedback" class="muted small" aria-live="polite"></p></form></section>${libraryEpisodes.length ? `<section class="section library-section"><div class="section-header"><h2>Фильмы и серии на сервере</h2><button class="text-button" data-library-refresh type="button">Обновить</button></div><div class="library-episodes">${libraryEpisodes.map(libraryEpisodeMarkup).join("")}</div></section>` : `<section class="section"><div class="empty-state"><h2>Общий каталог пока пуст</h2><p>Добавь первый разрешённый файл на backend. После транскодирования он станет доступен всем пользователям этого сервера.</p></div></section>`}<section class="notice library-notice"><strong>Как это работает.</strong> Локальный файл транскодируется в HLS на backend. RUTUBE-плеер остаётся у RUTUBE и не скачивается Lumo Film.</section>`;
    removeAdminTokenFields(page);
    bindPageActions();
  }

  function openCatalogSourceImport(item) {
    const kinopoiskId = Number(item?.kinopoiskId || item?.kinopoisk_id || 0);
    if (!item || !kinopoiskId) return;
    const kind = item.kind === "series" ? "series" : "movie";
    const kindLabel = kind === "series" ? "Сериал" : "Фильм";
    const metadata = {
      title: item.title || "",
      original_title: item.originalTitle || "",
      year: item.year || "",
      description: item.description || "",
      poster_url: item.posterImage || "",
      runtime: item.runtime || 0,
      ...(kind === "series" && Array.isArray(item.seasons) ? { seasons: item.seasons } : {}),
    };
    const metadataJson = JSON.stringify(metadata, null, 2);
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="catalog-source-import-title"><div class="modal-head"><div><div class="eyebrow">Lumo Film · карточка ${kindLabel.toLowerCase()}</div><h2 id="catalog-source-import-title">Добавить источник</h2></div><button class="icon-button" id="catalog-source-import-close" type="button" aria-label="Закрыть">${uiIcon("close")}</button></div><p class="muted small">JSON будет привязан к этой карточке. Доступны только стабильные разрешённые ссылки — временные URL с токенами не импортируются.</p><form id="catalog-source-import-form" class="library-upload-form"><label>Админский ключ<input name="admin_token" type="password" value="${escapeHtml(adminToken)}" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><div class="library-upload-row"><label>Kinopoisk ID<input name="kinopoisk_id" type="number" value="${kinopoiskId}" readonly></label><label>Тип<input type="text" value="${kindLabel}" readonly><input name="kind" type="hidden" value="${kind}"></label><label class="library-upload-wide">Название<input name="title" value="${escapeHtml(item.title || "")}" readonly></label></div><label>Метаданные карточки<textarea name="metadata" rows="7">${escapeHtml(metadataJson)}</textarea></label><label>JSON-файл источника<input name="source_json" type="file" required accept=".json,application/json"></label><div class="hero-actions"><button class="primary-button" type="submit">Добавить видео в карточку</button><button class="secondary-button" id="catalog-source-import-cancel" type="button">Отмена</button></div><p id="catalog-source-import-feedback" class="muted small" aria-live="polite"></p></form></section></div>`;
    removeAdminTokenFields(modalRoot);
    const close = () => { modalRoot.innerHTML = ""; };
    $("#catalog-source-import-close")?.addEventListener("click", close);
    $("#catalog-source-import-cancel")?.addEventListener("click", close);
    $(".modal-backdrop")?.addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
    $("#catalog-source-import-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const feedback = $("#catalog-source-import-feedback");
      const formData = new FormData(form);
      adminToken = String(formData.get("admin_token") || "").trim();
      if (adminToken) sessionStorage.setItem("cinevault.adminToken", adminToken);
      feedback.textContent = "Проверяю JSON и обновляю карточку…";
      try {
        const metadataValue = String(formData.get("metadata") || "{}").trim() || "{}";
        JSON.parse(metadataValue);
        formData.set("metadata", metadataValue);
        const response = await apiFetch("/api/catalog/source-json", {
          method: "POST",
          headers: adminToken ? { "X-CineVault-Admin-Token": adminToken } : {},
          body: formData,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const skipped = Array.isArray(payload.skipped) && payload.skipped.length ? ` Пропущено: ${payload.skipped.length}.` : "";
        close();
        await loadImportedCatalog();
        renderDetails(item.id);
        window.scrollTo({ top: 0, behavior: "smooth" });
        if (skipped) console.warn(`Источник добавлен частично.${skipped}`);
      } catch (error) {
        feedback.textContent = error.message.includes("403") ? "Импорт доступен только администратору backend." : `JSON не импортирован: ${error.message}`;
      }
    });
  }

  function renderSettings() {
    page.innerHTML = `<div class="page-heading"><div><h1>Настройки</h1><p class="muted">Просмотр и история.</p></div></div>${sectionSwitchMarkup()}
<section class="settings-section"><h2>Просмотр</h2>
<label class="settings-toggle"><input type="checkbox" id="settings-skip"${state.skipSegments !== false ? " checked" : ""}><span><strong>Пропускать заставки автоматически</strong><small>Если для серии известны тайминги вступления и титров.</small></span></label>
<div class="settings-row"><div><strong>История просмотра</strong><small>Удалит «Продолжить просмотр» и историю на всех устройствах.</small></div><button class="secondary-button danger-button" id="settings-clear-history" type="button">Очистить историю</button></div></section>
<section class="settings-section"><h2>Показ</h2>
<label class="settings-toggle"><input type="checkbox" id="settings-showcase"${isShowcase() ? " checked" : ""}><span><strong>Режим показа</strong><small>Готовые избранное и «Продолжить просмотр», а смотреть можно только в своём плеере и трейлеры. Ваши данные вернутся, когда режим выключите.</small></span></label>
<div class="settings-row"><div><strong>О Lumo Film</strong><small>Что умеет сайт и приложения.</small></div><a class="secondary-button" href="/about/" data-view="about">Открыть</a></div></section>
${isAdminMode() ? `<details class="settings-admin"><summary>Для администратора</summary><div class="settings-row"><div><strong>Общий каталог</strong><small>Добавление фильмов, серий и источников.</small></div><a class="secondary-button" href="/library/" data-view="library">Открыть</a></div><div class="settings-row"><div><strong>Режим администратора</strong><small>Служебные разделы видны только на этом устройстве.</small></div><button class="secondary-button" id="settings-admin-off" type="button">Выключить</button></div><div class="settings-grid"><section class="settings-card"><h3>TMDB-каталог</h3><p>${escapeHtml(tmdbStatus)}</p><small class="muted">TMDB добавляет реальные постеры, описания, рейтинги, сезоны и трейлеры. Ключ хранится только локально.</small><p class="attribution">This product uses the TMDB API but is not endorsed or certified by TMDB.</p></section><section class="settings-card"><h3>RUTUBE-плеер</h3><p>Вставь ссылку на разрешённое видео RUTUBE, чтобы открыть его встроенным плеером и сохранять позицию просмотра.</p><div class="provider-input"><input id="rutube-url" type="url" value="${escapeHtml(state.rutubeUrl || "")}" placeholder="https://rutube.ru/video/..." autocomplete="off"><button class="primary-button" id="rutube-open" type="button">Открыть</button></div><button class="secondary-button" id="rutube-test" type="button">Проверить тестовый плеер</button><p id="rutube-feedback" class="muted small" aria-live="polite"></p></section><section class="settings-card settings-card-wide"><h3>Демо: LegalDemoProvider</h3><p>Оффлайн-адаптер для проверки каталога, сезонов, серий и выбора перевода. Он читает только локальные fixtures и не обращается к сайтам, proxy или cookies.</p><div class="provider-input"><input id="hdrezka-query" type="search" value="Тестовый сериал" placeholder="Например, Тестовый сериал" autocomplete="off"><button class="secondary-button" id="hdrezka-search" type="button">Искать</button></div><div class="provider-input hdrezka-episode-inputs"><label>Сезон <input id="hdrezka-season" type="number" min="1" value="1"></label><label>Серия <input id="hdrezka-episode" type="number" min="1" value="1"></label></div><p id="hdrezka-feedback" class="muted small" aria-live="polite"></p><div id="hdrezka-results"></div></section></div></details>` : ""}`;
    bindPageActions();
    $("#settings-admin-off")?.addEventListener("click", () => {
      try { localStorage.removeItem(ADMIN_MODE_KEY); } catch (_error) { /* nothing to remove */ }
      renderSettings();
    });
    $("#settings-skip")?.addEventListener("change", (event) => { state.skipSegments = event.currentTarget.checked; saveState(); });
    $("#settings-showcase")?.addEventListener("change", async (event) => {
      const input = event.currentTarget;
      input.disabled = true;
      try { await setShowcase(input.checked); } finally { renderSettings(); }
    });
    $("#settings-clear-history")?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      if (button.dataset.confirm !== "1") { button.dataset.confirm = "1"; button.textContent = "Точно очистить?"; window.setTimeout(() => { if (button.isConnected) { button.dataset.confirm = ""; button.textContent = "Очистить историю"; } }, 4000); return; }
      state.progress = {}; state.history = []; state.episodeProgress = {};
      saveState(); button.textContent = "История очищена"; button.disabled = true;
    });
  }

  function detailList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
    return String(value || "").split(/[,;/|]/).map((item) => item.trim()).filter(Boolean);
  }

  function detailAge(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^pg[- ]?13$/i.test(raw)) return "13+";
    if (/^pg$/i.test(raw)) return "6+";
    return /\+$/.test(raw) ? raw : `${raw}+`;
  }

  function detailRating(value) {
    const rating = Number(value);
    return Number.isFinite(rating) && rating > 0 ? rating.toFixed(1) : "—";
  }

  function detailFact(label, value) {
    const text = Array.isArray(value) ? value.join(", ") : String(value || "").trim();
    return text ? `<div class="detail-fact"><dt>${label}</dt><dd>${escapeHtml(text)}</dd></div>` : "";
  }

  const similarTitlesCache = new Map();
  // ---- Home as in Lampa (src/core/api/sources/tmdb.js main()): fixed TMDB rows, then genre
  // rows without end while scrolling.
  let tmdbHome = null;
  let tmdbHomeLoading = null;
  let tmdbHomeGenreCursor = 0;
  const tmdbHomeGenreRows = [];
  const TMDB_HOME_GENRES = [[28, "Боевики"], [35, "Комедии"], [18, "Драмы"], [878, "Фантастика"], [53, "Триллеры"], [16, "Мультфильмы"], [27, "Ужасы"], [10749, "Мелодрамы"], [80, "Криминал"], [12, "Приключения"], [14, "Фэнтези"], [9648, "Детективы"], [10751, "Семейные"], [36, "Исторические"], [10752, "Военные"], [99, "Документальные"], [37, "Вестерны"], [10402, "Музыкальные"]];
  const TMDB_MOVIE_GENRE_IDS = new Set([28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]);
  const TMDB_TV_GENRE_IDS = new Set([10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37]);
  function tmdbDiscoverPath(kind, page = 1) {
    const params = new URLSearchParams({ language: "ru-RU", page: String(page), include_adult: "false" });
    const dateField = kind === "movie" ? "primary_release_date" : "first_air_date";
    const sort = state.catalogSort || "now";
    if (state.view === "upcoming") {
      params.set(`${dateField}.gte`, tmdbDay(1));
      params.set("sort_by", "popularity.desc");
    } else if (state.catalogCollection === "new") {
      // «Последний год», as Lampa's title_last_year: this and last year, already out.
      params.set(`${dateField}.gte`, `${new Date().getFullYear() - 1}-01-01`);
      params.set(`${dateField}.lte`, tmdbDay());
      params.set("sort_by", "popularity.desc");
      params.set("vote_count.gte", "20");
    } else if (state.catalogCollection === "audience") {
      params.set("sort_by", "vote_count.desc");
    } else if (sort === "audience") params.set("sort_by", "vote_count.desc");
    else if (sort === "rating") { params.set("sort_by", "vote_average.desc"); params.set("vote_count.gte", kind === "movie" ? "500" : "200"); }
    else if (sort === "year") { params.set("sort_by", `${dateField}.desc`); params.set(`${dateField}.lte`, tmdbDay()); params.set("vote_count.gte", "20"); }
    else if (sort === "title") { params.set("sort_by", kind === "movie" ? "original_title.asc" : "name.asc"); params.set("vote_count.gte", "300"); }
    else params.set("sort_by", "popularity.desc");
    const genre = String(state.catalogGenre || "").trim().toLowerCase();
    if (genre) {
      const valid = kind === "movie" ? TMDB_MOVIE_GENRE_IDS : TMDB_TV_GENRE_IDS;
      const ids = Object.entries(TMDB_GENRES).filter(([id, name]) => name === genre && valid.has(Number(id))).map(([id]) => id);
      if (genre === "мультфильм" || genre === "анимация") ids.push("16");
      if (genre === "аниме") { ids.push("16"); params.set("with_original_language", "ja"); }
      params.set("with_genres", ids.length ? [...new Set(ids)].join("|") : "0");
    }
    return `discover/${kind}?${params}`;
  }
  function tmdbDay(offsetDays = 0) {
    return new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);
  }
  function loadTmdbHome() {
    if (tmdbHome) return Promise.resolve(tmdbHome);
    if (tmdbHomeLoading) return tmdbHomeLoading;
    const rows = [
      ["now", "Сейчас смотрят", "Вышли в цифре за последние три месяца — не экранки", `discover/movie?with_release_type=4%7C5%7C6&release_date.lte=${tmdbDay()}&release_date.gte=${tmdbDay(-90)}&sort_by=popularity.desc&vote_count.gte=10`, "movie"],
      ["trend-day", "Тренды дня", "", "trending/all/day", ""],
      ["trend-week", "Тренды недели", "", "trending/movie/week", "movie"],
      ["upcoming", "Скоро", "Премьеры ближайших двух месяцев", `discover/movie?primary_release_date.gte=${tmdbDay(1)}&primary_release_date.lte=${tmdbDay(60)}&sort_by=popularity.desc`, "movie"],
      ["popular-movies", "Популярные фильмы", "", "movie/popular", "movie"],
      ["popular-tv", "Популярные сериалы", "", "trending/tv/week", "tv"],
      ["ru-movies", "Российские фильмы", "", "discover/movie?with_origin_country=RU&sort_by=popularity.desc&vote_count.gte=20", "movie"],
      ["top-movies", "Топ фильмов", "", "movie/top_rated", "movie"],
      ["top-tv", "Топ сериалов", "", "tv/top_rated", "tv"],
    ];
    const today = tmdbDay();
    tmdbHomeLoading = Promise.all(rows.map(([key, title, description, path, kind]) => cvTmdb(`${path}${path.includes("?") ? "&" : "?"}language=ru-RU`)
      .then((json) => {
        let items = tmdbListItems(json, kind);
        if (key === "upcoming") items = items.filter((item) => !item.premiere || item.premiere >= today);
        return { key, title, description, items };
      })
      .catch(() => ({ key, title, description, items: [] }))))
      .then((list) => {
        tmdbHome = list.filter((row) => row.items.length);
        rememberLooseTitles(tmdbHome.flatMap((row) => row.items));
        return tmdbHome;
      })
      .finally(() => { tmdbHomeLoading = null; });
    return tmdbHomeLoading;
  }
  // «Топ-10 за неделю»: the week's trends with big rank numbers next to the posters.
  function tmdbTopTenMarkup(items) {
    const list = items.filter((item) => item.posterImage).slice(0, 10);
    if (list.length < 5) return "";
    return `<section class="discovery-shelf top-ten-shelf" data-tmdb-row="top10"><div class="section-header discovery-shelf-header"><div><h2>Топ-10 за неделю</h2></div></div><div class="discovery-rail top-ten-rail">${list.map((item, index) => `<a class="top-ten-card" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}" aria-label="${index + 1}. ${escapeHtml(item.title)}"><span class="top-ten-number" aria-hidden="true">${index + 1}</span><span class="top-ten-poster"><img src="${escapeHtml(previewImageUrl(highResolutionPosterUrl(item.posterImage)))}" alt="" loading="lazy" decoding="async"></span></a>`).join("")}</div></section>`;
  }
  // «Сейчас смотрят» as big frames (as the services' premieres): the frame, the film's logo, one line of facts,
  // two lines of story and the button; the rest of the rows stay posters.
  function tmdbWideRowMarkup(row) {
    const list = row.items.filter((item) => item.backdropImage).slice(0, 12);
    if (list.length < 3) return "";
    return `<section class="discovery-shelf wide-shelf" data-tmdb-row="${escapeHtml(row.key)}"><div class="section-header discovery-shelf-header"><div><h2>${escapeHtml(row.title)}</h2></div></div><div class="wide-rail">${list.map((item) => {
      const line = itemMetaLine(item);
      const rating = catalogRatingValue(item);
      return `<article class="wide-card" style="--wide-image:url('${escapeHtml(item.backdropImage)}')"><a class="wide-card-link" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)}"></a><div class="wide-card-copy"><h3 class="wide-card-title is-logo-pending" data-logo-for="${escapeHtml(item.id)}">${escapeHtml(item.title)}</h3><p class="wide-card-meta">${rating ? `<span class="wide-card-rating">${rating.toFixed(1)}</span>` : ""}${[line[0], line.length > 2 ? line[1] : ""].filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</p>${item.description ? `<p class="wide-card-text">${escapeHtml(item.description)}</p>` : ""}<a class="primary-button wide-card-button" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}">Подробнее</a></div></article>`;
    }).join("")}</div></section>`;
  }
  function tmdbHomeRowMarkup(row) {
    if (!row.items.length) return "";
    if (row.key === "now") return tmdbWideRowMarkup(row) || "";
    return `<section class="discovery-shelf" data-tmdb-row="${escapeHtml(row.key)}"><div class="section-header discovery-shelf-header"><div><h2>${escapeHtml(row.title)}</h2>${row.description ? `<p>${escapeHtml(row.description)}</p>` : ""}</div></div><div class="discovery-rail">${row.items.map((candidate) => poster(candidate)).join("")}</div></section>`;
  }
  function tmdbHomeShelves(continueShelf) {
    if (!tmdbHome) {
      loadTmdbHome().then(() => { if (state.view === "home" && readRouteFromLocation().type === "view" && readRouteFromLocation().view === "home") { renderHome(); hydrateLazyPosters(); } }).catch(() => {});
      return `${continueShelf || ""}<div class="home-rows-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span> Загружаю подборки…</div>`;
    }
    if (personalRecsKey !== personalSeeds().map((seed) => seed.id).join(",") || (!personalRecs && !personalRecsLoading)) {
      loadPersonalRecs().then(() => { if (state.view === "home" && readRouteFromLocation().type === "view" && readRouteFromLocation().view === "home") { renderHome(); hydrateLazyPosters(); } }).catch(() => {});
    }
    const week = tmdbHome.find((row) => row.key === "trend-week")?.items || [];
    const [firstRow, ...otherRows] = tmdbHome;
    return `${continueShelf || ""}${personalShelvesMarkup()}${firstRow ? tmdbHomeRowMarkup(firstRow) : ""}${tmdbTopTenMarkup(week)}${otherRows.map(tmdbHomeRowMarkup).join("")}${tmdbHomeGenreRows.map(tmdbHomeRowMarkup).join("")}<div class="home-more" data-tmdb-home-more aria-hidden="true"></div>`;
  }
  // «Для вас» from everything watched: every title in the history, the progress and the favourites is a seed
  // (newer and finished ones weigh more); TMDB's «recommendations» of each seed are pooled, a title liked by
  // several seeds rises, a well-rated and popular one rises, an obscure or weak one sinks; nothing seen is shown.
  let personalRecs = null;
  let personalRecsKey = "";
  let personalRecsLoading = null;
  function personalSeeds() {
    const progress = Object.values(state.progress || {}).filter((entry) => entry?.titleId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const finished = new Set(progress.filter((entry) => entry.completed || (entry.duration && entry.position / entry.duration > 0.6)).map((entry) => String(entry.titleId)));
    const ordered = [...new Set([...progress.map((entry) => String(entry.titleId)), ...(state.history || []).map(String), ...(state.favorites || []).map(String)])];
    const favorites = new Set((state.favorites || []).map(String));
    return ordered.slice(0, 24).map((id, index) => ({ id, weight: (1 / (1 + index * 0.12)) * (finished.has(id) ? 1.3 : 1) * (favorites.has(id) ? 1.4 : 1) }));
  }
  function loadPersonalRecs() {
    const seeds = personalSeeds();
    const key = seeds.map((seed) => seed.id).join(",");
    if (personalRecs && personalRecsKey === key) return Promise.resolve(personalRecs);
    if (personalRecsLoading && personalRecsKey === key) return personalRecsLoading;
    personalRecsKey = key;
    if (!seeds.length) { personalRecs = { top: [], because: [] }; return Promise.resolve(personalRecs); }
    personalRecsLoading = (async () => {
      const seen = new Set(seeds.map((seed) => seed.id));
      const resolved = await Promise.all(seeds.map(async (seed) => {
        const ref = await tmdbRefFor(seed.id).catch(() => null);
        if (!ref) return null;
        const type = ref.kind === "series" ? "tv" : "movie";
        seen.add(`tmdb-${type}-${ref.tmdbId}`);
        const json = await cvTmdb(`${type}/${ref.tmdbId}/recommendations?language=ru-RU`, 8000).catch(() => null);
        return { ...seed, title: getTitle(seed.id)?.title || "", items: tmdbListItems(json, type) };
      }));
      const pool = new Map();
      const usable = resolved.filter((entry) => entry && entry.items.length);
      for (const seed of usable) {
        seed.items.forEach((item, rank) => {
          if (seen.has(item.id) || hasSharedHistory(item)) return;
          const entry = pool.get(item.id) || { item, score: 0, seeds: [] };
          entry.score += seed.weight * (1 - rank / 25);
          entry.seeds.push(seed);
          pool.set(item.id, entry);
        });
      }
      const quality = (item) => {
        const rating = Number(item.rating || 0);
        const votes = Number(item.votes || 0);
        const ratingFactor = rating ? Math.max(0.35, Math.min(1.25, (rating - 4.5) / 3)) : 0.5;
        const popularity = 1 + 0.12 * Math.log10(1 + Number(item.popularity || 0)) + 0.08 * Math.log10(1 + votes);
        return ratingFactor * popularity * (votes < 40 ? 0.5 : 1);
      };
      const ranked = [...pool.values()].map((entry) => ({ ...entry, final: entry.score * quality(entry.item) })).sort((a, b) => b.final - a.final);
      const top = ranked.map((entry) => ({ ...entry.item, personalBecause: entry.seeds.sort((a, b) => b.weight - a.weight)[0]?.title || "" }));
      const because = usable.slice(0, 3).filter((seed) => seed.title).map((seed) => ({
        title: seed.title,
        items: seed.items.filter((item) => !seen.has(item.id) && !hasSharedHistory(item) && Number(item.votes || 0) >= 40).slice(0, 16),
      })).filter((row) => row.items.length >= 5);
      rememberLooseTitles([...top, ...because.flatMap((row) => row.items)]);
      personalRecs = { top: top.slice(0, 40), because };
      return personalRecs;
    })().finally(() => { personalRecsLoading = null; });
    return personalRecsLoading;
  }
  function personalShelvesMarkup() {
    if (!personalRecs?.top?.length) return "";
    const rows = [];
    if (personalRecs.top.length >= 6) rows.push({ key: "for-you", title: "Для вас", description: "По тому, что вы смотрели", items: personalRecs.top.slice(0, 20) });
    personalRecs.because.slice(0, 2).forEach((row, index) => rows.push({ key: `because-${index}`, title: `Похоже на «${row.title}»`, description: "", items: row.items }));
    return rows.map(tmdbHomeRowMarkup).join("");
  }
  let tmdbHomeObserver = null;
  let tmdbHomeMoreBusy = false;
  function bindTmdbHomeMore() {
    tmdbHomeObserver?.disconnect();
    const sentinel = page.querySelector("[data-tmdb-home-more]");
    if (!sentinel || !("IntersectionObserver" in window)) return;
    tmdbHomeObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNextTmdbGenreRow();
    }, { rootMargin: "800px 0px" });
    tmdbHomeObserver.observe(sentinel);
  }
  async function loadNextTmdbGenreRow() {
    if (tmdbHomeMoreBusy) return;
    if (tmdbHomeGenreCursor >= TMDB_HOME_GENRES.length * 2) return;
    tmdbHomeMoreBusy = true;
    try {
      const index = tmdbHomeGenreCursor++;
      const [genreId, name] = TMDB_HOME_GENRES[index % TMDB_HOME_GENRES.length];
      // First lap: popular films of the genre; second lap: the best rated ones.
      const second = index >= TMDB_HOME_GENRES.length;
      const path = `discover/movie?with_genres=${genreId}&sort_by=${second ? "vote_average.desc&vote_count.gte=1500" : "popularity.desc&vote_count.gte=50"}&language=ru-RU`;
      const items = tmdbListItems(await cvTmdb(path).catch(() => null), "movie");
      const row = { key: `genre-${index}`, title: second ? `${name}: лучшие` : name, description: "", items };
      if (!items.length) return;
      tmdbHomeGenreRows.push(row);
      rememberLooseTitles(items);
      const sentinel = page.querySelector("[data-tmdb-home-more]");
      if (sentinel) { sentinel.insertAdjacentHTML("beforebegin", tmdbHomeRowMarkup(row)); hydrateLazyPosters(); }
    } finally {
      tmdbHomeMoreBusy = false;
      const sentinel = page.querySelector("[data-tmdb-home-more]");
      if (sentinel && sentinel.getBoundingClientRect().top < window.innerHeight + 800) window.setTimeout(loadNextTmdbGenreRow, 50);
    }
  }

  // ---- Sections as in Lampa: «Фильмы», «Сериалы», «Мультфильмы» are pages of themed rows
  // (now watching, this year, last year, Russian, top rated, worth rewatching…) followed by
  // endless genre rows. «Каталог» stays the grid with filters.
  const SECTION_PAGES = {
    movies: { title: "Фильмы", note: "Подборки как в Lampa: новинки в цифре, этого и прошлого года, российские, лучшие и жанры." },
    series: { title: "Сериалы", note: "Что выходит сейчас, новинки, российские сериалы, лучшие и жанры." },
    cartoons: { title: "Мультфильмы", note: "Мультфильмы и мультсериалы: новинки, популярное, российские, лучшие и жанры. Аниме — в своём разделе." },
    anime: { title: "Аниме", note: "Японская анимация: что выходит сейчас, новинки, популярное, лучшее и жанры." },
  };
  const SECTION_GENRES = {
    movies: [[28, "Боевики"], [35, "Комедии"], [18, "Драмы"], [878, "Фантастика"], [53, "Триллеры"], [27, "Ужасы"], [10749, "Мелодрамы"], [80, "Криминал"], [12, "Приключения"], [14, "Фэнтези"], [9648, "Детективы"], [10751, "Семейные"], [36, "Исторические"], [10752, "Военные"], [99, "Документальные"], [37, "Вестерны"], [10402, "Музыкальные"]],
    series: [[18, "Драмы"], [35, "Комедии"], [80, "Криминал"], [10765, "Фантастика и фэнтези"], [10759, "Боевики и приключения"], [9648, "Детективы"], [10751, "Семейные"], [99, "Документальные"], [10768, "Военные"], [10764, "Реалити-шоу"], [37, "Вестерны"]],
    cartoons: [[10751, "Семейные"], [35, "Комедии"], [12, "Приключения"], [14, "Фэнтези"], [878, "Фантастика"], [10402, "Музыкальные"], [28, "Боевики"]],
    anime: [[10759, "Экшен и приключения"], [10765, "Фантастика и фэнтези"], [35, "Комедии"], [18, "Драмы"], [9648, "Детективы"], [10762, "Для детей"], [80, "Криминал"]],
  };
  const sectionCache = new Map();
  const sectionGenreState = new Map();
  let sectionObserver = null;
  function sectionRows(view) {
    const year = new Date().getFullYear();
    const today = tmdbDay();
    const movie = (query) => [`discover/movie?${query}`, "movie"];
    const tv = (query) => [`discover/tv?${query}`, "tv"];
    if (view === "series") return [
      ["on-air", "Сейчас выходят", "Новые серии на этой неделе", ...tv(`air_date.gte=${tmdbDay(-7)}&air_date.lte=${today}&sort_by=popularity.desc&vote_count.gte=30`)],
      ["popular", "Популярные", "", "trending/tv/week", "tv"],
      ["this-year", `Новинки ${year} года`, "", ...tv(`first_air_date_year=${year}&sort_by=popularity.desc&vote_count.gte=10`)],
      ["ru", "Российские сериалы", "", ...tv("with_origin_country=RU&sort_by=popularity.desc&vote_count.gte=5")],
      ["last-year", `Сериалы ${year - 1} года`, "", ...tv(`first_air_date_year=${year - 1}&sort_by=popularity.desc&vote_count.gte=30`)],
      ["top", "Высокий рейтинг", "", ...tv("vote_average.gte=8&vote_count.gte=500&sort_by=vote_average.desc")],
      ["rewatch", "Стоит пересмотреть", "Лучшее из 2000–2015", ...tv("first_air_date.gte=2000-01-01&first_air_date.lte=2015-12-31&vote_count.gte=800&sort_by=vote_average.desc")],
    ];
    const ja = "with_genres=16&with_original_language=ja";
    const jp = "with_genres=16&with_origin_country=JP";
    if (view === "anime") return [
      ["on-air", "Сейчас выходят", "Новые серии на этой неделе", ...tv(`${jp}&air_date.gte=${tmdbDay(-7)}&air_date.lte=${today}&sort_by=popularity.desc`)],
      ["popular", "Популярное аниме", "", ...tv(`${jp}&sort_by=popularity.desc&vote_count.gte=50`)],
      ["this-year", `Новинки ${year} года`, "", ...tv(`${jp}&first_air_date_year=${year}&sort_by=popularity.desc`)],
      ["movies", "Аниме-фильмы", "", ...movie(`${ja}&sort_by=popularity.desc&vote_count.gte=100`)],
      ["last-year", `Аниме ${year - 1} года`, "", ...tv(`${jp}&first_air_date_year=${year - 1}&sort_by=popularity.desc&vote_count.gte=20`)],
      ["top", "Высокий рейтинг", "", ...tv(`${jp}&vote_average.gte=8&vote_count.gte=300&sort_by=vote_average.desc`)],
      ["top-movies", "Лучшие аниме-фильмы", "", ...movie(`${ja}&vote_average.gte=7.8&vote_count.gte=500&sort_by=vote_average.desc`)],
    ];
    if (view === "cartoons") return [
      ["now", "Сейчас смотрят", "Вышли в цифре за три месяца", ...movie(`with_genres=16&with_release_type=4%7C5%7C6&release_date.lte=${today}&release_date.gte=${tmdbDay(-90)}&sort_by=popularity.desc`)],
      ["popular", "Популярные мультфильмы", "", ...movie("with_genres=16&sort_by=popularity.desc&vote_count.gte=50")],
      ["this-year", `Новинки ${year} года`, "", ...movie(`with_genres=16&primary_release_year=${year}&sort_by=popularity.desc`)],
      ["series", "Мультсериалы", "", ...tv("with_genres=16&sort_by=popularity.desc&vote_count.gte=100&without_genres=10767%2C10764")],
      ["ru", "Российские мультфильмы", "", ...movie("with_genres=16&with_origin_country=RU&sort_by=popularity.desc")],
      ["last-year", `Мультфильмы ${year - 1} года`, "", ...movie(`with_genres=16&primary_release_year=${year - 1}&sort_by=popularity.desc`)],
      ["top", "Высокий рейтинг", "", ...movie("with_genres=16&vote_average.gte=7.8&vote_count.gte=800&sort_by=vote_average.desc")],
      ["rewatch", "Стоит пересмотреть", "Классика 1990–2015", ...movie("with_genres=16&primary_release_date.gte=1990-01-01&primary_release_date.lte=2015-12-31&vote_count.gte=1500&sort_by=vote_average.desc")],
    ];
    return [
      ["now", "Сейчас смотрят", "Вышли в цифре за три месяца — не экранки", ...movie(`with_release_type=4%7C5%7C6&release_date.lte=${today}&release_date.gte=${tmdbDay(-90)}&sort_by=popularity.desc&without_genres=16`)],
      ["popular", "Популярные", "", "movie/popular", "movie"],
      ["this-year", `Новинки ${year} года`, "", ...movie(`primary_release_year=${year}&primary_release_date.lte=${today}&sort_by=popularity.desc&without_genres=16`)],
      ["ru", "Российские фильмы", "", ...movie("with_origin_country=RU&sort_by=popularity.desc&without_genres=16&vote_count.gte=20")],
      ["last-year", `Фильмы ${year - 1} года`, "", ...movie(`primary_release_year=${year - 1}&sort_by=popularity.desc&vote_count.gte=100&without_genres=16`)],
      ["top", "Высокий рейтинг", "", ...movie("vote_average.gte=8&vote_count.gte=2000&sort_by=vote_average.desc&without_genres=16")],
      ["rewatch", "Стоит пересмотреть", "Лучшее из 1995–2015", ...movie("primary_release_date.gte=1995-01-01&primary_release_date.lte=2015-12-31&vote_count.gte=3000&sort_by=vote_average.desc")],
      ["ru-classic", "Российская классика", "", ...movie("with_origin_country=RU%7CSU&primary_release_date.lte=2005-12-31&vote_count.gte=50&sort_by=vote_average.desc")],
    ];
  }
  // «Мультфильмы» without anime: it has its own section.
  function sectionItems(view, items) {
    return view === "cartoons" ? items.filter((entry) => !entry.isAnime) : items;
  }
  function loadSectionRows(view) {
    if (sectionCache.has(view)) return sectionCache.get(view);
    const job = Promise.all(sectionRows(view).map(([key, title, description, path, kind]) => cvTmdb(`${path}${path.includes("?") ? "&" : "?"}language=ru-RU`)
      .then((json) => ({ key: `${view}-${key}`, title, description, items: sectionItems(view, tmdbListItems(json, kind)) }))
      .catch(() => ({ key: `${view}-${key}`, title, description, items: [] }))))
      .then((rows) => {
        const ready = rows.filter((row) => row.items.length);
        rememberLooseTitles(ready.flatMap((row) => row.items));
        if (!ready.length) sectionCache.delete(view);
        return ready;
      });
    sectionCache.set(view, job);
    return job;
  }
  function renderSectionPage(view) {
    const meta = SECTION_PAGES[view];
    const genres = sectionGenreState.get(view) || { cursor: 0, rows: [] };
    sectionGenreState.set(view, genres);
    const head = `<div class="page-heading"><div><h1>${meta.title}</h1><p class="muted">${meta.note}</p></div></div>${sectionSwitchMarkup()}`;
    page.innerHTML = `${head}<div class="home-rows-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span> Загружаю подборки…</div>`;
    loadSectionRows(view).then((rows) => {
      if (state.view !== view) return;
      page.innerHTML = `${head}${rows.map(tmdbHomeRowMarkup).join("")}${genres.rows.map(tmdbHomeRowMarkup).join("")}<div class="home-more" data-section-more aria-hidden="true"></div>`;
      hydrateLazyPosters();
      bindSectionMore(view);
    });
  }
  function bindSectionMore(view) {
    sectionObserver?.disconnect();
    const sentinel = page.querySelector("[data-section-more]");
    if (!sentinel || !("IntersectionObserver" in window)) return;
    sectionObserver = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) loadNextSectionGenreRow(view); }, { rootMargin: "800px 0px" });
    sectionObserver.observe(sentinel);
  }
  async function loadNextSectionGenreRow(view) {
    const genres = sectionGenreState.get(view);
    const list = SECTION_GENRES[view];
    if (!genres || genres.busy || genres.cursor >= list.length * 2) return;
    genres.busy = true;
    try {
      const index = genres.cursor++;
      const [genreId, name] = list[index % list.length];
      const second = index >= list.length;
      const kind = view === "series" || view === "anime" ? "tv" : "movie";
      const base = view === "anime" ? `with_genres=16%2C${genreId}&with_origin_country=JP` : view === "cartoons" ? `with_genres=16%2C${genreId}` : `with_genres=${genreId}${view === "movies" ? "&without_genres=16" : ""}`;
      const sort = second ? `vote_average.desc&vote_count.gte=${view === "movies" ? 1500 : 300}` : "popularity.desc&vote_count.gte=50";
      const items = sectionItems(view, tmdbListItems(await cvTmdb(`discover/${kind}?${base}&sort_by=${sort}&language=ru-RU`).catch(() => null), kind));
      if (!items.length || state.view !== view) return;
      const row = { key: `${view}-genre-${index}`, title: second ? `${name}: лучшие` : name, description: "", items };
      genres.rows.push(row);
      rememberLooseTitles(items);
      page.querySelector("[data-section-more]")?.insertAdjacentHTML("beforebegin", tmdbHomeRowMarkup(row));
      hydrateLazyPosters();
    } finally {
      genres.busy = false;
      const sentinel = page.querySelector("[data-section-more]");
      if (sentinel && state.view === view && sentinel.getBoundingClientRect().top < window.innerHeight + 800) window.setTimeout(() => loadNextSectionGenreRow(view), 50);
    }
  }

  // Under a TMDB card, as in Lampa: the cast with photos, then TMDB's recommendations and similar titles.
  const tmdbExtrasCache = new Map();
  function personCardMarkup(person) {
    const photo = person.photo ? `<img src="${escapeHtml(person.photo)}" alt="" loading="lazy" decoding="async">` : `<span class="person-card-initial" aria-hidden="true">${escapeHtml(String(person.name || "?").slice(0, 1))}</span>`;
    return `<a class="person-card" href="${routeForPerson(person.id)}" data-open-person="${escapeHtml(String(person.id))}"><span class="person-card-photo">${photo}</span><strong>${escapeHtml(person.name)}</strong>${person.role ? `<small>${escapeHtml(person.role)}</small>` : ""}</a>`;
  }
  function tmdbShelfSection(key, title, items) {
    if (!items.length) return "";
    return `<section class="discovery-shelf" data-tmdb-extra="${escapeHtml(key)}"><div class="section-header discovery-shelf-header"><div><h2>${escapeHtml(title)}</h2></div></div><div class="discovery-rail">${items.map((candidate) => poster(candidate)).join("")}</div></section>`;
  }
  async function renderTmdbExtras(item) {
    let pending = tmdbExtrasCache.get(item.id);
    if (!pending) {
      const kindPath = item.kind === "series" ? "tv" : "movie";
      pending = Promise.all([
        cvTmdb(`${kindPath}/${item.tmdbId}/recommendations?language=ru-RU`).catch(() => null),
        cvTmdb(`${kindPath}/${item.tmdbId}/similar?language=ru-RU`).catch(() => null),
      ]).then(([recommended, similar]) => {
        const recommendations = tmdbListItems(recommended, kindPath).slice(0, 20);
        const seen = new Set(recommendations.map((entry) => entry.id));
        const alike = tmdbListItems(similar, kindPath).filter((entry) => !seen.has(entry.id)).slice(0, 20);
        rememberLooseTitles([...recommendations, ...alike]);
        return { recommendations, alike };
      });
      tmdbExtrasCache.set(item.id, pending);
    }
    const cast = (item.people || []).filter((person) => person.name).slice(0, 20);
    const castSection = cast.length ? `<section class="discovery-shelf person-shelf" data-tmdb-extra="cast"><div class="section-header discovery-shelf-header"><div><h2>В ролях</h2></div></div><div class="discovery-rail person-rail">${cast.map(personCardMarkup).join("")}</div></section>` : "";
    if (castSection && !page.querySelector('[data-tmdb-extra="cast"]')) page.insertAdjacentHTML("beforeend", castSection);
    try {
      const { recommendations, alike } = await pending;
      if (activeTitleId !== item.id) return;
      if (!page.querySelector('[data-tmdb-extra="recommendations"]')) page.insertAdjacentHTML("beforeend", tmdbShelfSection("recommendations", "Рекомендации", recommendations));
      if (!page.querySelector('[data-tmdb-extra="similar"]')) page.insertAdjacentHTML("beforeend", tmdbShelfSection("similar", "Похожие", alike));
      hydrateLazyPosters();
    } catch { tmdbExtrasCache.delete(item.id); }
  }

  // A person, as in Lampa: photo, dates, biography and what they are known for, best first.
  const tmdbPeopleCache = new Map();
  async function renderPersonPage(personId) {
    state.view = "person";
    page.innerHTML = `<div class="page-heading"><a class="text-button" href="/" data-back-from-detail>Назад</a></div><section class="person-page" aria-busy="true"><div class="loading-spinner" aria-hidden="true"></div></section>`;
    let data = tmdbPeopleCache.get(personId);
    if (!data) {
      data = cvTmdb(`person/${personId}?language=ru-RU&append_to_response=combined_credits`).then(async (person) => {
        if (!person.biography) {
          const english = await cvTmdb(`person/${personId}?language=en-US`).catch(() => null);
          if (english?.biography) person.biography = english.biography;
        }
        person.biography = String(person.biography || "").replace(/\*\*|__/g, "").trim();
        return person;
      });
      tmdbPeopleCache.set(personId, data);
    }
    let person;
    try { person = await data; } catch {
      tmdbPeopleCache.delete(personId);
      if (readRouteFromLocation().id !== personId) return;
      page.innerHTML = `<section class="section"><div class="empty-state"><h2>Не удалось загрузить</h2><p>Попробуйте открыть страницу ещё раз.</p></div></section>`;
      return;
    }
    if (readRouteFromLocation().type !== "person" || readRouteFromLocation().id !== personId) return;
    const credits = [...(person.combined_credits?.cast || []), ...(person.combined_credits?.crew || []).filter((entry) => entry.job === "Director")];
    // Only real roles, newest first: no talk shows, news, award shows or playing oneself.
    const selfRole = /\b(himself|herself|themselves|self)\b|сам(а|и)?\s*себя|себя|камео|cameo|archive footage|архивн/i;
    const notRoles = new Set([10767, 10763, 10764]);
    const unique = [...new Map(credits
      .filter((entry) => (entry.media_type === "movie" || entry.media_type === "tv") && !selfRole.test(String(entry.character || "")) && !(entry.genre_ids || []).some((id) => notRoles.has(id)))
      .map((entry) => [`${entry.media_type}-${entry.id}`, entry])).values()];
    const dateOf = (entry) => String(entry.release_date || entry.first_air_date || "");
    const today = new Date().toISOString().slice(0, 10);
    const toItems = (list) => list.map((raw) => withTitleOverrides(tmdbToItem(raw))).filter((entry) => entry.posterImage);
    const upcoming = toItems(unique.filter((entry) => !dateOf(entry) || dateOf(entry) > today).sort((a, b) => (dateOf(a) || "9999").localeCompare(dateOf(b) || "9999")));
    const recent = toItems(unique.filter((entry) => dateOf(entry) && dateOf(entry) <= today).sort((a, b) => dateOf(b).localeCompare(dateOf(a)))).slice(0, 40);
    rememberLooseTitles([...upcoming, ...recent]);
    const age = person.birthday ? Math.floor((new Date(person.deathday || Date.now()) - new Date(person.birthday)) / (365.25 * 864e5)) : 0;
    const dates = person.birthday ? `${new Date(person.birthday).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}${person.deathday ? ` — ${new Date(person.deathday).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}` : ""}${age ? ` · ${countWord(age, "год", "года", "лет")}` : ""}` : "";
    const department = { Acting: "Актёр", Directing: "Режиссёр", Writing: "Сценарист", Production: "Продюсер" }[person.known_for_department] || "";
    const photo = person.profile_path ? `<img class="person-photo" src="${escapeHtml(tmdbImage(person.profile_path, "w500"))}" alt="">` : "";
    page.innerHTML = `<div class="page-heading"><a class="text-button" href="/" data-back-from-detail>Назад</a></div>
      <section class="person-page"><div class="person-head">${photo}<div class="person-info"><div class="eyebrow">${escapeHtml(department || "Персона")}</div><h1>${escapeHtml(person.name || "")}</h1>${dates ? `<p class="person-dates">${escapeHtml(dates)}</p>` : ""}${person.place_of_birth ? `<p class="person-place">${escapeHtml(person.place_of_birth)}</p>` : ""}${person.biography ? `<p class="person-bio">${escapeHtml(person.biography)}</p>` : ""}</div></div></section>
      ${tmdbShelfSection("upcoming", "Скоро выйдут", upcoming)}${tmdbShelfSection("recent", "Последние роли", recent)}`;
    document.title = `${person.name} — Lumo Film`;
    hydrateLazyPosters();
  }

  async function renderSimilarTitles(item) {
    if (item.source === "tmdb") return renderTmdbExtras(item);
    const genre = genresForItem(item)[0];
    if (!genre) return;
    let pending = similarTitlesCache.get(item.id);
    if (!pending) {
      const params = new URLSearchParams({ page: '1', limit: '30', sort: 'popular', type: item.kind, genre });
      pending = apiFetch(`/api/catalog?${params}`, { headers: { accept: 'application/json' } })
        .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
        .then((data) => (data.items || []).filter((candidate) => candidate.id !== item.id).slice(0, 15));
      similarTitlesCache.set(item.id, pending);
    }
    try {
      const items = await pending;
      if (activeTitleId !== item.id || !items.length) return;
      if (page.querySelector('[data-similar-titles]')) return;
      const section = document.createElement('section');
      section.className = 'discovery-shelf';
      section.dataset.similarTitles = item.id;
      section.innerHTML = `<div class="section-header discovery-shelf-header"><div><h2>Похожие</h2></div></div><div class="discovery-rail">${items.map((candidate) => poster(candidate)).join('')}</div>`;
      page.append(section);
      rememberLooseTitles(items);
    } catch { similarTitlesCache.delete(item.id); }
  }

  function renderDetails(id) {
    const item = getTitle(id);
    if (!item) return;
    if (item.kinopoiskId && !Array.isArray(item.videoSources) && !importedDetailsLoaded.has(String(item.kinopoiskId))) {
      loadImportedTitleDetails(item);
    }
    const enteringTitle = activeTitleId !== id;
    if (enteringTitle && Number(item.catalogId || 0) === 2205 && !item.episodePosterUrls && !episodeAssetsLoading) loadEpisodeAssets();
    if (item.kind === "series" && !episodeRatingsCache.has(item.id)) loadEpisodeRatings(item);
    // Loading metadata and episodes finishes after the page is already open.
    // Rebuilding the detail DOM must not throw the reader back to the top.
    const preservedScrollY = enteringTitle ? 0 : window.scrollY;
    if (enteringTitle) selectedSeason = episodeProgressEntries(item).find((entry) => !entry.progress.completed)?.season || episodeProgressEntries(item)[0]?.season || 1;
    activeTitleId = id;
    const kinopoiskId = Number(item.kinopoiskId || item.kinopoisk_id || 0);
    const upcoming = upcomingPremiere(item);
    const awaitingPlayback = awaitingPremierePlayback(item);
    loadOnlineEpisodeAssets(item);
    const progress = progressForTitle(item);
    const favorite = state.favorites.includes(item.id);
    const resumeEpisode = progress?.episodeNumber || null;
    const watchLabel = progress && !progress.completed && Number(progress.position || 0) >= 3 ? "Продолжить просмотр" : "Смотреть";
    const detailWatch = awaitingPlayback ? "" : watchButton(item, watchLabel);
    const detailLocalTest = "";
    const sourceTitle = item.licenseLabel ? `${item.providerName} · ${item.licenseLabel}` : item.providerName;
    const sourceNote = item.providerNote || "Откроется на странице источника.";
    const isKinopoiskMetadata = String(item.providerName || "").startsWith("Kinopoisk");
    const isKinopoiskUrl = /^https?:\/\/(?:www\.)?kinopoisk\.ru\//i.test(String(item.providerUrl || ""));
    const showProviderPanel = item.providerUrl && !isKinopoiskMetadata && !isKinopoiskUrl;
    const sourceLink = showProviderPanel ? `<a class="secondary-button" href="${escapeHtml(item.providerUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник${uiIcon("external")}</a>` : "";
    const providerPanel = showProviderPanel ? `<div class="provider-list"><div class="provider-row"><div><strong>${escapeHtml(sourceTitle)}</strong><small>${escapeHtml(sourceNote)}${item.licenseUrl ? ` · <a href="${escapeHtml(item.licenseUrl)}" target="_blank" rel="noopener noreferrer">условия лицензии${uiIcon("external")}</a>` : ""}</small></div>${sourceLink}</div></div>` : "";
    const sourceImportAction = "";
    const genres = detailList(item.genres?.length ? item.genres : item.tags).filter((tag) => tag.toLowerCase() !== "для нас");
    const countries = detailList(item.countries || item.country);
    const directors = detailList(item.directors || item.director);
    const actors = detailList(item.actors || item.cast);
    const producers = detailList(item.producers);
    const ageRating = detailAge(item.ageRating || item.ratingMpaa);
    const ratingKinopoisk = detailRating(item.ratingKinopoisk || item.rating);
    const ratingImdb = detailRating(item.imdbRating);
    const premiereRaw = String(item.premiere || "").trim();
    const premiereDate = /^\d{4}-\d{2}-\d{2}$/.test(premiereRaw) ? new Date(`${premiereRaw}T00:00:00Z`) : null;
    const premiere = premiereDate && !Number.isNaN(premiereDate.getTime())
      ? premiereDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).replace(/\s*г\.$/, "")
      : premiereRaw;
    const frame = posterOnlyTitles.has(item.id) ? "" : item.backdropImage;
    const backdropUrl = frame || (item.posterImage ? highResolutionPosterUrl(item.posterImage) : "");
    const backdropStyle = "";
    const factMarkup = [
      detailFact("Оригинальное название", item.originalTitle),
      detailFact("Год", item.year),
      detailFact("Премьера", premiere),
      detailFact("Страна", countries),
      detailFact("Режиссёр", directors),
      detailFact("Продюсеры", producers),
      detailFact("Возраст", ageRating),
      detailFact(item.kind === "series" ? "Сезоны" : "Хронометраж", item.kind === "series" ? seasonsLabel(item) : formatRuntime(item.runtime)),
    ].join("");
    const actorPreview = actors.slice(0, 8).map((actor) => `<span class="detail-person">${escapeHtml(actor)}</span>`).join("");
    const actorAll = actors.length > 8 ? `<details class="detail-more"><summary>Показать всех актёров (${actors.length})</summary><div class="detail-people">${actors.map((actor) => `<span class="detail-person">${escapeHtml(actor)}</span>`).join("")}</div></details>` : "";
    const catalogReturnView = ["catalog", "movies", "series", "favorites", "evening", "history", "home"].includes(state.view) ? state.view : "catalog";
    const backLabel = `${uiIcon("arrow-left")}${catalogReturnView === "home" ? "Назад" : "Назад к списку"}`;
    // The page is drawn again as TMDB details, episodes and ratings arrive: the logo that is already shown stays
    // (the same picture element), so the title does not blink on every pass.
    const keptLogo = enteringTitle ? null : page.querySelector(".detail-title .title-logo");
    page.innerHTML = `<div class="page-heading"><a class="text-button" href="${routeForView(catalogReturnView)}" data-back-from-detail>${backLabel}</a></div><section class="detail-shell${frame ? " has-backdrop" : ""}"${backdropStyle}><div class="detail-backdrop" aria-hidden="true"></div><div class="detail-hero"><div class="detail-poster" style="${posterStyle(item)}">${posterTitleArt(item)}</div><div class="detail-content"><div class="eyebrow">${item.kind === "series" ? "Сериал" : "Фильм"}</div><h1 class="detail-title${item.title.length > 24 ? " is-long" : ""}${titleLogoPending(item.id) ? " is-logo-pending" : ""}" data-logo-for="${escapeHtml(item.id)}">${titleLogoMarkup(item.id, item.title)}</h1>${item.tagline ? `<p class="detail-tagline">${escapeHtml(item.tagline)}</p>` : `<p class="detail-original">${escapeHtml(item.originalTitle || "")}</p>`}<div class="detail-ratings"><div class="detail-rating-card detail-rating-kp"><span class="detail-rating-star">${uiIcon("star")}</span><strong>${ratingKinopoisk}</strong><small>${item.source === "tmdb" ? "TMDB" : "КиноПоиск"}</small></div>${item.source === "tmdb" && !Number(item.imdbRating || 0) ? "" : `<div class="detail-rating-card"><span class="detail-rating-label">IMDb</span><strong>${ratingImdb}</strong><small>оценка</small></div>`}${hasPlayableSource(item) && !awaitingPlayback
      // Less to read: the seasons are listed below, so a playable series says nothing here; a film shows its length.
      ? (item.kind === "series" || !formatRuntime(item.runtime) ? "" : `<div class="detail-status-card is-plain"><strong>${escapeHtml(formatRuntime(item.runtime))}</strong></div>`)
      : `<div class="detail-status-card"><span class="detail-status-dot"></span><strong>Видео пока нет</strong><small>${item.kind === "series" ? seasonsLabel(item) : formatRuntime(item.runtime)}</small></div>`}</div>${(() => {
      // As in Lampa: when the next episode comes out, or when a film is released.
      const today = new Date().toISOString().slice(0, 10);
      if (item.kind === "series" && item.nextEpisode?.airDate >= today) return `<p class="detail-next-air">${uiIcon("calendar")}<span>Новая серия ${escapeHtml(airDateLabel(item.nextEpisode.airDate))}</span><small>${item.nextEpisode.season} сезон, ${item.nextEpisode.episode} серия${item.nextEpisode.name && !/^(Эпизод|Серия|Episode)\s*\d+$/i.test(item.nextEpisode.name) ? ` · ${escapeHtml(item.nextEpisode.name)}` : ""}</small></p>`;
      if (item.kind === "movie" && item.source === "tmdb" && String(item.premiere || "") > today && !upcomingPremiere(item)) return `<p class="detail-next-air">${uiIcon("calendar")}<span>Премьера ${escapeHtml(airDateLabel(item.premiere))}</span></p>`;
      return "";
    })()}<div class="detail-tags">${genres.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div><div class="hero-actions">${detailWatch}${`<button class="secondary-button" data-trailer="${escapeHtml(item.id)}" type="button">${uiIcon("play")}<span>Трейлер</span></button>`}${detailLocalTest}${sourceImportAction}<button class="secondary-button" data-favorite="${item.id}" type="button">${favorite ? `${uiIcon("heart-filled")}<span>В избранном</span>` : `${uiIcon("heart")}<span>В избранное</span>`}</button>${parseTmdbItemId(item.id) && (item.kind === "series" || String(item.premiere || "") > new Date().toISOString().slice(0, 10) || isSubscribed(item.id)) ? subscribeButtonMarkup(item.id) : ""}</div>${randomBarMarkup(item)}</div></div>${playbackPreferencesMarkup(item)}${providerPanel}</section>${item.kind === "series" ? renderSeasons(item) : ""}<section class="section detail-about" aria-labelledby="detail-about-title"><div class="section-header"><div><h2 id="detail-about-title">${item.kind === "series" ? "О сериале" : "О фильме"}</h2></div></div><div class="detail-about-grid"><div class="detail-description">${item.description ? `<p>${escapeHtml(item.description)}</p>` : `<p class="muted">Описания пока нет.</p>`}</div><div class="detail-facts"><dl>${factMarkup}</dl></div></div></section>${actors.length ? `<section class="section detail-cast"><div class="detail-section-heading"><h2>Актёры</h2>${actors.length > 8 ? actorAll : ""}</div><div class="detail-people">${actorPreview}</div></section>` : ""}</div>`;
    if (keptLogo) {
      const heading = page.querySelector(".detail-title");
      if (heading && heading.dataset.logoFor === id) { heading.replaceChildren(keptLogo); heading.classList.remove("is-logo-pending"); heading.classList.add("has-logo"); }
    }
    progressiveBackground($(".detail-shell"), "--detail-backdrop", backdropUrl);
    if (awaitingPlayback) {
      const status = page.querySelector('.detail-status-card strong');
      const rawDate = String(item.premiere || '');
      const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? new Date(`${rawDate}T00:00:00Z`) : null;
      const releaseKnown = releaseDate && !Number.isNaN(releaseDate.getTime()) && releaseDate.toISOString().slice(0, 10) === rawDate && rawDate <= new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
      if (status) status.textContent = upcoming ? `${upcoming} · видео пока нет` : releaseKnown ? 'Премьера прошла · видео пока нет' : 'Дата премьеры уточняется · видео пока нет';
      const statusDetail = page.querySelector('.detail-status-card small');
      if (statusDetail) statusDetail.textContent = 'Видео может появиться позже премьеры';
    }
    bindPageActions();
    renderSimilarTitles(item);
    if (!enteringTitle && preservedScrollY > 0) {
      const restoreDetailScroll = () => {
        const route = readRouteFromLocation();
        if (activeTitleId !== id || route.type !== "title" || route.id !== id) return;
        window.scrollTo({ top: preservedScrollY, left: 0, behavior: "auto" });
      };
      window.requestAnimationFrame(() => window.requestAnimationFrame(restoreDetailScroll));
      window.setTimeout(restoreDetailScroll, 150);
    }
  }

  function episodeTitle(item, season, episode) {
    return item.episodeTitles?.[String(season)]?.[String(episode)] || `Серия ${episode}`;
  }

  function episodePosterStyle(item, season, episode) {
    const poster = item.episodePosterUrls?.[String(season)]?.[String(episode)] || item.posterImage;
    const fallback = item.posterImage && poster !== item.posterImage ? `,url(${escapeHtml(item.posterImage)})` : "";
    return poster ? `background-image:linear-gradient(180deg, transparent 35%, rgba(12, 10, 30, .78)),url(${escapeHtml(poster)})${fallback};background-size:cover;background-position:center` : `--poster:${item.poster}`;
  }

  // TMDB stills are stored small (w300); the card asks for a size that stays sharp on its width and screen.
  // TMDB stills, direct or through the site's /tmdb/t/p proxy, at any stored size.
  const TMDB_STILL = /^((?:https:\/\/image\.tmdb\.org)?\/(?:tmdb\/)?t\/p\/)(?:w\d+|original)(\/.+)$/;
  function stillSize(url, size) { return String(url).replace(TMDB_STILL, `$1${size}$2`); }
  function stillSrcset(url) {
    if (!TMDB_STILL.test(String(url))) return "";
    return ` srcset="${escapeHtml(stillSize(url, "w780"))} 780w, ${escapeHtml(stillSize(url, "w1280"))} 1280w" sizes="(max-width: 720px) 132px, (max-width: 1100px) 50vw, 25vw"`;
  }
  function episodePosterMarkup(item, season, episode, title, episodePlayable) {
    const poster = item.episodePosterUrls?.[String(season)]?.[String(episode)] || "";
    const fallback = item.posterImage || "";
    const action = episodePlayable ? `data-play-media="${escapeHtml(item.id)}"` : `data-demo-play="${escapeHtml(item.id)}"`;
    const imageSource = poster || fallback;
    const image = imageSource
      ? `<span class="episode-card-image" style="--poster:${item.poster}"><span class="episode-image-placeholder" aria-hidden="true"></span><img data-episode-poster${poster && fallback ? ` data-fallback="${escapeHtml(fallback)}"` : ""} src="${escapeHtml(stillSize(imageSource, "w780"))}"${stillSrcset(imageSource)} alt="" loading="lazy"><span class="episode-image-status" aria-hidden="true">Не удалось загрузить</span></span>`
      : `<span class="episode-card-image" style="--poster:${item.poster}"><span class="episode-image-placeholder" aria-hidden="true"></span><span class="episode-image-status" aria-hidden="true">Превью пока недоступно</span></span>`;
    return `<button class="episode-card-art${episodePlayable ? "" : " episode-card-art-unavailable"}" ${action} data-resume-season="${season}" data-episode="${episode}" type="button" aria-label="Открыть ${escapeHtml(title)}">${image}<span class="episode-card-play">${uiIcon("play")}</span><span class="episode-card-number">${String(episode).padStart(2, "0")}</span></button>`;
  }

  function episodeSkeletonMarkup(item, season, episode) {
    return `<article class="episode-card episode-card-skeleton"><div class="episode-card-art" style="--poster:${item.poster}"><span class="episode-card-image"><span class="episode-image-placeholder" aria-hidden="true"></span><span class="episode-loading-icon" aria-hidden="true"></span><span class="episode-card-number">${String(episode).padStart(2, "0")}</span></span></div><div class="episode-card-copy"><div class="episode-card-kicker">Сезон ${season} · серия ${episode}</div><span class="episode-skeleton-line episode-skeleton-line-wide"></span><span class="episode-skeleton-line"></span></div></article>`;
  }

  // A map is shown only when there is enough to read from it.
  const EPISODE_MAP_MIN_RATED = 6;
  // A TMDB series: names, stills and per-episode ratings of every season, from TMDB, as Lampa shows them.
  async function loadTmdbEpisodeAssets(item, assetState) {
    if (!item.detailed || !(item.seasons || []).length) {
      // The seasons are not known yet (a short copy from a list): wait for the full card.
      delete episodeAssetStates[item.id];
      return;
    }
    try {
      const count = (item.seasons || []).length;
      const results = await Promise.all(Array.from({ length: count }, (_, index) => cvTmdb(`tv/${item.tmdbId}/season/${index + 1}?language=ru-RU`).catch(() => null)));
      const titles = {};
      const posters = {};
      const airDates = {};
      const ratings = [];
      results.forEach((data, index) => {
        if (!data) return;
        const season = String(index + 1);
        titles[season] = {};
        posters[season] = {};
        airDates[season] = {};
        const rated = [];
        (data.episodes || []).forEach((episode) => {
          const number = String(episode.episode_number);
          const name = String(episode.name || "").replace(/^(Эпизод|Серия|Episode)\s*\d+$/i, "").trim();
          if (name) titles[season][number] = name;
          if (episode.still_path) posters[season][number] = tmdbImage(episode.still_path, "w300");
          if (episode.air_date) airDates[season][number] = episode.air_date;
          if (Number(episode.vote_count || 0) >= 3 && Number(episode.vote_average || 0) > 0) rated.push({ episode: episode.episode_number, rating: Math.round(episode.vote_average * 10) / 10, votes: episode.vote_count });
        });
        if (rated.length) ratings.push({ season: index + 1, episodes: rated });
      });
      item.episodeTitles = titles;
      item.episodePosterUrls = posters;
      item.episodeAirDates = airDates;
      if (ratings.reduce((sum, season) => sum + season.episodes.length, 0) >= EPISODE_MAP_MIN_RATED) episodeRatingsCache.set(item.id, ratings);
      assetState.loaded = true;
    } catch {
      assetState.error = "Не удалось загрузить список серий.";
    } finally {
      assetState.loading = false;
      if (activeTitleId === item.id) renderDetails(item.id);
    }
  }
  async function loadEpisodeRatings(item) {
    if (item.source === "tmdb") return;
    episodeRatingsCache.set(item.id, null);
    try {
      const response = await apiFetch(`/api/episode-ratings?title=${encodeURIComponent(item.id)}`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const payload = await response.json();
      const seasons = (Array.isArray(payload.seasons) ? payload.seasons : []).filter((season) => Array.isArray(season.episodes) && season.episodes.length);
      if (seasons.reduce((sum, season) => sum + season.episodes.length, 0) < EPISODE_MAP_MIN_RATED) return;
      episodeRatingsCache.set(item.id, seasons);
      if (activeTitleId === item.id) renderDetails(item.id);
    } catch { /* no map: the page stays as it is */ }
  }
  function episodeRatingFor(item, season, episode) {
    const seasons = episodeRatingsCache.get(item.id);
    return seasons?.find((entry) => entry.season === season)?.episodes.find((entry) => entry.episode === episode) || null;
  }
  // Six steps, like SeriesGraph: the number is always printed, the colour only helps.
  function ratingStep(rating) { return rating >= 9 ? 5 : rating >= 8 ? 4 : rating >= 7 ? 3 : rating >= 6 ? 2 : rating >= 5 ? 1 : 0; }
  const RATING_STEP_NAMES = ["Провал", "Плохо", "Средне", "Хорошо", "Отлично", "Шедевр"];
  function episodeMapMarkup(item) {
    const seasons = episodeRatingsCache.get(item.id);
    if (!seasons) return "";
    const rows = Math.max(...seasons.map((season) => Math.max(...season.episodes.map((entry) => entry.episode))));
    const all = seasons.flatMap((season) => season.episodes.map((entry) => ({ ...entry, season: season.season })));
    // "Few votes" is relative to the source: IMDb counts hundreds, TMDB tens.
    const fewVotes = item.source === "tmdb" ? 10 : 100;
    const trusted = all.filter((entry) => entry.votes >= fewVotes);
    const best = (trusted.length ? trusted : all).reduce((top, entry) => entry.rating > top.rating ? entry : top);
    const averages = seasons.map((season) => ({ season: season.season, rating: season.episodes.reduce((sum, entry) => sum + entry.rating, 0) / season.episodes.length }));
    const strongest = averages.reduce((top, entry) => entry.rating > top.rating ? entry : top);
    const weakest = averages.reduce((low, entry) => entry.rating < low.rating ? entry : low);
    const facts = [
      `Лучшая серия — ${best.season} сезон, ${best.episode} серия: ${best.rating.toFixed(1)}`,
      seasons.length > 1 ? `сильнее всего ${strongest.season} сезон (${strongest.rating.toFixed(1)})` : "",
      seasons.length > 1 && weakest.season !== strongest.season ? `слабее всего ${weakest.season} сезон (${weakest.rating.toFixed(1)})` : "",
    ].filter(Boolean).join(", ");
    const head = `<span class="ep-map-corner" aria-hidden="true"></span>${seasons.map((season) => `<span class="ep-map-season">С${season.season}</span>`).join("")}`;
    const body = Array.from({ length: rows }, (_, index) => {
      const episode = index + 1;
      const cells = seasons.map((season) => {
        const entry = season.episodes.find((candidate) => candidate.episode === episode);
        if (!entry) return `<span class="ep-map-empty" aria-hidden="true"></span>`;
        const name = episodeTitle(item, season.season, episode);
        const label = `${season.season} сезон, ${episode} серия «${name}»: ${entry.rating.toFixed(1)}, ${countWord(entry.votes, "оценка", "оценки", "оценок")}`;
        return `<button class="ep-map-cell is-r${ratingStep(entry.rating)}" data-map-season="${season.season}" data-map-episode="${episode}" type="button" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${entry.rating.toFixed(1)}</button>`;
      }).join("");
      return `<span class="ep-map-episode">${episode}</span>${cells}`;
    }).join("");
    const legend = RATING_STEP_NAMES.map((name, step) => `<span><i class="is-r${step}" aria-hidden="true"></i>${name}</span>`).reverse().join("");
    return `<section class="section ep-map-section" aria-labelledby="ep-map-title"><div class="section-header"><div><h2 id="ep-map-title">Оценки серий</h2><span>по оценкам зрителей ${item.source === "tmdb" ? "TMDB" : "IMDb"}</span></div></div><p class="ep-map-facts">${escapeHtml(facts)}.</p><div class="ep-map-scroll"><div class="ep-map" style="--seasons:${seasons.length}">${head}${body}</div></div><div class="ep-map-legend">${legend}</div></section>`;
  }

  // The interface keeps one accent colour; a tint saved by the old poster-colour feature is dropped.
  try { localStorage.removeItem("cinevault.accent.v1"); } catch {}

  // ---- Feed and series subscriptions, as in Lampa. The feed is CUB's own (the same one
  // Lampa shows); subscriptions live in the account like favourites, and the bell is
  // worked out on the device from TMDB: which episodes came out since one subscribed.
  const CUB_FEED_URLS = ["/cub/api/feed/all", "https://cub.red/api/feed/all"];
  const SUBS_CACHE_KEY = "cinevault.subsCache.v1";
  const NOTIFY_SEEN_KEY = "cinevault.notifySeen.v1";
  const SUBS_FRESH_MS = 3 * 60 * 60 * 1000;
  const FEED_FILTERS = [["all", "Всё"], ["subs", "Подписки"], ["episode", "Новые серии"], ["uhd", "В высоком качестве"], ["now", "Новинки"], ["now_playing", "Сейчас смотрят"]];
  let cubFeed = null;
  let cubFeedLoading = null;
  let feedFilter = "all";
  let subsLoading = null;
  let notifyPanelOpen = false;

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function announceLive(text) {
    let toast = document.getElementById("site-toast");
    if (!toast) { toast = document.createElement("div"); toast.id = "site-toast"; toast.className = "site-toast"; toast.setAttribute("role", "status"); document.body.append(toast); }
    toast.textContent = text;
    toast.classList.add("is-shown");
    window.clearTimeout(announceLive.timer);
    announceLive.timer = window.setTimeout(() => toast.classList.remove("is-shown"), 2600);
  }
  function isSubscribed(id) { return (state.subscriptions || []).includes(id); }
  function toggleSubscription(id) {
    const adding = !isSubscribed(id);
    state.subscriptions = adding ? [...(state.subscriptions || []), id] : (state.subscriptions || []).filter((entry) => entry !== id);
    saveState();
    if (adding) refreshSubscriptions({ only: id }).then(updateNotifyBadge);
    else updateNotifyBadge();
    return adding;
  }
  function subscriptionSince(id) {
    const at = Number(state.savedMarks?.subscriptions?.[id]?.at || 0);
    return new Date(at || Date.now()).toISOString().slice(0, 10);
  }
  function feedDateLabel(date) {
    if (!date) return "";
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    if (date === today) return "сегодня";
    if (date === yesterday) return "вчера";
    return airDateLabel(date);
  }
  function timeAgo(ms) {
    const minutes = Math.max(1, Math.round((Date.now() - Number(ms || 0)) / 60000));
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    const days = Math.round(hours / 24);
    return days === 1 ? "вчера" : `${days} дн назад`;
  }
  function tmdbStill(path, size = "w780") { return path ? tmdbImage(path, size) : ""; }

  // What a subscribed series has: the episodes out since the subscription, and the next one.
  async function refreshSubscriptions({ force = false, only = "" } = {}) {
    if (subsLoading && !only) return subsLoading;
    const run = async () => {
      const cache = readJson(SUBS_CACHE_KEY, {});
      const ids = (only ? [only] : state.subscriptions || []).filter((id) => parseTmdbItemId(id)).slice(0, 60);
      await Promise.all(ids.map(async (id) => {
        const known = cache[id];
        if (!force && known && Date.now() - known.fetchedAt < SUBS_FRESH_MS) return;
        const { tmdbId, kind } = parseTmdbItemId(id);
        try {
          if (kind === "movie") {
            // A film: one notice on its release day (digital release when TMDB knows it).
            const movie = await cvTmdb(`movie/${tmdbId}?language=ru-RU&append_to_response=release_dates`, 10000);
            const today = new Date().toISOString().slice(0, 10);
            const dates = (movie.release_dates?.results || []).flatMap((country) => country.release_dates || []);
            const digital = dates.filter((entry) => [4, 5, 6].includes(entry.type)).map((entry) => String(entry.release_date || "").slice(0, 10)).sort()[0] || "";
            const release = String(movie.release_date || "");
            const out = [digital, release].filter((date) => date && date <= today && date >= subscriptionSince(id)).sort()[0] || "";
            const next = [release, digital].filter((date) => date && date > today).sort()[0] || "";
            cache[id] = {
              fetchedAt: Date.now(), kind: "movie", title: movie.title || "", poster: movie.poster_path || "", backdrop: movie.backdrop_path || "",
              fresh: out ? [{ season: 0, episode: 0, name: out === digital ? "Вышел в цифре" : "Премьера", airDate: out, still: "" }] : [],
              next: next ? { season: 0, episode: 0, name: next === digital ? "в цифре" : "премьера", airDate: next } : null,
            };
            return;
          }
          const show = await cvTmdb(`tv/${tmdbId}?language=ru-RU`, 10000);
          const last = show.last_episode_to_air;
          const since = subscriptionSince(id);
          const today = new Date().toISOString().slice(0, 10);
          let fresh = [];
          if (last?.air_date && last.air_date >= since) {
            const season = await cvTmdb(`tv/${tmdbId}/season/${last.season_number}?language=ru-RU`, 10000).catch(() => null);
            fresh = (season?.episodes || [last])
              .filter((episode) => episode.air_date && episode.air_date >= since && episode.air_date <= today)
              .slice(-6)
              .map((episode) => ({ season: episode.season_number, episode: episode.episode_number, name: cleanEpisodeName(episode.name), airDate: episode.air_date, still: episode.still_path || "" }));
          }
          const next = show.next_episode_to_air;
          cache[id] = {
            fetchedAt: Date.now(),
            title: show.name || "",
            poster: show.poster_path || "",
            backdrop: show.backdrop_path || "",
            fresh,
            next: next?.air_date ? { season: next.season_number, episode: next.episode_number, name: cleanEpisodeName(next.name), airDate: next.air_date } : null,
          };
        } catch {}
      }));
      Object.keys(cache).forEach((id) => { if (!(state.subscriptions || []).includes(id)) delete cache[id]; });
      writeJson(SUBS_CACHE_KEY, cache);
      return cache;
    };
    const job = run();
    if (!only) subsLoading = job.finally(() => { subsLoading = null; });
    return job;
  }
  function cleanEpisodeName(name) { return String(name || "").replace(/^(Эпизод|Серия|Episode)\s*\d+$/i, "").trim(); }
  function subscriptionNotices() {
    const cache = readJson(SUBS_CACHE_KEY, {});
    return (state.subscriptions || []).flatMap((id) => (cache[id]?.fresh || []).map((entry) => ({ ...entry, id, title: cache[id].title, poster: cache[id].poster, backdrop: cache[id].backdrop, key: `${id}:${entry.season}:${entry.episode}` })))
      .sort((a, b) => b.airDate.localeCompare(a.airDate) || b.episode - a.episode);
  }
  function upcomingSubscriptionEpisodes() {
    const cache = readJson(SUBS_CACHE_KEY, {});
    return (state.subscriptions || []).map((id) => cache[id]?.next ? { ...cache[id].next, id, title: cache[id].title, poster: cache[id].poster } : null).filter(Boolean)
      .sort((a, b) => a.airDate.localeCompare(b.airDate));
  }
  function unreadNotices() {
    const seen = new Set(readJson(NOTIFY_SEEN_KEY, []));
    return subscriptionNotices().filter((entry) => !seen.has(entry.key));
  }
  function updateNotifyBadge() {
    const badge = $("#notify-badge");
    if (!badge) return;
    const count = unreadNotices().length;
    badge.hidden = !count;
    badge.textContent = count > 9 ? "9+" : String(count);
    $("#notify-button")?.setAttribute("aria-label", count ? `Уведомления: новых ${count}` : "Уведомления");
    if (notifyPanelOpen) renderNotifyPanel();
  }
  function markNoticesSeen() {
    const keys = subscriptionNotices().map((entry) => entry.key);
    writeJson(NOTIFY_SEEN_KEY, [...new Set([...readJson(NOTIFY_SEEN_KEY, []), ...keys])].slice(-500));
  }
  function noticeMarkup(entry, { upcoming = false } = {}) {
    const image = upcoming ? tmdbImage(entry.poster, "w185") : tmdbStill(entry.still, "w300") || tmdbImage(entry.backdrop || entry.poster, "w300");
    const what = entry.season ? `${entry.season} сезон, ${entry.episode} серия${entry.name ? ` · ${escapeHtml(entry.name)}` : ""}` : escapeHtml(entry.name || "Фильм");
    return `<a class="notify-item${upcoming ? " is-upcoming" : ""}" href="${routeForTitle(entry.id)}" data-notify-open="${escapeHtml(entry.id)}" data-notify-season="${entry.season}" data-notify-episode="${entry.episode}"><span class="notify-art${upcoming ? " is-poster" : ""}">${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">` : ""}</span><span class="notify-copy"><b>${escapeHtml(entry.title)}</b><span>${what}</span><small>${upcoming ? `Выйдет ${escapeHtml(feedDateLabel(entry.airDate))}` : `${entry.season ? "Новая серия" : "Уже можно смотреть"} · ${escapeHtml(feedDateLabel(entry.airDate))}`}</small></span></a>`;
  }
  // ---- Notifications on the device itself (Web Push): the server checks new episodes and
  // premieres of the "Напомнить" list and sends them even when the site is closed.
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const iosBrowserTab = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia?.("(display-mode: standalone)").matches && !navigator.standalone;
  async function pushSubscription() {
    if (!pushSupported()) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }
  async function pushApi(route, body) {
    const accounts = window.CineVaultAccounts;
    const response = await fetch(`/api/push/${route}`, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CineVault-CSRF": accounts?.csrf || "" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `Ошибка ${response.status}`);
    return json;
  }
  async function enablePush() {
    if (!window.CineVaultAccounts?.user) { announceLive("Сначала войдите в аккаунт — уведомления приходят по нему"); window.CineVaultAccounts?.form?.(); return false; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { announceLive("Уведомления запрещены в настройках браузера"); return false; }
    const { key } = await pushApi("key");
    const registration = await navigator.serviceWorker.ready;
    const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - key.length % 4) % 4));
    const subscription = (await registration.pushManager.getSubscription()) || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (char) => char.charCodeAt(0)) });
    await pushApi("subscribe", { subscription: subscription.toJSON(), hello: true });
    announceLive("Уведомления включены");
    return true;
  }
  async function disablePush() {
    const subscription = await pushSubscription();
    if (subscription) {
      await pushApi("unsubscribe", { endpoint: subscription.endpoint }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
    announceLive("Уведомления на этом устройстве выключены");
  }
  async function pushControlMarkup() {
    if (iosBrowserTab()) return `<div class="notify-push"><span>Чтобы уведомления приходили на iPhone, добавьте сайт на экран «Домой» (Поделиться → На экран «Домой») и откройте его оттуда.</span></div>`;
    if (!pushSupported()) return "";
    const on = Notification.permission === "granted" && Boolean(await pushSubscription().catch(() => null));
    return `<div class="notify-push"><span>${on ? "Уведомления приходят на это устройство" : "Присылать уведомления на это устройство, даже когда сайт закрыт"}</span><button class="${on ? "text-button" : "primary-button"}" data-push-toggle="${on ? "off" : "on"}" type="button">${on ? "Выключить" : "Включить"}</button></div>`;
  }
  async function renderPushControl() {
    const slot = $("#notify-push-slot");
    if (!slot) return;
    slot.innerHTML = await pushControlMarkup();
    slot.querySelector("[data-push-toggle]")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      const button = event.currentTarget;
      button.disabled = true;
      try { if (button.dataset.pushToggle === "on") await enablePush(); else await disablePush(); }
      catch (error) { announceLive(`Не получилось: ${error.message}`); }
      renderPushControl();
    });
  }
  function renderNotifyPanel() {
    const panel = $("#notify-panel");
    if (!panel) return;
    const notices = subscriptionNotices().slice(0, 20);
    const unread = new Set(unreadNotices().map((entry) => entry.key));
    const soon = upcomingSubscriptionEpisodes().slice(0, 6);
    const subs = (state.subscriptions || []).length;
    const body = !subs
      ? `<p class="notify-empty">Нажмите «Напомнить» в карточке сериала или ещё не вышедшего фильма — здесь появятся новые серии и премьеры.</p>`
      : notices.length || soon.length
        ? `${notices.map((entry) => noticeMarkup(entry).replace('class="notify-item"', `class="notify-item${unread.has(entry.key) ? " is-new" : ""}"`)).join("")}${soon.length ? `<div class="notify-subhead">Скоро выйдут</div>${soon.map((entry) => noticeMarkup(entry, { upcoming: true })).join("")}` : ""}`
        : subsLoading ? `<p class="notify-empty"><span class="loading-spinner" aria-hidden="true"></span> Проверяю новые серии…</p>` : `<p class="notify-empty">С момента подписки новых серий не выходило.</p>`;
    panel.innerHTML = `<div class="notify-head"><b>Уведомления</b><a href="${routeForView("feed")}" data-view="feed" data-notify-close>Вся лента</a></div><div class="notify-list">${body}</div><div id="notify-push-slot"></div>`;
    renderPushControl();
  }
  function toggleNotifyPanel(open = !notifyPanelOpen) {
    const panel = $("#notify-panel");
    if (!panel) return;
    notifyPanelOpen = open;
    panel.hidden = !open;
    $("#notify-button")?.setAttribute("aria-expanded", String(open));
    if (!open) return;
    renderNotifyPanel();
    refreshSubscriptions().then(() => { if (notifyPanelOpen) { renderNotifyPanel(); markNoticesSeen(); updateNotifyBadge(); } });
    markNoticesSeen();
    window.setTimeout(updateNotifyBadge, 1500);
  }
  function openTitleAtEpisode(id, season, episode, { watch = false } = {}) {
    const go = (item) => {
      if (!item) return;
      rememberLooseTitles([item]);
      openTitleRoute(item.id);
      if (item.kind === "series" && season) { selectedSeason = Number(season); renderDetails(item.id); }
      if (watch) openWatch(item, item.kind === "series" && season ? { season: Number(season), episode: Number(episode) || null } : {});
    };
    const known = getTitle(id);
    if (known?.detailed || !parseTmdbItemId(id)) go(known);
    else loadTmdbTitle(id).then(go).catch(() => go(known));
  }
  // A link from "На другом устройстве": the same title, episode, second, source and voice.
  // The place is saved as this device's progress and the watch window opens on it.
  function takeHandoff() {
    const params = new URLSearchParams(window.location.search);
    const at = Number(params.get("t") || 0);
    const route = readRouteFromLocation();
    if (!(at > 0) || route.type !== "title") return;
    const season = Number(params.get("s") || 0) || null;
    const episode = Number(params.get("e") || 0) || null;
    const source = params.get("src") || "";
    const voice = params.get("voice") || "";
    const clean = new URL(window.location.href);
    ["t", "s", "e", "src", "voice"].forEach((key) => clean.searchParams.delete(key));
    window.history.replaceState(window.history.state, "", clean.pathname + clean.search + clean.hash);
    const go = (item) => {
      if (!item) return;
      state.progress[lampacProgressKey(item, season, episode)] = { titleId: item.id, providerId: "lampac", ...(season ? { seasonNumber: season, episodeNumber: episode } : {}), position: at, duration: 0, completed: false, updatedAt: Date.now() };
      if (source) rememberLampacChoice({ source, voice }, item.id);
      saveState();
      openWatch(item, item.kind === "series" ? { season, episode } : {});
    };
    const known = getTitle(route.id);
    if (known?.detailed || !parseTmdbItemId(route.id)) window.setTimeout(() => go(getTitle(route.id)), 800);
    else loadTmdbTitle(route.id).then(go).catch(() => go(known));
  }
  function installNotifications() {
    const wantedSeason = Number(new URLSearchParams(window.location.search).get("season") || 0);
    if (wantedSeason) selectedSeason = wantedSeason;
    const button = $("#notify-button");
    if (!button || button.dataset.ready) return;
    button.dataset.ready = "1";
    button.addEventListener("click", (event) => { event.stopPropagation(); toggleNotifyPanel(); });
    document.addEventListener("click", (event) => {
      const element = event.target instanceof Element ? event.target : null;
      const open = element?.closest("[data-notify-open]");
      if (open) {
        event.preventDefault();
        toggleNotifyPanel(false);
        openTitleAtEpisode(open.dataset.notifyOpen, open.dataset.notifySeason, open.dataset.notifyEpisode);
        return;
      }
      if (element?.closest("[data-notify-close]")) { toggleNotifyPanel(false); return; }
      if (notifyPanelOpen && !element?.closest("#notify-panel")) toggleNotifyPanel(false);
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && notifyPanelOpen) toggleNotifyPanel(false); });
    updateNotifyBadge();
    const check = () => refreshSubscriptions().then(updateNotifyBadge).catch(() => {});
    window.setTimeout(check, 2500);
    window.setInterval(check, 30 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  }

  // ---- The feed page.
  async function loadCubFeed() {
    if (cubFeed && Date.now() - cubFeed.at < 10 * 60 * 1000) return cubFeed.entries;
    if (cubFeedLoading) return cubFeedLoading;
    cubFeedLoading = (async () => {
      for (const url of CUB_FEED_URLS) {
        try {
          const controller = new AbortController();
          const timer = window.setTimeout(() => controller.abort(), 8000);
          const response = await fetch(url, { signal: controller.signal, credentials: url.startsWith("/") ? "same-origin" : "omit" }).finally(() => window.clearTimeout(timer));
          if (!response.ok) continue;
          const json = await response.json();
          const entries = (json.result || []).filter((entry) => entry?.data?.id && !entry.data.adult);
          cubFeed = { at: Date.now(), entries };
          return entries;
        } catch {}
      }
      throw new Error("Лента сейчас недоступна");
    })().finally(() => { cubFeedLoading = null; });
    return cubFeedLoading;
  }
  // CUB writes the episode as a Python-style dict string; the numbers and the still are read out of it.
  function cubEpisode(entry) {
    const text = typeof entry.data.episode === "string" ? entry.data.episode : JSON.stringify(entry.data.episode || {});
    const pick = (key) => text.match(new RegExp(`['"]${key}['"]:\\s*(?:'([^']*)'|"([^"]*)"|(\\d+))`))?.slice(1).find((value) => value !== undefined) || "";
    const hash = String(entry.hash || "").match(/s(\d+);e(\d+)/);
    return { season: Number(pick("season_number") || hash?.[1] || 0), episode: Number(pick("episode_number") || hash?.[2] || 0), name: cleanEpisodeName(pick("name")), still: pick("still_path"), airDate: pick("air_date") };
  }
  const QUALITY_NAMES = { "4k": "4K", webdl: "WEB-DL", webrip: "WEBRip", ts: "Экранка", camrip: "Экранка", bdrip: "BDRip", hdrip: "HDRip" };
  function cubItem(entry) {
    const raw = { ...entry.data, genres: undefined, media_type: entry.card_type === "tv" ? "tv" : "movie" };
    return withTitleOverrides(tmdbToItem(raw, raw.media_type));
  }
  function feedEntryMarkup(entry) {
    const item = cubItem(entry);
    const isTv = entry.card_type === "tv";
    const episode = entry.type === "episode" ? cubEpisode(entry) : null;
    const label = { episode: "Новая серия", uhd: "В высоком качестве", now: "Новинка", now_playing: "Сейчас смотрят" }[entry.type] || "Новое";
    const quality = QUALITY_NAMES[String(entry.data.release_quality || "").toLowerCase()] || "";
    const year = String(entry.data.release_date || entry.data.first_air_date || "").slice(0, 4);
    const genres = (Array.isArray(entry.data.genres) ? entry.data.genres : []).slice(0, 3).join(", ");
    const sub = episode?.season ? `Сезон ${episode.season} · Серия ${episode.episode}${episode.name ? ` · ${episode.name}` : ""}` : [year, genres].filter(Boolean).join(" · ");
    const image = episode?.still ? tmdbStill(episode.still, "w780") : tmdbImage(entry.data.backdrop_path || entry.data.poster_path, "w780");
    const overview = String(entry.data.overview || "");
    return `<article class="feed-entry is-${escapeHtml(entry.type)}"><div class="feed-copy"><div class="feed-meta"><span class="feed-label">${label}</span>${quality ? `<span class="feed-quality${quality === "Экранка" ? " is-cam" : ""}">${quality}</span>` : ""}<time>${escapeHtml(timeAgo(entry.time))}</time></div><h3><a href="${routeForTitle(item.id)}" data-feed-open="${escapeHtml(item.id)}"${episode?.season ? ` data-feed-season="${episode.season}"` : ""}>${escapeHtml(item.title)}</a></h3>${sub ? `<p class="feed-sub">${escapeHtml(sub)}</p>` : ""}${overview ? `<p class="feed-overview">${escapeHtml(overview)}</p>` : ""}<div class="feed-actions"><button class="primary-button" data-feed-watch="${escapeHtml(item.id)}"${episode?.season ? ` data-feed-season="${episode.season}" data-feed-episode="${episode.episode}"` : ""} type="button">${uiIcon("play")}<span>Смотреть</span></button>${isTv ? subscribeButtonMarkup(item.id) : ""}</div></div><a class="feed-art" href="${routeForTitle(item.id)}" data-feed-open="${escapeHtml(item.id)}"${episode?.season ? ` data-feed-season="${episode.season}"` : ""} tabindex="-1" aria-hidden="true">${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async">` : ""}</a></article>`;
  }
  function subscriptionFeedMarkup(entry) {
    const image = tmdbStill(entry.still, "w780") || tmdbImage(entry.backdrop || entry.poster, "w780");
    return `<article class="feed-entry is-subscription"><div class="feed-copy"><div class="feed-meta"><span class="feed-label">Ваша подписка</span><time>${escapeHtml(feedDateLabel(entry.airDate))}</time></div><h3><a href="${routeForTitle(entry.id)}" data-feed-open="${escapeHtml(entry.id)}" data-feed-season="${entry.season}">${escapeHtml(entry.title)}</a></h3><p class="feed-sub">${entry.season ? `Сезон ${entry.season} · Серия ${entry.episode}${entry.name ? ` · ${escapeHtml(entry.name)}` : ""}` : escapeHtml(entry.name || "")}</p><div class="feed-actions"><button class="primary-button" data-feed-watch="${escapeHtml(entry.id)}" data-feed-season="${entry.season}" data-feed-episode="${entry.episode}" type="button">${uiIcon("play")}<span>Смотреть</span></button></div></div><a class="feed-art" href="${routeForTitle(entry.id)}" data-feed-open="${escapeHtml(entry.id)}" data-feed-season="${entry.season}" tabindex="-1" aria-hidden="true">${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async">` : ""}</a></article>`;
  }
  function subscribeButtonMarkup(id) {
    const on = isSubscribed(id);
    return `<button class="secondary-button subscribe-button${on ? " is-on" : ""}" data-subscribe="${escapeHtml(id)}" type="button" aria-pressed="${on}">${uiIcon("bell")}<span>${on ? "Напомню" : "Напомнить"}</span></button>`;
  }
  function renderFeedPage() {
    const filters = `<div class="feed-filters" role="group" aria-label="Что показать">${FEED_FILTERS.map(([value, label]) => `<button class="genre-pill${feedFilter === value ? " is-active" : ""}" data-feed-filter="${value}" type="button" aria-pressed="${feedFilter === value}">${label}</button>`).join("")}</div>`;
    const subs = subscriptionNotices();
    const soon = upcomingSubscriptionEpisodes();
    const draw = (entries, error = "") => {
      if (state.view !== "feed") return;
      const fromCub = feedFilter === "subs" ? [] : (entries || []).filter((entry) => feedFilter === "all" || entry.type === feedFilter);
      const mine = feedFilter === "all" || feedFilter === "subs" ? subs.slice(0, feedFilter === "subs" ? 60 : 6) : [];
      const soonMarkup = feedFilter === "subs" && soon.length ? `<section class="feed-soon"><h2>Скоро выйдут</h2><div class="notify-list">${soon.map((entry) => noticeMarkup(entry, { upcoming: true })).join("")}</div></section>` : "";
      const empty = feedFilter === "subs" && !mine.length
        ? `<div class="empty-state"><h2>${(state.subscriptions || []).length ? "Новых серий пока нет" : "Подписок пока нет"}</h2><p>${(state.subscriptions || []).length ? "Как только у сериалов из подписок выйдут новые серии, они появятся здесь и в колокольчике." : "Откройте сериал или ещё не вышедший фильм и нажмите «Напомнить» — новые серии и премьеры будут появляться здесь и в колокольчике."}</p></div>`
        : "";
      const list = entries === null && !mine.length
        ? `<div class="feed-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span> Загружаю ленту…</div>`
        : `${mine.map(subscriptionFeedMarkup).join("")}${fromCub.map(feedEntryMarkup).join("")}`;
      page.innerHTML = `<div class="page-heading"><div><h1>Лента</h1><p class="muted">Новые серии, релизы в высоком качестве и новинки — как в Lampa.</p></div></div>${filters}${soonMarkup}${empty}<div class="feed-list">${list}</div>${error ? `<div class="empty-state"><p>${escapeHtml(error)}</p><button class="secondary-button" data-feed-retry type="button">Повторить</button></div>` : ""}`;
      bindFeedPage();
    };
    draw(cubFeed?.entries || null);
    loadCubFeed().then((entries) => draw(entries)).catch((error) => draw([], error.message));
    if ((state.subscriptions || []).length) refreshSubscriptions().then(() => { if (state.view === "feed") draw(cubFeed?.entries || null); updateNotifyBadge(); });
  }
  function bindFeedPage() {
    $$("[data-feed-filter]", page).forEach((button) => button.addEventListener("click", () => { feedFilter = button.dataset.feedFilter; renderFeedPage(); }));
    $("[data-feed-retry]", page)?.addEventListener("click", () => { cubFeed = null; renderFeedPage(); });
    $$("[data-feed-open]", page).forEach((link) => link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      rememberFeedTitles();
      openTitleAtEpisode(link.dataset.feedOpen, link.dataset.feedSeason);
    }));
    $$("[data-feed-watch]", page).forEach((button) => button.addEventListener("click", () => {
      rememberFeedTitles();
      openTitleAtEpisode(button.dataset.feedWatch, button.dataset.feedSeason, button.dataset.feedEpisode, { watch: true });
    }));
    bindSubscribeButtons(page);
  }
  function rememberFeedTitles() { if (cubFeed?.entries) rememberLooseTitles(cubFeed.entries.map(cubItem)); }
  function bindSubscribeButtons(root) {
    $$("[data-subscribe]", root).forEach((button) => button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const on = toggleSubscription(button.dataset.subscribe);
      const known = getTitle(button.dataset.subscribe);
      announceLive(on ? (known?.kind === "movie" ? "Напомню, когда фильм выйдет" : "Напомню о каждой новой серии") : "Напоминание выключено");
      $$(`[data-subscribe="${CSS.escape(button.dataset.subscribe)}"]`).forEach((other) => {
        other.classList.toggle("is-on", on);
        other.setAttribute("aria-pressed", String(on));
        other.querySelector("span").textContent = on ? "Напомню" : "Напомнить";
      });
    }));
  }

  function renderSeasons(item) {
    const isImportedSeries = Number(item.catalogId || 0) === 2205;
    const onlineAssetState = episodeAssetStateFor(item);
    const hasEpisodeAssets = isImportedSeries || Boolean(item.episodeDataProvider || item.episodeDataFile);
    const assetsLoading = isImportedSeries ? episodeAssetsLoading : onlineAssetState.loading;
    const assetsError = isImportedSeries ? episodeAssetsError : onlineAssetState.error;
    const seasonList = titleSeasonList(item);
    if (!seasonList.length && item.source === "tmdb" && !item.detailed) {
      return item.detailFailed
        ? `<section class="section"><div class="section-header"><div><h2>Сезоны и серии</h2></div></div><div class="episode-loading-note" role="status">Сезоны не загрузились. <button class="text-button" type="button" data-retry-title="${escapeHtml(item.id)}">Повторить</button></div></section>`
        : `<section class="section"><div class="section-header"><div><h2>Сезоны и серии</h2></div></div><div class="episode-loading-note" role="status"><span class="loading-spinner" aria-hidden="true"></span> Загружаю сезоны…</div></section>`;
    }
    const activeSeason = seasonList.find((season) => season.number === selectedSeason) || seasonList[0];
    if (activeSeason) selectedSeason = activeSeason.number;
    const seasonCount = seasonList.length;
    const demoEpisodes = activeSeason?.episodes || [];
    const episodeRecords = episodeProgressEntries(item);
    const latestEpisode = episodeRecords.find((entry) => !entry.progress.completed);
    const sourceAction = item.providerUrl && !String(item.providerName || "").startsWith("Kinopoisk") ? `<a class="secondary-button season-provider-link" href="${escapeHtml(item.providerUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник${uiIcon("external")}</a>` : "";
    const episodeRows = hasEpisodeAssets && assetsLoading
      ? demoEpisodes.map((episode) => episodeSkeletonMarkup(item, selectedSeason, episode)).join("")
      : demoEpisodes.map((episode) => {
      const progress = episodeRecords.find((entry) => entry.season === selectedSeason && entry.episode === episode)?.progress;
      const localEpisode = item.libraryEpisodes?.find((candidate) => candidate.season === selectedSeason && candidate.episode === episode);
      const episodeProgress = localEpisode?.progress || progress;
      const episodePlayable = localEpisode ? localEpisode.status === "ready" : (!item.libraryEpisodes?.length && hasPlayableSource(item));
      const title = episodeTitle(item, selectedSeason, episode);
      const current = Boolean(latestEpisode && latestEpisode.season === selectedSeason && latestEpisode.episode === episode && !localEpisode?.progress?.completed);
      const seen = Boolean(episodeProgress?.completed);
      const progressText = current ? "Продолжить просмотр" : "";
      const ratio = !seen && Number(episodeProgress?.duration) > 0 ? Math.min(100, Math.round((Number(episodeProgress.position) / Number(episodeProgress.duration)) * 100)) : 0;
      const poster = episodePosterMarkup(item, selectedSeason, episode, title, episodePlayable);
      const rated = episodeRatingFor(item, selectedSeason, episode);
      const hasStill = Boolean(item.episodePosterUrls?.[String(selectedSeason)]?.[String(episode)]);
      const airDate = episodeAirDate(item, selectedSeason, episode);
      const future = Boolean(airDate && airDate > new Date().toISOString().slice(0, 10));
      return `<article class="episode-card${hasStill && !future ? " has-still" : ""}${future ? " is-future" : ""}${current ? " is-now" : ""}${seen ? " is-seen" : ""}">${ratio > 0 ? `<span class="episode-card-progress" style="--progress:${ratio}%" aria-hidden="true"></span>` : ""}${poster}<div class="episode-card-copy"><div class="episode-card-kicker">Сезон ${selectedSeason} · серия ${episode}${rated ? ` <span class="episode-rating is-r${ratingStep(rated.rating)}" title="${item.source === "tmdb" ? "Оценка TMDB" : "Оценка IMDb"}">${rated.rating.toFixed(1)}</span>` : ""}${(() => { const airDate = episodeAirDate(item, selectedSeason, episode); return airDate && airDate > new Date().toISOString().slice(0, 10) ? ` <span class="episode-air">Выйдет ${escapeHtml(airDateLabel(airDate))}</span>` : ""; })()}</div><h3>${escapeHtml(title)}</h3>${episodeVoiceMarkup(item, selectedSeason, episode, title)}${progressText ? `<p>${escapeHtml(progressText)}</p>` : ""}</div></article>`;
    }).join("");
    const loadingNote = assetsLoading ? `<div class="episode-loading-note" role="status"><span class="loading-spinner" aria-hidden="true"></span> Загружаю список серий…</div>` : isImportedSeries && episodeImagesLoading ? `<div class="episode-loading-note" role="status"><span class="loading-spinner" aria-hidden="true"></span> Загружаю серии сезона…</div>` : assetsError ? `<div class="episode-loading-note is-error" role="status">${escapeHtml(assetsError)} Показываю доступные данные.</div>` : "";
    return `<section class="section"><div class="section-header"><div><h2>Сезоны и серии</h2><span>${countWord(seasonCount, "сезон", "сезона", "сезонов")} · ${countWord(seasonList.reduce((sum, season) => sum + season.episodes.length, 0), "серия", "серии", "серий")}</span></div>${sourceAction}</div><div class="season-tabs">${seasonList.map((season) => `<button class="filter-button ${selectedSeason === season.number ? "is-active" : ""}" data-season="${season.number}" type="button">Сезон ${season.number}</button>`).join("")}</div>${loadingNote}<div class="episode-list is-season-entering">${episodeRows}</div></section>${episodeMapMarkup(item)}`;
  }



  function openRutubePlayer(videoId, title = "RUTUBE-видео", contentId = `rutube-${videoId}`) {
    rememberPlayerContext();
    const existing = state.progress[contentId] || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let lastSavedAt = 0;
    const embedUrl = `https://rutube.ru/play/embed/${encodeURIComponent(videoId)}?skinColor=f078b4&getPlayOptions=duration,title`;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="rutube-player-title"><div class="modal-head"><div><div class="eyebrow">RUTUBE · встроенный плеер</div><h2 id="rutube-player-title">${escapeHtml(title)}</h2></div><button class="icon-button" id="rutube-close" type="button" aria-label="Закрыть">${uiIcon("close")}</button></div><div class="provider-frame"><iframe id="rutube-frame" title="${escapeHtml(title)}" src="${embedUrl}" allow="clipboard-write; autoplay; fullscreen" allowfullscreen></iframe></div><div class="player-toolbar player-toolbar-compact"><div class="player-utility-actions">${playerFullscreenButtonMarkup("rutube")}</div></div><div class="player-meta-strip"><span><small>Качество</small><strong>Выбирается в RUTUBE</strong></span><span><small>Озвучка</small><strong>Выбирается в RUTUBE</strong></span><span><small>Источник</small><strong>Официальная публикация</strong></span></div><div class="provider-progress"><div class="player-range-wrap" id="rutube-range-wrap"><input id="rutube-range" type="range" min="0" max="${duration || 1}" value="${position}" aria-label="Позиция просмотра"><output class="player-seek-time" aria-hidden="true">${formatTime(position)}</output></div><span><span id="rutube-position">${formatTime(position)}</span> / <span id="rutube-duration">${formatTime(duration)}</span></span></div><div id="rutube-status" class="notice"><strong>Загрузка плеера…</strong> Место просмотра сохраняется на этом устройстве.</div></section></div>`;
    const frame = $("#rutube-frame");
    const player = $(".player-modal");
    installEmbedFullscreenControls(player);
    const range = $("#rutube-range");
    const rangeWrap = $("#rutube-range-wrap");
    const positionLabel = $("#rutube-position");
    const durationLabel = $("#rutube-duration");
    const status = $("#rutube-status");
    bindSeekTimePreview(range, rangeWrap);
    const saveProgress = (completed = false) => { state.progress[contentId] = { titleId: contentId, providerId: `rutube:${videoId}`, seasonNumber: null, episodeNumber: null, position, duration, completed, updatedAt: Date.now() }; const linkedTitle = getTitle(contentId); if (linkedTitle) rememberHistory(linkedTitle.id); saveState(); };
    const send = (message) => frame?.contentWindow?.postMessage(JSON.stringify(message), "https://rutube.ru");
    const handleMessage = (event) => {
      if (event.origin !== "https://rutube.ru") return;
      let message;
      try { message = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
      if (!message?.type) return;
      if (message.type === "player:ready") { status.innerHTML = `<strong>Плеер готов.</strong> Продолжение восстановится автоматически.`; if (position > 0) send({ type: "player:setCurrentTime", data: { time: position } }); }
      if (message.type === "player:durationChange" && Number(message.data?.duration) > 0) { duration = Number(message.data.duration); range.max = duration; durationLabel.textContent = formatDuration(duration); }
      if (message.type === "player:currentTime") { position = Math.max(0, Number(message.data?.time || 0)); range.value = Math.min(position, duration || position); positionLabel.textContent = formatTime(position); if (Date.now() - lastSavedAt > 3000) { saveProgress(false); lastSavedAt = Date.now(); } }
      if (message.type === "player:playComplete") { position = duration || position; saveProgress(true); status.innerHTML = `<strong>Просмотр завершён.</strong> Прогресс сохранён.`; }
      if (message.type === "player:error") status.innerHTML = `<strong>RUTUBE не запустил видео.</strong> Проверьте, что оно открыто для просмотра и встраивания.`;
    };
    window.addEventListener("message", handleMessage);
    range.addEventListener("input", () => { position = Number(range.value); positionLabel.textContent = formatTime(position); send({ type: "player:setCurrentTime", data: { time: position } }); saveProgress(false); });
    const close = () => { saveProgress(false); window.removeEventListener("message", handleMessage); player._exitFullscreen?.(); player._removeEmbedFullscreenControls?.(); returnFromPlayer(); };
    $("#rutube-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }








  function openExternalEmbedPlayer(item) {
    rememberPlayerContext();
    const embedURL = String(item.embed_url || "").trim();
    if (!embedURL) return;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="external-player-title"><div class="modal-head"><div><div class="eyebrow">${item.kind === "series" ? "Сериал" : "Фильм"}</div><h2 id="external-player-title">${escapeHtml(item.title)} · ${escapeHtml(item.episode_title)}</h2></div><button class="icon-button" id="external-player-close" type="button" aria-label="Закрыть">${uiIcon("close")}</button></div><div class="provider-frame external-embed-frame"><iframe title="${escapeHtml(item.title)}" src="${escapeHtml(embedURL)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div><div class="player-toolbar player-toolbar-compact"><div class="player-utility-actions">${playerFullscreenButtonMarkup("external-player")}</div></div><p class="notice"><strong>Видео открыто у источника.</strong> Озвучка и качество выбираются в самом плеере.</p></section></div>`;
    const player = $(".player-modal");
    installEmbedFullscreenControls(player);
    const close = () => { player._exitFullscreen?.(); player._removeEmbedFullscreenControls?.(); returnFromPlayer(); };
    $("#external-player-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  async function openLibraryPlayer(item, roomId = "") {
    roomId = "";
    rememberPlayerContext();
    if (item.source_type === "external_embed") {
      const rutubeVideoId = extractRutubeVideoId(item.embed_url);
      return rutubeVideoId ? openRutubePlayer(rutubeVideoId, `${item.title} · ${item.episode_title}`, item.id) : openExternalEmbedPlayer(item);
    }
    const existing = item.progress || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let lastSaved = 0;
    let hls = null;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal player-cinematic" role="dialog" aria-modal="true" aria-labelledby="library-player-title"><div class="modal-head"><div><div class="eyebrow">${item.kind === "series" ? "Сериал" : "Фильм"}</div><h2 id="library-player-title">${escapeHtml(item.title)} · ${escapeHtml(item.episode_title)}</h2></div><button class="icon-button" id="player-close" type="button" aria-label="Закрыть">${uiIcon("close")}</button></div><div class="provider-frame video-frame"><video id="library-video" playsinline preload="auto"></video><button class="video-play-overlay" id="library-play-overlay" type="button" aria-label="Воспроизвести">${playerIcon("play")}</button><div class="video-loading" id="library-video-loading" role="status" aria-live="polite">Загружаю видео…</div><div class="video-error" id="library-video-error" role="alert" hidden></div></div>${playerToolbarMarkup("library", hlsTrackControlsMarkup("library"))}<p class="player-audio-notice" id="library-audio-notice" role="status" aria-live="polite" hidden></p><div class="library-seekbar"><div class="player-range-wrap" id="library-range-wrap"><span class="player-range-buffer" aria-hidden="true"></span><input id="library-range" type="range" min="0" max="${duration || 1}" step="0.1" value="${position}" aria-label="Перемотка видео"><output class="player-seek-time" aria-hidden="true">${formatTime(position)}</output></div><div class="player-progress-info"><span><span id="library-player-position">${formatTime(position)}</span> / <span id="library-player-duration">${formatDuration(duration)}</span></span><span class="player-buffer-status" id="library-buffer-status" role="status">Загружается…</span></div></div><div id="library-room-status" class="watch-room-status" role="status" aria-live="polite"${roomId ? "" : " hidden"}></div><div class="library-skip-panel" id="library-skip-panel" hidden><span id="library-skip-label"></span><button class="secondary-button" id="library-skip-now" type="button"></button><label class="library-skip-toggle"><input id="library-skip-auto" type="checkbox"${state.skipSegments !== false ? " checked" : ""}> Автопропуск</label></div><p id="library-player-status" class="notice" aria-live="polite">${position > 0 ? "Продолжение просмотра." : "Позиция сохраняется автоматически."}</p></section></div>`;
    const fullscreenPlayer = $(".player-modal");
    installPlayerFullscreenControls(fullscreenPlayer);
    const video = $("#library-video");
    const loading = $("#library-video-loading");
    const videoError = $("#library-video-error");
    const status = $("#library-player-status");
    const play = $("#library-play");
    const playOverlay = $("#library-play-overlay");
    const removeVolumeControl = bindPlayerVolumeControl(video, "library");
    const removeSettingsControl = bindPlayerSettings("library");
    const removeLoadingState = bindPlayerLoadingState(video, loading, play);
    const range = $("#library-range");
    const rangeWrap = $("#library-range-wrap");
    bindSeekTimePreview(range, rangeWrap);
    const bufferStatus = $("#library-buffer-status");
    const skipPanel = $("#library-skip-panel");
    const skipLabel = $("#library-skip-label");
    const skipNow = $("#library-skip-now");
    const skipAuto = $("#library-skip-auto");
    const roomStatus = $("#library-room-status");
    let roomSync = null;
    let activeSkip = null;
    const skippedSegments = new Set();
    const updateSkipControls = () => {
      const segments = librarySkipSegments(item, duration || Number(video.duration || 0));
      const currentPosition = Number.isFinite(video.currentTime) ? Number(video.currentTime) : Number(position || 0);
      activeSkip = segments.find((segment) => currentPosition >= segment.from && currentPosition < segment.to - 0.5) || null;
      skipPanel.hidden = !activeSkip;
      if (activeSkip) {
        skipLabel.textContent = `Сейчас идут ${activeSkip.label}`;
        skipNow.textContent = activeSkip.button;
      }
    };
    const skipActiveSegment = (automatic = false) => {
      if (!activeSkip || (roomSync && !roomSync.isHost)) return;
      const segment = activeSkip;
      skippedSegments.add(segment.key);
      position = segment.to;
      video.currentTime = segment.to;
      if (roomSync) roomSync.publish({ position: segment.to });
      range.value = segment.to;
      status.textContent = `${segment.button} выполнено.`;
      updateSkipControls();
      if (automatic) skipPanel.hidden = true;
      saveProgress(false);
    };
    const maybeAutoSkip = () => {
      if (roomId || !activeSkip || !skipAuto.checked || skippedSegments.has(activeSkip.key) || !activeSkip.auto) return;
      skipActiveSegment(true);
    };
    const saveProgress = (completed = false, force = false) => {
      if (roomId && nativeWatchRooms.has(roomId)) return;
      const payload = { position, duration, completed };
      if (!force && Date.now() - lastSaved < 1500 && !completed) return;
      lastSaved = Date.now();
      state.episodeProgress = { ...(state.episodeProgress || {}), [item.id]: { ...payload, updatedAt: new Date().toISOString() } };
      saveState();
      const current = libraryEpisodes.find((episode) => episode.id === item.id);
      if (current) {
        current.progress = { ...payload, updatedAt: new Date().toISOString() };
        libraryHistory = [current, ...libraryHistory.filter((entry) => entry.id !== item.id)];
      }
    };
    const updateBuffer = () => updatePlayerBuffer(video, duration, rangeWrap, bufferStatus);
    const onMetadata = () => { videoError.hidden = true; duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); $("#library-player-duration").textContent = formatDuration(duration); updateBuffer(); if (!roomId) restorePlaybackPosition(video, position < duration ? position : 0, duration); updateSkipControls(); maybeAutoSkip(); };
    const onTime = () => { if (!roomId && protectResumePosition(video, position, duration)) return; position = Number(video.currentTime || 0); duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); updateBuffer(); updateSkipControls(); maybeAutoSkip(); saveProgress(false); };
    const onEnded = () => { position = duration || Number(video.currentTime || 0); saveProgress(true); roomSync?.publish({ position, playing: false }); status.innerHTML = "<strong>Серия завершена.</strong> Прогресс сохранён."; };
    const onError = () => { loading.hidden = true; showSourceErrorCard(videoError, null, "Попробуйте открыть позже."); status.innerHTML = "<strong>Видео не открылось.</strong> Попробуйте открыть позже."; };
    const onPlay = () => { setPlayerPlayButton(play, true, false); if (!roomSync?.isApplying()) roomSync?.publish({ playing: true }); };
    const onPause = () => { position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : position; duration = Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : duration; setPlayerPlayButton(play, false, false); saveProgress(false, true); if (!roomSync?.isApplying()) roomSync?.publish({ position, playing: false }); };
    const seekBy = (seconds) => {
      const currentPosition = Number.isFinite(video.currentTime) ? Number(video.currentTime) : Number(position || 0);
      const nextPosition = Math.max(0, Math.min(video.duration || duration || Number.MAX_SAFE_INTEGER, currentPosition + seconds));
      position = nextPosition;
      video.currentTime = nextPosition;
      range.value = nextPosition;
      status.textContent = seconds < 0 ? "Перемотка назад на 10 секунд." : "Перемотка вперёд на 10 секунд.";
      saveProgress(false);
      roomSync?.publish({ position: nextPosition });
    };
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("progress", updateBuffer);
    video.addEventListener("canplay", updateBuffer);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    bindVideoPlaybackControls(video, play, playOverlay, () => { status.innerHTML = "<strong>Воспроизведение не запустилось.</strong> Нажмите «Воспроизвести» ещё раз."; });
    $("#library-back").addEventListener("click", () => seekBy(-10));
    $("#library-forward").addEventListener("click", () => seekBy(10));
    range.addEventListener("input", () => { position = Number(range.value); video.currentTime = position; status.textContent = "Позиция изменена."; saveProgress(false); roomSync?.schedulePublish(); });
    skipNow.addEventListener("click", () => skipActiveSegment(false));
    skipAuto.addEventListener("change", () => { state.skipSegments = skipAuto.checked; saveState(); if (skipAuto.checked) maybeAutoSkip(); });
    roomSync = installWatchRoomSync({ roomId, video, item, season: item.season, episode: item.episode, roomStatus, onEpisodeChange: (nextSeason, nextEpisode) => { const next = libraryEpisodes.find((entry) => entry.title_id === item.title_id && Number(entry.season) === nextSeason && Number(entry.episode) === nextEpisode); if (next) { roomSync?.dispose(); modalRoot.innerHTML = ""; openLibraryPlayer(next, roomId); } else roomSync?.message?.("Эта серия недоступна в медиатеке."); }, onLeave: () => { roomId = ""; roomSync = null; roomStatus.hidden = true; setWatchRoomInUrl(""); } });
    const player = $(".player-modal");
    player._watchRoom = roomSync;
    $("#library-room")?.addEventListener("click", async () => {
      try {
        if (roomId) { await navigator.clipboard?.writeText(watchRoomLink(roomId)); roomStatus.hidden = false; if (roomSync?.message) roomSync.message("Ссылка на комнату скопирована."); else roomStatus.textContent = "Ссылка на комнату скопирована."; return; }
        const created = await createWatchRoom(item, item.season, item.episode, { position: Number(video.currentTime || position || 0), playing: !video.paused && !video.ended });
        await navigator.clipboard?.writeText(created.link);
        roomId = created.room_id;
        setWatchRoomInUrl(created.room_id);
        roomSync?.dispose();
        roomSync = installWatchRoomSync({ roomId, video, item, season: item.season, episode: item.episode, roomStatus, onEpisodeChange: (nextSeason, nextEpisode) => { const next = libraryEpisodes.find((entry) => entry.title_id === item.title_id && Number(entry.season) === nextSeason && Number(entry.episode) === nextEpisode); if (next) { roomSync?.dispose(); modalRoot.innerHTML = ""; openLibraryPlayer(next, roomId); } else roomSync?.message?.("Эта серия недоступна в медиатеке."); }, onLeave: () => { roomId = ""; roomSync = null; roomStatus.hidden = true; setWatchRoomInUrl(""); } });
        player._watchRoom = roomSync;
        roomStatus.hidden = false;
        roomSync?.message?.("Приглашение скопировано.");
      } catch (error) { roomStatus.hidden = false; roomStatus.textContent = `Комнату создать не удалось: ${error.message}`; roomStatus.classList.add("is-error"); }
    });
    const streamUrl = item.hls_url || item.source_url;
    if (item.hls_url && window.Hls && window.Hls.isSupported()) {
      hls = createHlsPlayer(video, streamUrl, "library", () => { videoError.hidden = true; }, (_event, data) => { if (data?.fatal) onError(); }, HLS_PLAYBACK_CONFIG, { preferredAudioKey: selectedHlsAudioKey(item), preferredAudioLabel: titlePlaybackSelection(item).hlsAudioLabel || "", preserveVolume: () => playerVolumeSnapshot(video), onAudioPreferenceChange: ({ key, label }) => { state.playbackSelections[item.id] = { ...titlePlaybackSelection(item), hlsAudio: key, hlsAudioLabel: label }; saveState(); } });
    } else {
      video.src = streamUrl;
      video.load();
    }
    const close = () => { position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : position; duration = Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : duration; saveProgress(false, true); if (nativeWatchRooms.has(roomId)) roomSync?.leave?.(); else roomSync?.publish({ position, playing: false }); roomSync?.dispose(); fullscreenPlayer._exitFullscreen?.(); video.pause(); hls?.destroy(); removeLoadingState(); removeVolumeControl(); removeSettingsControl(); video.removeEventListener("loadedmetadata", onMetadata); video.removeEventListener("timeupdate", onTime); video.removeEventListener("ended", onEnded); video.removeEventListener("error", onError); video.removeEventListener("play", onPlay); video.removeEventListener("pause", onPause); fullscreenPlayer._removeFullscreenControls?.(); returnFromPlayer(); };
    $("#player-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  async function createLibraryRoom(item) {
    const feedback = $("#library-upload-feedback");
    try {
      const payload = await createWatchRoom(item, item.season, item.episode);
      await navigator.clipboard?.writeText(payload.link);
      setWatchRoomInUrl(payload.room_id);
      await openLibraryPlayer(item, payload.room_id);
      if (feedback) feedback.textContent = `Комната ${payload.share_code} создана. Ссылка скопирована.`;
    } catch (error) { if (feedback) feedback.textContent = `Комнату создать не удалось: ${error.message}`; }
  }

  // Posters and frames fade in once they arrive instead of popping in line by line. Only a picture that is
  // not in the cache yet is hidden, and only until it loads or fails, so nothing can stay invisible.
  // Episode stills of one list come up together (when all have loaded, or after 1.5 s at most), not one by one.
  const stillGroups = new WeakMap();
  function fadeInImage(image) {
    if (!(image instanceof HTMLImageElement) || image.dataset.fade || image.complete || image.closest(".title-logo, .cv-player")) return;
    image.dataset.fade = "1";
    image.classList.add("img-fading");
    const group = image.hasAttribute("data-episode-poster") ? image.closest("section, .page") : null;
    if (!group) {
      const done = () => image.classList.remove("img-fading");
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
      return;
    }
    let entry = stillGroups.get(group);
    if (!entry || entry.shown) {
      entry = { images: [], waiting: 0, shown: false };
      entry.show = () => { if (entry.shown) return; entry.shown = true; entry.images.forEach((one) => one.classList.remove("img-fading")); };
      entry.timer = window.setTimeout(entry.show, 1500);
      stillGroups.set(group, entry);
    }
    entry.images.push(image);
    entry.waiting += 1;
    const settled = () => { entry.waiting -= 1; if (entry.waiting <= 0) { window.clearTimeout(entry.timer); entry.show(); } };
    image.addEventListener("load", settled, { once: true });
    image.addEventListener("error", settled, { once: true });
  }
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === "IMG") fadeInImage(node);
      else node.querySelectorAll?.("img").forEach(fadeInImage);
      if (node.matches?.("[data-logo-for]") || node.querySelector?.("[data-logo-for]")) hydrateTitleLogos(node.parentNode || node);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  function bindPageActions(root = document) {
    hydrateTitleLogos(root);
    const $ = (selector, parent = root) => parent.querySelector(selector);
    const $$ = (selector, parent = root) => [...parent.querySelectorAll(selector)];
    $$('[data-open-source-import]').forEach((button) => button.addEventListener("click", () => { const item = getTitle(button.dataset.openSourceImport); if (item) openCatalogSourceImport(item); }));
    $$('[data-home-genre]').forEach((button) => button.addEventListener("click", () => { state.catalogCollection = ""; state.catalogSort = "now"; state.catalogMoodOnly = false; state.query = ""; searchDraft = ""; state.catalogGenre = normalizeCatalogGenre(button.dataset.homeGenre); resetCatalogPage(); saveState(); navigateToView("catalog", { preserveCatalogFilters: true }); }));
    $$('[data-feature-pick]').forEach((button) => button.addEventListener("click", () => selectHomeFeature(button.dataset.featurePick)));
    $('[data-feature-shuffle]')?.addEventListener("click", () => { const total = homeFeaturePicks().length || 1; selectHomeFeature((homeFeatureIndex + 1) % total); });
    // Opening a title must not enter fullscreen by itself: a pending source refresh
    // or resume seek can otherwise make the browser exit fullscreen and reset the UI.
    // Fullscreen remains available from the player's explicit control.
    const beginCinematicWatch = () => {};
    $$('[data-play-media]').forEach((button) => button.addEventListener("click", () => { beginCinematicWatch(); const item = getTitle(button.dataset.playMedia); const season = button.dataset.resumeSeason ? Number(button.dataset.resumeSeason) : null; const episode = button.dataset.episode ? Number(button.dataset.episode) : null; openWatch(item, { episode, season }); }));
    $$('[data-trailer]').forEach((button) => button.addEventListener("click", () => openTrailer(getTitle(button.dataset.trailer))));
    $$('[data-demo-play]').forEach((button) => button.addEventListener("click", () => { beginCinematicWatch(); const item = getTitle(button.dataset.demoPlay); const season = button.dataset.resumeSeason ? Number(button.dataset.resumeSeason) : null; const episode = button.dataset.episode ? Number(button.dataset.episode) : (item?.kind === "series" ? (progressForTitle(item)?.episodeNumber || 1) : null); openWatch(item, { episode, season }); }));
    const episodeImages = $$('[data-episode-poster]');
    let pendingEpisodeImages = episodeImages.length;
    const finishEpisodeImageLoading = () => {
      if (!episodeImagesLoading || pendingEpisodeImages > 0) return;
      episodeImagesLoading = false;
      // Never re-render from inside this pass: the rest of it would bind the new page a second time,
      // and every doubled toggle (favourites, seasons) would undo itself.
      const titleId = activeTitleId;
      if (titleId) queueMicrotask(() => { if (activeTitleId === titleId) renderDetails(titleId); });
    };
    episodeImages.forEach((image) => {
      const frame = image.closest(".episode-card-image");
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        pendingEpisodeImages -= 1;
        finishEpisodeImageLoading();
      };
      image.addEventListener("load", () => { frame?.classList.add("is-loaded"); settle(); }, { once: true });
      image.addEventListener("error", () => {
        if (image.dataset.fallback && !image.dataset.fallbackUsed) {
          image.dataset.fallbackUsed = "1";
          image.removeAttribute("srcset");
          image.src = image.dataset.fallback;
          return;
        }
        frame?.classList.add("is-error");
        settle();
      });
      if (image.complete) {
        if (image.naturalWidth > 0) frame?.classList.add("is-loaded");
        else image.dispatchEvent(new Event("error"));
        if (image.naturalWidth > 0) settle();
      }
    });
    finishEpisodeImageLoading();
    $$('[data-library-play]').forEach((button) => button.addEventListener("click", () => { const item = libraryEpisodes.find((episode) => episode.id === button.dataset.libraryPlay); if (item) openLibraryPlayer(item); }));
    $$('[data-library-room]').forEach((button) => button.addEventListener("click", () => { const item = libraryEpisodes.find((episode) => episode.id === button.dataset.libraryRoom); if (item) createLibraryRoom(item); }));
    $("#catalog-search-form")?.addEventListener("submit", runCatalogSearch);
    $$('[data-catalog-select]').forEach((button) => button.addEventListener("click", () => selectCatalogTitle(button.dataset.catalogSelect, button.dataset.catalogKind, button.dataset.catalogProvider)));
    $$('[data-library-refresh]').forEach((button) => button.addEventListener("click", () => loadLibraryData(true)));
    $("#kinopoisk-import-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const input = $("#kinopoisk-import-input");
      const feedback = $("#kinopoisk-import-feedback");
      const submit = form.querySelector('[type="submit"]');
      const kinopoisk = String(new FormData(form).get("kinopoisk") || "").trim();
      const kinopoiskAdminToken = String(new FormData(form).get("kinopoisk_admin_token") || "").trim();
      if (!kinopoisk) {
        input?.setAttribute("aria-invalid", "true");
        if (feedback) feedback.textContent = "Введи Kinopoisk ID или ссылку на фильм либо сериал.";
        input?.focus();
        return;
      }
      input?.removeAttribute("aria-invalid");
      submit.disabled = true;
      feedback.textContent = "Добавляю карточку без видеопотока…";
      try {
        const response = await apiFetch("/api/catalog/kinopoisk-imports", {
          method: "POST",
          headers: { "content-type": "application/json", ...(kinopoiskAdminToken ? { "X-CineVault-Admin-Token": kinopoiskAdminToken } : {}) },
          body: JSON.stringify({ kinopoisk }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const jobId = payload.id;
        const poll = async () => {
          if (!document.body.contains(feedback)) return;
          const statusResponse = await apiFetch(`/api/catalog/kinopoisk-imports/${encodeURIComponent(jobId)}`);
          const status = await statusResponse.json();
          if (!statusResponse.ok) throw new Error(status.error || `HTTP ${statusResponse.status}`);
          if (status.status === "queued" || status.status === "running") {
            feedback.textContent = "Импортирую и собираю карточку Lumo Film…";
            window.setTimeout(() => poll().catch(showError), 1500);
            return;
          }
          if (status.status !== "completed") throw new Error(status.error || "Импорт не завершился");
          await loadImportedCatalog();
          const entry = status.entry || {};
          const title = entry.title || `Kinopoisk ${status.kinopoisk_id}`;
          const route = entry.id ? routeForTitle(entry.id) : routeForView("catalog");
          feedback.innerHTML = `Готово: <strong>${escapeHtml(title)}</strong> добавлен в каталог. <a href="${escapeHtml(route)}">Открыть карточку</a>`;
          form.reset();
          submit.disabled = false;
        };
        const showError = (error) => {
          input?.setAttribute("aria-invalid", "true");
          feedback.textContent = `Не удалось добавить: ${error.message}. Проверь ID и попробуй ещё раз.`;
          submit.disabled = false;
        };
        poll().catch(showError);
      } catch (error) {
        input?.setAttribute("aria-invalid", "true");
        feedback.textContent = `Не удалось запустить импорт: ${error.message}. Проверь ID и попробуй ещё раз.`;
        submit.disabled = false;
      }
    });
    $("#library-upload-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const feedback = $("#library-upload-feedback");
      feedback.textContent = "Загружаю исходник на сервер…";
      try {
        const headers = {};
        const files = form.querySelector('[name="file"]')?.files || [];
        const endpoint = files.length > 1 || files[0]?.webkitRelativePath ? "/api/library/bulk-upload" : "/api/library/upload";
        const response = await apiFetch(endpoint, { method: "POST", headers, body: new FormData(form) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        feedback.textContent = "Файл сохранён. FFmpeg готовит HLS; обнови список через несколько секунд.";
        form.reset();
        await loadLibraryData(true);
      } catch (error) { feedback.textContent = error.message.includes("403") ? "Импорт доступен только администратору backend." : `Загрузка не выполнена: ${error.message}`; }
    });
    $("#library-external-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const feedback = $("#library-external-feedback");
      const formData = new FormData(form);
      adminToken = String(formData.get("admin_token") || "").trim();
      if (adminToken) sessionStorage.setItem("cinevault.adminToken", adminToken);
      feedback.textContent = "Подключаю внешний embed…";
      try {
        const response = await apiFetch("/api/library/external-embed", {
          method: "POST",
          headers: { "content-type": "application/json", ...(adminToken ? { "X-CineVault-Admin-Token": adminToken } : {}) },
          body: JSON.stringify({ title: formData.get("title"), season: formData.get("season"), episode: formData.get("episode"), episode_title: formData.get("episode_title"), embed_url: formData.get("embed_url") }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        feedback.textContent = "Внешний плеер подключён. Обновляю общий каталог…";
        form.reset();
        await loadLibraryData(true);
      } catch (error) { feedback.textContent = error.message.includes("403") ? "Импорт доступен только администратору backend." : `Embed не подключён: ${error.message}`; }
    });
    $("#library-source-json-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const feedback = $("#library-source-json-feedback");
      const formData = new FormData(form);
      adminToken = String(formData.get("admin_token") || "").trim();
      if (adminToken) sessionStorage.setItem("cinevault.adminToken", adminToken);
      feedback.textContent = "Проверяю JSON и добавляю варианты озвучки…";
      try {
        const metadata = String(formData.get("metadata") || "{}").trim() || "{}";
        JSON.parse(metadata);
        formData.set("metadata", metadata);
        const response = await apiFetch("/api/catalog/source-json", {
          method: "POST",
          headers: adminToken ? { "X-CineVault-Admin-Token": adminToken } : {},
          body: formData,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const skipped = Array.isArray(payload.skipped) && payload.skipped.length ? ` Пропущено: ${payload.skipped.length}.` : "";
        feedback.textContent = `${payload.created ? "Карточка создана" : "Карточка обновлена"}: добавлено вариантов — ${payload.accepted}.${skipped}`;
        form.reset();
        await loadImportedCatalog();
        render();
      } catch (error) { feedback.textContent = error.message.includes("403") ? "Импорт доступен только администратору backend." : `JSON не импортирован: ${error.message}`; }
    });
    $$('[data-mood]').forEach((button) => button.addEventListener("click", () => { selectMood(button.dataset.mood); }));
    bindSubscribeButtons(page);
    $$('[data-favorite]').forEach((button) => button.addEventListener("click", () => { const id = button.dataset.favorite; const adding = !state.favorites.includes(id); state.favorites = adding ? [...state.favorites, id] : withoutTitle(state.favorites, id); const tracked = Array.isArray(state.anticipatedPremieres) ? state.anticipatedPremieres : []; state.anticipatedPremieres = adding && upcomingPremiere(getTitle(id)) ? [...new Set([...tracked, id])] : adding ? tracked : tracked.filter((item) => item !== id); saveState(); renderDetails(id); }));
    $$('[data-watchlist]').forEach((button) => button.addEventListener("click", () => { const id = button.dataset.watchlist; state.watchlist = state.watchlist.includes(id) ? withoutTitle(state.watchlist, id) : [...state.watchlist, id]; saveState(); renderDetails(id); }));
    $$('[data-season]').forEach((button) => button.addEventListener("click", () => switchSeason(button.dataset.season)));
    ["detail-playback-source", "detail-playback-voice", "detail-hls-audio"].forEach((controlId) => {
      $(`#${controlId}`)?.addEventListener("change", (event) => {
        const item = getTitle(activeTitleId);
        if (!item) return;
        state.playbackSelections = state.playbackSelections && typeof state.playbackSelections === "object" ? state.playbackSelections : {};
        const current = { ...titlePlaybackSelection(item) };
        if (controlId === "detail-playback-source") current.source = event.currentTarget.value;
        if (controlId === "detail-playback-voice") current.voice = event.currentTarget.value;
        if (controlId === "detail-hls-audio") {
          current.hlsAudio = event.currentTarget.value;
          current.hlsAudioLabel = event.currentTarget.selectedOptions?.[0]?.textContent || "";
        }
        state.playbackSelections[item.id] = current;
        saveState();
      });
    });
    $$('[data-clear-progress]').forEach((button) => button.addEventListener("click", () => { state.progress = {}; persistAndRender(); }));
    $$('[data-catalog-genre]').forEach((button) => button.addEventListener("click", () => {
      const genre = normalizeCatalogGenre(button.dataset.catalogGenre);
      state.catalogGenre = normalizeCatalogGenre(state.catalogGenre) === genre ? "" : genre;
      resetCatalogPage();
      saveState();
      loadRemoteCatalogPage(1);
    }));
    $$('[data-catalog-collection]').forEach((button) => button.addEventListener("click", () => {
      const collectionId = String(button.dataset.catalogCollection || "");
      state.catalogCollection = state.catalogCollection === collectionId ? "" : collectionId;
      state.catalogSort = sortForCatalogCollection(state.catalogCollection, state.catalogSort);
      state.query = "";
      searchDraft = "";
      const search = $("#search");
      if (search) search.value = "";
      hideSearchSuggestions();
      state.catalogGenre = "";
      state.catalogMoodOnly = false;
      resetCatalogPage();
      saveState();
      loadRemoteCatalogPage(1);
    }));
    $$('[data-open-collection]').forEach((button) => button.addEventListener("click", () => openCatalogCollection(button.dataset.openCollection, button.dataset.collectionView)));
    bindCatalogSortMenu();
    bindCatalogMoreButton();
    $$('[data-catalog-reset]').forEach((button) => button.addEventListener("click", resetCatalogFilters));
    $$('[data-map-season]').forEach((button) => button.addEventListener("click", () => {
      const item = getTitle(activeTitleId);
      if (item) openWatch(item, { season: Number(button.dataset.mapSeason), episode: Number(button.dataset.mapEpisode) });
    }));
    $$('[data-upcoming-sort]').forEach((button) => button.addEventListener("click", () => {
      const next = button.dataset.upcomingSort === "soon" ? "soon" : "await";
      if ((state.upcomingSort || "await") === next) return;
      state.upcomingSort = next;
      resetCatalogPage();
      saveState();
      loadRemoteCatalogPage(1);
    }));
    const genreRail = $(".genre-rail");
    $("[data-genre-toggle]")?.addEventListener("click", (event) => {
      genreRailExpanded = !genreRailExpanded;
      $(".genre-rail-wrap")?.classList.toggle("is-expanded", genreRailExpanded);
      event.currentTarget.setAttribute("aria-expanded", String(genreRailExpanded));
      event.currentTarget.textContent = genreRailExpanded ? "Свернуть" : "Все жанры";
    });
    $$('[data-genre-scroll]').forEach((button) => button.addEventListener("click", () => genreRail?.scrollBy({ left: Number(button.dataset.genreScroll) * genreRail.clientWidth * .8, behavior: "smooth" })));
    const activeGenre = genreRail?.querySelector(".genre-pill.is-active:not([data-catalog-genre=''])");
    if (activeGenre) genreRail.scrollLeft = Math.max(0, activeGenre.offsetLeft - (genreRail.clientWidth - activeGenre.offsetWidth) / 2);
    $('[data-catalog-random]')?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      const type = state.view === "movies" ? "movie" : state.view === "series" ? "tv" : "all";
      randomSession = { type, genre: String(state.catalogGenre || "").trim().toLowerCase(), seen: [], currentId: "" };
      button.disabled = true;
      button.textContent = "Подбираю…";
      openRandomTitle({ replace: false }).finally(() => { if (button.isConnected) { button.disabled = false; button.textContent = "Случайный"; } });
    });
    $("#rutube-open")?.addEventListener("click", () => { const input = $("#rutube-url"); const feedback = $("#rutube-feedback"); const videoId = extractRutubeVideoId(input?.value); if (!videoId) { feedback.textContent = "Нужна прямая ссылка RUTUBE на видео или embed-код."; return; } state.rutubeUrl = input.value.trim(); saveState(); openRutubePlayer(videoId, "RUTUBE-видео", `rutube-${videoId}`); });
    $("#rutube-test")?.addEventListener("click", () => openRutubePlayer(RUTUBE_SAMPLE_ID, "Тестовый плеер RUTUBE", `rutube-demo-${RUTUBE_SAMPLE_ID}`));
    $("#hdrezka-search")?.addEventListener("click", runHdrezkaSearch);
    $("#hdrezka-query")?.addEventListener("keydown", (event) => { if (event.key === "Enter") runHdrezkaSearch(); });
  }

  function getTitleFromPage() { return activeTitleId || $("[data-demo-play]")?.dataset.demoPlay || "desperate-housewives"; }

  function hideSearchSuggestions() {
    const popup = $("#search-suggestions");
    if (popup) popup.hidden = true;
    app.classList.remove("is-searching");
    unlockPageForSearch();
  }
  // While the search window is open the page under it stands still: on iPhone the finger otherwise scrolls the
  // page through the window, and the keyboard pushes everything up. The page is pinned where it was and put back.
  let searchLockedAt = null;
  function lockPageForSearch() {
    if (searchLockedAt !== null) return;
    searchLockedAt = window.scrollY;
    Object.assign(document.body.style, { position: "fixed", top: `-${searchLockedAt}px`, left: "0", right: "0", width: "100%" });
  }
  function unlockPageForSearch() {
    if (searchLockedAt === null) return;
    const at = searchLockedAt;
    searchLockedAt = null;
    Object.assign(document.body.style, { position: "", top: "", left: "", right: "", width: "" });
    window.scrollTo(0, at);
  }
  // The list ends right above the on-screen keyboard (iPhone), so its last lines can be scrolled to.
  if (window.visualViewport) {
    const fitAboveKeyboard = () => {
      const keyboard = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard-h", `${Math.round(keyboard)}px`);
    };
    window.visualViewport.addEventListener("resize", fitAboveKeyboard);
    window.visualViewport.addEventListener("scroll", fitAboveKeyboard);
  }
  function openSearchWindow() {
    app.classList.add("is-searching");
    if (window.matchMedia("(max-width: 720px)").matches) lockPageForSearch();
  }

  // The search window: opened over the page as soon as the field gets the focus. Before anything is typed it
  // offers ways in — sections and genres, the last searches, what is popular today; while typing, results.
  // «Вы искали» keeps the titles opened from search (not the typed words): poster, name, year.
  const RECENT_SEARCHES_KEY = "cinevault.recentSearchTitles";
  const searchShown = new Map();
  function recentSearches() { try { return (JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || "[]") || []).filter((one) => one && one.id && one.title).slice(0, 6); } catch { return []; } }
  function rememberSearchTitle(id) {
    const item = searchShown.get(id) || getTitle(id);
    if (!item?.title) return;
    const entry = { id, title: item.title, year: item.year || "", kind: item.kind || "", genre: genresForItem(item)[0] || "", posterImage: item.posterImage || "" };
    try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify([entry, ...recentSearches().filter((one) => one.id !== id)].slice(0, 6))); } catch {}
  }
  function searchResultRow(item, extra = "") {
    searchShown.set(item.id, item);
    const kind = item.kind === "series" ? "сериал" : "фильм";
    const facts = [item.year, kind, item.genre || genresForItem(item)[0]].filter(Boolean).join(" · ");
    return `<a class="search-suggestion" ${extra} href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}"><span class="search-suggestion-poster" style="${item.posterImage ? `background-image:url('${escapeHtml(previewImageUrl(item.posterImage))}')` : ""}" aria-hidden="true"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(facts)}</small></span></a>`;
  }
  const SEARCH_SECTIONS = [["movies", "Фильмы"], ["series", "Сериалы"], ["cartoons", "Мультфильмы"], ["anime", "Аниме"], ["upcoming", "Скоро"]];
  const SEARCH_GENRES = [["комедия", "Комедии"], ["ужасы", "Ужасы"], ["фантастика", "Фантастика"], ["триллер", "Триллеры"], ["драма", "Драмы"], ["мелодрама", "Про любовь"], ["детектив", "Детективы"]];
  function renderSearchStart() {
    const popup = $("#search-suggestions");
    if (!popup) return;
    const recent = recentSearches();
    // Outside the home page the day's trends may not be loaded yet: fetch them and fill the window when they come.
    if (!tmdbHome && lampacOrigin()) loadTmdbHome().then(() => { if (app.classList.contains("is-searching") && searchDraft.trim().length < 2) renderSearchStart(); }).catch(() => {});
    const trending = (tmdbHome?.find((row) => row.key === "trend-day")?.items || []).filter((item) => item.posterImage).slice(0, 6);
    const kindLabel = (item) => item.kind === "series" ? "сериал" : "фильм";
    popup.innerHTML = `<div class="search-start">
      <p class="search-start-title">Разделы</p>
      <div class="search-chips">${SEARCH_SECTIONS.map(([view, label]) => `<a class="search-chip" href="${routeForView(view)}" data-search-view="${view}">${escapeHtml(label)}</a>`).join("")}${SEARCH_GENRES.map(([genre, label]) => `<button class="search-chip" type="button" data-search-genre="${escapeHtml(genre)}">${escapeHtml(label)}</button>`).join("")}</div>
      ${recent.length ? `<p class="search-start-title">Вы искали</p><div class="search-suggestions-list">${recent.map((item) => searchResultRow(item)).join("")}</div>` : ""}
      ${trending.length ? `<p class="search-start-title">Сейчас ищут</p><div class="search-suggestions-list">${trending.filter((item) => !recent.some((one) => one.id === item.id)).slice(0, Math.max(3, 6 - recent.length)).map((item) => searchResultRow(item)).join("")}</div>` : ""}
    </div>`;
    popup.hidden = false;
    openSearchWindow();
  }
  function runSearch(query) {
    const text = String(query || "").trim();
    state.query = text;
    state.catalogCollection = "";
    state.catalogGenre = "";
    resetCatalogPage();
    saveState();
    hideSearchSuggestions();
    $("#search")?.blur();
    navigateToView("catalog", { replace: true, preserveCatalogFilters: true });
  }

  // Live suggestions ask the server: the browser holds only a slice of the catalogue.
  function renderSearchSuggestions(query = searchDraft.trim(), results = searchSuggestionCatalog, failed = false) {
    const popup = $("#search-suggestions");
    if (!popup) return;
    if (query.length < 2) return document.activeElement === $("#search") ? renderSearchStart() : hideSearchSuggestions();
    popup.hidden = false;
    openSearchWindow();
    const kindLabel = (item) => item.kind === "series" ? "сериал" : "фильм";
    popup.innerHTML = failed
      ? `<p class="search-suggestions-empty">Поиск сейчас не отвечает. Enter откроет полный поиск.</p>`
      : results.length
        ? `<div class="search-suggestions-list" role="listbox" aria-label="Подсказки поиска">${results.map((item) => searchResultRow(item, 'role="option"')).join("")}</div><p class="search-suggestions-title">Enter — все результаты</p>`
        : `<p class="search-suggestions-empty">По запросу «${escapeHtml(query)}» ничего не нашлось.</p>`;
  }
  function requestSearchSuggestions() {
    window.clearTimeout(searchSuggestionTimer);
    searchSuggestionRequest?.abort();
    const query = searchDraft.trim();
    if (query.length < 2) return document.activeElement === $("#search") ? renderSearchStart() : hideSearchSuggestions();
    searchSuggestionTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      searchSuggestionRequest = controller;
      try {
        let found;
        if (lampacOrigin()) {
          // As in Lampa: TMDB search over films and series, the most known first.
          const json = await tmdbSearchMulti(query);
          found = tmdbListItems(json).sort((a, b) => b.popularity - a.popularity).slice(0, 6);
        } else {
          const params = new URLSearchParams({ search: query, limit: "6" });
          const response = await apiFetch(`/api/catalog?${params}`, { headers: { accept: "application/json" }, signal: controller.signal });
          if (!response.ok) throw new Error(String(response.status));
          const payload = await response.json();
          found = Array.isArray(payload.items) ? payload.items.slice(0, 6) : [];
        }
        if (controller.signal.aborted || searchDraft.trim() !== query) return;
        searchSuggestionCatalog = found;
        if (document.activeElement === $("#search")) renderSearchSuggestions(query, searchSuggestionCatalog);
      } catch (error) {
        if (error?.name !== "AbortError" && searchDraft.trim() === query && document.activeElement === $("#search")) renderSearchSuggestions(query, [], true);
      }
    }, 220);
  }

  searchDraft = state.query;
  $("#search").addEventListener("input", (event) => {
    searchDraft = event.target.value;
    requestSearchSuggestions();
  });
  $("#search").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      const first = $("#search-suggestions .search-suggestion");
      if (first && !$("#search-suggestions").hidden) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key !== "Enter") return;
    window.clearTimeout(searchSuggestionTimer);
    event.preventDefault();
    runSearch(searchDraft);
  });
  $("[data-search-tab]")?.addEventListener("click", () => $("#search").focus());
  // Without a connection the site keeps working from the saved copy; say so once.
  function updateConnectionNotice() {
    let notice = $("#connection-notice");
    if (navigator.onLine) { notice?.remove(); return; }
    if (notice) return;
    app.insertAdjacentHTML("beforeend", `<div id="connection-notice" class="toast" role="status"><strong>Нет соединения</strong><span>Показываю сохранённое. Сайт обновится сам, когда связь вернётся.</span></div>`);
  }
  window.addEventListener("offline", updateConnectionNotice);
  window.addEventListener("online", updateConnectionNotice);
  updateConnectionNotice();
  $("#search").addEventListener("focus", () => { if (searchDraft.trim().length >= 2) requestSearchSuggestions(); else renderSearchStart(); });
  // Taps inside the window must not take the focus from the field (iPhone gives buttons no focus, so the window
  // would close before the tap lands); the chosen action closes it itself.
  $("#search-suggestions")?.addEventListener("mousedown", (event) => { if (event.target.closest("a, button")) event.preventDefault(); });
  $("#search-suggestions")?.addEventListener("click", (event) => {
    const view = event.target.closest("[data-search-view]");
    const genre = event.target.closest("[data-search-genre]");
    const query = event.target.closest("[data-search-query]");
    const title = event.target.closest("[data-open-title]");
    if (title) { rememberSearchTitle(title.dataset.openTitle); window.setTimeout(() => { hideSearchSuggestions(); $("#search")?.blur(); }, 0); return; }
    if (!view && !genre && !query) return;
    event.preventDefault();
    if (query) { $("#search").value = searchDraft = query.dataset.searchQuery; runSearch(searchDraft); return; }
    hideSearchSuggestions();
    $("#search")?.blur();
    if (view) { navigateToView(view.dataset.searchView); return; }
    state.query = "";
    state.catalogCollection = "";
    state.catalogGenre = genre.dataset.searchGenre;
    resetCatalogPage();
    saveState();
    navigateToView("catalog", { preserveCatalogFilters: true });
  });
  document.addEventListener("click", (event) => { if (event.target.classList?.contains("search-scrim")) hideSearchSuggestions(); });
  $("#search").addEventListener("blur", () => window.setTimeout(() => { if (!$("#search-suggestions")?.contains(document.activeElement)) hideSearchSuggestions(); }, 120));
  $("#search-suggestions")?.addEventListener("keydown", (event) => {
    const links = $$("#search-suggestions .search-suggestion");
    const index = links.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = index + (event.key === "ArrowDown" ? 1 : -1);
      if (next < 0) $("#search").focus(); else links[Math.min(next, links.length - 1)]?.focus();
    } else if (event.key === "Escape") { hideSearchSuggestions(); $("#search").focus(); }
  });
  $("#search-suggestions")?.addEventListener("focusout", () => window.setTimeout(() => { if (!$("#search-suggestions")?.contains(document.activeElement) && document.activeElement !== $("#search")) hideSearchSuggestions(); }, 120));
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search").focus(); hideSearchSuggestions(); }
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.target.closest?.("input, textarea, select, [contenteditable]") && !modalRoot.children.length) { event.preventDefault(); $("#search").focus(); }
    if (event.key === "Escape" && event.target === $("#search")) { hideSearchSuggestions(); $("#search").blur(); return; }
    const video = modalRoot.querySelector("video");
    const target = event.target instanceof Element ? event.target : null;
    const isTextControl = target?.closest("input, textarea, select, [contenteditable=\"true\"]");
    if (video && !isTextControl) {
      const seek = (seconds) => {
        const duration = Number(video.duration || 0);
        const current = Number(video.currentTime || 0);
        const next = Math.max(0, Math.min(duration > 0 ? duration : Number.MAX_SAFE_INTEGER, current + seconds));
        video.currentTime = next;
      };
      // A focused button normally consumes Space and repeats its last action.
      // While a Lumo Film player is open, Space always belongs to playback;
      // form fields and ranges keep their own native keyboard behavior.
      if (event.code === "Space" && !event.repeat && !isTextControl) { event.preventDefault(); toggleVideoPlayback(video); return; }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        seek((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 30 : 10));
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        if (event.key === "ArrowUp" && video.muted) video.muted = false;
        video.volume = Math.max(0, Math.min(1, Number(video.volume || 0) + (event.key === "ArrowUp" ? 0.1 : -0.1)));
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "m") { event.preventDefault(); video.muted = !video.muted; return; }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "f") { event.preventDefault(); requestPlayerFullscreen(video); return; }
      if (event.key === "Home") { event.preventDefault(); seek(-Number(video.currentTime || 0)); return; }
      if (event.key === "End" && Number(video.duration || 0) > 0) { event.preventDefault(); seek(Number(video.duration) - Number(video.currentTime || 0)); return; }
    }
    if (event.key === "Escape") { if (modalRoot.innerHTML) modalRoot.querySelector("button[aria-label=\"Закрыть\"]")?.click(); }
  });
  document.addEventListener("keyup", (event) => {
    // Prevent the browser from turning Space-up into a second click on the
    // button that had focus before playback was toggled.
    if (event.code !== "Space") return;
    const video = modalRoot.querySelector("video");
    const target = event.target instanceof Element ? event.target : null;
    const isTextControl = target?.closest("input, textarea, select, [contenteditable=\"true\"]");
    if (video && !isTextControl) event.preventDefault();
  });

  // Card images fade in once loaded; until then a shimmer placeholder shows.
  document.addEventListener("load", (event) => { if (event.target instanceof HTMLImageElement) event.target.classList.add("is-loaded"); }, true);
  // A picture through our TMDB proxy sometimes fails on a flaky network: ask once more, then
  // straight from TMDB (works where it is not blocked); only then give up and show the title.
  document.addEventListener("error", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const src = image.getAttribute("src") || "";
    const tries = Number(image.dataset.retries || 0);
    const proxied = src.match(/^(?:https?:\/\/[^/]+)?\/tmdb(\/t\/p\/[^?#]+)/);
    if (!proxied && !src.startsWith("https://image.tmdb.org/")) return;
    image.dataset.retries = String(tries + 1);
    if (proxied && tries === 0) {
      window.setTimeout(() => { image.src = `/tmdb${proxied[1]}?retry=1`; }, 1500);
    } else if (proxied && tries === 1) {
      image.src = `https://image.tmdb.org${proxied[1]}`;
    } else {
      image.hidden = true;
      const box = image.parentElement;
      box?.classList.add("image-failed");
      const title = image.closest(".poster-card, [data-title-id], article")?.querySelector("strong")?.textContent || image.alt || "";
      if (box && title && !box.querySelector(".poster-title-art")) box.insertAdjacentHTML("beforeend", `<span class="poster-title-art">${escapeHtml(title)}</span>`);
    }
  }, true);
  // Solid top bar once the page scrolls past the hero's top edge.
  const syncScrolledHeader = () => app.classList.toggle("is-scrolled", window.scrollY > 24);
  window.addEventListener("scroll", syncScrolledHeader, { passive: true });
  syncScrolledHeader();
  setupHeaderNavFit();
  if (window.CineVaultAccounts) window.CineVaultAccounts.onResume = async record => {
    try {
      const item = await ensureCatalogTitle(record.title_id);
      if (!item) throw new Error("Этого фильма больше нет в каталоге.");
      openWatch(item, { season: record.season || null, episode: record.episode || null });
    } catch(error) { window.CineVaultAccounts.home(); window.CineVaultAccounts.error(error.message); }
  };

  renderRoute(initialRoute, { replaceHistory: true });
  const hydrateCatalog = () => {
    const importedCatalog = loadImportedCatalog()
    .then(async () => {
      const route = readRouteFromLocation();
      if (route.type === "title") await ensureCatalogTitle(route.id);
      catalogHydrating = false;
      initialCatalogReady = true;
      const readyRoute = readRouteFromLocation();
      renderRoute(readyRoute, { replaceHistory: true, reuseCatalogPage: readyRoute.type === "view" && initialRoute.type === "view" && readyRoute.view === initialRoute.view });
      // Saved records still naming Kinopoisk cards move to TMDB in the background.
      window.setTimeout(() => { migrateLegacyTitles().then(() => loadSavedTitlesCatalog()).then(() => { if (state.view === "home" && readRouteFromLocation().type !== "title") render(); }).catch(() => {}); }, 1500);
      return loadEpisodeAssets();
    })
    .then(() => {
      return openWatchRoomFromUrl();
    });
    loadLibraryData(false)
      .then(() => render())
      .catch(() => {});
    installNotifications();
    window.setTimeout(takeHandoff, 300);
    Promise.all([importedCatalog, loadCatalogProgress()])
      .then(() => { if (state.view === "home" || state.view === "history") render(); })
      .catch(() => {});
    return importedCatalog;
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(hydrateCatalog, { timeout: 1200 });
  else window.setTimeout(hydrateCatalog, 0);
})();
