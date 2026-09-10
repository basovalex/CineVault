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
  const HLS_PLAYBACK_CONFIG = {
    enableWorker: true,
    capLevelToPlayerSize: true,
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
  const HLS_PREBUFFER_CONFIG = {
    ...HLS_PLAYBACK_CONFIG,
    maxBufferLength: 12,
    maxMaxBufferLength: 18,
    backBufferLength: 0,
    maxBufferSize: 20 * 1000 * 1000,
  };

  function apiUrl(path) {
    if (!configuredApiBaseUrl || /^https?:\/\//i.test(path)) return path;
    return new URL(path, `${configuredApiBaseUrl}/`).toString();
  }

  function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (viewerToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${viewerToken}`);
    return fetch(apiUrl(path), { ...options, headers });
  }

  const openMediaCatalog = [
    { id: "sintel-open", kind: "movie", title: "Sintel", originalTitle: "Sintel", year: 2010, description: "Открытый фантастический фильм Blender Foundation о девушке, драконе и обещании, которое нельзя забыть.", tags: ["фантастика", "атмосферно", "на вечер"], runtime: 15, poster: "linear-gradient(145deg, #d88963, #292242)", posterImage: "https://archive.org/services/img/Sintel", providerUrl: "https://archive.org/details/Sintel", providerName: "Archive.org", providerNote: "Открытый фильм Blender Foundation · CC BY 3.0", videoUrl: "https://archive.org/download/Sintel/sintel-2048-stereo_512kb.mp4", licenseUrl: "https://creativecommons.org/licenses/by/3.0/", licenseLabel: "CC BY 3.0" },
    { id: "big-buck-bunny-open", kind: "movie", title: "Большой кролик", originalTitle: "Big Buck Bunny", year: 2008, description: "Добрая короткометражная история Blender Open Movie Project. Можно смотреть прямо в CineVault.", tags: ["комедия", "уютно", "на вечер"], runtime: 10, poster: "linear-gradient(145deg, #72b9df, #6b8b55)", posterImage: "https://archive.org/services/img/big-buck-bunny-640x360_202403", providerUrl: "https://archive.org/details/big-buck-bunny-640x360_202403", providerName: "Archive.org", providerNote: "Открытый фильм · Public Domain Mark 1.0", videoUrl: "https://archive.org/download/big-buck-bunny-640x360_202403/BigBuckBunny%20640x360.mp4", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/", licenseLabel: "Public Domain Mark 1.0" },
    { id: "elephants-dream-open", kind: "movie", title: "Elephants Dream", originalTitle: "Elephants Dream", year: 2006, description: "Первый открытый фильм Blender Foundation: странное путешествие по механическому миру.", tags: ["фантастика", "атмосферно", "напряжённо"], runtime: 11, poster: "linear-gradient(145deg, #b68663, #241d35)", posterImage: "https://archive.org/services/img/elephants-dream_202403", providerUrl: "https://archive.org/details/elephants-dream_202403", providerName: "Archive.org", providerNote: "Открытый фильм · Public Domain Mark 1.0", videoUrl: "https://archive.org/download/elephants-dream_202403/Elephants%20Dream.mp4", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/", licenseLabel: "Public Domain Mark 1.0" },
    { id: "gentlemen-of-fortune-rutube", kind: "movie", title: "Джентльмены удачи", originalTitle: "Джентльмены удачи", year: 1971, description: "Легендарная советская комедия в официальной публикации Киноконцерна «Мосфильм» на RUTUBE.", tags: ["комедия", "уютно", "для нас"], runtime: 88, poster: "linear-gradient(145deg, #c58b54, #4a2630)", providerUrl: "https://rutube.ru/video/8f50ed5a7841ff1418671a3c6b7440d4/", providerName: "RUTUBE · Мосфильм", providerNote: "Официальный канал Киноконцерна «Мосфильм» · встроенный просмотр", rutubeId: "8f50ed5a7841ff1418671a3c6b7440d4" }
  ];

  const seedCatalog = [
    { id: "desperate-housewives", kind: "series", title: "Отчаянные домохозяйки", originalTitle: "Desperate Housewives", year: 2004, description: "Четыре подруги, тайны Вистерия-Лейн и история, к которой хочется возвращаться сериями.", tags: ["драма", "комедия", "уютно"], seasons: [23, 24, 23, 17, 24, 23, 23, 23], runtime: 42, poster: "linear-gradient(145deg, #5a244b, #1e203e)", providerUrl: "", providerName: "Источник не подключён", providerNote: "Для этого тайтла пока нет разрешённого видеопотока в CineVault" },
    { id: "the-mentalist", kind: "series", title: "Менталист", originalTitle: "The Mentalist", year: 2008, description: "После того как серийный убийца убил его семью, Патрик Джейн отказался от карьеры экстрасенса и использует свои способности, чтобы помогать правоохранительным органам.", tags: ["детектив", "драма", "напряжённо"], seasons: [23, 23, 24, 24, 22, 22, 13], runtime: 43, tmdbId: 5920, kinopoiskId: 412344, catalogId: 2368, poster: "linear-gradient(145deg, #a36a4f, #1b2338)", posterImage: "https://image.tmdb.org/t/p/w780/sdlnS04iwOeYzng0CAOyiycNTM3.jpg", providerUrl: "", providerName: "TMDB · метаданные", providerNote: "Метаданные, постер и список серий загружаются онлайн. Источники серий подключаются из отдельного файла Менталиста; видеопоток используется только из разрешённого источника.", episodeDataProvider: "tvmaze", tvmazeId: 116 },
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

  const defaultState = { view: "home", theme: "graphite", companion: "plush", mood: "уютно", query: "", catalogGenre: "", catalogCollection: "", catalogMoodOnly: false, catalogPlayableOnly: false, catalogSort: "rating", catalogPage: 1, favorites: [], watchlist: [], progress: {}, ratings: {}, history: [], recommendationHistory: [], offline: {}, voiceSelections: {}, playbackSelections: {}, playerVolume: 1, playerMuted: false, rutubeUrl: "", skipSegments: true };
  const ROUTE_PATHS = Object.freeze({ home: "/", catalog: "/catalog/", movies: "/movies/", series: "/series/", library: "/library/", favorites: "/favorites/", evening: "/evening/", history: "/history/", settings: "/settings/" });
  const ROUTE_VIEWS = Object.freeze(Object.fromEntries(Object.entries(ROUTE_PATHS).map(([view, path]) => [path, view])));
  let state = loadState();
  if (state.theme !== "graphite") { state.theme = "graphite"; saveState(); }
  const initialRoute = readRouteFromLocation();
  if (initialRoute.type === "view") state.view = initialRoute.view;
  let catalog = [...seedCatalog, ...openMediaCatalog].map((item) => ({ ...item }));
  const posterOverrides = Object.freeze({
    "kinopoisk-5304403": "https://old.mvapspdmpg.com/movies/files/posters/147213.jpeg",
  });
  function applyPosterOverrides() {
    catalog = catalog.map((item) => posterOverrides[item.id] ? { ...item, posterImage: posterOverrides[item.id] } : item);
  }
  applyPosterOverrides();
  Object.assign(catalog.find((item) => item.id === "desperate-housewives"), importedDesperateHousewives);
  let tmdbStatus = tmdbCredential ? "Загружаю постеры и данные TMDB…" : "TMDB-ключ не найден";
  let tmdbSyncStarted = false;
  let initialCatalogReady = false;
  let catalogHydrating = true;
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
  let recommendationCursor = 0;
  let recommendationCandidateKey = "";
  let libraryStatus = "Проверяю сервер медиатеки…";
  let adminToken = String(sessionStorage.getItem("cinevault.adminToken") || "").trim();
  let activeWatchRoomId = new URLSearchParams(window.location.search).get("room") || "";
  let roomOpenAttempted = false;
  let detailPrebuffer = null;
  const playbackRefreshes = new Map();

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const app = $("#app");
  const page = $("#page");
  const modalRoot = $("#modal-root");

  if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

  function safePathname(pathname = window.location.pathname) {
    let decoded = pathname || "/";
    try { decoded = decodeURIComponent(decoded); } catch { /* Keep the raw path for malformed copied links. */ }
    if (decoded === "/index.html") return "/";
    return decoded.length > 1 ? decoded.replace(/\/+$/, "") + "/" : "/";
  }

  function routeForView(view) { return ROUTE_PATHS[view] || ROUTE_PATHS.catalog; }
  function routeForTitle(id) { return `/title/${encodeURIComponent(String(id))}/`; }

  function readRouteFromLocation() {
    const path = safePathname();
    const titleMatch = path.match(/^\/title\/([^/]+)\/$/);
    if (titleMatch) {
      try { return { type: "title", id: decodeURIComponent(titleMatch[1]) }; }
      catch { return { type: "view", view: "catalog" }; }
    }
    return { type: "view", view: ROUTE_VIEWS[path] || "home" };
  }

  function routeHistoryState(route, scrollY = 0, extra = {}) {
    return { cinevaultRoute: true, route: route.type, view: route.view || "", titleId: route.id || "", scrollY: Math.max(0, Number(scrollY) || 0), ...extra };
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

  function updateDocumentRoute(route, item = null) {
    const titles = { home: "CineVault — кино для вас", catalog: "Каталог — CineVault", movies: "Фильмы — CineVault", series: "Сериалы — CineVault", library: "Моя медиатека — CineVault", favorites: "Избранное — CineVault", evening: "Наш вечер — CineVault", history: "История просмотра — CineVault", settings: "Настройки — CineVault" };
    document.title = item ? `${item.title} — CineVault` : (titles[route.view] || "CineVault — кино для вас");
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      const path = route.type === "title" ? routeForTitle(route.id) : routeForView(route.view);
      canonical.setAttribute("href", new URL(path, window.location.origin).toString());
    }
  }

  function renderRoute(route, { restoreScroll = false, replaceHistory = false } = {}) {
    if (catalogHydrating && route.type === "title") {
      state.view = "catalog";
      renderCatalogLoading();
      updateDocumentRoute({ type: "view", view: "catalog" });
      return;
    }
    if (route.type === "title") {
      const item = getTitle(route.id);
      if (!item) {
        const fallback = { type: "view", view: "catalog" };
        state.view = fallback.view;
        saveState();
        window.history.replaceState(routeHistoryState(fallback), "", routeForView(fallback.view));
        render();
        updateDocumentRoute(fallback);
        scheduleScroll(0);
        return;
      }
      if (replaceHistory) window.history.replaceState(routeHistoryState(route), "", window.location.href);
      renderDetails(item.id);
      updateDocumentRoute(route, item);
      scheduleScroll(0);
      page.focus({ preventScroll: true });
      return;
    }

    state.view = route.view;
    saveState();
    if (replaceHistory) window.history.replaceState(routeHistoryState(route), "", window.location.href);
    render();
    updateDocumentRoute(route);
    scheduleScroll(restoreScroll ? window.history.state?.scrollY : 0);
    if (state.view === "history") loadLibraryData(true);
  }

  function navigateToView(view, { replace = false } = {}) {
    const route = { type: "view", view: ROUTE_PATHS[view] ? view : "catalog" };
    updateCurrentHistoryScroll();
    const method = replace ? "replaceState" : "pushState";
    window.history[method](routeHistoryState(route), "", routeForView(route.view));
    renderRoute(route);
  }

  function setAssistantCopy(text) {
    const copy = $("#assistant-copy");
    if (copy) copy.textContent = text;
  }

  function openTitleRoute(id, { recommendation = false } = {}) {
    const item = getTitle(id);
    if (!item) return;
    hideSearchSuggestions();
    const returnView = ROUTE_PATHS[state.view] ? state.view : "catalog";
    updateCurrentHistoryScroll();
    const route = { type: "title", id: item.id };
    window.history.pushState(
      routeHistoryState(route, 0, { returnView, hasPreviousView: true }),
      "",
      routeForTitle(item.id),
    );
    renderRoute(route);
    if (recommendation) setAssistantCopy(`Вот «${item.title}». ${recommendationReason(item)}`);
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
      openTitleRoute(detailLink.dataset.openTitle);
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
      if (nextView !== state.view) resetCatalogPage();
      navigateToView(nextView);
    }
  });

  window.addEventListener("popstate", () => renderRoute(readRouteFromLocation(), { restoreScroll: true }));

  async function loadImportedCatalog() {
    try {
      const response = await fetch("./data/catalog_imports.json", { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) return;
      const imported = await response.json();
      if (!Array.isArray(imported)) return;
      imported.forEach((entry) => {
        if (!entry || !entry.kinopoiskId) return;
        const existing = catalog.find((item) =>
          item.id === entry.id ||
          Number(item.kinopoiskId || item.kinopoisk_id || 0) === Number(entry.kinopoiskId)
        );
        if (!existing) {
          catalog.push({ ...entry });
          return;
        }
        const isImportedDesperateHousewives = Number(entry.catalogId || 0) === 2205 || Number(entry.kinopoiskId || 0) === 160958;
        const merged = { ...existing, ...entry, id: existing.id || entry.id };
        if (isImportedDesperateHousewives) {
          merged.posterImage = importedDesperateHousewives.posterImage;
          merged.episodePosterUrls = importedDesperateHousewives.episodePosterUrls;
        }
        if (Array.isArray(existing.seasons) && existing.seasons.length) merged.seasons = existing.seasons;
        merged.tags = [...new Set([...(existing.tags || []), ...(entry.tags || [])])];
        catalog = catalog.map((item) => item === existing ? merged : item);
      });
      applyPosterOverrides();
      if (activeTitleId) renderDetails(activeTitleId);
    } catch (error) {
      // Static catalog remains available when no generated import file exists.
    }
  }

  function loadState() {
    try { return { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; } catch { return { ...defaultState }; }
  }

  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function loadMetadataCache() { try { return JSON.parse(localStorage.getItem(TMDB_CACHE_KEY) || "{}"); } catch { return {}; } }
  function saveMetadataCache(cache) { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(cache)); }
  const sourceFilesByKinopoiskId = {
    160958: "./data/desperate_housewives_episode_sources.json",
    412344: "./data/mentalist_episode_sources.json",
  };
  function normalizeEpisodeSource(candidate, index) {
    if (!candidate || typeof candidate !== "object") return null;
    const sourceUrl = String(candidate.url || candidate.source_url || "").trim();
    if (!sourceUrl) return null;
    const label = String(candidate.label || candidate.name || `Озвучка ${index + 1}`).trim() || `Озвучка ${index + 1}`;
    const variantId = candidate.variant_id ?? candidate.variantId ?? null;
    return {
      sourceKey: variantId != null ? `variant:${variantId}` : `source:${index + 1}:${label}`,
      label,
      sourceUrl,
      variantId,
      dubbingStudioId: candidate.dubbing_studio_id ?? candidate.dubbingStudioId ?? null,
      quality: candidate.quality || "",
      hasAds: candidate.has_adv ?? candidate.hasAds ?? null,
    };
  }
  function sourceTokensFromRows(rows) {
    return Array.isArray(rows)
      ? Object.fromEntries(rows.map((source) => {
        const sources = (Array.isArray(source.sources) ? source.sources : []).map(normalizeEpisodeSource).filter(Boolean);
        const fallbackUrl = source.is_full_url ? String(source.token || "").trim() : "";
        if (!sources.length && fallbackUrl) sources.push({ sourceKey: "legacy:default", label: "По умолчанию", sourceUrl: fallbackUrl, variantId: null, dubbingStudioId: null, quality: "", hasAds: null });
        const firstSource = sources[0];
        return [`${Number(source.season)}-${Number(source.episode)}`, {
          token: String(source.token || ""),
          sourceUrl: String(firstSource?.sourceUrl || fallbackUrl || "").trim(),
          episodeId: source.episode_id || null,
          isFullUrl: Boolean(source.is_full_url || firstSource?.sourceUrl),
          sources,
        }];
      }))
      : {};
  }
  async function loadSourceRowsForItem(item) {
    const kinopoiskId = Number(item?.kinopoiskId || item?.kinopoisk_id || 0);
    const sourceFile = item?.sourceFile || sourceFilesByKinopoiskId[kinopoiskId];
    if (!sourceFile) return [];
    const response = await fetch(sourceFile, { cache: "no-store", headers: { accept: "application/json" } });
    return response.ok ? response.json() : [];
  }
  async function loadEpisodeAssets() {
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
      const sourceRows = await loadSourceRowsForItem(item);
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
      item.episodeSourceTokens = sourceTokensFromRows(sourceRows);
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
    if ((!item?.episodeDataProvider && !item?.episodeDataFile) || episodeAssetStates[item.id]?.loading || episodeAssetStates[item.id]?.loaded) return;
    const assetState = episodeAssetStates[item.id] = { loading: true, error: "", loaded: false };
    if (activeTitleId === item.id) renderDetails(item.id);
    try {
      const metadataFile = item.episodeDataFile || "";
      let localRows = [];
      if (metadataFile) {
        const metadataResponse = await fetch(metadataFile, { cache: "no-store", headers: { accept: "application/json" } });
        localRows = metadataResponse.ok ? await metadataResponse.json() : [];
      }
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
      if (!sourceEpisodes.length) throw new Error("Пустой список серий");
      const sourceRows = await loadSourceRowsForItem(item);
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
      item.episodeTitles = episodeTitles;
      item.episodeOriginalTitles = episodeOriginalTitles;
      item.episodePosterUrls = episodePosterUrls;
      item.episodeSourceTokens = sourceTokensFromRows(sourceRows);
      assetState.loaded = true;
    } catch (error) {
      assetState.error = "Не удалось загрузить список серий и превью онлайн.";
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
      libraryEpisodes = (Array.isArray(payload.items) ? payload.items : []).map((item) => ({ ...item, offlineUrl: state.offline?.[item.id] || "" }));
      libraryHistory = (Array.isArray(payload.history) ? payload.history : libraryEpisodes.filter((item) => item.progress)).map((item) => ({ ...item }));
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
        description: isImportedDesperateHousewives ? existing.description : first.overview || first.metadata?.overview || existing?.description || "Видео установлено на общем backend.",
        posterImage: isImportedDesperateHousewives ? existing.posterImage : first.poster_url || first.metadata?.poster_url || existing?.posterImage || "",
        seasons: isImportedDesperateHousewives ? existing.seasons : metadataSeasons.length ? metadataSeasons : existing?.seasons?.length ? existing.seasons : Array.from({ length: maxSeason }, (_, index) => index === maxSeason - 1 ? maxEpisode : 1),
        tags: [...new Set([...(existing?.tags || []), "медиатека", "для нас"])],
        providerName: episodes.some((episode) => episode.source_type === "external_embed") ? "Внешний официальный плеер" : "CineVault · сервер",
        providerNote: episodes.some((episode) => episode.source_type === "external_embed") ? "Плеер открывается у исходного сервиса; CineVault не скачивает и не проксирует поток." : "Видео хранится на общем backend и доступно пользователям этого сервера.",
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
    const results = await Promise.allSettled(seedCatalog.map(async (item) => {
      const cached = cache[item.id];
      const update = cached || await fetchTmdbDetails(item);
      catalog = catalog.map((entry) => entry.id === item.id && !String(entry.providerName || "").startsWith("Kinopoisk") ? { ...entry, ...update } : entry);
      cache[item.id] = update;
      synced += 1;
    }));
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
  function removeAdminTokenFields(root = document) {
    $$('input[name="admin_token"], #library-admin-token', root).forEach((input) => {
      input.closest("label")?.remove();
    });
  }
  function formatTime(seconds) { const total = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
  function formatDuration(seconds) { const minutes = Math.max(0, Math.round(Number(seconds || 0) / 60)); return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`; }
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
    bufferStatus.textContent = bufferedEnd > 0 ? `Прогружено: ${formatTime(bufferedEnd)}${total > 0 ? ` из ${formatTime(total)} · ${Math.round(percent)}%` : ""}` : "Буфер: загружается…";
  }
  function formatRuntime(minutes) { return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60 ? `${minutes % 60} мин` : ""}`.trim() : `${minutes} мин`; }
  function posterStyle(item) { return item.posterImage ? `background-image:linear-gradient(180deg, transparent 38%, rgba(0,0,0,.18)),url(${escapeHtml(item.posterImage)});background-size:cover;background-position:center` : `--poster:${item.poster}`; }
  function posterTitleArt(item) { return item.posterImage ? "" : `<span class="poster-title-art">${escapeHtml(item.title)}</span>`; }
  function catalogRatingLabel(item) {
    const value = Number(item.ratingKinopoisk ?? item.rating);
    if (!Number.isFinite(value) || value <= 0) return "";
    return `${item.ratingKinopoisk != null ? "КП" : "TMDB"} ${value.toFixed(1)}`;
  }
  function extractRutubeVideoId(value) { const match = String(value || "").match(/rutube\.ru\/(?:video|play\/embed)\/([a-z0-9]+)(?:[/?#\s"']|$)/i); return match?.[1] || null; }
  function getVideoVariants(item) {
    const configured = Array.isArray(item?.videoSources) ? item.videoSources.filter((source) => source?.url) : [];
    const sources = configured.length ? configured : item?.videoUrl ? [{ id: "default", url: item.videoUrl, type: "video/mp4", quality: "Источник", voice: "Оригинал" }] : [];
    return sources.map((source, index) => ({ id: source.id || `source-${index + 1}`, url: source.url, type: source.type || "video/mp4", quality: source.quality || "Авто", voice: source.voice || "Оригинал", sourceName: source.sourceName || source.provider || source.providerName || item?.providerName || "Подключённый источник" }));
  }
  function playerSelectMarkup(id, label, options, disabled = false) { return `<label class="player-select"><span>${label}</span><select id="${id}"${disabled ? " disabled" : ""}>${options.map((option) => `<option value="${escapeHtml(option.value ?? option)}"${option.selected ? " selected" : ""}>${escapeHtml(option.label ?? option)}</option>`).join("")}</select></label>`; }
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
    return `<div class="player-settings" data-player-settings><button class="player-control-button player-settings-button" id="${prefix}-settings" type="button" aria-expanded="false" aria-controls="${prefix}-settings-panel" aria-label="Настройки плеера" title="Настройки">${playerIcon("settings")}</button><div class="player-settings-panel" id="${prefix}-settings-panel" role="group" aria-label="Настройки плеера" hidden>${controls}<p class="player-settings-empty">Параметры потока появятся после загрузки.</p></div></div>`;
  }
  function playerToolbarMarkup(prefix, settingsControls) {
    return `<div class="player-toolbar player-toolbar-compact player-toolbar-cinematic"><div class="player-actions"><button class="player-control-button player-skip-button" id="${prefix}-back" type="button" aria-label="Назад на 10 секунд" title="Назад на 10 секунд">${playerIcon("back")}<small aria-hidden="true">10</small></button><button class="player-play-button" id="${prefix}-play" type="button" aria-label="Воспроизвести" title="Воспроизвести">${playerIcon("play")}</button><button class="player-control-button player-skip-button" id="${prefix}-forward" type="button" aria-label="Вперёд на 10 секунд" title="Вперёд на 10 секунд">${playerIcon("forward")}<small aria-hidden="true">10</small></button></div><div class="player-utility-actions">${playerVolumeMarkup(prefix)}${playerSettingsMarkup(prefix, settingsControls)}</div></div>`;
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
    return `<label class="player-select" id="${prefix}-hls-quality-wrap" hidden><span>Качество</span><select id="${prefix}-hls-quality" aria-label="Качество HLS"></select></label>${includeAudio ? `<label class="player-select" id="${prefix}-hls-audio-wrap" hidden><span>Озвучка</span><select id="${prefix}-hls-audio" aria-label="Озвучка HLS"></select></label>` : ""}<label class="player-select" id="${prefix}-hls-subtitle-wrap" hidden><span>Субтитры</span><select id="${prefix}-hls-subtitle" aria-label="Субтитры HLS"></select></label>`;
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
      setSelectOptions(qualitySelect, [{ value: -1, label: "Авто" }, ...levels], hls.autoLevelEnabled ? -1 : hls.currentLevel);
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
    const onQualityChange = () => { hls.currentLevel = Number(qualitySelect.value); };
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
    const start = () => { if (!video.paused && !video.ended) setBusy(true, "Загрузка видеопотока"); };
    const wait = () => { if (!video.paused && !video.ended) setBusy(true, "Буферизация видео"); };
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
  function playerSeriesMarkup(item, episodeNumber = 1) {
    if (item?.kind !== "series" || !item.seasons?.length) return "";
    const seasonOptions = item.seasons.map((_, index) => ({ value: index + 1, label: `Сезон ${index + 1}`, selected: selectedSeason === index + 1 }));
    const episodeCount = item.seasons[selectedSeason - 1] || 1;
    const activeEpisode = Math.min(Number(episodeNumber || 1), episodeCount);
    const episodeOptions = Array.from({ length: episodeCount }, (_, index) => ({ value: index + 1, label: `Серия ${index + 1}`, selected: activeEpisode === index + 1 }));
    return `<div class="player-series-bar">${playerSelectMarkup("player-season", "Сезон", seasonOptions)}${playerSelectMarkup("player-episode", "Серия", episodeOptions)}</div>`;
  }
  function bindPlayerSeriesSelectors(item, episodeNumber, roomId = "", roomSync = null) {
    if (item?.kind !== "series") return;
    const reopen = async () => {
      const nextEpisode = Math.min(Number($("#player-episode")?.value || episodeNumber || 1), item.seasons[selectedSeason - 1] || 1);
      if (roomSync) await roomSync.publishEpisode(selectedSeason, nextEpisode);
      roomSync?.dispose();
      modalRoot.innerHTML = "";
      openItemPlayer(item, nextEpisode, selectedSeason, roomId || null);
    };
    $("#player-season")?.addEventListener("change", () => { selectedSeason = Math.max(1, Number($("#player-season").value || 1)); reopen(); });
    $("#player-episode")?.addEventListener("change", reopen);
  }
  function libraryEpisodeFor(item, season = null, episode = null) {
    const localEpisodes = item?.libraryEpisodes || [];
    if (!localEpisodes.length) return null;
    const exact = localEpisodes.find((candidate) => candidate.status === "ready" && (season == null || candidate.season === season) && (episode == null || candidate.episode === episode));
    return exact || localEpisodes.filter((candidate) => candidate.status === "ready").sort((a, b) => Date.parse(b.progress?.updatedAt || "") - Date.parse(a.progress?.updatedAt || "") || Number(b.episode || 0) - Number(a.episode || 0))[0] || null;
  }
  function directEpisodeUrl(item, season, episode) {
    return String(selectedEpisodeSource(item, season, episode)?.sourceUrl || "").trim();
  }
  function episodeSourceEntry(item, season, episode) {
    return item?.episodeSourceTokens?.[`${Number(season)}-${Number(episode)}`] || null;
  }
  function episodeSourceOptions(item, season, episode) {
    const entry = episodeSourceEntry(item, season, episode);
    if (!entry) return [];
    if (Array.isArray(entry.sources) && entry.sources.length) return entry.sources;
    return entry.sourceUrl ? [{ sourceKey: "legacy:default", label: "По умолчанию", sourceUrl: entry.sourceUrl, variantId: null, dubbingStudioId: null, quality: "", hasAds: null }] : [];
  }
  function episodeSourceSelectionKey(item, season, episode) {
    return `${item?.id || "title"}-s${Number(season) || 0}e${Number(episode) || 0}`;
  }
  function titlePlaybackSelection(item) {
    state.playbackSelections = state.playbackSelections && typeof state.playbackSelections === "object" ? state.playbackSelections : {};
    return state.playbackSelections[item?.id] || {};
  }
  function titleVoiceOptions(item) {
    const labels = item?.kind === "series"
      ? Object.values(item?.episodeSourceTokens || {}).flatMap((entry) => Array.isArray(entry?.sources) ? entry.sources.map((source) => source.label) : [])
      : getVideoVariants(item).map((variant) => variant.voice);
    const seen = new Set();
    return labels.filter((label) => {
      const key = String(label || "").trim().toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function selectedVideoVariant(item, variants = getVideoVariants(item)) {
    const choice = titlePlaybackSelection(item);
    return variants.find((variant) => variant.quality === choice.source && variant.voice === choice.voice)
      || variants.find((variant) => variant.voice === choice.voice)
      || variants.find((variant) => variant.quality === choice.source)
      || variants[0];
  }
  function selectedHlsAudioKey(item) { return String(titlePlaybackSelection(item).hlsAudio || ""); }
  function selectedEpisodeSource(item, season, episode) {
    const options = episodeSourceOptions(item, season, episode);
    if (!options.length) return null;
    const savedKey = state.voiceSelections?.[episodeSourceSelectionKey(item, season, episode)];
    const titleVoice = String(titlePlaybackSelection(item).voice || "").trim().toLocaleLowerCase();
    return options.find((source) => source.sourceKey === savedKey)
      || options.find((source) => String(source.label || "").trim().toLocaleLowerCase() === titleVoice)
      || options[0];
  }
  function shouldRefreshKinopoiskPlayback(item) {
    const kinopoiskId = Number(item?.kinopoiskId || item?.kinopoisk_id || 0);
    const provider = String(item?.providerName || "");
    const providerUrl = String(item?.providerUrl || "");
    return kinopoiskId > 0 && (provider.startsWith("Kinopoisk") || /^https?:\/\/(?:www\.)?kinopoisk\.ru\//i.test(providerUrl));
  }
  function setPlaybackButtonsBusy(item, busy) {
    $$(`[data-play-media="${CSS.escape(String(item?.id || ""))}"], [data-demo-play="${CSS.escape(String(item?.id || ""))}"]`).forEach((button) => {
      if (busy) {
        button.dataset.playbackLabel = button.textContent;
        button.textContent = "Обновляю поток…";
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
      } else {
        button.textContent = button.dataset.playbackLabel || button.textContent;
        button.disabled = false;
        button.removeAttribute("aria-busy");
        delete button.dataset.playbackLabel;
      }
    });
  }
  async function applyRefreshedCatalogEntry(item, entry) {
    if (!item || !entry || typeof entry !== "object") return item;
    const originalId = item.id;
    const originalSeasons = Array.isArray(item.seasons) && item.seasons.length ? item.seasons : null;
    Object.assign(item, entry, { id: originalId || entry.id });
    if (originalSeasons) item.seasons = originalSeasons;
    if (item.sourceFile) {
      try {
        const sourceRows = await loadSourceRowsForItem(item);
        item.episodeSourceTokens = sourceTokensFromRows(sourceRows);
      } catch {
        // The previous in-memory episode sources remain usable as a fallback.
      }
    }
    return item;
  }
  async function refreshKinopoiskPlayback(item, { force = true } = {}) {
    if (!shouldRefreshKinopoiskPlayback(item)) return item;
    const kinopoiskId = Number(item.kinopoiskId || item.kinopoisk_id);
    if (playbackRefreshes.has(kinopoiskId)) return playbackRefreshes.get(kinopoiskId);
    const refresh = (async () => {
      setPlaybackButtonsBusy(item, true);
      item.playbackRefreshWarning = "";
      try {
        const response = await apiFetch("/api/playback/refresh", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ kinopoisk_id: kinopoiskId, force }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        await applyRefreshedCatalogEntry(item, payload.entry);
        item.playbackRefreshWarning = payload.warning || "";
      } catch (error) {
        item.playbackRefreshWarning = `Свежую ссылку получить не удалось (${error.message}). Пробую предыдущую.`;
      } finally {
        setPlaybackButtonsBusy(item, false);
      }
      return item;
    })();
    playbackRefreshes.set(kinopoiskId, refresh);
    try {
      return await refresh;
    } finally {
      playbackRefreshes.delete(kinopoiskId);
    }
  }
  function detailPrebufferUrl(item) {
    if (!item || item.rutubeId) return "";
    if (item.kind === "series") {
      const progress = progressForTitle(item);
      const season = Math.max(1, Number(progress?.seasonNumber || selectedSeason || 1));
      const episode = Math.max(1, Number(progress?.episodeNumber || 1));
      const direct = directEpisodeUrl(item, season, episode);
      if (direct) return direct;
      const local = libraryEpisodeFor(item, season, episode);
      return String(local?.offlineUrl || local?.hls_url || local?.source_url || "");
    }
    const local = libraryEpisodeFor(item);
    return String(local?.offlineUrl || local?.hls_url || local?.source_url || selectedVideoVariant(item)?.url || "");
  }
  function stopDetailPrebuffer() {
    if (!detailPrebuffer) return;
    if (detailPrebuffer.timer) window.clearTimeout(detailPrebuffer.timer);
    detailPrebuffer.hls?.destroy();
    if (detailPrebuffer.video) {
      detailPrebuffer.video.pause();
      detailPrebuffer.video.removeAttribute("src");
      detailPrebuffer.video.load();
      detailPrebuffer.video.remove();
    }
    detailPrebuffer = null;
  }
  function startDetailPrebuffer(item) {
    stopDetailPrebuffer();
    const sourceUrl = detailPrebufferUrl(item);
    const status = $("#detail-prebuffer-status");
    if (!sourceUrl || document.visibilityState === "hidden") {
      if (status) status.textContent = "Буфер начнёт загружаться после выбора доступного источника.";
      return;
    }
    const expectedTitleId = item.id;
    const holder = { timer: null, hls: null, video: null };
    holder.timer = window.setTimeout(() => {
      if (activeTitleId !== expectedTitleId || detailPrebuffer !== holder) return;
      const video = document.createElement("video");
      video.className = "detail-prebuffer-media";
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.tabIndex = -1;
      video.setAttribute("aria-hidden", "true");
      page.appendChild(video);
      holder.video = video;
      const markReady = () => { if (status && detailPrebuffer === holder) status.textContent = "Начало видеопотока заранее подготовлено."; };
      const markUnavailable = () => { if (status && detailPrebuffer === holder) status.textContent = "Предзагрузка недоступна — плеер попробует поток при запуске."; };
      if (isHlsUrl(sourceUrl) && window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls(HLS_PREBUFFER_CONFIG);
        holder.hls = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => { if (status && detailPrebuffer === holder) status.textContent = "Загружаю начало видеопотока в буфер…"; });
        hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => {
          const tracks = [];
          const seen = new Set();
          (hls.audioTracks || []).forEach((track, index) => {
            const key = hlsTrackKey(track, String(index));
            if (seen.has(key)) return;
            seen.add(key);
            tracks.push({ key, label: hlsTrackLabel(track, `Дорожка ${index + 1}`) });
          });
          if (!tracks.length) return;
          item.availableHlsAudioTracks = tracks;
          const select = $("#detail-hls-audio");
          if (select) setSelectOptions(select, tracks.map((track) => ({ value: track.key, label: track.label })), selectedHlsAudioKey(item) || tracks[0].key);
        });
        hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
          let buffered = 0;
          try { buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0; } catch {}
          if (buffered >= 8) { hls.stopLoad(); markReady(); }
        });
        hls.on(window.Hls.Events.ERROR, (_event, data) => { if (data?.fatal) markUnavailable(); });
        hls.loadSource(sourceUrl);
        hls.attachMedia(video);
      } else {
        video.addEventListener("canplay", markReady, { once: true });
        video.addEventListener("error", markUnavailable, { once: true });
        video.src = sourceUrl;
        video.load();
      }
    }, 250);
    detailPrebuffer = holder;
  }
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
      ? "Сейчас открыт локальный адрес 127.0.0.1. На другом устройстве он указывает на само устройство. Откройте CineVault через внешний SSH-адрес и передайте ссылку комнаты оттуда."
      : "Проверьте, что внешний SSH-адрес всё ещё активен и ведёт на порт 8081.";
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
  async function createWatchRoom(item, season, episode) {
    const isLocalEpisode = Boolean(item?.source_type && item?.id);
    const payload = {
      episode_id: isLocalEpisode && item.source_type !== "external_embed" ? item.id : "",
      title_id: watchRoomTitleId(item),
      target_key: watchRoomTargetKey(item, season || item?.season, episode || item?.episode),
      season: Number(season || item?.season || 0),
      episode: Number(episode || item?.episode || 0),
    };
    const response = await apiFetch("/api/watch/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
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
    const targetKey = String(roomState.target_key || "");
    const titleId = String(roomState.title_id || targetKey.replace(/-s\d+e\d+$/, "") || "");
    const item = getTitle(titleId) || catalog.find((entry) => entry.id === titleId);
    if (!item) {
      roomOpenAttempted = true;
      showWatchRoomEntryError("В комнате указан тайтл, которого нет в текущем каталоге.");
      return;
    }
    roomOpenAttempted = true;
    if (item.kind === "movie" && getVideoVariants(item).length) return openItemPlayer(item, null, null, roomId);
    const season = Number(roomState.season || 1);
    const episode = Number(roomState.episode || 1);
    const sourceUrl = directEpisodeUrl(item, season, episode);
    if (sourceUrl) return openItemPlayer(item, episode, season, roomId);
    const localEpisode = libraryEpisodes.find((candidate) => candidate.id === roomState.episode_id || (candidate.title_id === titleId && Number(candidate.season) === season && Number(candidate.episode) === episode));
    if (localEpisode) return openLibraryPlayer(localEpisode, roomId);
    showWatchRoomEntryError("Для этого тайтла не найден подключённый видеопоток на сервере.");
  }
  function installWatchRoomSync({ roomId, video, item, season, episode, roomStatus, onEpisodeChange }) {
    if (!roomId || !video) return null;
    let disposed = false;
    let lastSeq = 0;
    let currentSeason = Number(season || 0);
    let currentEpisode = Number(episode || 0);
    let suppressUntil = 0;
    let localActionUntil = 0;
    let pendingPublishes = 0;
    let publishTimer = null;
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
      if (!seq || seq <= lastSeq) return;
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
    const poll = async () => { if (!disposed) { try { apply(await loadWatchRoom(roomId)); } catch (error) { setRoomStatus(`Совместный просмотр недоступен: ${error.message}`, true); } } };
    const interval = window.setInterval(poll, 900);
    setRoomStatus("Совместный просмотр · подключаюсь…");
    poll();
    return { publish, publishEpisode, isApplying, schedulePublish: () => { window.clearTimeout(publishTimer); publishTimer = window.setTimeout(() => publish(), 120); }, dispose: () => { disposed = true; window.clearInterval(interval); window.clearTimeout(publishTimer); } };
  }
  function hlsResponseStatus(data) {
    return Number(data?.response?.code || data?.response?.status || data?.networkDetails?.status || 0);
  }
  function sourceErrorMarkup(statusCode, fallback) {
    return Number(statusCode) === 410
      ? "<strong>Ссылка на видео больше не действует.</strong> Обновите ссылки на источник и попробуйте открыть видео снова."
      : fallback;
  }
  function sourceErrorCardMarkup(statusCode, fallback) {
    const expired = Number(statusCode) === 410;
    const title = expired ? "Видеопоток нужно обновить" : "Не удалось подключить видеопоток";
    const detail = expired ? "Ссылка на это видео устарела. Обновите ссылку в импорте и откройте его снова." : fallback;
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
    const toggle = () => toggleVideoPlayback(video, onBlocked);
    playButton?.addEventListener("click", toggle);
    playOverlay?.addEventListener("click", toggle);
    video.addEventListener("click", (event) => { if (event.target === video) toggle(); });
    ["play", "pause", "ended"].forEach((eventName) => video.addEventListener(eventName, sync));
    sync();
  }
  function rememberPlayerContext() {
    playerReturnContext = { titleId: activeTitleId, view: state.view, season: selectedSeason };
  }
  function returnFromPlayer() {
    const context = playerReturnContext;
    playerReturnContext = null;
    modalRoot.innerHTML = "";
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
  async function beginCinematicFullscreen() {
    const mobile = window.matchMedia?.("(max-width: 720px)").matches;
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
      if (mobile && screen.orientation?.lock) await screen.orientation.lock("landscape").catch(() => {});
    } catch {}
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
      ["pointermove", "pointerdown", "touchstart", "keydown", "focusin"].forEach((eventName) => player.removeEventListener(eventName, reveal));
      player.removeEventListener("focusout", scheduleHide);
      player.removeEventListener("dblclick", onDoubleClick);
    };
  }
  function hasPlayableSource(item) { return Boolean(libraryEpisodeFor(item) || item?.rutubeId || getVideoVariants(item).length || Object.values(item?.episodeSourceTokens || {}).some((source) => source.sourceUrl)); }
  async function openItemPlayer(item, episodeNumber = null, seasonNumber = null, roomId = null, refreshSource = true) {
    if (!item) return;
    stopDetailPrebuffer();
    if (refreshSource) item = await refreshKinopoiskPlayback(item);
    if (roomId !== null) activeWatchRoomId = String(roomId || "");
    rememberPlayerContext();
    const titleProgress = item.kind === "series" ? progressForTitle(item) : null;
    if (item.kind === "series") {
      if (seasonNumber != null) selectedSeason = Math.max(1, Number(seasonNumber) || 1);
      else if (episodeNumber == null && titleProgress?.seasonNumber) selectedSeason = Math.max(1, Number(titleProgress.seasonNumber) || 1);
    }
    const targetEpisode = episodeNumber || (item.kind === "series" ? titleProgress?.episodeNumber || 1 : null);
    const sourceUrl = directEpisodeUrl(item, selectedSeason, targetEpisode);
    if (sourceUrl) return openRemoteEpisodePlayer(item, selectedSeason, targetEpisode, sourceUrl, roomId || "");
    const localEpisode = libraryEpisodeFor(item, selectedSeason, targetEpisode);
    if (localEpisode) return openLibraryPlayer(localEpisode, roomId || "");
    if (getVideoVariants(item).length) return openVideoPlayer(item.id, episodeNumber, roomId || "");
    if (item.rutubeId) return openRutubePlayer(item.rutubeId, item.title, item.id);
    openPlayer(item.id, episodeNumber);
  }
  function watchButton(item, label = "Смотреть") {
    if (hasPlayableSource(item)) return `<button class="primary-button" data-play-media="${escapeHtml(item.id)}" type="button">${escapeHtml(label)}</button>`;
    return "";
  }
  function playbackPreferencesMarkup(item) {
    if (!hasPlayableSource(item)) return "";
    const choice = titlePlaybackSelection(item);
    const variants = getVideoVariants(item);
    const sourceOptions = [...new Set(variants.map((variant) => variant.quality).filter(Boolean))];
    const voiceOptions = titleVoiceOptions(item);
    const hlsTracks = Array.isArray(item.availableHlsAudioTracks) ? item.availableHlsAudioTracks : [];
    const selectedVariant = selectedVideoVariant(item, variants);
    const sourceControl = item.kind !== "series" && sourceOptions.length > 1
      ? playerSelectMarkup("detail-playback-source", "Источник", sourceOptions.map((source) => ({ value: source, label: source, selected: source === (choice.source || selectedVariant?.quality) })))
      : `<div class="playback-preference-static"><span>Источник</span><strong>${escapeHtml(selectedVariant?.sourceName || item.providerName || "Подключённый поток")}</strong></div>`;
    const voiceControl = voiceOptions.length > 1
      ? playerSelectMarkup("detail-playback-voice", "Озвучка", voiceOptions.map((voice) => ({ value: voice, label: voice, selected: voice === (choice.voice || selectedVariant?.voice) })))
      : `<div class="playback-preference-static"><span>Озвучка</span><strong>${escapeHtml(voiceOptions[0] || selectedVariant?.voice || "По умолчанию")}</strong></div>`;
    const hlsAudioControl = hlsTracks.length > 1
      ? playerSelectMarkup("detail-hls-audio", "Дорожка HLS", hlsTracks.map((track) => ({ value: track.key, label: track.label, selected: track.key === (choice.hlsAudio || hlsTracks[0]?.key) })))
      : `<select id="detail-hls-audio" hidden aria-hidden="true"></select>`;
    return `<section class="playback-preferences" aria-label="Параметры просмотра"><div><div class="section-kicker">Перед просмотром</div><h2>Настрой один раз</h2><p>Источник и озвучка будут применяться ко всем сериям, где они доступны.</p></div><div class="playback-preferences-controls">${sourceControl}${voiceControl}${hlsAudioControl}</div></section>`;
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
  function getPet() { return ({ plush: ["🐶", "Мопс", "уютный помощник по выбору кино"], noir: ["🐈‍⬛", "Нуар", "спокойный советчик"], pixie: ["🐰", "Пикси", "нежный романтик"], moti: ["🐻", "Моти", "любит комедии"] })[state.companion] || ["🐶", "Мопс", "уютный помощник по выбору кино"]; }
  function petVisual(className = "") { const [emoji, name] = getPet(); return state.companion === "plush" ? `<img class="pet-avatar ${className}" src="./assets/pug-mascot.png" alt="${escapeHtml(name)}">` : `<span class="pet-emoji ${className}" aria-label="${escapeHtml(name)}">${emoji}</span>`; }
  function syncAssistant() { const [, petName, description] = getPet(); $("#header-pet") && ($("#header-pet").innerHTML = petVisual("header-pet-visual")); $("#header-pet-name") && ($("#header-pet-name").textContent = petName); $("#assistant-name") && ($("#assistant-name").textContent = petName); $("#assistant-pet img")?.setAttribute("alt", petName); $("#assistant-copy") && ($("#assistant-copy").textContent = state.companion === "plush" ? "Я рядом. Иногда ем, иногда сплю, но рекомендации держу под контролем." : `${description}. Подберу фильм под ваше настроение.`); $$(".pet-choice").forEach((button) => button.classList.toggle("is-selected", button.dataset.pet === state.companion)); }
  function setPetState(mode = "idle") { const rail = $("#assistant-rail"); const pet = $("#assistant-pet"); if (!rail || !pet) return; rail.classList.remove("is-sleeping", "is-snacking"); pet.classList.remove("is-sleeping", "is-eating", "is-falling", "is-happy"); if (mode === "sleep") { rail.classList.add("is-sleeping"); pet.classList.add("is-sleeping"); } if (mode === "snack") { rail.classList.add("is-snacking"); pet.classList.add("is-eating"); } if (mode === "fall") pet.classList.add("is-falling"); if (mode === "happy") pet.classList.add("is-happy"); }
  function startPetStates() { const modes = ["idle", "snack", "idle", "sleep", "idle", "fall", "happy"]; let index = 0; setPetState(modes[index]); window.setInterval(() => { index = (index + 1) % modes.length; setPetState(modes[index]); }, 5200); }
  function persistAndRender() { saveState(); render(); }
  function renderCatalogLoading() {
    const viewLabels = { home: "Для вас", catalog: "Каталог", movies: "Фильмы", series: "Сериалы", favorites: "Избранное", evening: "Наш вечер", history: "История просмотра" };
    const label = viewLabels[state.view] || "Каталог";
    const skeletons = Array.from({ length: 8 }, (_, index) => `<div class="catalog-loading-card" aria-hidden="true"><div class="catalog-loading-poster"></div><span class="catalog-loading-line catalog-loading-line-wide"></span><span class="catalog-loading-line"></span></div>`).join("");
    page.innerHTML = `<section class="catalog-loading-shell" role="status" aria-live="polite"><div class="eyebrow">CineVault</div><h1>${label}</h1><p>Подготавливаю страницу и загружаю карточки…</p><div class="catalog-loading-grid">${skeletons}</div></section>`;
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

  function recommendation() {
    const unseen = catalog.filter((item) => !hasSharedHistory(item));
    const candidates = unseen.length ? unseen : catalog;
    return sortPersonalRecommendations(candidates)[0] || catalog[0];
  }

  function nextRecommendation() {
    const unseen = catalog.filter((item) => !hasSharedHistory(item));
    const candidates = sortPersonalRecommendations(unseen.length ? unseen : catalog);
    if (!candidates.length) return null;
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const history = Array.isArray(state.recommendationHistory) ? state.recommendationHistory : [];
    const recentIds = new Set(history.filter((entry) => Number(entry?.at || 0) > weekAgo).map((entry) => String(entry?.id || entry)).filter(Boolean));
    const freshCandidates = candidates.filter((item) => !recentIds.has(item.id));
    const pool = (freshCandidates.length ? freshCandidates : candidates).slice(0, Math.min(24, candidates.length));
    const totalWeight = pool.reduce((sum, _item, index) => sum + Math.pow(pool.length - index, 1.35), 0);
    let cursor = Math.random() * totalWeight;
    let pick = pool[pool.length - 1];
    for (let index = 0; index < pool.length; index += 1) {
      cursor -= Math.pow(pool.length - index, 1.35);
      if (cursor <= 0) { pick = pool[index]; break; }
    }
    state.recommendationHistory = [...history, { id: pick.id, at: now }].slice(-40);
    saveState();
    recommendationCandidateKey = candidates.map((item) => item.id).join("|");
    recommendationCursor += 1;
    return pick;
  }

  function poster(item, extra = "") {
    const progress = progressForTitle(item);
    const progressPct = progress ? Math.min(100, Math.round((progress.position / progress.duration) * 100)) : 0;
    const meta = [item.year, catalogRatingLabel(item), item.kind === "series" ? `${item.seasons.length} сезонов` : formatRuntime(item.runtime)].filter(Boolean);
    const genres = genresForItem(item).slice(0, 3);
    return `<a class="poster-card ${extra}" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}" aria-label="Открыть ${escapeHtml(item.title)}"><div class="poster-art" style="${posterStyle(item)}">${posterTitleArt(item)}${progress ? `<span class="progress-bar" style="--progress:${progressPct}%"><i></i></span>` : ""}</div><div class="poster-card-copy"><strong>${escapeHtml(item.title)}</strong><div class="poster-card-meta">${meta.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div><p class="poster-card-description">${escapeHtml(item.description || "Подробности появятся после синхронизации каталога.")}</p><div class="poster-card-tags">${genres.map((genre) => `<span>#${escapeHtml(genre)}</span>`).join("")}</div></div></a>`;
  }

  function resumePoster(item, progress) {
    const progressPct = Math.min(100, Math.round((progress.position / progress.duration) * 100));
    const episodeText = progress.episodeNumber ? ` · S${String(progress.seasonNumber).padStart(2, "0")}E${String(progress.episodeNumber).padStart(2, "0")}` : "";
    const playbackAttr = hasPlayableSource(item) ? `data-play-media="${item.id}"` : `data-demo-play="${item.id}"`;
    const episodeAttrs = progress.episodeNumber ? `data-resume-season="${Number(progress.seasonNumber) || 1}" data-episode="${Number(progress.episodeNumber)}"` : "";
    return `<button class="poster-card" ${playbackAttr} ${episodeAttrs} type="button"><div class="poster-art" style="${posterStyle(item)}">${posterTitleArt(item)}<span class="progress-bar" style="--progress:${progressPct}%"><i></i></span></div><strong>${escapeHtml(item.title)}</strong><small>${item.kind === "series" ? `${item.seasons.length} сезонов${episodeText}` : `${item.year} · ${formatTime(progress.position)} из ${formatTime(progress.duration)}`}</small></button>`;
  }

  function render() {
    stopDetailPrebuffer();
    activeTitleId = null;
    app.dataset.theme = state.theme;
    syncAssistant();
    $("#search").value = state.query;
    $$(".nav-item[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === state.view));
    if (catalogHydrating && ["home", "catalog", "movies", "series", "favorites", "evening", "history"].includes(state.view)) {
      renderCatalogLoading();
      return;
    }
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
    const pickWatch = hasPlayableSource(pick) ? watchButton(pick, "Смотреть") : "";
    const continueItems = Object.entries(state.progress).map(([contentId, progress]) => ({ item: getTitleForProgress(contentId, progress), progress: { ...progress, contentId } })).filter((entry) => entry.item && !entry.progress.completed).sort((a, b) => b.progress.updatedAt - a.progress.updatedAt);
    const moodTitle = moodDefinition(state.mood)?.title || state.mood;
    const shelves = [
      discoveryShelf({ id: "personal", eyebrow: "Персонально для тебя", title: "Мопс советует", description: "Похожие на то, что тебе уже понравилось, с учётом жанров, актёров и режиссёров.", items: personalCollectionItems(8) }),
      discoveryShelf({ id: "mood", eyebrow: "Под твоё настроение", title: moodTitle, description: moodDefinition(state.mood)?.description || "Подборка по жанрам и атмосфере.", items: collectionItems("mood", 8) }),
      discoveryShelf({ id: "evening", eyebrow: "Без лишнего выбора", title: "На один вечер", description: "Фильмы, которые удобно включить сегодня.", items: collectionItems("evening", 8) }),
      discoveryShelf({ id: "anime", eyebrow: "Отдельная полка", title: "Аниме", description: "Сериалы и фильмы с жанром «аниме».", items: collectionItems("anime", 8) }),
    ].filter(Boolean).join("");
    page.innerHTML = `<section class="home-hero"><div class="hero-card"><div class="eyebrow">Рекомендация на сегодня</div><h1>${escapeHtml(pick.title)}</h1><p>${escapeHtml(recommendationReason(pick))}</p><div class="hero-actions">${pickWatch}<a class="secondary-button" href="${routeForTitle(pick.id)}" data-open-title="${escapeHtml(pick.id)}">Открыть карточку</a></div></div><div class="companion-card"><div class="pet-art" aria-label="${escapeHtml(petName)}">${petEmoji}</div><div><h2>${escapeHtml(petName)} рядом</h2><p>${escapeHtml(petDescription)}. Подберу варианты по жанрам, настроению и тому, что вы уже смотрели.</p></div><div class="mood-row" role="group" aria-label="Настроение">${["уютно", "романтично", "смеяться", "напряжённо"].map((mood) => `<button class="mood-button ${state.mood === mood ? "is-active" : ""}" data-mood="${mood}" type="button">${escapeHtml(moodDefinition(mood)?.shortLabel || mood)}</button>`).join("")}</div></div></section>${continueItems.length ? `<section class="section"><div class="section-header"><div><div class="section-kicker">Не потерять место</div><h2>Продолжить просмотр</h2></div><button class="text-button" data-view="history" type="button">Вся история</button></div><div class="poster-grid">${continueItems.slice(0, 4).map(({ item, progress }) => resumePoster(item, progress)).join("")}</div></section>` : ""}${shelves}`;
    bindPageActions();
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
    { id: "popular", title: "Популярное", description: "Рейтинг и интерес в библиотеке" },
    { id: "mood", title: "Под настроение", description: "Выбранное настроение" },
    { id: "evening", title: "На вечер", description: "Фильмы на один вечер" },
    { id: "romance", title: "Для двоих", description: "Романтика и лёгкие истории" },
    { id: "thrill", title: "Напряжённое", description: "Триллеры, детективы, ужасы" },
    { id: "anime", title: "Аниме", description: "Аниме-сериалы и фильмы" },
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
    return matches * 12 + catalogRatingValue(item) * .45 + Math.max(0, Number(item.year || 0) - 2000) * .015;
  }

  function itemLocalInterest(item) {
    return (state.favorites.includes(item.id) ? 3 : 0) + (hasSharedHistory(item) ? 2 : 0) + (state.watchlist.includes(item.id) ? 1 : 0);
  }

  function matchesCollection(item, collectionId = state.catalogCollection) {
    const tags = itemDiscoveryTags(item);
    if (!collectionId || collectionId === "popular") return true;
    if (collectionId === "mood") return (catalogMoodTags[state.mood] || []).some((tag) => tags.has(normalizeCatalogGenre(tag)));
    if (collectionId === "evening") return item.kind === "movie" && (!item.runtime || Number(item.runtime) <= 155);
    if (collectionId === "romance") return ["мелодрама", "комедия", "драма"].some((tag) => tags.has(tag));
    if (collectionId === "thrill") return ["триллер", "детектив", "ужасы", "криминал", "боевик"].some((tag) => tags.has(tag));
    if (collectionId === "anime") return tags.has("аниме");
    return true;
  }

  function discoveryScore(item, collectionId = "popular") {
    const base = catalogRatingValue(item) * 3 + Math.max(0, Number(item.year || 0) - 2000) * .04 + itemLocalInterest(item) * 2;
    if (collectionId === "mood") return base + moodScore(item) * 3;
    if (collectionId === "romance") return base + moodScore(item, "романтично") * 2;
    if (collectionId === "thrill") return base + moodScore(item, "напряжённо") * 2;
    if (collectionId === "evening") return base + (item.kind === "movie" ? 3 : 0);
    return base;
  }

  function sortDiscoveryItems(items, collectionId = "popular") {
    return [...items].sort((left, right) => discoveryScore(right, collectionId) - discoveryScore(left, collectionId) || catalogRatingValue(right) - catalogRatingValue(left) || Number(right.year || 0) - Number(left.year || 0) || String(left.title || "").localeCompare(String(right.title || ""), "ru"));
  }

  function recommendationInteractionWeight(item) {
    const progress = progressForTitle(item);
    const progressRatio = progress?.duration > 0 ? Number(progress.position || 0) / Number(progress.duration) : 0;
    let weight = 0;
    if (state.favorites.includes(item.id)) weight += 6;
    if (state.watchlist.includes(item.id)) weight += 2;
    if (hasSharedHistory(item)) weight += progress?.completed || progressRatio >= .8 ? 5 : 3;
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
    catalog.forEach((item) => {
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
    const genreScore = profileOverlap(genresForItem(item), profile.genres) * 2.2;
    const actorScore = profileOverlap(item.actors, profile.actors) * 1.3;
    const directorScore = profileOverlap(item.directors, profile.directors) * 1.7;
    const countryScore = profileOverlap(item.countries, profile.countries) * .55;
    const kindScore = (profile.kinds.get(String(item.kind || "").trim()) || 0) * .7;
    const averageYear = weightedAverage(profile.years);
    const averageRuntime = weightedAverage(profile.runtimes);
    const yearScore = averageYear && Number(item.year) ? Math.max(0, 4 - Math.abs(Number(item.year) - averageYear) / 12) : 0;
    const runtimeScore = averageRuntime && Number(item.runtime) ? Math.max(0, 2 - Math.abs(Number(item.runtime) - averageRuntime) / 45) : 0;
    const moodScoreValue = moodScore(item) * 1.15;
    const qualityScore = catalogRatingValue(item) * 1.4;
    return genreScore + actorScore + directorScore + countryScore + kindScore + yearScore + runtimeScore + moodScoreValue + qualityScore;
  }

  function sortPersonalRecommendations(items) {
    const profile = recommendationProfile();
    return [...items].sort((left, right) => personalRecommendationScore(right, profile) - personalRecommendationScore(left, profile) || discoveryScore(right, "mood") - discoveryScore(left, "mood") || String(left.title || "").localeCompare(String(right.title || ""), "ru"));
  }

  function collectionItems(collectionId, limit = 8) {
    return sortDiscoveryItems(catalog.filter((item) => matchesCollection(item, collectionId)), collectionId).slice(0, limit);
  }

  function personalCollectionItems(limit = 8) {
    const unseen = catalog.filter((item) => !hasSharedHistory(item));
    return sortPersonalRecommendations(unseen.length ? unseen : catalog).slice(0, limit);
  }

  function catalogCollectionDefinition(collectionId = state.catalogCollection) {
    return catalogCollections.find((collection) => collection.id === collectionId) || null;
  }

  function recommendationReason(item) {
    const tags = itemDiscoveryTags(item);
    const moodMatch = (catalogMoodTags[state.mood] || []).map(normalizeCatalogGenre).find((tag) => tags.has(tag));
    const rating = catalogRatingValue(item);
    const profile = recommendationProfile();
    const personalGenre = genresForItem(item).find((genre) => profile.genres.has(normalizeCatalogGenre(genre)));
    const personalActor = (Array.isArray(item.actors) ? item.actors : item.actors ? [item.actors] : []).find((actor) => profile.actors.has(normalizeCatalogGenre(actor)));
    const personalDirector = (Array.isArray(item.directors) ? item.directors : item.directors ? [item.directors] : []).find((director) => profile.directors.has(normalizeCatalogGenre(director)));
    const personalMatch = personalActor ? `Похожий актёр: ${personalActor}.` : personalDirector ? `Похожий режиссёр: ${personalDirector}.` : personalGenre ? `Совпадает любимый жанр: ${personalGenre}.` : "Подобрано по твоему профилю и рейтингу.";
    return `${personalMatch} ${moodMatch ? `Подходит под настроение: ${moodMatch}.` : ""}${rating ? ` Рейтинг в каталоге — ${rating.toFixed(1)}.` : ""}`.trim();
  }

  function catalogSearchText(item) {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return [item.title, item.originalTitle, item.description, ...genresForItem(item), ...tags, ...(item.countries || []), ...(item.actors || []), ...(item.directors || [])].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU");
  }

  function searchMatches(query = state.query) {
    const needle = String(query || "").trim().toLocaleLowerCase("ru-RU");
    if (!needle) return [];
    return sortDiscoveryItems(catalog.filter((item) => catalogSearchText(item).includes(needle)), "popular");
  }

  function discoveryShelf({ id, eyebrow, title, description, items }) {
    if (!items.length) return "";
    return `<section class="discovery-shelf" aria-labelledby="shelf-${escapeHtml(id)}"><div class="section-header discovery-shelf-header"><div><div class="section-kicker">${escapeHtml(eyebrow)}</div><h2 id="shelf-${escapeHtml(id)}">${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><button class="text-button" data-open-collection="${escapeHtml(id)}" type="button">Смотреть всё</button></div><div class="discovery-rail" aria-label="${escapeHtml(title)}">${items.map((item) => poster(item, "discovery-poster")).join("")}</div></section>`;
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
    const counts = new Map();
    catalog.filter((item) => catalogViewMatches(item) && matchesCollection(item)).forEach((item) => genresForItem(item).forEach((genre) => counts.set(genre, (counts.get(genre) || 0) + 1)));
    const selectedGenre = normalizeCatalogGenre(state.catalogGenre);
    if (selectedGenre && !counts.has(selectedGenre)) counts.set(selectedGenre, 0);
    return [...counts.entries()]
      .map(([genre, count]) => ({ genre, count }))
      .sort((left, right) => right.count - left.count || left.genre.localeCompare(right.genre, "ru"));
  }

  function catalogRatingValue(item) {
    const value = Number(item?.ratingKinopoisk ?? item?.rating ?? item?.imdbRating ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  function sortCatalogItems(items) {
    const sort = ["rating", "year", "title"].includes(state.catalogSort) ? state.catalogSort : "rating";
    return [...items].sort((left, right) => {
      if (sort === "title") return String(left.title || "").localeCompare(String(right.title || ""), "ru");
      if (sort === "year") return Number(right.year || 0) - Number(left.year || 0) || catalogRatingValue(right) - catalogRatingValue(left);
      return catalogRatingValue(right) - catalogRatingValue(left) || Number(right.year || 0) - Number(left.year || 0);
    });
  }

  function filteredCatalog() {
    const query = String(state.query || "").trim().toLocaleLowerCase("ru-RU");
    const selectedGenre = normalizeCatalogGenre(state.catalogGenre);
    const items = catalog.filter((item) => {
      const tags = itemDiscoveryTags(item);
      const genres = genresForItem(item);
      const queryOkay = !query || catalogSearchText(item).includes(query);
      const genreOkay = !selectedGenre || genres.includes(selectedGenre);
      const moodOkay = !state.catalogMoodOnly || (catalogMoodTags[state.mood] || [state.mood]).some((tag) => tags.has(normalizeCatalogGenre(tag)));
      const playableOkay = !state.catalogPlayableOnly || hasPlayableSource(item);
      return catalogViewMatches(item) && matchesCollection(item) && queryOkay && genreOkay && moodOkay && playableOkay;
    });
    // Catalog sorting is a user choice. Discovery ranking is still used for
    // recommendation shelves, but must not silently override this control in
    // a collection such as "Под настроение".
    return sortCatalogItems(items);
  }

  function catalogCountLabel(count) {
    const tens = count % 100;
    const units = count % 10;
    const noun = units === 1 && tens !== 11 ? "карточка" : units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? "карточки" : "карточек";
    return `${count} ${noun}`;
  }

  const catalogPageSize = 50;
  function catalogPagination(items) {
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
    state.catalogGenre = "";
    state.catalogCollection = "";
    state.catalogMoodOnly = false;
    state.catalogPlayableOnly = false;
    state.catalogSort = "rating";
    resetCatalogPage();
    const search = $("#search");
    if (search) search.value = "";
    saveState();
    renderCatalogView();
  }

  function openCatalogCollection(collectionId) {
    state.catalogCollection = collectionId;
    state.catalogMoodOnly = false;
    state.catalogGenre = "";
    state.query = "";
    resetCatalogPage();
    saveState();
    navigateToView("catalog");
  }

  function renderCatalogView() {
    const items = filteredCatalog();
    const pagination = catalogPagination(items);
    if (state.catalogPage !== pagination.currentPage) state.catalogPage = pagination.currentPage;
    const pageItems = pagination.items;
    const genreOptions = catalogGenreOptions();
    const selectedGenre = normalizeCatalogGenre(state.catalogGenre);
    const collection = catalogCollectionDefinition();
    const availableCount = catalog.filter((item) => catalogViewMatches(item) && matchesCollection(item)).length;
    const hasFilters = Boolean(state.query || selectedGenre || collection || state.catalogMoodOnly || state.catalogPlayableOnly || state.view !== "catalog");
    const title = state.view === "favorites" ? "Избранное" : state.view === "evening" ? "Наш вечер" : state.view === "history" ? "История просмотра" : state.view === "movies" ? "Фильмы" : state.view === "series" ? "Сериалы" : state.query ? `Результаты для «${escapeHtml(state.query)}»` : collection ? collection.title : "Каталог";
    const subtitle = state.view === "evening" ? "То, что хочется посмотреть вместе." : state.view === "history" ? "То, к чему можно вернуться в любой момент." : collection?.id === "mood" ? moodDefinition().description : collection ? collection.description : "Ищи по названию, актёрам и жанрам или выбери готовую подборку.";
    const genreButtons = [`<button class="genre-chip ${selectedGenre ? "" : "is-active"}" data-catalog-genre="" type="button" aria-pressed="${selectedGenre ? "false" : "true"}"><span>Все жанры</span><small>${availableCount}</small></button>`, ...genreOptions.map(({ genre, count }) => `<button class="genre-chip ${selectedGenre === genre ? "is-active" : ""}" data-catalog-genre="${escapeHtml(genre)}" type="button" aria-pressed="${selectedGenre === genre ? "true" : "false"}"><span>${escapeHtml(genre.charAt(0).toLocaleUpperCase("ru-RU") + genre.slice(1))}</span><small>${count}</small></button>`)].join("");
    const collectionButtons = [`<button class="collection-chip ${collection ? "" : "is-active"}" data-catalog-collection="" type="button" aria-pressed="${collection ? "false" : "true"}"><strong>Весь каталог</strong><small>Все фильмы и сериалы</small></button>`, ...catalogCollections.map((entry) => `<button class="collection-chip ${collection?.id === entry.id ? "is-active" : ""}" data-catalog-collection="${escapeHtml(entry.id)}" type="button" aria-pressed="${collection?.id === entry.id ? "true" : "false"}"><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.id === "mood" ? moodDefinition().description : entry.description)}</small></button>`)].join("");
    const activeFilters = [collection ? `Подборка: ${collection.title}` : "", selectedGenre ? `Жанр: ${selectedGenre}` : "", state.catalogMoodOnly ? `Настроение: ${state.mood}` : "", state.catalogPlayableOnly ? "Только доступные" : ""].filter(Boolean).join(" · ");
    const emptyCopy = state.query ? `По запросу «${escapeHtml(state.query)}» ничего не найдено. Измени запрос или сбрось фильтры.` : "Попробуй другой жанр или сбрось фильтры, чтобы снова увидеть весь каталог.";
    const paginationMarkup = pagination.totalPages > 1 ? `<nav class="catalog-pagination" aria-label="Страницы каталога"><button class="secondary-button catalog-page-arrow" data-catalog-page="${pagination.currentPage - 1}" type="button" aria-label="Предыдущая страница" title="Предыдущая страница"${pagination.currentPage === 1 ? " disabled" : ""}>←</button><p aria-live="polite">Страница <strong>${pagination.currentPage}</strong> из ${pagination.totalPages}<span> · показано ${pagination.start + 1}–${pagination.end}</span></p><button class="secondary-button catalog-page-arrow" data-catalog-page="${pagination.currentPage + 1}" type="button" aria-label="Следующая страница" title="Следующая страница"${pagination.currentPage === pagination.totalPages ? " disabled" : ""}>→</button></nav>` : "";
    const genreFilterMarkup = state.view === "favorites" ? "" : `<div class="catalog-genre-heading"><h3>Жанры</h3><span>Количество карточек указано справа</span></div><div class="genre-list" role="group" aria-label="Фильтр по жанру">${genreButtons}</div>`;
    page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">CineVault</div><h1>${title}</h1><p class="muted">${subtitle}</p></div></div><section class="catalog-controls" aria-labelledby="catalog-filters-title"><div class="catalog-control-top"><div><h2 id="catalog-filters-title">Подобрать фильм</h2><p>Начни с готовой подборки или уточни тип, жанр и доступность.</p></div><div class="catalog-control-actions"><label class="catalog-sort"><span>Сортировка</span><select data-catalog-sort><option value="rating"${state.catalogSort === "rating" ? " selected" : ""}>С высоким рейтингом</option><option value="year"${state.catalogSort === "year" ? " selected" : ""}>Сначала новые</option><option value="title"${state.catalogSort === "title" ? " selected" : ""}>По алфавиту</option></select></label><button class="secondary-button catalog-random-button" data-catalog-random type="button"${items.length ? "" : " disabled"}>Выбрать случайно</button></div></div><div class="catalog-collection-heading"><h3>Подборки</h3><span>Автоматически по жанрам, рейтингу и вашей истории</span></div><div class="collection-list" role="group" aria-label="Подборки каталога">${collectionButtons}</div><div class="catalog-toolbar" role="group" aria-label="Тип и быстрые фильтры"><button class="filter-button ${state.view === "catalog" ? "is-active" : ""}" data-view="catalog" type="button" aria-pressed="${state.view === "catalog"}">Все</button><button class="filter-button ${state.view === "movies" ? "is-active" : ""}" data-view="movies" type="button" aria-pressed="${state.view === "movies"}">Фильмы</button><button class="filter-button ${state.view === "series" ? "is-active" : ""}" data-view="series" type="button" aria-pressed="${state.view === "series"}">Сериалы</button><button class="filter-button ${state.catalogPlayableOnly ? "is-active" : ""}" data-catalog-playable type="button" aria-pressed="${Boolean(state.catalogPlayableOnly)}">Можно смотреть</button><button class="filter-button ${state.catalogMoodOnly ? "is-active" : ""}" data-mood-filter="${escapeHtml(state.mood)}" type="button" aria-pressed="${Boolean(state.catalogMoodOnly)}">Под настроение: ${escapeHtml(moodDefinition().shortLabel)}</button></div>${genreFilterMarkup}<div class="catalog-result-row"><p><strong>${catalogCountLabel(items.length)}</strong>${activeFilters ? `<span>${escapeHtml(activeFilters)}</span>` : ""}</p>${hasFilters ? `<button class="text-button" data-catalog-reset type="button">Сбросить фильтры</button>` : ""}</div></section>${items.length ? `<div class="poster-grid" id="catalog-results" tabindex="-1">${pageItems.map((item) => poster(item)).join("")}</div>${paginationMarkup}` : `<div class="empty-state"><div class="empty-pet">${petVisual()}</div><h2>Ничего не подошло</h2><p>${emptyCopy}</p><button class="primary-button" data-catalog-reset type="button">Сбросить фильтры</button></div>`}`;
    const liveStatus = $("#catalog-live-status");
    if (liveStatus) window.requestAnimationFrame(() => { liveStatus.textContent = `Каталог обновлён: ${catalogCountLabel(items.length)}.`; });
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
    const downloadAction = item.source_type === "external_embed" ? "" : `<button class="secondary-button" data-library-offline="${item.id}" type="button">Скачать максимум</button>`;
    const sourceLabel = item.source_type === "external_embed" ? "Ссылка на просмотр" : "";
    const externalLinkAction = item.source_type === "external_embed" && item.embed_url ? `<a class="secondary-button" href="${escapeHtml(item.embed_url)}" target="_blank" rel="noopener noreferrer">Открыть ссылку ↗</a>` : "";
    const episodeMeta = [seriesLabel, sourceLabel, progress && !progress.completed ? `продолжить с ${formatTime(position)}` : ""].filter(Boolean).join(" · ");
    return `<article class="library-episode"><div class="library-episode-art"><span>▶</span><small>${seriesLabel}</small><i style="--progress:${progressPct}%"></i></div><div class="library-episode-copy"><div class="eyebrow">${escapeHtml(item.title)}</div><h3>${escapeHtml(item.episode_title)}</h3><p class="muted small">${escapeHtml(episodeMeta)}</p><div class="library-episode-actions">${item.status === "ready" ? `<button class="primary-button" data-library-play="${item.id}" type="button">${progress && !progress.completed ? "Продолжить" : "Смотреть"}</button>${externalLinkAction}${downloadAction}<button class="secondary-button" data-library-room="${item.id}" type="button">Совместный просмотр</button>` : `<button class="secondary-button" data-library-refresh type="button">Обновить статус</button>`}</div></div></article>`;
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

  function renderLibraryView() {
    page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Shared backend library</div><h1>Общий каталог</h1><p class="muted">Фильмы и серии устанавливаются один раз на backend. Все пользователи смотрят общий HLS-поток, а текущий MVP сохраняет продолжение в браузере.</p></div><span class="library-status">${escapeHtml(libraryStatus)}</span></div>${catalogSearchMarkup()}<section class="library-upload-card kinopoisk-import-card"><div><div class="section-kicker">Kinopoisk</div><h2>Добавить фильм или сериал</h2><p class="muted small">Вставь ID или ссылку на карточку. CineVault запустит привычную команду импорта, обновит каталог и сообщит, когда карточка готова.</p></div><form id="kinopoisk-import-form" class="library-upload-form"><label for="kinopoisk-import-input">Kinopoisk ID или ссылка<input id="kinopoisk-import-input" name="kinopoisk" required autocomplete="off" placeholder="Например, 689 или https://www.kinopoisk.ru/film/689/"></label><button class="primary-button" type="submit">Добавить в каталог</button><p id="kinopoisk-import-feedback" class="muted small" role="status" aria-live="polite"></p></form></section><section class="library-upload-card"><div><h2>Админский импорт</h2><p class="muted small">Для всего сезона можно выбрать папку целиком. Система сама разберёт <code>S01E01</code> или <code>Season 01/01.mp4</code>; обычным пользователям импорт не нужен.</p></div><form id="library-upload-form" class="library-upload-form"><input id="library-metadata" name="metadata" type="hidden" value="{}"><label>Админский ключ<input id="library-admin-token" type="password" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><label>Название тайтла<input name="title" data-library-title required maxlength="200" placeholder="Выбери карточку выше"></label><div class="library-upload-row"><label>Сезон<input name="season" type="number" min="0" value="1"></label><label>Серия<input name="episode" type="number" min="0" value="1"></label><label class="library-upload-wide">Название серии<input name="episode_title" maxlength="200" placeholder="Для одного файла"></label></div><label>Файлы или папка сезона<input name="file" type="file" required multiple webkitdirectory directory accept="video/*,.mkv,.avi"></label><button class="primary-button" type="submit">Импортировать выбранные серии</button><p id="library-upload-feedback" class="muted small" aria-live="polite"></p></form></section><section class="library-upload-card"><div><h2>Добавить RUTUBE-видео</h2><p class="muted small">Вставь ссылку RUTUBE вида <code>https://rutube.ru/video/...</code> или <code>/play/embed/...</code>. CineVault откроет официальный RUTUBE-плеер и не забирает прямой поток.</p></div><form id="library-external-form" class="library-upload-form"><label>Админский ключ<input name="admin_token" type="password" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><label>Название тайтла<input name="title" data-library-title required maxlength="200" placeholder="Например, Отчаянные домохозяйки"></label><div class="library-upload-row"><label>Сезон<input name="season" type="number" min="0" value="1"></label><label>Серия<input name="episode" type="number" min="0" value="1"></label><label class="library-upload-wide">Название серии<input name="episode_title" maxlength="200" placeholder="Например, Пилотная серия"></label></div><label>Ссылка RUTUBE<textarea name="embed_url" required rows="3" placeholder="https://rutube.ru/video/... или https://rutube.ru/play/embed/..."></textarea></label><button class="primary-button" type="submit">Подключить RUTUBE-плеер</button><p id="library-external-feedback" class="muted small" aria-live="polite"></p></form></section><section class="library-upload-card"><div><h2>Импорт JSON озвучек</h2><p class="muted small">Для фильма загрузи варианты с полями <code>data → translations → m3u8/name/quality</code>. Также поддерживаются <code>hlsUrl</code>, <code>filepath</code>, <code>url</code>, <code>sources</code> и <code>videoSources</code>. Система добавит или обновит карточку по Kinopoisk ID и сохранит только стабильные разрешённые HLS-ссылки.</p></div><form id="library-source-json-form" class="library-upload-form"><label>Админский ключ<input name="admin_token" type="password" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><div class="library-upload-row"><label>Kinopoisk ID<input name="kinopoisk_id" type="number" min="1" required placeholder="258687"></label><label>Тип<select name="kind"><option value="movie">Фильм</option><option value="series">Сериал</option></select></label><label class="library-upload-wide">Название (необязательно)<input name="title" maxlength="200" placeholder="Если карточки ещё нет"></label></div><label>Дополнительные метаданные (необязательно)<textarea name="metadata" rows="4" placeholder='{"title":"Интерстеллар","year":2014,"poster_url":"https://..."}'></textarea></label><label>JSON-файл источника<input name="source_json" type="file" required accept=".json,application/json"></label><button class="primary-button" type="submit">Добавить озвучки в каталог</button><p id="library-source-json-feedback" class="muted small" aria-live="polite"></p></form></section>${libraryEpisodes.length ? `<section class="section library-section"><div class="section-header"><h2>Фильмы и серии на сервере</h2><button class="text-button" data-library-refresh type="button">Обновить</button></div><div class="library-episodes">${libraryEpisodes.map(libraryEpisodeMarkup).join("")}</div></section>` : `<section class="section"><div class="empty-state"><div class="empty-pet">📚</div><h2>Общий каталог пока пуст</h2><p>Добавь первый разрешённый файл на backend. После транскодирования он станет доступен всем пользователям этого сервера.</p></div></section>`}<section class="notice library-notice"><strong>Как это работает.</strong> Локальный файл транскодируется в HLS на backend. RUTUBE-плеер остаётся у RUTUBE и не скачивается CineVault.</section>`;
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
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="catalog-source-import-title"><div class="modal-head"><div><div class="eyebrow">CineVault · карточка ${kindLabel.toLowerCase()}</div><h2 id="catalog-source-import-title">Добавить источник</h2></div><button class="icon-button" id="catalog-source-import-close" type="button" aria-label="Закрыть">×</button></div><p class="muted small">JSON будет привязан к этой карточке. Доступны только стабильные разрешённые ссылки — временные URL с токенами не импортируются.</p><form id="catalog-source-import-form" class="library-upload-form"><label>Админский ключ<input name="admin_token" type="password" value="${escapeHtml(adminToken)}" autocomplete="off" placeholder="CINEVAULT_ADMIN_TOKEN"></label><div class="library-upload-row"><label>Kinopoisk ID<input name="kinopoisk_id" type="number" value="${kinopoiskId}" readonly></label><label>Тип<input type="text" value="${kindLabel}" readonly><input name="kind" type="hidden" value="${kind}"></label><label class="library-upload-wide">Название<input name="title" value="${escapeHtml(item.title || "")}" readonly></label></div><label>Метаданные карточки<textarea name="metadata" rows="7">${escapeHtml(metadataJson)}</textarea></label><label>JSON-файл источника<input name="source_json" type="file" required accept=".json,application/json"></label><div class="hero-actions"><button class="primary-button" type="submit">Добавить видео в карточку</button><button class="secondary-button" id="catalog-source-import-cancel" type="button">Отмена</button></div><p id="catalog-source-import-feedback" class="muted small" aria-live="polite"></p></form></section></div>`;
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
    const [, petName] = getPet();
    const petEmoji = petVisual("settings-pet-visual");
    page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Настройки</div><h1>Под себя и для нас</h1><p class="muted">Всё важное хранится на общем backend-сервере.</p></div></div><div class="settings-grid"><section class="settings-card"><h3>Оформление</h3><p>Графитовая тема теперь собрана на серых и угольных поверхностях: спокойный контраст, серебристые акценты и аккуратные фоновые детали. Тёмная тема остаётся полностью спокойной, без бабочек и облачков.</p><div class="setting-actions"><button class="filter-button ${state.theme === "night" ? "is-active" : ""}" data-set-theme="night" type="button">Тёмная без декора</button><button class="filter-button ${state.theme === "graphite" ? "is-active" : ""}" data-set-theme="graphite" type="button">Серый + графит</button></div></section><section class="settings-card"><h3>Питомец</h3><p class="settings-pet-preview">${petEmoji} ${escapeHtml(petName)} сейчас отвечает за подсказки и настроение рекомендаций.</p><button class="primary-button" id="settings-pet" type="button">Выбрать питомца</button></section><section class="settings-card"><h3>TMDB-каталог</h3><p>${escapeHtml(tmdbStatus)}</p><small class="muted">TMDB добавляет реальные постеры, описания, рейтинги, сезоны и трейлеры. Ключ хранится только локально.</small><p class="attribution">This product uses the TMDB API but is not endorsed or certified by TMDB.</p></section><section class="settings-card"><h3>RUTUBE-плеер</h3><p>Вставь ссылку на разрешённое видео RUTUBE, чтобы открыть его встроенным плеером и сохранять позицию просмотра.</p><div class="provider-input"><input id="rutube-url" type="url" value="${escapeHtml(state.rutubeUrl || "")}" placeholder="https://rutube.ru/video/..." autocomplete="off"><button class="primary-button" id="rutube-open" type="button">Открыть</button></div><button class="secondary-button" id="rutube-test" type="button">Проверить тестовый плеер</button><p id="rutube-feedback" class="muted small" aria-live="polite"></p></section><section class="settings-card"><h3>Продолжение просмотра</h3><p>Прогресс и история серий сохраняются на общем backend и видны всем пользователям. Плееры продолжают с последней сохранённой позиции.</p><button class="secondary-button" data-clear-progress type="button">Очистить локальный кэш прогресса</button></section><section class="settings-card"><h3>Видеоисточники</h3><p>В каталоге остаются только подключённые разрешённые источники: открытые фильмы и официальный RUTUBE. Остальные карточки используются для метаданных и рекомендаций без кнопок внешнего просмотра.</p><small class="muted">Новый источник можно добавить только при наличии права на встраивание или прямого разрешённого потока.</small></section></div>`;
    $(".settings-grid")?.insertAdjacentHTML("beforeend", `<section class="settings-card settings-card-wide"><h3>Демо: LegalDemoProvider</h3><p>Оффлайн-адаптер для проверки каталога, сезонов, серий и выбора перевода. Он читает только локальные fixtures и не обращается к сайтам, proxy или cookies.</p><div class="provider-input"><input id="hdrezka-query" type="search" value="Тестовый сериал" placeholder="Например, Тестовый сериал" autocomplete="off"><button class="secondary-button" id="hdrezka-search" type="button">Искать</button></div><div class="provider-input hdrezka-episode-inputs"><label>Сезон <input id="hdrezka-season" type="number" min="1" value="1"></label><label>Серия <input id="hdrezka-episode" type="number" min="1" value="1"></label></div><p id="hdrezka-feedback" class="muted small" aria-live="polite"></p><div id="hdrezka-results"></div></section>`);
    bindPageActions();
    $("#settings-pet")?.addEventListener("click", openCompanion);
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

  function renderDetails(id, { skipPlaybackRefresh = false } = {}) {
    const item = getTitle(id);
    if (!item) return;
    stopDetailPrebuffer();
    if (activeTitleId !== id) selectedSeason = 1;
    activeTitleId = id;
    loadOnlineEpisodeAssets(item);
    const progress = progressForTitle(item);
    const shouldRefreshDetailPlayback = !skipPlaybackRefresh && shouldRefreshKinopoiskPlayback(item);
    const favorite = state.favorites.includes(item.id);
    const watchlist = state.watchlist.includes(item.id);
    const resumeEpisode = progress?.episodeNumber || null;
    const detailWatch = hasPlayableSource(item) ? watchButton(item, progress && !progress.completed ? "Продолжить просмотр" : "Смотреть") : item.providerUrl ? watchButton(item, "Смотреть") : "";
    const detailLocalTest = "";
    const sourceTitle = item.licenseLabel ? `${item.providerName} · ${item.licenseLabel}` : item.providerName;
    const sourceNote = item.providerNote || "Откроется на странице источника.";
    const isKinopoiskMetadata = String(item.providerName || "").startsWith("Kinopoisk");
    const isKinopoiskUrl = /^https?:\/\/(?:www\.)?kinopoisk\.ru\//i.test(String(item.providerUrl || ""));
    const showProviderPanel = item.providerUrl && !isKinopoiskMetadata && !isKinopoiskUrl;
    const sourceLink = showProviderPanel ? `<a class="secondary-button" href="${escapeHtml(item.providerUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник ↗</a>` : "";
    const providerPanel = showProviderPanel ? `<div class="provider-list"><div class="provider-row"><div><strong>${escapeHtml(sourceTitle)}</strong><small>${escapeHtml(sourceNote)}${item.licenseUrl ? ` · <a href="${escapeHtml(item.licenseUrl)}" target="_blank" rel="noopener noreferrer">условия лицензии ↗</a>` : ""}</small></div>${sourceLink}</div></div>` : "";
    const sourceImportAction = item.kinopoiskId ? `<button class="secondary-button" data-open-source-import="${escapeHtml(item.id)}" type="button">Добавить источник</button>` : "";
    const genres = detailList(item.genres?.length ? item.genres : item.tags).filter((tag) => tag.toLowerCase() !== "для нас");
    const countries = detailList(item.countries || item.country);
    const directors = detailList(item.directors || item.director);
    const actors = detailList(item.actors || item.cast);
    const producers = detailList(item.producers);
    const ageRating = detailAge(item.ageRating || item.ratingMpaa);
    const ratingKinopoisk = detailRating(item.ratingKinopoisk || item.rating);
    const ratingImdb = detailRating(item.imdbRating);
    const premiere = String(item.premiere || "").trim();
    const backdropStyle = item.posterImage ? ` style="--detail-backdrop: url('${escapeHtml(item.posterImage)}')"` : "";
    const factMarkup = [
      detailFact("Оригинальное название", item.originalTitle),
      detailFact("Год", item.year),
      detailFact("Премьера", premiere),
      detailFact("Страна", countries),
      detailFact("Режиссёр", directors),
      detailFact("Продюсеры", producers),
      detailFact("Возраст", ageRating),
      detailFact(item.kind === "series" ? "Сезоны" : "Хронометраж", item.kind === "series" ? `${item.seasons?.length || 0} сезонов` : formatRuntime(item.runtime)),
    ].join("");
    const actorPreview = actors.slice(0, 8).map((actor) => `<span class="detail-person">${escapeHtml(actor)}</span>`).join("");
    const actorAll = actors.length > 8 ? `<details class="detail-more"><summary>Показать всех актёров (${actors.length})</summary><div class="detail-people">${actors.map((actor) => `<span class="detail-person">${escapeHtml(actor)}</span>`).join("")}</div></details>` : "";
    const catalogReturnView = ["catalog", "movies", "series", "favorites", "evening", "history", "home"].includes(state.view) ? state.view : "catalog";
    const backLabel = catalogReturnView === "home" ? "← Назад" : "← Назад к списку";
    page.innerHTML = `<div class="page-heading"><a class="text-button" href="${routeForView(catalogReturnView)}" data-back-from-detail>${backLabel}</a></div><section class="detail-shell"${backdropStyle}><div class="detail-backdrop" aria-hidden="true"></div><div class="detail-hero"><div class="detail-poster" style="${posterStyle(item)}">${posterTitleArt(item)}<span class="detail-poster-kind">${item.kind === "series" ? "SERIES" : "MOVIE"}</span></div><div class="detail-content"><div class="eyebrow">${item.kind === "series" ? "Сериал" : "Фильм"} · CineVault</div><h1>${escapeHtml(item.title)}</h1>${item.tagline ? `<p class="detail-tagline">${escapeHtml(item.tagline)}</p>` : `<p class="detail-original">${escapeHtml(item.originalTitle || "")}</p>`}<div class="detail-ratings"><div class="detail-rating-card detail-rating-kp"><span class="detail-rating-star">★</span><strong>${ratingKinopoisk}</strong><small>КиноПоиск</small></div><div class="detail-rating-card"><span class="detail-rating-label">IMDb</span><strong>${ratingImdb}</strong><small>оценка</small></div><div class="detail-status-card"><span class="detail-status-dot ${hasPlayableSource(item) ? "is-ready" : ""}"></span><strong>${hasPlayableSource(item) ? "Можно смотреть" : "Источник не подключён"}</strong><small>${item.kind === "series" ? `${item.seasons?.length || 0} сезонов` : formatRuntime(item.runtime)}</small></div></div><div class="detail-tags">${genres.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div><div class="hero-actions">${detailWatch}${item.trailerUrl ? `<a class="secondary-button" href="${escapeHtml(item.trailerUrl)}" target="_blank" rel="noopener noreferrer">Трейлер ↗</a>` : ""}${detailLocalTest}${sourceImportAction}<button class="secondary-button" data-favorite="${item.id}" type="button">${favorite ? "♥ В избранном" : "♡ В избранное"}</button><button class="secondary-button" data-watchlist="${item.id}" type="button">${watchlist ? "✓ В нашем вечере" : "Добавить в наш вечер"}</button></div></div></div>${playbackPreferencesMarkup(item)}<div class="detail-facts"><dl>${factMarkup}</dl></div><div class="detail-description"><div class="section-kicker">О фильме</div><h2>${item.tagline ? escapeHtml(item.tagline) : "История, к которой хочется возвращаться"}</h2><p>${escapeHtml(item.description || "Описание пока не загружено.")}</p></div>${actors.length ? `<section class="detail-cast"><div class="section-kicker">В ролях</div><div class="detail-section-heading"><h2>Актёры</h2>${actors.length > 8 ? actorAll : ""}</div><div class="detail-people">${actorPreview}</div></section>` : ""}${providerPanel}</section>${item.kind === "series" ? renderSeasons(item) : ""}</div>`;
    $(".detail-content .hero-actions")?.insertAdjacentHTML("afterend", `<p class="detail-prebuffer-status" id="detail-prebuffer-status" role="status" aria-live="polite">Подготавливаю начало видеопотока…</p>`);
    bindPageActions();
    if (shouldRefreshDetailPlayback) {
      const refreshStatus = $("#detail-prebuffer-status");
      if (refreshStatus) refreshStatus.textContent = "Обновляю видеопоток…";
      refreshKinopoiskPlayback(item, { force: true }).then(() => {
        if (activeTitleId === item.id) renderDetails(item.id, { skipPlaybackRefresh: true });
      });
      return;
    }
    startDetailPrebuffer(item);
  }

  function episodeTitle(item, season, episode) {
    return item.episodeTitles?.[String(season)]?.[String(episode)] || (episode === 1 ? "Пилотная серия" : `Серия ${episode}`);
  }

  function episodePosterStyle(item, season, episode) {
    const poster = item.episodePosterUrls?.[String(season)]?.[String(episode)] || item.posterImage;
    const fallback = item.posterImage && poster !== item.posterImage ? `,url(${escapeHtml(item.posterImage)})` : "";
    return poster ? `background-image:linear-gradient(180deg, transparent 35%, rgba(12, 10, 30, .78)),url(${escapeHtml(poster)})${fallback};background-size:cover;background-position:center` : `--poster:${item.poster}`;
  }

  function episodePosterMarkup(item, season, episode, title, episodePlayable) {
    const poster = item.episodePosterUrls?.[String(season)]?.[String(episode)] || "";
    const fallback = item.posterImage || "";
    const action = episodePlayable ? `data-play-media="${escapeHtml(item.id)}"` : `data-demo-play="${escapeHtml(item.id)}"`;
    const image = poster
      ? `<span class="episode-card-image" style="--poster:${item.poster}"><span class="episode-image-placeholder" aria-hidden="true"></span><img data-episode-poster data-fallback="${escapeHtml(fallback)}" src="${escapeHtml(poster)}" alt="" loading="${item.episodeDataProvider ? "lazy" : "eager"}"><span class="episode-image-status" aria-hidden="true">Не удалось загрузить</span></span>`
      : `<span class="episode-card-image" style="--poster:${item.poster}"><span class="episode-image-placeholder" aria-hidden="true"></span><span class="episode-image-status" aria-hidden="true">Превью пока недоступно</span></span>`;
    return `<button class="episode-card-art${episodePlayable ? "" : " episode-card-art-unavailable"}" ${action} data-episode="${episode}" type="button" aria-label="Открыть ${escapeHtml(title)}">${image}<span class="episode-card-play">▶</span><span class="episode-card-number">${String(episode).padStart(2, "0")}</span></button>`;
  }

  function episodeSkeletonMarkup(item, season, episode) {
    return `<article class="episode-card episode-card-skeleton"><div class="episode-card-art" style="--poster:${item.poster}"><span class="episode-card-image"><span class="episode-image-placeholder" aria-hidden="true"></span><span class="episode-loading-icon" aria-hidden="true"></span><span class="episode-card-number">${String(episode).padStart(2, "0")}</span></span></div><div class="episode-card-copy"><div class="episode-card-kicker">Сезон ${season} · серия ${episode}</div><span class="episode-skeleton-line episode-skeleton-line-wide"></span><span class="episode-skeleton-line"></span></div></article>`;
  }

  function renderSeasons(item) {
    const isImportedSeries = Number(item.catalogId || 0) === 2205;
    const onlineAssetState = episodeAssetStateFor(item);
    const hasEpisodeAssets = isImportedSeries || Boolean(item.episodeDataProvider || item.episodeDataFile);
    const assetsLoading = isImportedSeries ? episodeAssetsLoading : onlineAssetState.loading;
    const assetsError = isImportedSeries ? episodeAssetsError : onlineAssetState.error;
    const seasonCount = item.seasons.length;
    const episodes = item.seasons[selectedSeason - 1] || 0;
    const demoEpisodes = Array.from({ length: episodes }, (_, index) => index + 1);
    const sourceAction = item.providerUrl && !String(item.providerName || "").startsWith("Kinopoisk") ? `<a class="secondary-button season-provider-link" href="${escapeHtml(item.providerUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник ↗</a>` : "";
    const episodeRows = hasEpisodeAssets && assetsLoading
      ? demoEpisodes.map((episode) => episodeSkeletonMarkup(item, selectedSeason, episode)).join("")
      : demoEpisodes.map((episode) => {
      const episodeId = `${item.id}-s${selectedSeason}e${episode}`;
      const progress = state.progress[episodeId];
      const localEpisode = item.libraryEpisodes?.find((candidate) => candidate.season === selectedSeason && candidate.episode === episode);
      const episodeProgress = localEpisode?.progress || progress;
      const episodePlayable = localEpisode ? localEpisode.status === "ready" : Boolean(directEpisodeUrl(item, selectedSeason, episode) || (!item.libraryEpisodes?.length && getVideoVariants(item).length));
      const title = episodeTitle(item, selectedSeason, episode);
      const progressText = episodeProgress && !episodeProgress.completed ? "Продолжить просмотр" : "";
      const poster = episodePosterMarkup(item, selectedSeason, episode, title, episodePlayable);
      return `<article class="episode-card">${poster}<div class="episode-card-copy"><div class="episode-card-kicker">Сезон ${selectedSeason} · серия ${episode}</div><h3>${escapeHtml(title)}</h3>${episodeVoiceMarkup(item, selectedSeason, episode, title)}${progressText ? `<p>${escapeHtml(progressText)}</p>` : ""}</div></article>`;
    }).join("");
    const loadingNote = assetsLoading ? `<div class="episode-loading-note" role="status"><span class="loading-spinner" aria-hidden="true"></span> Загружаю список серий и превью онлайн…</div>` : isImportedSeries && episodeImagesLoading ? `<div class="episode-loading-note" role="status"><span class="loading-spinner" aria-hidden="true"></span> Загружаю превью сезона…</div>` : assetsError ? `<div class="episode-loading-note is-error" role="status">${escapeHtml(assetsError)} Показываю доступные данные.</div>` : "";
    return `<section class="section"><div class="section-header"><div><h2>Сезоны и серии</h2><span>${seasonCount} сезонов · ${item.seasons.reduce((sum, count) => sum + count, 0)} серий</span></div>${sourceAction}</div><div class="season-tabs">${item.seasons.map((_, index) => `<button class="filter-button ${selectedSeason === index + 1 ? "is-active" : ""}" data-season="${index + 1}" type="button">Сезон ${index + 1}</button>`).join("")}</div>${loadingNote}<div class="episode-list is-season-entering">${episodeRows}</div></section>`;
  }

  function openDirectEpisodePlayer(item, season, episode, sourceUrl) {
    rememberPlayerContext();
    const contentId = `${item.id}-s${season}e${episode}`;
    const existing = state.progress[contentId] || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let hls = null;
    let lastSavedAt = 0;
    let sourceLinkExpired = false;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="direct-player-title"><div class="modal-head"><div><div class="eyebrow">${item.kind === "series" ? `Сезон ${season} · серия ${episode}` : "Фильм"}</div><h2 id="direct-player-title">${escapeHtml(item.title)}</h2></div><button class="icon-button" id="direct-player-close" type="button" aria-label="Закрыть">×</button></div><div class="provider-frame video-frame"><video id="direct-player-video" controls playsinline preload="metadata"></video><button class="video-play-overlay" id="direct-player-play-overlay" type="button" aria-label="Воспроизвести">${playerIcon("play")}</button><div class="video-loading" id="direct-player-loading" role="status" aria-live="polite">Загружаю видео…</div><div class="video-error" id="direct-player-error" role="alert" hidden></div></div><div class="provider-progress"><div class="player-range-wrap" id="direct-player-range-wrap"><span class="player-range-buffer" aria-hidden="true"></span><input id="direct-player-range" type="range" min="0" max="${duration || 1}" value="${position}" aria-label="Позиция просмотра"><output class="player-seek-time" aria-hidden="true">${formatTime(position)}</output></div><div class="player-progress-info"><span><span id="direct-player-position">${formatTime(position)}</span> / <span id="direct-player-duration">${formatDuration(duration)}</span></span><span class="player-buffer-status" id="direct-player-buffer-status" role="status">Буфер: загружается…</span></div></div><p id="direct-player-status" class="notice" aria-live="polite">Видео загружается по удалённой ссылке и не сохраняется на компьютере.</p></section></div>`;
    const video = $("#direct-player-video");
    const loading = $("#direct-player-loading");
    const videoError = $("#direct-player-error");
    const status = $("#direct-player-status");
    const range = $("#direct-player-range");
    const rangeWrap = $("#direct-player-range-wrap");
    bindSeekTimePreview(range, rangeWrap);
    const bufferStatus = $("#direct-player-buffer-status");
    const positionLabel = $("#direct-player-position");
    const durationLabel = $("#direct-player-duration");
    const playOverlay = $("#direct-player-play-overlay");
    bindVideoPlaybackControls(video, null, playOverlay, () => { status.innerHTML = "<strong>Воспроизведение не запустилось.</strong> Нажмите треугольник ещё раз."; });
    const saveProgress = (completed = false) => { state.progress[contentId] = { titleId: item.id, seasonNumber: season, episodeNumber: episode, position, duration, completed, updatedAt: Date.now() }; saveState(); };
    const updateBuffer = () => updatePlayerBuffer(video, duration, rangeWrap, bufferStatus);
    const onMetadata = () => { loading.hidden = true; videoError.hidden = true; duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); positionLabel.textContent = formatTime(position); durationLabel.textContent = formatDuration(duration); updateBuffer(); if (position > 0 && position < duration) video.currentTime = position; };
    const onTime = () => { position = Number(video.currentTime || 0); duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); positionLabel.textContent = formatTime(position); updateBuffer(); if (Date.now() - lastSavedAt > 3000) { lastSavedAt = Date.now(); saveProgress(false); } };
    const onEnded = () => { position = duration || Number(video.currentTime || 0); saveProgress(true); status.innerHTML = "<strong>Серия завершена.</strong> Прогресс сохранён."; };
    const onError = (statusCode = null) => { loading.hidden = true; if (Number(statusCode) === 410) sourceLinkExpired = true; if (sourceLinkExpired && Number(statusCode) !== 410) return; showSourceErrorCard(videoError, statusCode, "Проверьте полную ссылку, срок её действия и разрешение источника на воспроизведение в браузере."); status.innerHTML = sourceErrorMarkup(statusCode, "<strong>Видео не открылось.</strong> Проверь полную ссылку, срок её действия и разрешение источника на воспроизведение в браузере."); };
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("progress", updateBuffer);
    video.addEventListener("canplay", updateBuffer);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    range.addEventListener("input", () => { position = Number(range.value); if (video.duration) video.currentTime = position; positionLabel.textContent = formatTime(position); saveProgress(false); });
    if (isHlsUrl(sourceUrl) && window.Hls && window.Hls.isSupported()) {
      hls = createHlsPlayer(video, sourceUrl, "direct-player", null, (_event, data) => { const statusCode = hlsResponseStatus(data); if (statusCode === 410 || data?.fatal) onError(statusCode); });
    } else {
      video.src = sourceUrl;
      video.load();
    }
    const close = () => { position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : position; duration = Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : duration; saveProgress(false); hls?.destroy(); video.pause(); returnFromPlayer(); };
    $("#direct-player-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  function openRemoteEpisodePlayer(item, season, episode, sourceUrl, roomId = "") {
    rememberPlayerContext();
    const contentId = `${item.id}-s${season}e${episode}`;
    const existing = state.progress[contentId] || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let hls = null;
    let lastSavedAt = 0;
    let sourceLinkExpired = false;
    let retryingExpiredSource = false;
    const remotePlayerSettings = hlsTrackControlsMarkup("remote-player");
    const preferredVoice = String(titlePlaybackSelection(item).voice || "").trim();
    const episodeVoices = episodeSourceOptions(item, season, episode);
    const sourceFallback = preferredVoice && episodeVoices.length && !episodeVoices.some((entry) => String(entry.label || "").trim().toLocaleLowerCase() === preferredVoice.toLocaleLowerCase());
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal player-cinematic" role="dialog" aria-modal="true" aria-labelledby="remote-player-title"><div class="modal-head"><div><div class="eyebrow">Сезон ${season} · серия ${episode}</div><h2 id="remote-player-title">${escapeHtml(item.title)}</h2></div><button class="icon-button" id="remote-player-close" type="button" aria-label="Закрыть">×</button></div>${playerSeriesMarkup(item, episode)}<div class="provider-frame video-frame"><video id="remote-player-video" playsinline preload="auto"></video><button class="video-play-overlay" id="remote-player-play-overlay" type="button" aria-label="Воспроизвести">${playerIcon("play")}</button><div class="video-loading" id="remote-player-loading" role="status" aria-live="polite">Подключаю внешний поток…</div><div class="video-error" id="remote-player-error" role="alert" hidden></div></div>${playerToolbarMarkup("remote-player", remotePlayerSettings)}<p class="player-audio-notice" id="remote-player-audio-notice" role="status" aria-live="polite"${sourceFallback ? "" : " hidden"}>${sourceFallback ? `Озвучка «${escapeHtml(preferredVoice)}» недоступна в этой серии. Выбрана «${escapeHtml(selectedEpisodeSource(item, season, episode)?.label || "доступная") }».` : ""}</p><div class="provider-progress"><div class="player-range-wrap" id="remote-player-range-wrap"><span class="player-range-buffer" aria-hidden="true"></span><input id="remote-player-range" type="range" min="0" max="${duration || 1}" value="${position}" aria-label="Позиция просмотра"><output class="player-seek-time" aria-hidden="true">${formatTime(position)}</output></div><div class="player-progress-info"><span><span id="remote-player-position">${formatTime(position)}</span> / <span id="remote-player-duration">${formatDuration(duration)}</span></span><span class="player-buffer-status" id="remote-player-buffer-status" role="status">Буфер: загружается…</span></div></div><div id="remote-player-room-status" class="watch-room-status" role="status" aria-live="polite"${roomId ? "" : " hidden"}></div><p id="remote-player-status" class="notice" aria-live="polite">${escapeHtml(item.playbackRefreshWarning || "Позиция сохраняется автоматически.")}</p></section></div>`;
    const player = $(".player-modal");
    installPlayerFullscreenControls(player);
    const video = $("#remote-player-video");
    const loading = $("#remote-player-loading");
    const videoError = $("#remote-player-error");
    const status = $("#remote-player-status");
    const range = $("#remote-player-range");
    const rangeWrap = $("#remote-player-range-wrap");
    bindSeekTimePreview(range, rangeWrap);
    const bufferStatus = $("#remote-player-buffer-status");
    const positionLabel = $("#remote-player-position");
    const durationLabel = $("#remote-player-duration");
    const playButton = $("#remote-player-play");
    const playOverlay = $("#remote-player-play-overlay");
    const removeVolumeControl = bindPlayerVolumeControl(video, "remote-player");
    const removeSettingsControl = bindPlayerSettings("remote-player");
    const removeLoadingState = bindPlayerLoadingState(video, loading, playButton);
    const roomStatus = $("#remote-player-room-status");
    let roomSync = null;
    const saveProgress = (completed = false) => { state.progress[contentId] = { titleId: item.id, providerId: "remote-source", seasonNumber: season, episodeNumber: episode, position, duration, completed, updatedAt: Date.now() }; saveState(); };
    const updateBuffer = () => updatePlayerBuffer(video, duration, rangeWrap, bufferStatus);
    const onMetadata = () => { videoError.hidden = true; duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); durationLabel.textContent = formatDuration(duration); updateBuffer(); if (position > 0 && position < duration) { video.currentTime = position; status.innerHTML = `<strong>Продолжение восстановлено.</strong> Вы остановились на ${formatTime(position)}.`; } };
    const onTime = () => { position = Number(video.currentTime || 0); duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); positionLabel.textContent = formatTime(position); updateBuffer(); if (Date.now() - lastSavedAt > 3000) { lastSavedAt = Date.now(); saveProgress(false); } };
    const onEnded = () => { position = duration || Number(video.currentTime || 0); saveProgress(true); roomSync?.publish({ position, playing: false }); status.innerHTML = "<strong>Серия завершена.</strong> Прогресс сохранён."; };
    const retryExpiredSeriesSource = async () => {
      if (retryingExpiredSource) return;
      retryingExpiredSource = true;
      loading.hidden = false;
      videoError.hidden = true;
      status.innerHTML = "<strong>Ссылка серии устарела.</strong> Обновляю поток и подключаю его заново…";
      try {
        const refreshedItem = await refreshKinopoiskPlayback(item, { force: true });
        const refreshedUrl = directEpisodeUrl(refreshedItem, season, episode);
        if (!refreshedUrl || refreshedUrl === sourceUrl) throw new Error("источник не отдал новую ссылку для этой серии");
        hls?.destroy();
        roomSync?.dispose();
        player._removeFullscreenControls?.();
        video.pause();
        modalRoot.innerHTML = "";
        openItemPlayer(refreshedItem, episode, season, roomId, false);
      } catch (error) {
        loading.hidden = true;
        showSourceErrorCard(videoError, 410, "Не удалось получить новую ссылку на эту серию.");
        status.innerHTML = `<strong>Видеопоток нужно обновить.</strong> ${escapeHtml(error.message || "Попробуйте открыть серию ещё раз.")}`;
      } finally {
        retryingExpiredSource = false;
      }
    };
    const onError = (statusCode = null) => {
      if (Number(statusCode) === 410 && !retryingExpiredSource) { retryExpiredSeriesSource(); return; }
      loading.hidden = true;
      if (Number(statusCode) === 410) sourceLinkExpired = true;
      if (sourceLinkExpired && Number(statusCode) !== 410) return;
      showSourceErrorCard(videoError, statusCode, "Проверьте срок действия ссылки и разрешение источника на воспроизведение в браузере.");
      status.innerHTML = sourceErrorMarkup(statusCode, "<strong>Поток не открылся.</strong> Проверьте срок действия ссылки и разрешение источника на воспроизведение в браузере.");
    };
    const onPlay = () => { setPlayerPlayButton(playButton, true, false); if (!roomSync?.isApplying()) roomSync?.publish({ playing: true }); };
    const onPause = () => { position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : position; duration = Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : duration; setPlayerPlayButton(playButton, false, false); saveProgress(false); if (!roomSync?.isApplying()) roomSync?.publish({ position, playing: false }); };
    const seekBy = (seconds) => { const currentPosition = Number.isFinite(video.currentTime) ? Number(video.currentTime) : Number(position || 0); const nextPosition = Math.max(0, Math.min(video.duration || duration || Number.MAX_SAFE_INTEGER, currentPosition + seconds)); position = nextPosition; video.currentTime = nextPosition; range.value = nextPosition; positionLabel.textContent = formatTime(nextPosition); saveProgress(false); roomSync?.publish({ position: nextPosition }); };
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("progress", updateBuffer);
    video.addEventListener("canplay", updateBuffer);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    bindVideoPlaybackControls(video, playButton, playOverlay, () => { status.innerHTML = "<strong>Воспроизведение не запустилось.</strong> Нажмите треугольник ещё раз."; });
    $("#remote-player-back").addEventListener("click", () => seekBy(-10));
    $("#remote-player-forward").addEventListener("click", () => seekBy(10));
    range.addEventListener("input", () => { position = Number(range.value); if (video.duration) video.currentTime = position; positionLabel.textContent = formatTime(position); saveProgress(false); roomSync?.schedulePublish(); });
    roomSync = installWatchRoomSync({ roomId, video, item, season, episode, roomStatus, onEpisodeChange: (nextSeason, nextEpisode) => { roomSync?.dispose(); modalRoot.innerHTML = ""; openItemPlayer(item, nextEpisode, nextSeason, roomId); } });
    player._watchRoom = roomSync;
    bindPlayerSeriesSelectors(item, episode, roomId, roomSync);
    $("#remote-player-room")?.addEventListener("click", async () => {
      try {
        if (roomId) { const copied = await copyWatchRoomLink(roomId); roomStatus.hidden = false; roomStatus.textContent = copied ? "Ссылка на комнату скопирована." : "Комната активна. Ссылка находится в адресной строке."; return; }
        const created = await createWatchRoom(item, season, episode);
        const copied = await copyWatchRoomLink(created.room_id);
        setWatchRoomInUrl(created.room_id);
        modalRoot.innerHTML = "";
        openItemPlayer(item, episode, season, created.room_id, false);
        const nextRoomStatus = $("#remote-player-room-status");
        if (nextRoomStatus) { nextRoomStatus.hidden = false; nextRoomStatus.textContent = copied ? "Комната создана. Ссылка скопирована." : "Комната создана. Ссылка находится в адресной строке."; }
      } catch (error) { roomStatus.hidden = false; roomStatus.textContent = `Комнату создать не удалось: ${error.message}`; roomStatus.classList.add("is-error"); }
    });
    if (isHlsUrl(sourceUrl) && window.Hls && window.Hls.isSupported()) {
      hls = createHlsPlayer(
        video,
        sourceUrl,
        "remote-player",
        () => { videoError.hidden = true; status.innerHTML = "<strong>Master HLS подключён.</strong> Жду первый фрагмент видео…"; },
        (_event, data) => { const statusCode = hlsResponseStatus(data); if (statusCode === 410 || data?.fatal) onError(statusCode); },
        HLS_PLAYBACK_CONFIG,
        { preferredAudioKey: selectedHlsAudioKey(item), preferredAudioLabel: titlePlaybackSelection(item).hlsAudioLabel || "", preserveVolume: () => playerVolumeSnapshot(video), onAudioPreferenceChange: ({ key, label }) => { state.playbackSelections[item.id] = { ...titlePlaybackSelection(item), hlsAudio: key, hlsAudioLabel: label }; saveState(); } },
      );
    } else {
      video.src = sourceUrl;
      video.load();
    }
    const close = () => { position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : position; duration = Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : duration; saveProgress(false); roomSync?.publish({ position, playing: false }); roomSync?.dispose(); player._exitFullscreen?.(); video.pause(); hls?.destroy(); removeLoadingState(); removeVolumeControl(); removeSettingsControl(); video.removeEventListener("loadedmetadata", onMetadata); video.removeEventListener("timeupdate", onTime); video.removeEventListener("ended", onEnded); video.removeEventListener("error", onError); video.removeEventListener("play", onPlay); video.removeEventListener("pause", onPause); player._removeFullscreenControls?.(); returnFromPlayer(); };
    $("#remote-player-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  function openRutubePlayer(videoId, title = "RUTUBE-видео", contentId = `rutube-${videoId}`) {
    rememberPlayerContext();
    const existing = state.progress[contentId] || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let lastSavedAt = 0;
    const embedUrl = `https://rutube.ru/play/embed/${encodeURIComponent(videoId)}?skinColor=f078b4&getPlayOptions=duration,title`;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="rutube-player-title"><div class="modal-head"><div><div class="eyebrow">RUTUBE · встроенный плеер</div><h2 id="rutube-player-title">${escapeHtml(title)}</h2></div><button class="icon-button" id="rutube-close" type="button" aria-label="Закрыть">×</button></div><div class="provider-frame"><iframe id="rutube-frame" title="${escapeHtml(title)}" src="${embedUrl}" allow="clipboard-write; autoplay" allowfullscreen></iframe></div><div class="player-meta-strip"><span><small>Качество</small><strong>Выбирается в RUTUBE</strong></span><span><small>Озвучка</small><strong>Выбирается в RUTUBE</strong></span><span><small>Источник</small><strong>Официальная публикация</strong></span></div><div class="provider-progress"><div class="player-range-wrap" id="rutube-range-wrap"><input id="rutube-range" type="range" min="0" max="${duration || 1}" value="${position}" aria-label="Позиция просмотра"><output class="player-seek-time" aria-hidden="true">${formatTime(position)}</output></div><span><span id="rutube-position">${formatTime(position)}</span> / <span id="rutube-duration">${formatTime(duration)}</span></span></div><div id="rutube-status" class="notice"><strong>Загрузка плеера…</strong> Позиция сохраняется локально на этом MacBook.</div></section></div>`;
    const frame = $("#rutube-frame");
    const range = $("#rutube-range");
    const rangeWrap = $("#rutube-range-wrap");
    const positionLabel = $("#rutube-position");
    const durationLabel = $("#rutube-duration");
    const status = $("#rutube-status");
    bindSeekTimePreview(range, rangeWrap);
    const saveProgress = (completed = false) => { state.progress[contentId] = { titleId: contentId, providerId: `rutube:${videoId}`, seasonNumber: null, episodeNumber: null, position, duration, completed, updatedAt: Date.now() }; const linkedTitle = getTitle(contentId); if (linkedTitle && !state.history.includes(linkedTitle.id)) state.history.unshift(linkedTitle.id); saveState(); };
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
    const close = () => { saveProgress(false); window.removeEventListener("message", handleMessage); returnFromPlayer(); };
    $("#rutube-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  function openVideoPlayer(id, episodeNumber = null, roomId = "") {
    rememberPlayerContext();
    const item = getTitle(id);
    const variants = getVideoVariants(item);
    if (!variants.length) return openPlayer(id, episodeNumber);
    if (variants.some((variant) => variant.type === "embed")) return openEmbeddedVariantPlayer(item, variants, episodeNumber);
    const contentId = episodeNumber ? `${id}-s${selectedSeason}e${episodeNumber}` : id;
    const existing = state.progress[contentId] || {};
    let position = Number(existing.position || 0);
    let duration = Number(existing.duration || 0);
    let lastSavedAt = 0;
    let activeVariant = selectedVideoVariant(item, variants);
    const videoSettings = hlsTrackControlsMarkup("video");
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal player-cinematic" role="dialog" aria-modal="true" aria-labelledby="video-player-title"><div class="modal-head"><div><div class="eyebrow">${episodeNumber ? `Сезон ${selectedSeason} · серия ${episodeNumber}` : "Фильм"}</div><h2 id="video-player-title">${escapeHtml(item.title)}</h2></div><button class="icon-button" id="video-close" type="button" aria-label="Закрыть">×</button></div>${playerSeriesMarkup(item, episodeNumber)}<div class="provider-frame video-frame"><video id="cinevault-video" playsinline preload="auto"></video><button class="video-play-overlay" id="video-play-overlay" type="button" aria-label="Воспроизвести">${playerIcon("play")}</button><div class="video-loading" id="video-loading" role="status" aria-live="polite">Подключаю видеопоток…</div><div class="video-error" id="video-error" role="alert" hidden></div></div>${playerToolbarMarkup("video", videoSettings)}<div class="provider-progress"><div class="player-range-wrap" id="video-range-wrap"><span class="player-range-buffer" aria-hidden="true"></span><input id="video-range" type="range" min="0" max="${duration || 1}" value="${position}" aria-label="Позиция просмотра"><output class="player-seek-time" aria-hidden="true">${formatTime(position)}</output></div><div class="player-progress-info"><span><span id="video-position">${formatTime(position)}</span> / <span id="video-duration">${formatDuration(duration)}</span></span><span class="player-buffer-status" id="video-buffer-status" role="status">Буфер: загружается…</span></div></div><div id="video-room-status" class="watch-room-status" role="status" aria-live="polite"${roomId ? "" : " hidden"}></div><p id="video-status" class="notice" aria-live="polite">${escapeHtml(item.playbackRefreshWarning || "Позиция сохраняется автоматически.")}</p><p class="attribution">${escapeHtml(item.providerNote || "Подключённый источник")} · <a href="${escapeHtml(item.licenseUrl || item.providerUrl || activeVariant.url)}" target="_blank" rel="noopener noreferrer">Источник и лицензия ↗</a></p></section></div>`;
    const fullscreenPlayer = $(".player-modal");
    installPlayerFullscreenControls(fullscreenPlayer);
    const video = $("#cinevault-video");
    const range = $("#video-range");
    const rangeWrap = $("#video-range-wrap");
    const positionLabel = $("#video-position");
    const durationLabel = $("#video-duration");
    const status = $("#video-status");
    const loading = $("#video-loading");
    const videoError = $("#video-error");
    const playButton = $("#video-play");
    const playOverlay = $("#video-play-overlay");
    const removeVolumeControl = bindPlayerVolumeControl(video, "video");
    const removeSettingsControl = bindPlayerSettings("video");
    const removeLoadingState = bindPlayerLoadingState(video, loading, playButton);
    const bufferStatus = $("#video-buffer-status");
    const roomStatus = $("#video-room-status");
    bindSeekTimePreview(range, rangeWrap);
    const saveProgress = (completed = false) => { state.progress[contentId] = { titleId: id, providerId: `html5:${item.providerName}:${activeVariant.voice}`, seasonNumber: episodeNumber ? selectedSeason : null, episodeNumber: episodeNumber || null, position, duration, completed, updatedAt: Date.now() }; if (!state.history.includes(id)) state.history.unshift(id); saveState(); };
    let pendingPlay = false;
    let hls = null;
    let roomSync = null;
    let retryingExpiredSource = false;
    let playerClosed = false;
    const updateBuffer = () => updatePlayerBuffer(video, duration, rangeWrap, bufferStatus);
    const setVariant = (variant, autoplay = false, initial = false) => {
      activeVariant = variant;
      position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : Number(position || 0);
      saveProgress(false);
      pendingPlay = autoplay;
      loading.hidden = false;
      videoError.hidden = true;
      hls?.destroy();
      hls = null;
      video.pause();
      video.controls = false;
      video.removeAttribute("src");
      video.load();
      if (isHlsUrl(variant.url) && window.Hls && window.Hls.isSupported()) {
        hls = createHlsPlayer(video, variant.url, "video", () => {
          videoError.hidden = true;
          status.innerHTML = "<strong>Master HLS подключён.</strong> Жду первый фрагмент видео…";
        }, (_event, data) => {
          const statusCode = hlsResponseStatus(data);
          if (statusCode === 410 || data?.fatal) onError(statusCode);
        }, HLS_PLAYBACK_CONFIG, { preferredAudioKey: selectedHlsAudioKey(item), preferredAudioLabel: titlePlaybackSelection(item).hlsAudioLabel || "", preserveVolume: () => playerVolumeSnapshot(video), onAudioPreferenceChange: ({ key, label }) => { state.playbackSelections[item.id] = { ...titlePlaybackSelection(item), hlsAudio: key, hlsAudioLabel: label }; saveState(); } });
      } else {
        video.src = variant.url;
        video.load();
      }
      status.innerHTML = initial ? "<strong>Подключаю видеопоток…</strong> Позиция восстановится автоматически." : `<strong>${escapeHtml(variant.quality)} · ${escapeHtml(variant.voice)}.</strong> Источник переключён без сброса позиции.`;
    };
    const onLoadedMetadata = () => { videoError.hidden = true; duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); durationLabel.textContent = formatDuration(duration); updateBuffer(); if (position > 0 && position < duration) { video.currentTime = position; status.innerHTML = `<strong>Продолжение восстановлено.</strong> Вы остановились на ${formatTime(position)}.`; } else { status.innerHTML = `<strong>Поток подключён.</strong> Жду первый фрагмент видео…`; } if (pendingPlay) { video.play().catch(() => { status.innerHTML = `<strong>Нажмите «Воспроизвести».</strong> Браузер заблокировал автозапуск.`; }); pendingPlay = false; } };
    const onTimeUpdate = () => { position = Number(video.currentTime || 0); duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); positionLabel.textContent = formatTime(position); updateBuffer(); if (Date.now() - lastSavedAt > 3000) { saveProgress(false); lastSavedAt = Date.now(); } };
    const onEnded = () => { position = duration || Number(video.currentTime || 0); saveProgress(true); roomSync?.publish({ position, playing: false }); status.innerHTML = `<strong>Просмотр завершён.</strong> Прогресс сохранён.`; };
    const retryExpiredSource = async () => {
      if (retryingExpiredSource) return;
      retryingExpiredSource = true;
      loading.hidden = false;
      videoError.hidden = true;
      status.innerHTML = "<strong>Обновляю видеопоток…</strong> Получаю свежую ссылку и подключаю её заново.";
      try {
        const refreshedItem = await refreshKinopoiskPlayback(item, { force: true });
        if (playerClosed) return;
        const refreshedVariants = getVideoVariants(refreshedItem);
        const refreshedVariant = selectedVideoVariant(refreshedItem, refreshedVariants);
        if (!refreshedVariant?.url || refreshedVariant.url === activeVariant.url) throw new Error("источник не отдал новую ссылку");
        roomSync?.dispose();
        hls?.destroy();
        fullscreenPlayer._removeFullscreenControls?.();
        fullscreenPlayer._exitFullscreen?.();
        modalRoot.innerHTML = "";
        openItemPlayer(refreshedItem, episodeNumber, selectedSeason, roomId, false);
      } catch (error) {
        if (playerClosed) return;
        retryingExpiredSource = false;
        loading.hidden = true;
        videoError.innerHTML = `<div class="video-error-icon" aria-hidden="true">!</div><div class="video-error-copy"><strong>Не удалось обновить видеопоток</strong><p>Источник временно не выдал новую ссылку. Попробуйте открыть карточку ещё раз позже.</p></div>`;
        videoError.hidden = false;
        status.innerHTML = `<strong>Обновление не завершилось.</strong> ${escapeHtml(error.message || "Попробуйте ещё раз позже.")}`;
      }
    };
    const onError = (statusCode = null) => {
      if ((Number(statusCode) === 410 || !Number(statusCode)) && shouldRefreshKinopoiskPlayback(item)) {
        retryExpiredSource();
        return;
      }
      loading.hidden = true;
      showSourceErrorCard(videoError, statusCode, "Проверьте срок действия ссылки или выберите другой подключённый источник.");
      status.innerHTML = sourceErrorMarkup(statusCode, "<strong>Поток не открылся.</strong> Проверьте источник или выберите другой вариант.");
    };
    const onPlay = () => { setPlayerPlayButton(playButton, true, false); if (!roomSync?.isApplying()) roomSync?.publish({ playing: true }); };
    const onPause = () => { position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : position; duration = Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : duration; setPlayerPlayButton(playButton, false, false); saveProgress(false); if (!roomSync?.isApplying()) roomSync?.publish({ position, playing: false }); };
    const seekBy = (seconds) => { const currentPosition = Number.isFinite(video.currentTime) ? Number(video.currentTime) : Number(position || 0); const nextPosition = Math.max(0, Math.min(video.duration || duration || Number.MAX_SAFE_INTEGER, currentPosition + seconds)); position = nextPosition; video.currentTime = nextPosition; range.value = nextPosition; positionLabel.textContent = formatTime(nextPosition); saveProgress(false); roomSync?.publish({ position: nextPosition }); };
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("progress", updateBuffer);
    video.addEventListener("canplay", updateBuffer);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    range.addEventListener("input", () => { position = Number(range.value); if (video.duration) video.currentTime = position; positionLabel.textContent = formatTime(position); saveProgress(false); roomSync?.schedulePublish(); });
    bindVideoPlaybackControls(video, playButton, playOverlay, () => { status.innerHTML = "<strong>Воспроизведение не запустилось.</strong> Нажмите треугольник ещё раз."; });
    $("#video-back").addEventListener("click", () => seekBy(-10));
    $("#video-forward").addEventListener("click", () => seekBy(10));
    roomSync = installWatchRoomSync({ roomId, video, item, season: episodeNumber ? selectedSeason : 0, episode: episodeNumber || 0, roomStatus });
    fullscreenPlayer._watchRoom = roomSync;
    bindPlayerSeriesSelectors(item, episodeNumber, roomId, roomSync);
    $("#video-room")?.addEventListener("click", async () => {
      try {
        if (roomId) { const copied = await copyWatchRoomLink(roomId); roomStatus.hidden = false; roomStatus.textContent = copied ? "Ссылка на комнату скопирована." : "Комната активна. Ссылка находится в адресной строке."; return; }
        const created = await createWatchRoom(item, episodeNumber ? selectedSeason : 0, episodeNumber || 0);
        const copied = await copyWatchRoomLink(created.room_id);
        setWatchRoomInUrl(created.room_id);
        modalRoot.innerHTML = "";
        openItemPlayer(item, episodeNumber, selectedSeason, created.room_id, false);
        const nextRoomStatus = $("#video-room-status");
        if (nextRoomStatus) { nextRoomStatus.hidden = false; nextRoomStatus.textContent = copied ? "Комната создана. Ссылка скопирована." : "Комната создана. Ссылка находится в адресной строке."; }
      } catch (error) { roomStatus.hidden = false; roomStatus.textContent = `Комнату создать не удалось: ${error.message}`; roomStatus.classList.add("is-error"); }
    });
    const close = () => { if (playerClosed) return; playerClosed = true; position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : position; duration = Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : duration; saveProgress(false); roomSync?.publish({ position, playing: false }); roomSync?.dispose(); fullscreenPlayer._exitFullscreen?.(); video.pause(); hls?.destroy(); removeLoadingState(); removeVolumeControl(); removeSettingsControl(); video.removeEventListener("loadedmetadata", onLoadedMetadata); video.removeEventListener("timeupdate", onTimeUpdate); video.removeEventListener("progress", updateBuffer); video.removeEventListener("canplay", updateBuffer); video.removeEventListener("ended", onEnded); video.removeEventListener("error", onError); video.removeEventListener("play", onPlay); video.removeEventListener("pause", onPause); fullscreenPlayer._removeFullscreenControls?.(); returnFromPlayer(); };
    $("#video-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
    setVariant(activeVariant, false, true);
  }

  function openEmbeddedVariantPlayer(item, variants, episodeNumber = null) {
    rememberPlayerContext();
    const qualityOptions = [...new Set(variants.map((variant) => variant.quality))];
    const voiceOptions = [...new Set(variants.map((variant) => variant.voice))];
    let activeVariant = variants[0];
    const qualityControl = qualityOptions.length > 1 ? playerSelectMarkup("embed-variant-quality", "Качество", qualityOptions.map((option) => ({ value: option, label: option, selected: option === activeVariant.quality }))) : "";
    const voiceControl = voiceOptions.length > 1 ? playerSelectMarkup("embed-variant-voice", "Озвучка", voiceOptions.map((option) => ({ value: option, label: option, selected: option === activeVariant.voice }))) : "";
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="embed-variant-title"><div class="modal-head"><div><div class="eyebrow">CineVault · внешний embed</div><h2 id="embed-variant-title">${escapeHtml(item.title)}${episodeNumber ? ` · S${String(selectedSeason).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}` : ""}</h2></div><button class="icon-button" id="embed-variant-close" type="button" aria-label="Закрыть">×</button></div>${playerSeriesMarkup(item, episodeNumber)}<div class="provider-frame external-embed-frame"><iframe id="embed-variant-frame" title="${escapeHtml(item.title)}" src="${escapeHtml(activeVariant.url)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>${qualityControl || voiceControl ? `<div class="player-toolbar"><div class="player-selects">${qualityControl}${voiceControl}</div></div>` : ""}<p id="embed-variant-status" class="notice" aria-live="polite"><strong>${escapeHtml(activeVariant.voice)}</strong> · источник открыт напрямую. Внешний плеер сам отвечает за воспроизведение.</p></section></div>`;
    const frame = $("#embed-variant-frame");
    const qualitySelect = $("#embed-variant-quality");
    const voiceSelect = $("#embed-variant-voice");
    const status = $("#embed-variant-status");
    const findVariant = (preferred = "voice") => {
      const selectedQuality = qualitySelect?.value || activeVariant.quality;
      const selectedVoice = voiceSelect?.value || activeVariant.voice;
      return variants.find((variant) => variant.quality === selectedQuality && variant.voice === selectedVoice)
        || (preferred === "quality"
          ? variants.find((variant) => variant.quality === selectedQuality) || variants.find((variant) => variant.voice === selectedVoice)
          : variants.find((variant) => variant.voice === selectedVoice) || variants.find((variant) => variant.quality === selectedQuality))
        || variants[0];
    };
    const setVariant = (preferred) => {
      activeVariant = findVariant(preferred);
      frame.src = activeVariant.url;
      if (qualitySelect) qualitySelect.value = activeVariant.quality;
      if (voiceSelect) voiceSelect.value = activeVariant.voice;
      status.innerHTML = `<strong>${escapeHtml(activeVariant.voice)}</strong> · источник переключён. Если несколько подписей ведут на один embed, выбор озвучки выполняется внутри плеера источника.`;
    };
    qualitySelect?.addEventListener("change", () => setVariant("quality"));
    voiceSelect?.addEventListener("change", () => setVariant("voice"));
    bindPlayerSeriesSelectors(item, episodeNumber);
    const close = () => returnFromPlayer();
    $("#embed-variant-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  function openPlayer(id, episodeNumber = null) {
    rememberPlayerContext();
    const item = getTitle(id);
    const contentId = episodeNumber ? `${id}-s${selectedSeason}e${episodeNumber}` : id;
    const existing = state.progress[contentId];
    const duration = existing?.duration || (episodeNumber ? item.runtime * 60 : item.runtime * 60);
    let position = existing?.position || 0;
    let playing = false;
    let timer;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="player-title"><div class="modal-head"><div><div class="eyebrow">CineVault · источник не подключён</div><h2 id="player-title">${escapeHtml(item.title)}${episodeNumber ? ` · S${String(selectedSeason).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}` : ""}</h2></div><button class="icon-button" id="player-close" type="button" aria-label="Закрыть">×</button></div>${playerSeriesMarkup(item, episodeNumber)}<div class="player-stage player-stage-empty" style="--player:${item.poster}"><div class="player-center"><div class="player-pet">${petVisual()}</div><strong>Видеоисточник ещё не подключён</strong><span>Эта карточка готова к разрешённому MP4/HLS-потоку</span></div></div><div class="player-toolbar is-disabled"><div class="player-actions"><button class="primary-button" type="button" disabled>▶ Воспроизвести</button><button class="secondary-button" type="button" disabled>⛶ Полный экран</button></div></div><div class="notice"><strong>Для ${escapeHtml(item.title)} пока нет разрешённого видеопотока.</strong> Когда появится лицензированный MP4/HLS-источник, здесь появятся доступные варианты качества и озвучки.</div></section></div>`;
    bindPlayerSeriesSelectors(item, episodeNumber);
    $("#player-close").addEventListener("click", returnFromPlayer);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) $("#player-close").click(); });
  }

  function openExternalEmbedPlayer(item) {
    rememberPlayerContext();
    const embedURL = String(item.embed_url || "").trim();
    if (!embedURL) return;
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal" role="dialog" aria-modal="true" aria-labelledby="external-player-title"><div class="modal-head"><div><div class="eyebrow">CineVault · внешний embed</div><h2 id="external-player-title">${escapeHtml(item.title)} · ${escapeHtml(item.episode_title)}</h2></div><button class="icon-button" id="external-player-close" type="button" aria-label="Закрыть">×</button></div><div class="provider-frame external-embed-frame"><iframe title="${escapeHtml(item.title)}" src="${escapeHtml(embedURL)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div><p class="notice"><strong>Плеер источника подключён.</strong> CineVault открывает официальный embed напрямую и не скачивает, не расшифровывает и не проксирует его поток.</p></section></div>`;
    const close = () => { returnFromPlayer(); };
    $("#external-player-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  async function openLibraryPlayer(item, roomId = "") {
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
    modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal provider-modal player-modal player-cinematic" role="dialog" aria-modal="true" aria-labelledby="library-player-title"><div class="modal-head"><div><div class="eyebrow">CineVault · каталог</div><h2 id="library-player-title">${escapeHtml(item.title)} · ${escapeHtml(item.episode_title)}</h2></div><button class="icon-button" id="player-close" type="button" aria-label="Закрыть">×</button></div><div class="provider-frame video-frame"><video id="library-video" playsinline preload="auto"></video><button class="video-play-overlay" id="library-play-overlay" type="button" aria-label="Воспроизвести">${playerIcon("play")}</button><div class="video-loading" id="library-video-loading" role="status" aria-live="polite">Загружаю адаптивный поток…</div><div class="video-error" id="library-video-error" role="alert" hidden></div></div>${playerToolbarMarkup("library", hlsTrackControlsMarkup("library"))}<p class="player-audio-notice" id="library-audio-notice" role="status" aria-live="polite" hidden></p><div class="library-seekbar"><div class="player-range-wrap" id="library-range-wrap"><span class="player-range-buffer" aria-hidden="true"></span><input id="library-range" type="range" min="0" max="${duration || 1}" step="0.1" value="${position}" aria-label="Перемотка видео"><output class="player-seek-time" aria-hidden="true">${formatTime(position)}</output></div><div class="player-progress-info"><span><span id="library-player-position">${formatTime(position)}</span> / <span id="library-player-duration">${formatDuration(duration)}</span></span><span class="player-buffer-status" id="library-buffer-status" role="status">Буфер: загружается…</span></div></div><div id="library-room-status" class="watch-room-status" role="status" aria-live="polite"${roomId ? "" : " hidden"}></div><div class="library-skip-panel" id="library-skip-panel" hidden><span id="library-skip-label"></span><button class="secondary-button" id="library-skip-now" type="button"></button><label class="library-skip-toggle"><input id="library-skip-auto" type="checkbox"${state.skipSegments !== false ? " checked" : ""}> Автопропуск</label></div><p id="library-player-status" class="notice" aria-live="polite">${position > 0 ? "Продолжение просмотра." : "Позиция сохраняется автоматически."}</p></section></div>`;
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
    const saveProgress = (completed = false, force = false) => {
      const payload = { position, duration, completed };
      if (!force && Date.now() - lastSaved < 1500 && !completed) return;
      lastSaved = Date.now();
      apiFetch(`/api/progress/${encodeURIComponent(item.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
      const current = libraryEpisodes.find((episode) => episode.id === item.id);
      if (current) {
        current.progress = { ...payload, updatedAt: new Date().toISOString() };
        libraryHistory = [current, ...libraryHistory.filter((entry) => entry.id !== item.id)];
      }
    };
    const updateBuffer = () => updatePlayerBuffer(video, duration, rangeWrap, bufferStatus);
    const onMetadata = () => { videoError.hidden = true; duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); $("#library-player-duration").textContent = formatDuration(duration); updateBuffer(); if (position > 0 && position < duration) video.currentTime = position; updateSkipControls(); maybeAutoSkip(); };
    const onTime = () => { position = Number(video.currentTime || 0); duration = Number(video.duration || duration); range.max = duration || 1; range.value = Math.min(position, duration || position); updateBuffer(); updateSkipControls(); maybeAutoSkip(); saveProgress(false); };
    const onEnded = () => { position = duration || Number(video.currentTime || 0); saveProgress(true); roomSync?.publish({ position, playing: false }); status.innerHTML = "<strong>Серия завершена.</strong> Прогресс сохранён."; };
    const onError = () => { loading.hidden = true; showSourceErrorCard(videoError, null, "Проверьте состояние FFmpeg и доступность исходного файла на сервере."); status.innerHTML = "<strong>Поток не открылся.</strong> Проверь статус FFmpeg и доступность исходного файла на сервере."; };
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
    bindVideoPlaybackControls(video, play, playOverlay, () => { status.innerHTML = "<strong>Воспроизведение не запустилось.</strong> Нажмите треугольник ещё раз."; });
    $("#library-back").addEventListener("click", () => seekBy(-10));
    $("#library-forward").addEventListener("click", () => seekBy(10));
    range.addEventListener("input", () => { position = Number(range.value); video.currentTime = position; status.textContent = "Позиция изменена."; saveProgress(false); roomSync?.schedulePublish(); });
    skipNow.addEventListener("click", () => skipActiveSegment(false));
    skipAuto.addEventListener("change", () => { state.skipSegments = skipAuto.checked; saveState(); if (skipAuto.checked) maybeAutoSkip(); });
    roomSync = installWatchRoomSync({ roomId, video, item, season: item.season, episode: item.episode, roomStatus });
    const player = $(".player-modal");
    player._watchRoom = roomSync;
    $("#library-room")?.addEventListener("click", async () => {
      try {
        if (roomId) { await navigator.clipboard?.writeText(watchRoomLink(roomId)); roomStatus.hidden = false; roomStatus.textContent = "Ссылка на комнату скопирована."; return; }
        const created = await createWatchRoom(item, item.season, item.episode);
        await navigator.clipboard?.writeText(created.link);
        setWatchRoomInUrl(created.room_id);
        modalRoot.innerHTML = "";
        openLibraryPlayer(item, created.room_id);
      } catch (error) { roomStatus.hidden = false; roomStatus.textContent = `Комнату создать не удалось: ${error.message}`; roomStatus.classList.add("is-error"); }
    });
    const streamUrl = item.offlineUrl || item.hls_url || item.source_url;
    if (item.hls_url && window.Hls && window.Hls.isSupported()) {
      hls = createHlsPlayer(video, streamUrl, "library", () => { videoError.hidden = true; }, (_event, data) => { if (data?.fatal) onError(); }, HLS_PLAYBACK_CONFIG, { preferredAudioKey: selectedHlsAudioKey(item), preferredAudioLabel: titlePlaybackSelection(item).hlsAudioLabel || "", preserveVolume: () => playerVolumeSnapshot(video), onAudioPreferenceChange: ({ key, label }) => { state.playbackSelections[item.id] = { ...titlePlaybackSelection(item), hlsAudio: key, hlsAudioLabel: label }; saveState(); } });
    } else {
      video.src = streamUrl;
      video.load();
    }
    const close = () => { position = Number.isFinite(video.currentTime) ? Number(video.currentTime) : position; duration = Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : duration; saveProgress(false, true); roomSync?.publish({ position, playing: false }); roomSync?.dispose(); fullscreenPlayer._exitFullscreen?.(); video.pause(); hls?.destroy(); removeLoadingState(); removeVolumeControl(); removeSettingsControl(); video.removeEventListener("loadedmetadata", onMetadata); video.removeEventListener("timeupdate", onTime); video.removeEventListener("ended", onEnded); video.removeEventListener("error", onError); video.removeEventListener("play", onPlay); video.removeEventListener("pause", onPause); fullscreenPlayer._removeFullscreenControls?.(); returnFromPlayer(); };
    $("#player-close").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", (event) => { if (event.target.classList.contains("modal-backdrop")) close(); });
  }

  async function cacheLibraryOffline(item) {
    const feedback = $("#library-upload-feedback");
    try {
      const manifestResponse = await apiFetch(item.offline_manifest_url, { headers: { accept: "application/json" } });
      const manifest = await manifestResponse.json();
      if (!manifestResponse.ok) throw new Error(manifest.error || `HTTP ${manifestResponse.status}`);
      if (!window.caches) throw new Error("Cache Storage недоступен в этом браузере");
      const cache = await caches.open("cinevault-media-v1");
      for (const resource of manifest.resources) { const response = await apiFetch(resource, { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`); await cache.put(apiUrl(resource), response.clone()); }
      state.offline = { ...(state.offline || {}), [item.id]: manifest.quality_playlist };
      saveState();
      item.offlineUrl = manifest.quality_playlist;
      if (feedback) feedback.textContent = `${item.title} · ${item.episode_title} сохранена офлайн в качестве ${manifest.quality}.`;
    } catch (error) { if (feedback) feedback.textContent = `Офлайн-загрузка не выполнена: ${error.message}`; }
  }

  async function createLibraryRoom(item) {
    const feedback = $("#library-upload-feedback");
    try {
      const payload = await createWatchRoom(item, item.season, item.episode);
      await navigator.clipboard?.writeText(payload.link);
      if (feedback) feedback.textContent = `Комната ${payload.share_code} создана. Ссылка скопирована.`;
    } catch (error) { if (feedback) feedback.textContent = `Комнату создать не удалось: ${error.message}`; }
  }

  function bindPageActions() {
    $$('[data-open-source-import]').forEach((button) => button.addEventListener("click", () => { const item = getTitle(button.dataset.openSourceImport); if (item) openCatalogSourceImport(item); }));
    const beginCinematicWatch = () => { beginCinematicFullscreen(); };
    $$('[data-play-media]').forEach((button) => button.addEventListener("click", () => { beginCinematicWatch(); const item = getTitle(button.dataset.playMedia); const season = button.dataset.resumeSeason ? Number(button.dataset.resumeSeason) : null; const episode = button.dataset.episode ? Number(button.dataset.episode) : null; openItemPlayer(item, episode, season); }));
    $$('[data-demo-play]').forEach((button) => button.addEventListener("click", () => { beginCinematicWatch(); const item = getTitle(button.dataset.demoPlay); const season = button.dataset.resumeSeason ? Number(button.dataset.resumeSeason) : null; const episode = button.dataset.episode ? Number(button.dataset.episode) : (item?.kind === "series" ? (progressForTitle(item)?.episodeNumber || 1) : null); openItemPlayer(item, episode, season); }));
    const episodeImages = $$('[data-episode-poster]');
    let pendingEpisodeImages = episodeImages.length;
    const finishEpisodeImageLoading = () => {
      if (!episodeImagesLoading || pendingEpisodeImages > 0) return;
      episodeImagesLoading = false;
      if (activeTitleId) renderDetails(activeTitleId);
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
    $$('[data-library-offline]').forEach((button) => button.addEventListener("click", () => { const item = libraryEpisodes.find((episode) => episode.id === button.dataset.libraryOffline); if (item) cacheLibraryOffline(item); }));
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
      if (!kinopoisk) {
        input?.setAttribute("aria-invalid", "true");
        if (feedback) feedback.textContent = "Введи Kinopoisk ID или ссылку на фильм либо сериал.";
        input?.focus();
        return;
      }
      input?.removeAttribute("aria-invalid");
      submit.disabled = true;
      feedback.textContent = "Запускаю импорт. Это может занять несколько минут — страницу можно не закрывать.";
      try {
        const response = await apiFetch("/api/catalog/kinopoisk-imports", {
          method: "POST",
          headers: { "content-type": "application/json" },
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
            feedback.textContent = "Импортирую и собираю карточку CineVault…";
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
    $$('[data-mood]').forEach((button) => button.addEventListener("click", () => { state.mood = button.dataset.mood; persistAndRender(); }));
    $$('[data-favorite]').forEach((button) => button.addEventListener("click", () => { const id = button.dataset.favorite; state.favorites = state.favorites.includes(id) ? state.favorites.filter((item) => item !== id) : [...state.favorites, id]; saveState(); renderDetails(id); }));
    $$('[data-watchlist]').forEach((button) => button.addEventListener("click", () => { const id = button.dataset.watchlist; state.watchlist = state.watchlist.includes(id) ? state.watchlist.filter((item) => item !== id) : [...state.watchlist, id]; saveState(); renderDetails(id); }));
    $$('[data-season]').forEach((button) => button.addEventListener("click", () => switchSeason(button.dataset.season)));
    $$('[data-episode-source]').forEach((select) => select.addEventListener("change", () => {
      state.voiceSelections = state.voiceSelections && typeof state.voiceSelections === "object" ? state.voiceSelections : {};
      state.voiceSelections[episodeSourceSelectionKey(getTitle(select.dataset.episodeSource), select.dataset.sourceSeason, select.dataset.sourceEpisode)] = select.value;
      saveState();
    }));
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
        if (controlId !== "detail-hls-audio") startDetailPrebuffer(item);
      });
    });
    $$('[data-set-theme]').forEach((button) => button.addEventListener("click", () => { state.theme = "graphite"; persistAndRender(); }));
    $$('[data-clear-progress]').forEach((button) => button.addEventListener("click", () => { state.progress = {}; persistAndRender(); }));
    $$('[data-catalog-genre]').forEach((button) => button.addEventListener("click", () => {
      const genre = normalizeCatalogGenre(button.dataset.catalogGenre);
      state.catalogGenre = normalizeCatalogGenre(state.catalogGenre) === genre ? "" : genre;
      resetCatalogPage();
      saveState();
      renderCatalogView();
    }));
    $$('[data-catalog-collection]').forEach((button) => button.addEventListener("click", () => {
      const collectionId = String(button.dataset.catalogCollection || "");
      state.catalogCollection = state.catalogCollection === collectionId ? "" : collectionId;
      state.query = "";
      const search = $("#search");
      if (search) search.value = "";
      hideSearchSuggestions();
      state.catalogGenre = "";
      state.catalogMoodOnly = false;
      resetCatalogPage();
      saveState();
      renderCatalogView();
    }));
    $$('[data-open-collection]').forEach((button) => button.addEventListener("click", () => openCatalogCollection(button.dataset.openCollection)));
    $$('[data-mood-filter]').forEach((button) => button.addEventListener("click", () => {
      state.catalogMoodOnly = !state.catalogMoodOnly;
      resetCatalogPage();
      saveState();
      renderCatalogView();
    }));
    $('[data-catalog-playable]')?.addEventListener("click", () => {
      state.catalogPlayableOnly = !state.catalogPlayableOnly;
      resetCatalogPage();
      saveState();
      renderCatalogView();
    });
    $('[data-catalog-sort]')?.addEventListener("change", (event) => {
      state.catalogSort = event.currentTarget.value;
      resetCatalogPage();
      saveState();
      renderCatalogView();
    });
    $$('[data-catalog-page]').forEach((button) => button.addEventListener("click", () => {
      const nextPage = Number(button.dataset.catalogPage);
      const pagination = catalogPagination(filteredCatalog());
      if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > pagination.totalPages) return;
      state.catalogPage = nextPage;
      saveState();
      renderCatalogView();
      const results = $("#catalog-results");
      results?.scrollIntoView({ behavior: "smooth", block: "start" });
      results?.focus({ preventScroll: true });
    }));
    $$('[data-catalog-reset]').forEach((button) => button.addEventListener("click", resetCatalogFilters));
    $('[data-catalog-random]')?.addEventListener("click", () => {
      const items = filteredCatalog();
      const item = items[Math.floor(Math.random() * items.length)];
      if (item) openTitleRoute(item.id);
    });
    $("#settings-pet")?.addEventListener("click", openCompanion);
    $("#rutube-open")?.addEventListener("click", () => { const input = $("#rutube-url"); const feedback = $("#rutube-feedback"); const videoId = extractRutubeVideoId(input?.value); if (!videoId) { feedback.textContent = "Нужна прямая ссылка RUTUBE на видео или embed-код."; return; } state.rutubeUrl = input.value.trim(); saveState(); openRutubePlayer(videoId, "RUTUBE-видео", `rutube-${videoId}`); });
    $("#rutube-test")?.addEventListener("click", () => openRutubePlayer(RUTUBE_SAMPLE_ID, "Тестовый плеер RUTUBE", `rutube-demo-${RUTUBE_SAMPLE_ID}`));
    $("#hdrezka-search")?.addEventListener("click", runHdrezkaSearch);
    $("#hdrezka-query")?.addEventListener("keydown", (event) => { if (event.key === "Enter") runHdrezkaSearch(); });
  }

  function getTitleFromPage() { return activeTitleId || $("[data-demo-play]")?.dataset.demoPlay || "desperate-housewives"; }
  function openCompanion() { const popover = $("#companion-popover"); if (popover) popover.hidden = !popover.hidden; }

  function hideSearchSuggestions() {
    const popup = $("#search-suggestions");
    if (popup) popup.hidden = true;
  }

  function renderSearchSuggestions() {
    const popup = $("#search-suggestions");
    const query = String(state.query || "").trim();
    if (!popup || query.length < 2) return hideSearchSuggestions();
    const results = searchMatches(query).slice(0, 6);
    popup.hidden = false;
    popup.innerHTML = results.length
      ? `<p class="search-suggestions-title">${catalogCountLabel(searchMatches(query).length)} · быстрый выбор</p><div class="search-suggestions-list">${results.map((item) => `<a class="search-suggestion" href="${routeForTitle(item.id)}" data-open-title="${escapeHtml(item.id)}"><span class="search-suggestion-poster" style="${posterStyle(item)}" aria-hidden="true"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml([item.year, item.kind === "series" ? "сериал" : "фильм", ...genresForItem(item).slice(0, 2)].filter(Boolean).join(" · "))}</small></span><b>${escapeHtml(catalogRatingLabel(item) || "")}</b></a>`).join("")}</div>`
      : `<p class="search-suggestions-empty">По запросу «${escapeHtml(query)}» ничего не найдено. Измени запрос или открой каталог.</p>`;
  }

  $("#companion-open")?.addEventListener("click", openCompanion);
  $$(".pet-choice").forEach((button) => button.addEventListener("click", () => { state.companion = button.dataset.pet; $$(".pet-choice").forEach((item) => item.classList.toggle("is-selected", item === button)); $("#companion-popover").hidden = true; persistAndRender(); }));
  $("#search").addEventListener("input", (event) => {
    state.query = event.target.value;
    resetCatalogPage();
    saveState();
    renderSearchSuggestions();
    if (state.view !== "catalog" || safePathname() !== routeForView("catalog")) {
      navigateToView("catalog", { replace: true });
      window.requestAnimationFrame(() => { $("#search")?.focus({ preventScroll: true }); renderSearchSuggestions(); });
      return;
    }
    renderCatalogView();
  });
  $("#search").addEventListener("focus", renderSearchSuggestions);
  $("#search").addEventListener("blur", () => window.setTimeout(hideSearchSuggestions, 120));
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search").focus(); renderSearchSuggestions(); }
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
      // While a CineVault player is open, Space always belongs to playback;
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
    if (event.key === "Escape") { const popover = $("#companion-popover"); if (popover) popover.hidden = true; if (modalRoot.innerHTML) modalRoot.querySelector("button[aria-label=\"Закрыть\"]")?.click(); }
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

  $("#assistant-collapse")?.addEventListener("click", (event) => { const collapsed = $("#assistant-rail").classList.toggle("is-collapsed"); event.currentTarget.setAttribute("aria-expanded", String(!collapsed)); event.currentTarget.setAttribute("aria-label", collapsed ? "Развернуть помощника" : "Свернуть помощника"); });
  $("#assistant-pet")?.addEventListener("click", () => { $("#assistant-rail").classList.remove("is-collapsed"); setPetState("happy"); setAssistantCopy("Я выберу вариант по твоему вкусу, настроению и истории просмотра."); });
  $("#assistant-recommend")?.addEventListener("click", () => { setAssistantCopy("Секунду, ищу что-нибудь подходящее…"); const pick = nextRecommendation(); if (!pick) { setAssistantCopy("Пока не нашёл подходящих вариантов."); return; } setPetState("happy"); openTitleRoute(pick.id, { recommendation: true }); });

  startPetStates();
  renderRoute(initialRoute, { replaceHistory: true });
  Promise.all([loadImportedCatalog(), loadLibraryData(false)])
    .then(() => {
      catalogHydrating = false;
      initialCatalogReady = true;
      renderRoute(readRouteFromLocation(), { replaceHistory: true });
      return loadEpisodeAssets();
    })
    .then(() => {
      render();
      return openWatchRoomFromUrl();
    });
  syncCatalogFromTmdb();
})();
