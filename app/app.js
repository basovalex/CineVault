(() => {
  "use strict";

  const TMDB_API_BASE = "https://api.themoviedb.org/3";
  const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w780";
  const RUTUBE_SAMPLE_ID = "7716bd3e665725c3c008ae7ab4ff02e2";
  const STORAGE_KEY = "cinevault.state.v1";
  const TMDB_CACHE_KEY = "cinevault.tmdb.cache.v1";
  const tmdbCredential = String(window.CINEVAULT_CONFIG?.tmdbApiKey || "").trim();

  const openMediaCatalog = [
    { id: "sintel-open", kind: "movie", title: "Sintel", originalTitle: "Sintel", year: 2010, description: "Открытый фантастический фильм Blender Foundation о девушке, драконе и обещании, которое нельзя забыть.", tags: ["фантастика", "атмосферно", "на вечер"], runtime: 15, poster: "linear-gradient(145deg, #d88963, #292242)", posterImage: "https://archive.org/services/img/Sintel", providerUrl: "https://archive.org/details/Sintel", providerName: "Archive.org", providerNote: "Открытый фильм Blender Foundation · CC BY 3.0", videoUrl: "https://archive.org/download/Sintel/sintel-2048-stereo_512kb.mp4", licenseUrl: "https://creativecommons.org/licenses/by/3.0/", licenseLabel: "CC BY 3.0" },
    { id: "big-buck-bunny-open", kind: "movie", title: "Большой кролик", originalTitle: "Big Buck Bunny", year: 2008, description: "Добрая короткометражная история Blender Open Movie Project. Можно смотреть прямо в CineVault.", tags: ["комедия", "уютно", "на вечер"], runtime: 10, poster: "linear-gradient(145deg, #72b9df, #6b8b55)", posterImage: "https://archive.org/services/img/big-buck-bunny-640x360_202403", providerUrl: "https://archive.org/details/big-buck-bunny-640x360_202403", providerName: "Archive.org", providerNote: "Открытый фильм · Public Domain Mark 1.0", videoUrl: "https://archive.org/download/big-buck-bunny-640x360_202403/BigBuckBunny%20640x360.mp4", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/", licenseLabel: "Public Domain Mark 1.0" },
    { id: "elephants-dream-open", kind: "movie", title: "Elephants Dream", originalTitle: "Elephants Dream", year: 2006, description: "Первый открытый фильм Blender Foundation: странное путешествие по механическому миру.", tags: ["фантастика", "атмосферно", "напряжённо"], runtime: 11, poster: "linear-gradient(145deg, #b68663, #241d35)", posterImage: "https://archive.org/services/img/elephants-dream_202403", providerUrl: "https://archive.org/details/elephants-dream_202403", providerName: "Archive.org", providerNote: "Открытый фильм · Public Domain Mark 1.0", videoUrl: "https://archive.org/download/elephants-dream_202403/Elephants%20Dream.mp4", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/", licenseLabel: "Public Domain Mark 1.0" },
    { id: "gentlemen-of-fortune-rutube", kind: "movie", title: "Джентльмены удачи", originalTitle: "Джентльмены удачи", year: 1971, description: "Легендарная советская комедия в официальной публикации Киноконцерна «Мосфильм» на RUTUBE.", tags: ["комедия", "уютно", "для нас"], runtime: 88, poster: "linear-gradient(145deg, #c58b54, #4a2630)", providerUrl: "https://rutube.ru/video/8f50ed5a7841ff1418671a3c6b7440d4/", providerName: "RUTUBE · Мосфильм", providerNote: "Официальный канал Киноконцерна «Мосфильм» · встроенный просмотр", rutubeId: "8f50ed5a7841ff1418671a3c6b7440d4" }
  ];

  const seedCatalog = [
    { id: "desperate-housewives", kind: "series", title: "Отчаянные домохозяйки", originalTitle: "Desperate Housewives", year: 2004, description: "Четыре подруги, тайны Вистерия-Лейн и история, к которой хочется возвращаться сериями.", tags: ["драма", "комедия", "уютно"], seasons: [23, 24, 23, 17, 24, 23, 23, 23], runtime: 42, poster: "linear-gradient(145deg, #5a244b, #1e203e)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
    { id: "interstellar", kind: "movie", title: "Интерстеллар", originalTitle: "Interstellar", year: 2014, description: "Большая история о времени, расстоянии и связи, которая оказывается сильнее космоса.", tags: ["фантастика", "атмосферно", "на вечер"], runtime: 169, poster: "linear-gradient(145deg, #182d52, #05070f)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
    { id: "about-time", kind: "movie", title: "Бойфренд из будущего", originalTitle: "About Time", year: 2013, description: "Тёплая романтическая история о выборе, семье и самых обычных счастливых днях.", tags: ["романтика", "уютно", "для нас"], runtime: 123, poster: "linear-gradient(145deg, #e492ad, #6c3556)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
    { id: "the-office", kind: "series", title: "Офис", originalTitle: "The Office", year: 2005, description: "Неловкая, тёплая и очень смешная компания, к которой быстро привыкаешь.", tags: ["комедия", "смеяться", "сериал"], seasons: [6, 22, 25, 19, 28, 26, 25, 24, 25], runtime: 22, poster: "linear-gradient(145deg, #d69a55, #50352f)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
    { id: "little-women", kind: "movie", title: "Маленькие женщины", originalTitle: "Little Women", year: 2019, description: "Красивое, душевное кино о сестрах, взрослении и доме, куда хочется возвращаться.", tags: ["драма", "уютно", "для нас"], runtime: 135, poster: "linear-gradient(145deg, #c48d76, #3e344e)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
    { id: "knives-out", kind: "movie", title: "Достать ножи", originalTitle: "Knives Out", year: 2019, description: "Уютный детектив с яркими персонажами, тайнами и отличным темпом на один вечер.", tags: ["детектив", "на вечер", "напряжённо"], runtime: 130, poster: "linear-gradient(145deg, #7c2f37, #161a2f)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
    { id: "the-holiday", kind: "movie", title: "Отпуск по обмену", originalTitle: "The Holiday", year: 2006, description: "Мягкая романтическая комедия для вечера, когда хочется света, снега и добрых людей.", tags: ["романтика", "смеяться", "уютно"], runtime: 136, poster: "linear-gradient(145deg, #b4d8e8, #6f4778)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
    { id: "arrival", kind: "movie", title: "Прибытие", originalTitle: "Arrival", year: 2016, description: "Спокойная и умная фантастика о языке, времени и попытке понять друг друга.", tags: ["фантастика", "атмосферно", "напряжённо"], runtime: 116, poster: "linear-gradient(145deg, #728aa2, #1d2330)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
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

  const defaultState = { view: "home", theme: "night", companion: "plush", mood: "уютно", query: "", favorites: [], watchlist: [], progress: {}, ratings: {}, history: [], offline: {}, rutubeUrl: "", skipSegments: true };
  let state = loadState();
  if (state.theme === "pink") { state.theme = "graphite"; saveState(); }
  if (state.view === "library") { state.view = "catalog"; saveState(); }
  let catalog = [...seedCatalog, ...openMediaCatalog].map((item) => ({ ...item }));
  let tmdbStatus = tmdbCredential ? "Загружаю постеры и данные TMDB…" : "TMDB-ключ не найден";
  let tmdbSyncStarted = false;
  let selectedSeason = 1;
  let activeTitleId = null;
  let libraryEpisodes = [];
  let libraryHistory = [];
  let libraryStatus = "Проверяю сервер медиатеки…";
  let adminToken = String(sessionStorage.getItem("cinevault.adminToken") || "").trim();

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const app = $("#app");
  const page = $("#page");
  const modalRoot = $("#modal-root");

  function loadState() {
    try { return { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; } catch { return { ...defaultState }; }
  }

  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function loadMetadataCache() { try { return JSON.parse(localStorage.getItem(TMDB_CACHE_KEY) || "{}"); } catch { return {}; } }
  function saveMetadataCache(cache) { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(cache)); }
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
  async function loadLibraryData(shouldRender = false) {
    try {
      const response = await fetch("/api/library", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      libraryEpisodes = (Array.isArray(payload.items) ? payload.items : []).map((item) => ({ ...item, offlineUrl: state.offline?.[item.id] || "" }));
      libraryHistory = (Array.isArray(payload.history) ? payload.history : libraryEpisodes.filter((item) => item.progress)).map((item) => ({ ...item }));
      mergeLibraryIntoCatalog();
      libraryStatus = `Общий backend-каталог: ${libraryEpisodes.length} ${libraryEpisodes.length === 1 ? "серия" : "серий"}.`;
    } catch (error) {
      libraryStatus = "Сервер медиатеки не подключён. Запусти media_library_server.py.";
    }
    if (typeof render === "function") render();
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
        description: first.overview || first.metadata?.overview || existing?.description || "Видео установлено на общем backend.",
        posterImage: first.poster_url || first.metadata?.poster_url || existing?.posterImage || "",
        seasons: metadataSeasons.length ? metadataSeasons : existing?.seasons?.length ? existing.seasons : Array.from({ length: maxSeason }, (_, index) => index === maxSeason - 1 ? maxEpisode : 1),
        tags: [...new Set([...(existing?.tags || []), "медиатека", "для нас"])],
        providerName: "CineVault · сервер",
        providerNote: "Видео хранится на общем backend и доступно пользователям этого сервера.",
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
    const search = await tmdbRequest(searchPath, searchParams);
    const result = (search.results || []).find((entry) => {
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
    const results = await Promise.allSettled(seedCatalog.map(async (item) => {
      const cached = cache[item.id];
      const update = cached || await fetchTmdbDetails(item);
      catalog = catalog.map((entry) => entry.id === item.id ? { ...entry, ...update } : entry);
      cache[item.id] = update;
      synced += 1;
    }));
    saveMetadataCache(cache);
    const failed = results.filter((result) => result.status === "rejected").length;
    tmdbStatus = failed ? `TMDB: загружено ${synced} из ${seedCatalog.length}, остальные оставлены локально` : `TMDB: постеры и данные обновлены (${synced})`;
    if (libraryEpisodes.length) mergeLibraryIntoCatalog();
    render();
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
      const response = await fetch(`/api/hdrezka/search?q=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } });
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
        const response = await fetch(`/api/hdrezka/probe?q=${encodeURIComponent(query)}&index=${button.dataset.hdrezkaProbe}&season=${season}&episode=${episode}`, { headers: { accept: "application/json" } });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        feedback.textContent = payload.has_player ? `Локальный тестовый поток найден${payload.kind === "series" ? ` для S${payload.season}E${payload.episode}` : ""}: ${payload.qualities.join(", ")}. Внешние ссылки не используются.` : "Локальный fixture не найден.";
      } catch (error) {
        feedback.textContent = `Проверка карточки не прошла: ${error.message}`;
      }
    }));
  }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
  function formatTime(seconds) { const total = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
  function formatRuntime(minutes) { return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60 ? `${minutes % 60} мин` : ""}`.trim() : `${minutes} мин`; }
  function posterStyle(item) { return item.posterImage ? `background-image:linear-gradient(180deg, transparent 38%, rgba(0,0,0,.62)),url(${escapeHtml(item.posterImage)});background-size:cover;background-position:center` : `--poster:${item.poster}`; }
  function extractRutubeVideoId(value) { const match = String(value || "").match(/rutube\.ru\/(?:video|play\/embed)\/([a-z0-9]+)(?:[/?#\s"']|$)/i); return match?.[1] || null; }
  function getVideoVariants(item) {
    const configured = Array.isArray(item?.videoSources) ? item.videoSources.filter((source) => source?.url) : [];
    const sources = configured.length ? configured : item?.videoUrl ? [{ id: "default", url: item.videoUrl, type: "video/mp4", quality: "Источник", voice: "Оригинал" }] : [];
    return sources.map((source, index) => ({ id: source.id || `source-${index + 1}`, url: source.url, type: source.type || "video/mp4", quality: source.quality || "Авто", voice: source.voice || "Оригинал" }));
  }
  function playerSelectMarkup(id, label, options, disabled = false) { return `<label class="player-select"><span>${label}</span><select id="${id}"${disabled ? " disabled" : ""}>${options.map((option) => `<option value="${escapeHtml(option.value ?? option)}"${option.selected ? " selected" : ""}>${escapeHtml(option.label ?? option)}</option>`).join("")}</select></label>`; }
  function playerSeriesMarkup(item, episodeNumber = 1) {
    if (item?.kind !== "series" || !item.seasons?.length) return "";
    const seasonOptions = item.seasons.map((_, index) => ({ value: index + 1, label: `Сезон ${index + 1}`, selected: selectedSeason === index + 1 }));
    const episodeCount = item.seasons[selectedSeason - 1] || 1;
    const activeEpisode = Math.min(Number(episodeNumber || 1), episodeCount);
    const episodeOptions = Array.from({ length: episodeCount }, (_, index) => ({ value: index + 1, label: `Серия ${index + 1}`, selected: activeEpisode === index + 1 }));
    return `<div class="player-series-bar">${playerSelectMarkup("player-season", "Сезон", seasonOptions)}${playerSelectMarkup("player-episode", "Серия", episodeOptions)}</div>`;
  }
  function bindPlayerSeriesSelectors(item, episodeNumber) {
    if (item?.kind !== "series") return;
    const reopen = () => { const nextEpisode = Math.min(Number($("#player-episode")?.value || episodeNumber || 1), item.seasons[selectedSeason - 1] || 1); modalRoot.innerHTML = ""; openItemPlayer(item, nextEpisode); };
    $("#player-season")?.addEventListener("change", () => { selectedSeason = Math.max(1, Number($("#player-season").value || 1)); reopen(); });
    $("#player-episode")?.addEventListener("change", reopen);
  }
  function libraryEpisodeFor(item, season = null, episode = null) {
    const localEpisodes = item?.libraryEpisodes || [];
    if (!localEpisodes.length) return null;
    const exact = localEpisodes.find((candidate) => candidate.status === "ready" && (season == null || candidate.season === season) && (episode == null || candidate.episode === episode));
    return exact || localEpisodes.filter((candidate) => candidate.status === "ready").sort((a, b) => Date.parse(b.progress?.updatedAt || "") - Date.parse(a.progress?.updatedAt || "") || Number(b.episode || 0) - Number(a.episode || 0))[0] || null;
  }
  function hasPlayableSource(item) { return Boolean(libraryEpisodeFor(item) || item?.rutubeId || getVideoVariants(item).length); }
  function openItemPlayer(item, episodeNumber = null) {
    if (!item) return;
    const localEpisode = libraryEpisodeFor(item, selectedSeason, episodeNumber);
    if (localEpisode) return openLibraryPlayer(localEpisode);
    if (getVideoVariants(item).length) return openVideoPlayer(item.id, episodeNumber);
    if (item.rutubeId) return openRutubePlayer(item.rutubeId, item.title, item.id);
    openPlayer(item.id, episodeNumber);
  }
  function watchButton(item, label = "Смотреть") {
    if (hasPlayableSource(item)) return `<button class="primary-button" data-play-media="${escapeHtml(item.id)}" type="button">${escapeHtml(label)}</button>`;
    if (!item.providerUrl) return `<button class="secondary-button" type="button" disabled>Источник не подключён</button>`;
    return `<a class="primary-button" href="${escapeHtml(item.providerUrl)}" target="_blank" rel="noopener noreferrer">Смотреть на ${escapeHtml(item.providerName)} ↗</a>`;
  }
  function getTitle(id) { return catalog.find((item) => item.id === id); }
  function getTitleForProgress(id, progress) { return getTitle(progress?.titleId || id) || getTitle(String(id).split("-s")[0]); }
  function progressForTitle(item) {
    const direct = state.progress[item.id];
    if (direct) return { ...direct, contentId: item.id };
    return Object.entries(state.progress).map(([contentId, progress]) => ({ ...progress, contentId })).filter((progress) => progress.titleId === item.id || progress.contentId?.startsWith(`${item.id}-s`)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }
  function hasSharedHistory(item) {
    const historyIds = new Set(libraryHistory.map((entry) => entry.id));
    return state.history.includes(item.id) || Boolean(item.libraryEpisodes?.some((episode) => historyIds.has(episode.id)));
  }
  function getPet() { return ({ plush: ["🐶", "говно", "жирненький уютный мопсик"], noir: ["🐈‍⬛", "Нуар", "спокойный советчик"], pixie: ["🐰", "Пикси", "нежный романтик"], moti: ["🐻", "Моти", "любит комедии"] })[state.companion] || ["🐶", "говно", "жирненький уютный мопсик"]; }
  function petVisual(className = "") { const [emoji, name] = getPet(); return state.companion === "plush" ? `<img class="pet-avatar ${className}" src="./assets/pug-mascot.png" alt="${escapeHtml(name)}">` : `<span class="pet-emoji ${className}" aria-label="${escapeHtml(name)}">${emoji}</span>`; }
  function syncAssistant() { const [, petName, description] = getPet(); $("#header-pet").innerHTML = petVisual("header-pet-visual"); $("#header-pet-name").textContent = petName; $("#assistant-name").textContent = petName; $("#assistant-pet img")?.setAttribute("alt", petName); $("#assistant-copy").textContent = state.companion === "plush" ? "Я рядом. Иногда ем, иногда сплю, но рекомендации держу под контролем." : `${description}. Подберу фильм под ваше настроение.`; $$(".pet-choice").forEach((button) => button.classList.toggle("is-selected", button.dataset.pet === state.companion)); }
  function setPetState(mode = "idle") { const rail = $("#assistant-rail"); const pet = $("#assistant-pet"); if (!rail || !pet) return; rail.classList.remove("is-sleeping", "is-snacking"); pet.classList.remove("is-sleeping", "is-eating", "is-falling", "is-happy"); if (mode === "sleep") { rail.classList.add("is-sleeping"); pet.classList.add("is-sleeping"); } if (mode === "snack") { rail.classList.add("is-snacking"); pet.classList.add("is-eating"); } if (mode === "fall") pet.classList.add("is-falling"); if (mode === "happy") pet.classList.add("is-happy"); }
  function startPetStates() { const modes = ["idle", "snack", "idle", "sleep", "idle", "fall", "happy"]; let index = 0; setPetState(modes[index]); window.setInterval(() => { index = (index + 1) % modes.length; setPetState(modes[index]); }, 5200); }
  function persistAndRender() { saveState(); render(); }

  function recommendation() {
    const liked = catalog.filter((item) => state.favorites.includes(item.id) || hasSharedHistory(item));
    const mood = state.mood;
    return catalog.filter((item) => !hasSharedHistory(item)).map((item) => ({ item, score: (item.tags.includes(mood) ? 4 : 0) + item.tags.filter((tag) => liked.some((likedItem) => likedItem.tags.includes(tag))).length })).sort((a, b) => b.score - a.score)[0]?.item || catalog[0];
  }

  function poster(item, extra = "") {
    const progress = progressForTitle(item);
    const progressPct = progress ? Math.min(100, Math.round((progress.position / progress.duration) * 100)) : 0;
    const meta = [item.year, item.rating ? `TMDB ${item.rating.toFixed(1)}` : "", item.kind === "series" ? `${item.seasons.length} сезонов` : formatRuntime(item.runtime)].filter(Boolean);
    return `<button class="poster-card ${extra}" data-open-title="${item.id}" type="button" aria-label="Открыть ${escapeHtml(item.title)}"><div class="poster-art" style="${posterStyle(item)}"><span class="provider-chip">${escapeHtml(item.providerName)}${hasPlayableSource(item) ? " ▶" : " ↗"}</span><span class="poster-title-art">${escapeHtml(item.title)}</span>${progress ? `<span class="progress-bar" style="--progress:${progressPct}%"><i></i></span>` : ""}</div><div class="poster-card-copy"><strong>${escapeHtml(item.title)}</strong><div class="poster-card-meta">${meta.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div><p class="poster-card-description">${escapeHtml(item.description || "Подробности появятся после синхронизации каталога.")}</p><div class="poster-card-tags">${item.tags.slice(0, 3).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</div></div></button>`;
  }

  function resumePoster(item, progress) {
    const progressPct = Math.min(100, Math.round((progress.position / progress.duration) * 100));
    const episodeText = progress.episodeNumber ? ` · S${String(progress.seasonNumber).padStart(2, "0")}E${String(progress.episodeNumber).padStart(2, "0")}` : "";
    const playbackAttr = hasPlayableSource(item) ? `data-play-media="${item.id}"` : `data-demo-play="${item.id}"`;
    return `<button class="poster-card" ${playbackAttr} ${progress.episodeNumber ? `data-episode="${progress.episodeNumber}"` : ""} type="button"><div class="poster-art" style="${posterStyle(item)}"><span class="provider-chip">${escapeHtml(item.providerName)}${hasPlayableSource(item) ? " ▶" : " ↗"}</span><span class="poster-title-art">${escapeHtml(item.title)}</span><span class="progress-bar" style="--progress:${progressPct}%"><i></i></span></div><strong>${escapeHtml(item.title)}</strong><small>${item.kind === "series" ? `${item.seasons.length} сезонов${episodeText}` : `${item.year} · ${formatTime(progress.position)} из ${formatTime(progress.duration)}`}</small></button>`;
  }

  function render() {
    activeTitleId = null;
    app.dataset.theme = state.theme;
    syncAssistant();
    $("#search").value = state.query;
    $$(".nav-item[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === state.view));
    if (state.view === "home") renderHome();
    else if (["catalog", "movies", "series", "favorites", "evening", "history"].includes(state.view)) renderCatalogView();
    else if (state.view === "library") renderLibraryView();
    else if (state.view === "settings") renderSettings();
    page.focus({ preventScroll: true });
  }

  function renderHome() {
    const [, petName, petDescription] = getPet();
    const petEmoji = petVisual();
    const pick = recommendation();
    const pickWatch = hasPlayableSource(pick) ? watchButton(pick, "Смотреть в CineVault") : watchButton(pick, "Смотреть официально");
    const pickLocalTest = hasPlayableSource(pick) ? "" : `<button class="secondary-button" data-demo-play="${pick.id}" type="button">Проверить локальный прогресс</button>`;
    const continueItems = Object.entries(state.progress).map(([contentId, progress]) => ({ item: getTitleForProgress(contentId, progress), progress: { ...progress, contentId } })).filter((entry) => entry.item && !entry.progress.completed).sort((a, b) => b.progress.updatedAt - a.progress.updatedAt);
    page.innerHTML = `<section class="home-hero"><div class="hero-card"><div class="eyebrow">${escapeHtml(petName)} советует</div><h1>Что-то ${escapeHtml(state.mood)} на сегодняшний вечер</h1><p>${escapeHtml(pick.description)}</p><div class="hero-actions">${pickWatch}${pickLocalTest}<button class="secondary-button" data-open-title="${pick.id}" type="button">Открыть карточку</button></div></div><div class="companion-card"><div class="pet-art" aria-label="${escapeHtml(petName)}">${petEmoji}</div><div><h2>${escapeHtml(petName)} рядом</h2><p>${escapeHtml(petDescription)}. Я смотрю на твой выбор и предлагаю варианты, а не придумываю их из воздуха.</p></div><div class="mood-row" role="group" aria-label="Настроение">${["уютно", "романтично", "смеяться", "напряжённо"].map((mood) => `<button class="mood-button ${state.mood === mood ? "is-active" : ""}" data-mood="${mood}" type="button">${mood}</button>`).join("")}</div></div></section>${continueItems.length ? `<section class="section"><div class="section-header"><h2>Продолжить просмотр</h2><button class="text-button" data-view="history" type="button">История</button></div><div class="poster-grid">${continueItems.slice(0, 5).map(({ item, progress }) => resumePoster(item, progress)).join("")}</div></section>` : `<section class="section"><div class="empty-state"><div class="empty-pet">${petEmoji}</div><h2>Пока ничего не прервано</h2><p>Здесь запускаются только подключённые разрешённые источники. Для остальных карточек источник пока не добавлен.</p>${watchButton(pick, "Открыть просмотр")}</div></section>`}<section class="section"><div class="section-header"><h2>Подборка для нас</h2><button class="text-button" data-view="catalog" type="button">Весь каталог</button></div><div class="poster-grid">${catalog.filter((item) => item.tags.includes("для нас") || item.tags.includes(state.mood)).slice(0, 5).map((item) => poster(item)).join("")}</div></section>`;
    bindPageActions();
  }

  function filteredCatalog() {
    const query = state.query.trim().toLowerCase();
    return catalog.filter((item) => {
      const viewOkay = state.view === "movies" ? item.kind === "movie" : state.view === "series" ? item.kind === "series" : state.view === "favorites" ? state.favorites.includes(item.id) : state.view === "evening" ? state.watchlist.includes(item.id) : state.view === "history" ? hasSharedHistory(item) : true;
      const queryOkay = !query || `${item.title} ${item.originalTitle} ${item.tags.join(" ")}`.toLowerCase().includes(query);
      return viewOkay && queryOkay;
    });
  }

  function renderCatalogView() {
    const items = filteredCatalog();
    const title = state.view === "favorites" ? "Избранное" : state.view === "evening" ? "Наш вечер" : state.view === "history" ? "История просмотра" : state.view === "movies" ? "Фильмы" : state.view === "series" ? "Сериалы" : state.query ? `Результаты для «${escapeHtml(state.query)}»` : "Каталог";
    const subtitle = state.view === "evening" ? "То, что хочется посмотреть вместе." : state.view === "history" ? "То, к чему можно вернуться в любой момент." : "Обложки, описания и спокойный выбор без бесконечного скролла.";
    page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">CineVault</div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div><div class="catalog-toolbar"><button class="filter-button ${state.view === "catalog" ? "is-active" : ""}" data-view="catalog" type="button">Всё</button><button class="filter-button ${state.view === "movies" ? "is-active" : ""}" data-view="movies" type="button">Фильмы</button><button class="filter-button ${state.view === "series" ? "is-active" : ""}" data-view="series" type="button">Сериалы</button><button class="filter-button" data-mood-filter="${state.mood}" type="button">Настроение: ${state.mood}</button></div>${items.length ? `<div class="poster-grid">${items.map((item) => poster(item)).join("")}</div>` : `<div class="empty-state"><div class="empty-pet">${petVisual()}</div><h2>Здесь пока пусто</h2><p>Добавь что-нибудь в избранное или в «Наш вечер», и раздел наполнится.</p><button class="primary-button" data-view="catalog" type="button">Открыть каталог</button></div>`}`;
    bindPageActions();
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
    return `<article class="library-episode"><div class="library-episode-art"><span>▶</span><small>${seriesLabel}</small><i style="--progress:${progressPct}%"></i></div><div class="library-episode-copy"><div class="eyebrow">${escapeHtml(item.title)}</div><h3>${escapeHtml(item.episode_title)}</h3><p class="muted small">${seriesLabel} · ${escapeHtml(libraryStatusLabel(item))}${progress && !progress.completed ? ` · продолжить с ${formatTime(position)}` : ""}</p><div class="library-episode-actions">${item.status === "ready" ? `<button class="primary-button" data-library-play="${item.id}" type="button">${progress && !progress.completed ? "Продолжить" : "Смотреть"}</button><button class="secondary-button" data-library-offline="${item.id}" type="button">Скачать максимум</button><button class="secondary-button" data-library-room="${item.id}" type="button">Совместный просмотр</button>` : `<button class="secondary-button" data-library-refresh type="button">Обновить статус</button>`}</div></div></article>`;
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
      const response = await fetch(`/api/catalog/search?q=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}`, { headers: { accept: "application/json" } });
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
      const response = await fetch(`/api/catalog/title/${encodeURIComponent(provider)}/${encodeURIComponent(kind)}/${encodeURIComponent(externalId)}`, { headers: { accept: "application/json" } });
      const metadata = await response.json();
      if (!response.ok) throw new Error(metadata.error || `HTTP ${response.status}`);
      const titleInput = $("#library-upload-form [name=title]");
      const metadataInput = $("#library-metadata");
      if (titleInput) titleInput.value = metadata.title || "";
      if (metadataInput) metadataInput.value = JSON.stringify(metadata);
      feedback.textContent = `Выбрано: ${metadata.title}. Теперь укажи сезон/серию и файл, либо запусти массовый импорт папки на backend.`;
    } catch (error) { feedback.textContent = `Карточку не удалось загрузить: ${error.message}`; }
  }

  function renderLibraryView() {
    page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Shared backend library</div><h1>Общий каталог</h1><p class="muted">Фильмы и серии устанавливаются один раз на backend. Все пользователи смотрят общий HLS-поток, а текущий MVP сохраняет продолжение в браузере.</p></div><span class="library-status">${escapeHtml(libraryStatus)}</span></div>${catalogSearchMarkup()}<section class="library-upload-card"><div><h2>Админский импорт</h2><p class="muted small">Для всего сезона можно выбрать папку целиком. Система сама разберёт <code>S01E01</code> или <code>Season 01/01.mp4</code>; обычным пользователям импорт не нужен.</p></div><form id="library-upload-form" class="library-upload-form"><input id="library-metadata" name="metadata" type="hidden" value="{}"><label>Админский ключ<input id="library-admin-token" type="password" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><label>Название тайтла<input name="title" required maxlength="200" placeholder="Выбери карточку выше"></label><div class="library-upload-row"><label>Сезон<input name="season" type="number" min="0" value="1"></label><label>Серия<input name="episode" type="number" min="0" value="1"></label><label class="library-upload-wide">Название серии<input name="episode_title" maxlength="200" placeholder="Для одного файла"></label></div><label>Файлы или папка сезона<input name="file" type="file" required multiple webkitdirectory directory accept="video/*,.mkv,.avi"></label><button class="primary-button" type="submit">Импортировать выбранные серии</button><p id="library-upload-feedback" class="muted small" aria-live="polite"></p></form></section>${libraryEpisodes.length ? `<section class="section library-section"><div class="section-header"><h2>Фильмы и серии на сервере</h2><button class="text-button" data-library-refresh type="button">Обновить</button></div><div class="library-episodes">${libraryEpisodes.map(libraryEpisodeMarkup).join("")}</div></section>` : `<section class="section"><div class="empty-state"><div class="empty-pet">📚</div><h2>Общий каталог пока пуст</h2><p>Добавь первый разрешённый файл на backend. После транскодирования он станет доступен всем пользователям этого сервера.</p></div></section>`}<section class="notice library-notice"><strong>Как это работает.</strong> Исходник и HLS лежат на backend. Пользователи не копируют фильм к себе: Safari использует native HLS, Chrome/Windows — Hls.js, качество выбирается автоматически. Офлайн скачивается только явно выбранная серия.</section>`;
    $("#library-admin-token").value = adminToken;
    bindPageActions();
  }

  function renderSettings() {
    const [, petName] = getPet();
    const petEmoji = petVisual("settings-pet-visual");
    page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Настройки</div><h1>Под себя и для нас</h1><p class="muted">Всё важное хранится на общем backend-сервере.</p></div></div><div class="settings-grid"><section class="settings-card"><h3>Оформление</h3><p>Графитовая тема теперь собрана на серых и угольных поверхностях: спокойный контраст, серебристые акценты и аккуратные фоновые детали. Тёмная тема остаётся полностью спокойной, без бабочек и облачков.</p><div class="setting-actions"><button class="filter-button ${state.theme === "night" ? "is-active" : ""}" data-set-theme="night" type="button">Тёмная без декора</button><button class="filter-button ${state.theme === "graphite" ? "is-active" : ""}" data-set-theme="graphite" type="button">Серый + графит</button></div></section><section class="settings-card"><h3>Питомец</h3><p class="settings-pet-preview">${petEmoji} ${escapeHtml(petName)} сейчас отвечает за подсказки и настроение рекомендаций.</p><button class="primary-button" id="settings-pet" type="button">Выбрать питомца</button></section><section class="settings-card"><h3>TMDB-каталог</h3><p>${escapeHtml(tmdbStatus)}</p><small class="muted">TMDB добавляет реальные постеры, описания, рейтинги, сезоны и трейлеры. Ключ хранится только локально.</small><p class="attribution">This product uses the TMDB API but is not endorsed or certified by TMDB.</p></section><section class="settings-card"><h3>RUTUBE-плеер</h3><p>Вставь ссылку на разрешённое видео RUTUBE, чтобы открыть его встроенным плеером и сохранять позицию просмотра.</p><div class="provider-input"><input id="rutube-url" type="url" value="${escapeHtml(state.rutubeUrl || "")}" placeholder="https://rutube.ru/video/..." autocomplete="off"><button class="primary-button" id="rutube-open" type="button">Открыть</button></div><button class="secondary-button" id="rutube-test" type="button">Проверить тестовый плеер</button><p id="rutube-feedback" class="muted small" aria-live="polite"></p></section><section class="settings-card"><h3>Продолжение просмотра</h3><p>Прогресс и история серий сохраняются на общем backend и видны всем пользователям. Плееры продолжают с последней сохранённой позиции.</p><button class="secondary-button" data-clear-progress type="button">Очистить локальный кэш прогресса</button></section><section class="settings-card"><h3>Видеоисточники</h3><p>В каталоге остаются только подключённые разрешённые источники: открытые фильмы и официальный RUTUBE. Остальные карточки используются для метаданных и рекомендаций без кнопок внешнего просмотра.</p><small class="muted">Новый источник можно добавить только при наличии права на встраивание или прямого разрешённого потока.</small></section></div>`;
    $(".settings-grid")?.insertAdjacentHTML("beforeend", `<section class="settings-card settings-card-wide"><h3>Демо: LegalDemoProvider</h3><p>Оффлайн-адаптер для проверки каталога, сезонов, серий и выбора перевода. Он читает только локальные fixtures и не обращается к сайтам, proxy или cookies.</p><div class="provider-input"><input id="hdrezka-query" type="search" value="Тестовый сериал" placeholder="Например, Тестовый сериал" autocomplete="off"><button class="secondary-button" id="hdrezka-search" type="button">Искать</button></div><div class="provider-input hdrezka-episode-inputs"><label>Сезон <input id="hdrezka-season" type="number" min="1" value="1"></label><label>Серия <input id="hdrezka-episode" type="number" min="1" value="1"></label></div><p id="hdrezka-feedback" class="muted small" aria-live="polite"></p><div id="hdrezka-results"></div></section>`);
    bindPageActions();
    $("#settings-pet")?.addEventListener("click", openCompanion);
  }

  function renderDetails(id) {
    const item = getTitle(id);
    if (!item) return;
    activeTitleId = id;
    const progress = progressForTitle(item);
    const favorite = state.favorites.includes(item.id);
    const watchlist = state.watchlist.includes(item.id);
    const resumeEpisode = progress?.episodeNumber || null;
    const detailWatch = hasPlayableSource(item) ? watchButton(item, progress && !progress.completed ? "Продолжить просмотр" : "Смотреть в CineVault") : watchButton(item, "Смотреть официально");
    const detailLocalTest = hasPlayableSource(item) ? "" : `<button class="secondary-button" data-demo-play="${item.id}" ${resumeEpisode ? `data-episode="${resumeEpisode}"` : ""} type="button">${progress && !progress.completed ? `Проверить локальный прогресс с ${formatTime(progress.position)}` : "Проверить локальный прогресс"}</button>`;
    const sourceTitle = item.licenseLabel ? `${item.providerName} · ${item.licenseLabel}` : `Официальный источник: ${item.providerName}`;
    const sourceLink = item.libraryEpisodes?.length ? `<span class="muted small">Установлено на сервере</span>` : item.providerUrl ? `<a class="secondary-button" href="${escapeHtml(item.providerUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник ↗</a>` : `<span class="muted small">Источник не подключён</span>`;
    page.innerHTML = `<div class="page-heading"><button class="text-button" data-view="catalog" type="button">← Назад к каталогу</button></div><section class="detail-header"><div class="detail-poster" style="${posterStyle(item)}"><span class="poster-title-art">${escapeHtml(item.title)}</span></div><div class="detail-content"><div class="eyebrow">${item.kind === "series" ? "Сериал" : "Фильм"}</div><h1>${escapeHtml(item.title)}</h1><div class="detail-meta"><span class="badge">${item.year}</span><span class="badge">${item.kind === "series" ? `${item.seasons.length} сезонов` : formatRuntime(item.runtime)}</span>${item.rating ? `<span class="badge">TMDB ${item.rating.toFixed(1)}</span>` : ""}${item.tags.map((tag) => `<span class="badge">${tag}</span>`).join("")}</div><p>${escapeHtml(item.description)}</p><div class="hero-actions">${detailWatch}${item.trailerUrl ? `<a class="secondary-button" href="${item.trailerUrl}" target="_blank" rel="noopener noreferrer">Трейлер ↗</a>` : ""}${detailLocalTest}<button class="secondary-button" data-favorite="${item.id}" type="button">${favorite ? "♥ В избранном" : "♡ В избранное"}</button><button class="secondary-button" data-watchlist="${item.id}" type="button">${watchlist ? "✓ В нашем вечере" : "Добавить в наш вечер"}</button></div><div class="provider-list"><div class="provider-row"><div><strong>${escapeHtml(sourceTitle)}</strong><small>${escapeHtml(item.providerNote)}${item.licenseUrl ? ` · <a href="${escapeHtml(item.licenseUrl)}" target="_blank" rel="noopener noreferrer">условия лицензии ↗</a>` : ""}</small></div>${sourceLink}</div></div></div></section>${item.kind === "series" ? renderSeasons(item) : ""}`;
    bindPageActions();
  }

  function renderSeasons(item) {
    const seasonCount = item.seasons.length;
    const episodes = item.seasons[selectedSeason - 1] || 0;
    const demoEpisodes = Array.from({ length: episodes }, (_, index) => index + 1);
    const sourceAction = item.providerUrl ? `<a class="secondary-button season-provider-link" href="${escapeHtml(item.providerUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник ↗</a>` : item.libraryEpisodes?.length ? `<span class="muted small">Локальные файлы на сервере</span>` : `<span class="muted small">Источник не подключён</span>`;
    return `<section class="section"><div class="section-header"><div><h2>Сезоны и серии</h2><span>${seasonCount} сезонов · ${item.seasons.reduce((sum, count) => sum + count, 0)} серий</span></div>${sourceAction}</div><div class="season-tabs">${item.seasons.map((_, index) => `<button class="filter-button ${selectedSeason === index + 1 ? "is-active" : ""}" data-season="${index + 1}" type="button">Сезон ${index + 1}</button>`).join("")}</div><div class="episode-list">${demoEpisodes.map((episode) => { const episodeId = `${item.id}-s${selectedSeason}e${episode}`; const progress = state.progress[episodeId]; const localEpisode = item.libraryEpisodes?.find((candidate) => candidate.season === selectedSeason && candidate.episode === episode); const episodeProgress = localEpisode?.progress || progress; const episodePlayable = localEpisode ? localEpisode.status === "ready" : !item.libraryEpisodes?.length && hasPlayableSource(item); const episodeButton = episodePlayable ? `<button class="secondary-button" data-play-media="${item.id}" data-episode="${episode}" type="button">${episodeProgress && !episodeProgress.completed ? "Продолжить" : "Смотреть"}</button>` : `<button class="secondary-button" type="button" disabled>${item.libraryEpisodes?.length ? "Файл не установлен" : "Нет источника"}</button>`; return `<div class="episode-row"><div class="episode-number">${String(episode).padStart(2, "0")}</div><div><strong>${episode === 1 ? "Пилотная серия" : `Серия ${episode}`}</strong><small>${episodeProgress && !episodeProgress.completed ? `Остановились на ${formatTime(episodeProgress.position)} из ${formatTime(episodeProgress.duration)}` : episodePlayable ? "Разрешённый видеопоток" : item.libraryEpisodes?.length ? "Серия появится после установки файла" : "Для просмотра нужен разрешённый видеопоток"}</small></div>${episodeButton}</div>`; }).join("")}</div>${episodes > demoEpisodes.length ? `<p class="muted small" style="margin-top:12px">Остальные серии будут загружаться из metadata provider после подключения разрешённого источника.</p>` : ""}</section>`;
  }

  function openRutubePlayer(videoId, title = "RUTUBE-видео", contentId = `rutube-${videoId}`) {
    const existing = state.progress[contentId] || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let lastSavedAt = 0;
    const embedUrl = `https://rutube.ru/play/embed/${encodeURIComponent(videoId)}?skinColor=f078b4&getPlayOptions=duration,title`;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="rutube-player-title"><div class="modal-head"><div><div class="eyebrow">RUTUBE · встроенный плеер</div><h2 id="rutube-player-title">${escapeHtml(title)}</h2></div><button class="icon-button" id="rutube-close" type="button" aria-label="Закрыть">×</button></div><div class="provider-frame"><iframe id="rutube-frame" title="${escapeHtml(title)}" src="${embedUrl}" allow="clipboard-write; autoplay" allowfullscreen></iframe></div><div class="player-meta-strip"><span><small>Качество</small><strong>Выбирается в RUTUBE</strong></span><span><small>Озвучка</small><strong>Выбирается в RUTUBE</strong></span><span><small>Источник</small><strong>Официальная публикация</strong></span></div><div class="provider-progress"><input id="rutube-range" type="range" min="0" max="${duration || 1}" value="${position}" aria-label="Позиция просмотра"><span><span id="rutube-position">${formatTime(position)}</span> / <span id="rutube-duration">${formatTime(duration)}</span></span></div><div id="rutube-status" class="notice"><strong>Загрузка плеера…</strong> Позиция сохраняется локально на этом MacBook.</div></section></div>`;
    const frame = $("#rutube-frame");
    const range = $("#rutube-range");
    const positionLabel = $("#rutube-position");
    const durationLabel = $("#rutube-duration");
    const status = $("#rutube-status");
    const saveProgress = (completed = false) => { state.progress[contentId] = { titleId: contentId, providerId: `rutube:${videoId}`, seasonNumber: null, episodeNumber: null, position, duration, completed, updatedAt: Date.now() }; const linkedTitle = getTitle(contentId); if (linkedTitle && !state.history.includes(linkedTitle.id)) state.history.unshift(linkedTitle.id); saveState(); };
    const send = (message) => frame?.contentWindow?.postMessage(JSON.stringify(message), "https://rutube.ru");
    const handleMessage = (event) => {
      if (event.origin !== "https://rutube.ru") return;
      let message;
      try { message = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
      if (!message?.type) return;
      if (message.type === "player:ready") { status.innerHTML = `<strong>Плеер готов.</strong> Продолжение восстановится автоматически.`; if (position > 0) send({ type: "player:setCurrentTime", data: { time: position } }); }
      if (message.type === "player:durationChange" && Number(message.data?.duration) > 0) { duration = Number(message.data.duration); range.max = duration; durationLabel.textContent = formatTime(duration); }
      if (message.type === "player:currentTime") { position = Math.max(0, Number(message.data?.time || 0)); range.value = Math.min(position, duration || position); positionLabel.textContent = formatTime(position); if (Date.now() - lastSavedAt > 3000) { saveProgress(false); lastSavedAt = Date.now(); } }
      if (message.type === "player:playComplete") { position = duration || position; saveProgress(true); status.innerHTML = `<strong>Просмотр завершён.</strong> Прогресс сохранён.`; }
      if (message.type === "player:error") status.innerHTML = `<strong>RUTUBE не запустил видео.</strong> Проверьте, что оно открыто для просмотра и встраивания.`;
    };
    window.addEventListener("message", handleMessage);
    range.addEventListener("input", () => { position = Number(range.value); positionLabel.textContent = formatTime(position); send({ type: "player:setCurrentTime", data: { time: position } }); saveProgress(false); });
    const close = () => { saveProgress(false); window.removeEventListener("message", handleMessage); modalRoot.innerHTML = ""; render(); };
    $("#rutube-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  function openVideoPlayer(id, episodeNumber = null) {
    const item = getTitle(id);
    const variants = getVideoVariants(item);
    if (!variants.length) return openPlayer(id, episodeNumber);
    const contentId = episodeNumber ? `${id}-s${selectedSeason}e${episodeNumber}` : id;
    const existing = state.progress[contentId] || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let lastSavedAt = 0;
    let activeVariant = variants[0];
    const qualityOptions = [...new Set(variants.map((variant) => variant.quality))];
    const voiceOptions = [...new Set(variants.map((variant) => variant.voice))];
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="video-player-title"><div class="modal-head"><div><div class="eyebrow">CineVault · разрешённый источник</div><h2 id="video-player-title">${escapeHtml(item.title)}${episodeNumber ? ` · S${String(selectedSeason).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}` : ""}</h2></div><button class="icon-button" id="video-close" type="button" aria-label="Закрыть">×</button></div>${playerSeriesMarkup(item, episodeNumber)}<div class="provider-frame video-frame"><video id="cinevault-video" controls playsinline preload="metadata"${item.posterImage ? ` poster="${escapeHtml(item.posterImage)}"` : ""}></video><div class="video-loading" id="video-loading" hidden>Подключаю источник…</div></div><div class="player-toolbar"><div class="player-actions"><button class="icon-button" id="video-back" type="button" aria-label="Назад на 10 секунд">↶ 10</button><button class="primary-button" id="video-play" type="button">▶ Воспроизвести</button><button class="icon-button" id="video-forward" type="button" aria-label="Вперёд на 10 секунд">10 ↷</button></div><div class="player-selects">${playerSelectMarkup("video-quality", "Качество", qualityOptions.map((option) => ({ value: option, label: option, selected: option === variants[0].quality })), qualityOptions.length <= 1)}${playerSelectMarkup("video-voice", "Озвучка", voiceOptions.map((option) => ({ value: option, label: option, selected: option === variants[0].voice })), voiceOptions.length <= 1)}<button class="secondary-button" id="video-fullscreen" type="button">⛶ Полный экран</button></div></div><div class="provider-progress"><input id="video-range" type="range" min="0" max="${duration || 1}" value="${position}" aria-label="Позиция просмотра"><span><span id="video-position">${formatTime(position)}</span> / <span id="video-duration">${formatTime(duration)}</span></span></div><div id="video-status" class="notice"><strong>Готово к просмотру.</strong> Позиция сохраняется локально на этом MacBook.</div><p class="attribution">${escapeHtml(item.providerNote)} · <a href="${escapeHtml(item.licenseUrl || item.providerUrl)}" target="_blank" rel="noopener noreferrer">Источник и лицензия ↗</a></p></section></div>`;
    const video = $("#cinevault-video");
    const range = $("#video-range");
    const positionLabel = $("#video-position");
    const durationLabel = $("#video-duration");
    const status = $("#video-status");
    const loading = $("#video-loading");
    const qualitySelect = $("#video-quality");
    const voiceSelect = $("#video-voice");
    const playButton = $("#video-play");
    const saveProgress = (completed = false) => { state.progress[contentId] = { titleId: id, providerId: `html5:${item.providerName}:${activeVariant.voice}`, seasonNumber: episodeNumber ? selectedSeason : null, episodeNumber: episodeNumber || null, position, duration, completed, updatedAt: Date.now() }; if (!state.history.includes(id)) state.history.unshift(id); saveState(); };
    const findVariant = () => variants.find((variant) => variant.quality === qualitySelect.value && variant.voice === voiceSelect.value) || variants.find((variant) => variant.quality === qualitySelect.value) || variants.find((variant) => variant.voice === voiceSelect.value) || variants[0];
    let pendingPlay = false;
    const setVariant = (variant, autoplay = false) => { activeVariant = variant; position = Number(video.currentTime || position || 0); saveProgress(false); pendingPlay = autoplay; loading.hidden = false; video.src = variant.url; video.type = variant.type; video.load(); qualitySelect.value = variant.quality; voiceSelect.value = variant.voice; status.innerHTML = `<strong>${escapeHtml(variant.quality)} · ${escapeHtml(variant.voice)}.</strong> Источник переключён без сброса позиции.`; };
    const onLoadedMetadata = () => { loading.hidden = true; duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); durationLabel.textContent = formatTime(duration); if (position > 0 && position < duration) { video.currentTime = position; status.innerHTML = `<strong>Продолжение восстановлено.</strong> Вы остановились на ${formatTime(position)}.`; } if (pendingPlay) { video.play().catch(() => { status.innerHTML = `<strong>Нажмите «Воспроизвести».</strong> Браузер заблокировал автозапуск.`; }); pendingPlay = false; } };
    const onTimeUpdate = () => { position = Number(video.currentTime || 0); duration = Number(video.duration || duration); range.value = Math.min(position, duration || position); positionLabel.textContent = formatTime(position); if (Date.now() - lastSavedAt > 3000) { saveProgress(false); lastSavedAt = Date.now(); } };
    const onEnded = () => { position = duration || Number(video.currentTime || 0); saveProgress(true); status.innerHTML = `<strong>Просмотр завершён.</strong> Прогресс сохранён.`; };
    const onError = () => { status.innerHTML = `<strong>Источник не ответил.</strong> Откройте карточку источника или выберите другой разрешённый файл.`; };
    const onPlay = () => { playButton.textContent = "Ⅱ Пауза"; };
    const onPause = () => { playButton.textContent = "▶ Воспроизвести"; saveProgress(false); };
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    range.addEventListener("input", () => { position = Number(range.value); if (video.duration) video.currentTime = position; positionLabel.textContent = formatTime(position); saveProgress(false); });
    playButton.addEventListener("click", () => video.paused ? video.play().catch(() => {}) : video.pause());
    $("#video-back").addEventListener("click", () => { video.currentTime = Math.max(0, video.currentTime - 10); });
    $("#video-forward").addEventListener("click", () => { video.currentTime = Math.min(video.duration || duration, video.currentTime + 10); });
    qualitySelect.addEventListener("change", () => setVariant(findVariant(), !video.paused));
    voiceSelect.addEventListener("change", () => setVariant(findVariant(), !video.paused));
    $("#video-fullscreen").addEventListener("click", () => { video.requestFullscreen?.(); });
    bindPlayerSeriesSelectors(item, episodeNumber);
    const close = () => { saveProgress(false); video.pause(); video.removeEventListener("loadedmetadata", onLoadedMetadata); video.removeEventListener("timeupdate", onTimeUpdate); video.removeEventListener("ended", onEnded); video.removeEventListener("error", onError); video.removeEventListener("play", onPlay); video.removeEventListener("pause", onPause); modalRoot.innerHTML = ""; if (activeTitleId) renderDetails(activeTitleId); else render(); };
    $("#video-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
    setVariant(activeVariant);
  }

  function openPlayer(id, episodeNumber = null) {
    const item = getTitle(id);
    const contentId = episodeNumber ? `${id}-s${selectedSeason}e${episodeNumber}` : id;
    const existing = state.progress[contentId];
    const duration = existing?.duration || (episodeNumber ? item.runtime * 60 : item.runtime * 60);
    let position = existing?.position || 0;
    let playing = false;
    let timer;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="player-title"><div class="modal-head"><div><div class="eyebrow">CineVault · источник не подключён</div><h2 id="player-title">${escapeHtml(item.title)}${episodeNumber ? ` · S${String(selectedSeason).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}` : ""}</h2></div><button class="icon-button" id="player-close" type="button" aria-label="Закрыть">×</button></div>${playerSeriesMarkup(item, episodeNumber)}<div class="player-stage player-stage-empty" style="--player:${item.poster}"><div class="player-center"><div class="player-pet">${petVisual()}</div><strong>Видеоисточник ещё не подключён</strong><span>Эта карточка готова к разрешённому MP4/HLS-потоку</span></div></div><div class="player-toolbar is-disabled"><div class="player-actions"><button class="primary-button" type="button" disabled>▶ Воспроизвести</button><button class="secondary-button" type="button" disabled>⛶ Полный экран</button></div><div class="player-selects">${playerSelectMarkup("unavailable-quality", "Качество", ["Недоступно"], true)}${playerSelectMarkup("unavailable-voice", "Озвучка", ["Недоступно"], true)}</div></div><div class="notice"><strong>Для ${escapeHtml(item.title)} пока нет разрешённого видеопотока.</strong> Когда появится лицензированный MP4/HLS-источник, этот же плеер сможет показывать качество, озвучку, прогресс и полноэкранный режим.</div></section></div>`;
    bindPlayerSeriesSelectors(item, episodeNumber);
    $("#player-close").addEventListener("click", () => { modalRoot.innerHTML = ""; if (activeTitleId) renderDetails(activeTitleId); else render(); });
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) $("#player-close").click(); });
  }

  async function openLibraryPlayer(item) {
    const existing = item.progress || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let lastSaved = 0;
    let hls = null;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="library-player-title"><div class="modal-head"><div><div class="eyebrow">CineVault · каталог</div><h2 id="library-player-title">${escapeHtml(item.title)} · ${escapeHtml(item.episode_title)}</h2></div><button class="icon-button" id="player-close" type="button" aria-label="Закрыть">×</button></div><div class="provider-frame video-frame"><video id="library-video" playsinline preload="metadata"${item.poster_url ? ` poster="${escapeHtml(item.poster_url)}"` : ""}></video><div class="video-loading" id="library-video-loading">Загружаю адаптивный поток…</div></div><div class="player-toolbar"><div class="player-actions"><button class="secondary-button" id="library-back" type="button" aria-label="Назад на 10 секунд">↶ 10 сек</button><button class="primary-button" id="library-play" type="button" aria-label="Воспроизвести">▶</button><button class="secondary-button" id="library-forward" type="button" aria-label="Вперёд на 10 секунд">10 сек ↷</button><button class="secondary-button" id="library-fullscreen" type="button" aria-label="Полный экран">⛶</button><button class="secondary-button" id="library-room" type="button">Создать комнату</button></div><span class="muted small">Кнопки и шкала перемотки · авто до 720p</span></div><div class="library-seekbar"><input id="library-range" type="range" min="0" max="${duration || 1}" step="0.1" value="${position}" aria-label="Перемотка видео"></div><div class="library-skip-panel" id="library-skip-panel" hidden><span id="library-skip-label"></span><button class="secondary-button" id="library-skip-now" type="button"></button><label class="library-skip-toggle"><input id="library-skip-auto" type="checkbox"${state.skipSegments !== false ? " checked" : ""}> Автопропуск</label></div><p id="library-player-status" class="notice" aria-live="polite">${position > 0 ? "Продолжение просмотра." : "Позиция сохраняется автоматически."}</p></section></div>`;
    const video = $("#library-video");
    const loading = $("#library-video-loading");
    const status = $("#library-player-status");
    const play = $("#library-play");
    const range = $("#library-range");
    const skipPanel = $("#library-skip-panel");
    const skipLabel = $("#library-skip-label");
    const skipNow = $("#library-skip-now");
    const skipAuto = $("#library-skip-auto");
    let activeSkip = null;
    const skippedSegments = new Set();
    const updateSkipControls = () => {
      const segments = librarySkipSegments(item, duration || Number(video.duration || 0));
      activeSkip = segments.find((segment) => Number(video.currentTime || position || 0) >= segment.from && Number(video.currentTime || position || 0) < segment.to - 0.5) || null;
      skipPanel.hidden = !activeSkip;
      if (activeSkip) {
        skipLabel.textContent = `Сейчас идут ${activeSkip.label}`;
        skipNow.textContent = activeSkip.button;
      }
    };
    const skipActiveSegment = (automatic = false) => {
      if (!activeSkip) return;
      const segment = activeSkip;
      skippedSegments.add(segment.key);
      position = segment.to;
      video.currentTime = segment.to;
      range.value = segment.to;
      status.textContent = `${segment.button} выполнено.`;
      updateSkipControls();
      if (automatic) skipPanel.hidden = true;
      saveProgress(false);
    };
    const maybeAutoSkip = () => {
      if (!activeSkip || !skipAuto.checked || skippedSegments.has(activeSkip.key) || !activeSkip.auto) return;
      skipActiveSegment(true);
    };
    const saveProgress = (completed = false) => {
      const payload = { position, duration, completed };
      if (Date.now() - lastSaved < 1500 && !completed) return;
      lastSaved = Date.now();
      fetch(`/api/progress/${encodeURIComponent(item.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
      const current = libraryEpisodes.find((episode) => episode.id === item.id);
      if (current) {
        current.progress = { ...payload, updatedAt: new Date().toISOString() };
        libraryHistory = [current, ...libraryHistory.filter((entry) => entry.id !== item.id)];
      }
    };
    const onMetadata = () => { loading.hidden = true; duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); if (position > 0 && position < duration) video.currentTime = position; updateSkipControls(); maybeAutoSkip(); };
    const onTime = () => { position = Number(video.currentTime || 0); duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); updateSkipControls(); maybeAutoSkip(); saveProgress(false); };
    const onEnded = () => { position = duration || Number(video.currentTime || 0); saveProgress(true); status.innerHTML = "<strong>Серия завершена.</strong> Прогресс сохранён."; };
    const onError = () => { loading.hidden = true; status.innerHTML = "<strong>Поток не открылся.</strong> Проверь статус FFmpeg и доступность исходного файла на сервере."; };
    const onPlay = () => { play.textContent = "Ⅱ"; play.setAttribute("aria-label", "Пауза"); };
    const onPause = () => { play.textContent = "▶"; play.setAttribute("aria-label", "Воспроизвести"); saveProgress(false); };
    const seekBy = (seconds) => {
      const nextPosition = Math.max(0, Math.min(video.duration || duration || Number.MAX_SAFE_INTEGER, Number(video.currentTime || position || 0) + seconds));
      position = nextPosition;
      video.currentTime = nextPosition;
      range.value = nextPosition;
      status.textContent = seconds < 0 ? "Перемотка назад на 10 секунд." : "Перемотка вперёд на 10 секунд.";
      saveProgress(false);
    };
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    play.addEventListener("click", () => video.paused ? video.play().catch(() => {}) : video.pause());
    $("#library-back").addEventListener("click", () => seekBy(-10));
    $("#library-forward").addEventListener("click", () => seekBy(10));
    range.addEventListener("input", () => { position = Number(range.value); video.currentTime = position; status.textContent = "Позиция изменена."; saveProgress(false); });
    skipNow.addEventListener("click", () => skipActiveSegment(false));
    skipAuto.addEventListener("change", () => { state.skipSegments = skipAuto.checked; saveState(); if (skipAuto.checked) maybeAutoSkip(); });
    $("#library-fullscreen").addEventListener("click", () => video.requestFullscreen?.());
    $("#library-room").addEventListener("click", async () => {
      try {
        const response = await fetch("/api/watch/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episode_id: item.id }) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const link = `${location.origin}${location.pathname}?room=${payload.room_id}`;
        await navigator.clipboard?.writeText(link);
        status.innerHTML = `<strong>Комната ${escapeHtml(payload.share_code)} создана.</strong> Ссылка скопирована: ${escapeHtml(link)}`;
      } catch (error) { status.textContent = `Комнату создать не удалось: ${error.message}`; }
    });
    const streamUrl = item.offlineUrl || item.hls_url || item.source_url;
    if (item.hls_url && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: true, capLevelToPlayerSize: true });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
    } else {
      video.src = streamUrl;
      video.load();
    }
    const close = () => { saveProgress(false); video.pause(); hls?.destroy(); video.removeEventListener("loadedmetadata", onMetadata); video.removeEventListener("timeupdate", onTime); video.removeEventListener("ended", onEnded); video.removeEventListener("error", onError); video.removeEventListener("play", onPlay); video.removeEventListener("pause", onPause); modalRoot.innerHTML = ""; render(); };
    $("#player-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  async function cacheLibraryOffline(item) {
    const feedback = $("#library-upload-feedback");
    try {
      const manifestResponse = await fetch(item.offline_manifest_url, { headers: { accept: "application/json" } });
      const manifest = await manifestResponse.json();
      if (!manifestResponse.ok) throw new Error(manifest.error || `HTTP ${manifestResponse.status}`);
      if (!window.caches) throw new Error("Cache Storage недоступен в этом браузере");
      const cache = await caches.open("cinevault-media-v1");
      for (const resource of manifest.resources) { const response = await fetch(resource, { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); await cache.put(resource, response.clone()); }
      state.offline = { ...(state.offline || {}), [item.id]: manifest.quality_playlist };
      saveState();
      item.offlineUrl = manifest.quality_playlist;
      if (feedback) feedback.textContent = `${item.title} · ${item.episode_title} сохранена офлайн в качестве ${manifest.quality}.`;
    } catch (error) { if (feedback) feedback.textContent = `Офлайн-загрузка не выполнена: ${error.message}`; }
  }

  async function createLibraryRoom(item) {
    const feedback = $("#library-upload-feedback");
    try {
      const response = await fetch("/api/watch/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ episode_id: item.id }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const link = `${location.origin}${location.pathname}?room=${payload.room_id}`;
      await navigator.clipboard?.writeText(link);
      if (feedback) feedback.textContent = `Комната ${payload.share_code} создана. Ссылка скопирована.`;
    } catch (error) { if (feedback) feedback.textContent = `Комнату создать не удалось: ${error.message}`; }
  }

  function bindPageActions() {
    $$('[data-view]').forEach((button) => button.addEventListener("click", () => { state.view = button.dataset.view; saveState(); render(); if (state.view === "history") loadLibraryData(true); }));
    $$('[data-open-title]').forEach((button) => button.addEventListener("click", () => renderDetails(button.dataset.openTitle)));
    $$('[data-play-media]').forEach((button) => button.addEventListener("click", () => { const item = getTitle(button.dataset.playMedia); const episode = button.dataset.episode ? Number(button.dataset.episode) : null; openItemPlayer(item, episode); }));
    $$('[data-demo-play]').forEach((button) => button.addEventListener("click", () => { const item = getTitle(button.dataset.demoPlay); const episode = button.dataset.episode ? Number(button.dataset.episode) : (item?.kind === "series" ? (progressForTitle(item)?.episodeNumber || 1) : null); openItemPlayer(item, episode); }));
    $$('[data-library-play]').forEach((button) => button.addEventListener("click", () => { const item = libraryEpisodes.find((episode) => episode.id === button.dataset.libraryPlay); if (item) openLibraryPlayer(item); }));
    $$('[data-library-offline]').forEach((button) => button.addEventListener("click", () => { const item = libraryEpisodes.find((episode) => episode.id === button.dataset.libraryOffline); if (item) cacheLibraryOffline(item); }));
    $$('[data-library-room]').forEach((button) => button.addEventListener("click", () => { const item = libraryEpisodes.find((episode) => episode.id === button.dataset.libraryRoom); if (item) createLibraryRoom(item); }));
    $("#catalog-search-form")?.addEventListener("submit", runCatalogSearch);
    $$('[data-catalog-select]').forEach((button) => button.addEventListener("click", () => selectCatalogTitle(button.dataset.catalogSelect, button.dataset.catalogKind, button.dataset.catalogProvider)));
    $$('[data-library-refresh]').forEach((button) => button.addEventListener("click", () => loadLibraryData(true)));
    $("#library-upload-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const feedback = $("#library-upload-feedback");
      feedback.textContent = "Загружаю исходник на сервер…";
      try {
        adminToken = $("#library-admin-token").value.trim();
        if (adminToken) sessionStorage.setItem("cinevault.adminToken", adminToken);
        const headers = adminToken ? { "X-CineVault-Admin-Token": adminToken } : {};
        const files = form.querySelector('[name="file"]')?.files || [];
        const endpoint = files.length > 1 || files[0]?.webkitRelativePath ? "/api/library/bulk-upload" : "/api/library/upload";
        const response = await fetch(endpoint, { method: "POST", headers, body: new FormData(form) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        feedback.textContent = "Файл сохранён. FFmpeg готовит HLS; обнови список через несколько секунд.";
        form.reset();
        await loadLibraryData(true);
      } catch (error) { feedback.textContent = error.message.includes("403") ? "Импорт доступен только администратору backend." : `Загрузка не выполнена: ${error.message}`; }
    });
    $$('[data-mood]').forEach((button) => button.addEventListener("click", () => { state.mood = button.dataset.mood; persistAndRender(); }));
    $$('[data-favorite]').forEach((button) => button.addEventListener("click", () => { const id = button.dataset.favorite; state.favorites = state.favorites.includes(id) ? state.favorites.filter((item) => item !== id) : [...state.favorites, id]; saveState(); renderDetails(id); }));
    $$('[data-watchlist]').forEach((button) => button.addEventListener("click", () => { const id = button.dataset.watchlist; state.watchlist = state.watchlist.includes(id) ? state.watchlist.filter((item) => item !== id) : [...state.watchlist, id]; saveState(); renderDetails(id); }));
    $$('[data-season]').forEach((button) => button.addEventListener("click", () => { selectedSeason = Number(button.dataset.season); renderDetails(getTitleFromPage()); }));
    $$('[data-set-theme]').forEach((button) => button.addEventListener("click", () => { state.theme = button.dataset.setTheme; persistAndRender(); }));
    $$('[data-clear-progress]').forEach((button) => button.addEventListener("click", () => { state.progress = {}; persistAndRender(); }));
    $$('[data-mood-filter]').forEach((button) => button.addEventListener("click", () => { state.view = "catalog"; saveState(); render(); }));
    $("#settings-pet")?.addEventListener("click", openCompanion);
    $("#rutube-open")?.addEventListener("click", () => { const input = $("#rutube-url"); const feedback = $("#rutube-feedback"); const videoId = extractRutubeVideoId(input?.value); if (!videoId) { feedback.textContent = "Нужна прямая ссылка RUTUBE на видео или embed-код."; return; } state.rutubeUrl = input.value.trim(); saveState(); openRutubePlayer(videoId, "RUTUBE-видео", `rutube-${videoId}`); });
    $("#rutube-test")?.addEventListener("click", () => openRutubePlayer(RUTUBE_SAMPLE_ID, "Тестовый плеер RUTUBE", `rutube-demo-${RUTUBE_SAMPLE_ID}`));
    $("#hdrezka-search")?.addEventListener("click", runHdrezkaSearch);
    $("#hdrezka-query")?.addEventListener("keydown", (event) => { if (event.key === "Enter") runHdrezkaSearch(); });
  }

  function getTitleFromPage() { return $("[data-demo-play]")?.dataset.demoPlay || "desperate-housewives"; }
  function openCompanion() { const popover = $("#companion-popover"); popover.hidden = !popover.hidden; }

  $("#theme-toggle").addEventListener("click", () => { state.theme = state.theme === "night" ? "graphite" : "night"; persistAndRender(); });
  $("#companion-open").addEventListener("click", openCompanion);
  $$(".pet-choice").forEach((button) => button.addEventListener("click", () => { state.companion = button.dataset.pet; $$(".pet-choice").forEach((item) => item.classList.toggle("is-selected", item === button)); $("#companion-popover").hidden = true; persistAndRender(); }));
  $("#search").addEventListener("input", (event) => { state.query = event.target.value; state.view = "catalog"; renderCatalogView(); saveState(); });
  document.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search").focus(); } if (event.key === "Escape") { $("#companion-popover").hidden = true; if (modalRoot.innerHTML) $("#player-close")?.click(); } });

  $("#assistant-collapse")?.addEventListener("click", () => $("#assistant-rail").classList.toggle("is-collapsed"));
  $("#assistant-pet")?.addEventListener("click", () => { $("#assistant-rail").classList.remove("is-collapsed"); setPetState("happy"); $("#assistant-copy").textContent = "Я проснулся! Нажми «Подобрать для нас», и я подберу вариант под ваше настроение."; });
  $("#assistant-recommend")?.addEventListener("click", () => { state.view = "home"; const pick = recommendation(); saveState(); render(); setPetState("happy"); $("#assistant-copy").textContent = `${pick.title} выглядит хорошим вариантом на сегодня. Открыть карточку или начать демо?`; });

  startPetStates();
  render();
  loadLibraryData(false);
  syncCatalogFromTmdb();
})();
