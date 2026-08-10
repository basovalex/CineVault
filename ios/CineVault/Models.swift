import Foundation

struct ServerConfiguration: Equatable {
    var baseURL: URL
    var viewerToken: String

    init?(address: String, viewerToken: String) {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "http" || url.scheme == "https", url.host != nil else {
            return nil
        }
        self.baseURL = url
        self.viewerToken = viewerToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct LibraryResponse: Codable {
    let items: [Episode]
    let history: [Episode]
}

struct OfflineManifest: Codable {
    let episodeID: String
    let quality: String
    let qualityPlaylist: String
    let resources: [String]
    let resourceSizes: [Int64]?

    enum CodingKeys: String, CodingKey {
        case episodeID = "episode_id"
        case quality
        case qualityPlaylist = "quality_playlist"
        case resources
        case resourceSizes = "resource_sizes"
    }
}

struct CatalogTitle: Identifiable, Hashable {
    let id: String
    let kind: String
    let title: String
    let originalTitle: String
    let year: Int
    let description: String
    let tags: [String]
    let seasons: [Int]
    let runtime: Int
    let posterURL: String?
    let providerName: String
    let providerNote: String
    let videoURL: String?

    var isSeries: Bool { kind == "series" }
    var kindLabel: String { isSeries ? "Сериал" : "Фильм" }
    var availabilityLabel: String { videoURL == nil ? "Источник пока не подключён" : "Можно смотреть" }
    var runtimeLabel: String {
        guard runtime > 0 else { return "" }
        if runtime >= 60 {
            let hours = runtime / 60
            let minutes = runtime % 60
            return minutes == 0 ? "\(hours) ч" : "\(hours) ч \(minutes) мин"
        }
        return "\(runtime) мин"
    }
    var seasonLabel: String {
        guard isSeries, !seasons.isEmpty else { return "" }
        return "\(seasons.count) сезонов · \(seasons.reduce(0, +)) серий"
    }

    static let featured: [CatalogTitle] = [
        CatalogTitle(id: "desperate-housewives", kind: "series", title: "Отчаянные домохозяйки", originalTitle: "Desperate Housewives", year: 2004, description: "Четыре подруги, тайны Вистерия-Лейн и история, к которой хочется возвращаться сериями.", tags: ["драма", "комедия", "уютно"], seasons: [23, 23, 23, 17, 24, 23, 23, 23], runtime: 42, posterURL: "https://image.tmdb.org/t/p/w780/jNCd3vGMnFMlZrcEOs686ckD22l.jpg", providerName: "CineVault", providerNote: "Серии появляются после добавления на личный сервер", videoURL: nil),
        CatalogTitle(id: "miraculous-ladybug", kind: "series", title: "Леди Баг и Супер-Кот", originalTitle: "Miraculous: Tales of Ladybug & Cat Noir", year: 2015, description: "Париж, супергерои, дружба и двойная жизнь Маринетт и Адриана.", tags: ["мультфильм", "приключения", "семейное"], seasons: [26, 25, 26, 26, 26, 26], runtime: 22, posterURL: "https://image.tmdb.org/t/p/w780/pJKWBSVPebRcyLe3pM5awvMioy8.jpg", providerName: "CineVault", providerNote: "Карточка готова; добавь разрешённые серии на сервер", videoURL: nil),
        CatalogTitle(id: "modern-family", kind: "series", title: "Американская семейка", originalTitle: "Modern Family", year: 2009, description: "Большая современная семья, три поколения и много смешных историй из обычной жизни.", tags: ["комедия", "семейное", "уютно"], seasons: [24, 24, 24, 24, 24, 24, 22, 22, 22, 22, 18], runtime: 22, posterURL: "https://image.tmdb.org/t/p/w780/tbTOeLXT56sywk7OS0qCaHzFNO6.jpg", providerName: "CineVault", providerNote: "Карточка готова; добавь разрешённые серии на сервер", videoURL: nil),
        CatalogTitle(id: "interstellar", kind: "movie", title: "Интерстеллар", originalTitle: "Interstellar", year: 2014, description: "Большая история о времени, расстоянии и связи, которая оказывается сильнее космоса.", tags: ["фантастика", "атмосферно", "на вечер"], seasons: [], runtime: 169, posterURL: "https://image.tmdb.org/t/p/w780/vReLRjDV9XPhiOSEW7QWow4DXwf.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "about-time", kind: "movie", title: "Бойфренд из будущего", originalTitle: "About Time", year: 2013, description: "Тёплая романтическая история о выборе, семье и самых обычных счастливых днях.", tags: ["романтика", "уютно", "для нас"], seasons: [], runtime: 123, posterURL: "https://image.tmdb.org/t/p/w780/xWk8ukJ6dhRvlrboG3qgNWNtLJ1.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "the-office", kind: "series", title: "Офис", originalTitle: "The Office", year: 2005, description: "Неловкая, тёплая и очень смешная компания, к которой быстро привыкаешь.", tags: ["комедия", "смеяться", "сериал"], seasons: [6, 22, 25, 19, 28, 26, 25, 24, 25], runtime: 22, posterURL: "https://image.tmdb.org/t/p/w780/zjW7g5PGsJMy7pIr0hKdBKWcH9V.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "little-women", kind: "movie", title: "Маленькие женщины", originalTitle: "Little Women", year: 2019, description: "Красивое, душевное кино о сёстрах, взрослении и доме, куда хочется возвращаться.", tags: ["драма", "уютно", "для нас"], seasons: [], runtime: 135, posterURL: "https://image.tmdb.org/t/p/w780/kEVtUHvmO5MqJK0XgEROCWegYfH.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "knives-out", kind: "movie", title: "Достать ножи", originalTitle: "Knives Out", year: 2019, description: "Уютный детектив с яркими персонажами, тайнами и отличным темпом на один вечер.", tags: ["детектив", "на вечер", "напряжённо"], seasons: [], runtime: 130, posterURL: "https://image.tmdb.org/t/p/w780/mGfb75tcFWxuT8esS1isHrNFE90.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "the-holiday", kind: "movie", title: "Отпуск по обмену", originalTitle: "The Holiday", year: 2006, description: "Мягкая романтическая комедия для вечера, когда хочется света, снега и добрых людей.", tags: ["романтика", "смеяться", "уютно"], seasons: [], runtime: 136, posterURL: "https://image.tmdb.org/t/p/w780/s8nco4vYuVwWFvxXR3vyGmS5K7F.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "arrival", kind: "movie", title: "Прибытие", originalTitle: "Arrival", year: 2016, description: "Спокойная и умная фантастика о языке, времени и попытке понять друг друга.", tags: ["фантастика", "атмосферно", "напряжённо"], seasons: [], runtime: 116, posterURL: "https://image.tmdb.org/t/p/w780/3K1byNV0CfChvJFNbe2ZAkiro4U.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "shawshank-redemption", kind: "movie", title: "Побег из Шоушенка", originalTitle: "The Shawshank Redemption", year: 1994, description: "История дружбы, надежды и внутренней свободы, которая выдерживает годы заключения.", tags: ["драма", "классика", "на вечер"], seasons: [], runtime: 142, posterURL: "https://image.tmdb.org/t/p/w780/yvmKPlTIi0xdcFQIFcQKQJcI63W.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "green-mile", kind: "movie", title: "Зелёная миля", originalTitle: "The Green Mile", year: 1999, description: "Трогательная фантастическая драма о людях, сострадании и чуде в блоке смертников.", tags: ["драма", "фэнтези", "классика"], seasons: [], runtime: 189, posterURL: "https://image.tmdb.org/t/p/w780/lHxe8t4B0CKv4DO0C0B4rsuiG95.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "forrest-gump", kind: "movie", title: "Форрест Гамп", originalTitle: "Forrest Gump", year: 1994, description: "Добрая история о жизни, любви и человеке, который всегда продолжает идти вперёд.", tags: ["драма", "романтика", "уютно"], seasons: [], runtime: 142, posterURL: "https://image.tmdb.org/t/p/w780/ejDjdjHHE1T0T7Bo8Ghj2y8gR02.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "the-matrix", kind: "movie", title: "Матрица", originalTitle: "The Matrix", year: 1999, description: "Неоновая фантастика о выборе, свободе и мире, который оказывается совсем не таким, как кажется.", tags: ["фантастика", "экшен", "напряжённо"], seasons: [], runtime: 136, posterURL: "https://image.tmdb.org/t/p/w780/kEDbym5htJgDQNenjUtSJxAHysB.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "prestige", kind: "movie", title: "Престиж", originalTitle: "The Prestige", year: 2006, description: "Мрачная и умная дуэль двух иллюзионистов, где каждый секрет требует новой жертвы.", tags: ["триллер", "драма", "детектив"], seasons: [], runtime: 130, posterURL: "https://image.tmdb.org/t/p/w780/cynfEpFBHGkdBIVpdnx8Od2TQNj.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "parasite", kind: "movie", title: "Паразиты", originalTitle: "Parasite", year: 2019, description: "Остроумная социальная драма с неожиданными поворотами и идеальным напряжением.", tags: ["драма", "триллер", "напряжённо"], seasons: [], runtime: 132, posterURL: "https://image.tmdb.org/t/p/w780/9xL2PwIOerz8jld06J9cxwuJfoD.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "grand-budapest", kind: "movie", title: "Отель «Гранд Будапешт»", originalTitle: "The Grand Budapest Hotel", year: 2014, description: "Яркая, стремительная и очень уютная комедия о дружбе, отеле и исчезнувшей картине.", tags: ["комедия", "приключения", "уютно"], seasons: [], runtime: 100, posterURL: "https://image.tmdb.org/t/p/w780/5qFxj03eBrkI0bUiGIonb4e0AI4.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "lord-of-the-rings", kind: "movie", title: "Властелин колец: Братство кольца", originalTitle: "The Lord of the Rings: The Fellowship of the Ring", year: 2001, description: "Большое путешествие хоббита и его друзей через Средиземье навстречу судьбе.", tags: ["фэнтези", "приключения", "на вечер"], seasons: [], runtime: 178, posterURL: "https://image.tmdb.org/t/p/w780/5CrZYYasUUxo71m0JXxTTDTsSpV.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "harry-potter-1", kind: "movie", title: "Гарри Поттер и философский камень", originalTitle: "Harry Potter and the Philosopher's Stone", year: 2001, description: "Первый вечер в Хогвартсе, дружба, тайны и магия, к которой хочется возвращаться.", tags: ["фэнтези", "семейное", "уютно"], seasons: [], runtime: 152, posterURL: "https://image.tmdb.org/t/p/w780/q3LZNzwW7ZWu4kSFIPGcB5CYFE4.jpg", providerName: "Источник не подключён", providerNote: "Карточка готова, разрешённый видеопоток пока не подключён", videoURL: nil),
        CatalogTitle(id: "sintel-open", kind: "movie", title: "Sintel", originalTitle: "Sintel", year: 2010, description: "Открытый фантастический фильм Blender Foundation о девушке, драконе и обещании, которое нельзя забыть.", tags: ["фантастика", "атмосферно", "на вечер"], seasons: [], runtime: 15, posterURL: "https://archive.org/services/img/Sintel", providerName: "Archive.org · CC BY 3.0", providerNote: "Открытый фильм, можно смотреть прямо в CineVault", videoURL: "https://archive.org/download/Sintel/sintel-2048-stereo_512kb.mp4"),
        CatalogTitle(id: "big-buck-bunny-open", kind: "movie", title: "Большой кролик", originalTitle: "Big Buck Bunny", year: 2008, description: "Добрая короткометражная история Blender Open Movie Project.", tags: ["комедия", "уютно", "на вечер"], seasons: [], runtime: 10, posterURL: "https://archive.org/services/img/big-buck-bunny-640x360_202403", providerName: "Archive.org · Public Domain", providerNote: "Открытый фильм, можно смотреть прямо в CineVault", videoURL: "https://archive.org/download/big-buck-bunny-640x360_202403/BigBuckBunny%20640x360.mp4"),
        CatalogTitle(id: "elephants-dream-open", kind: "movie", title: "Elephants Dream", originalTitle: "Elephants Dream", year: 2006, description: "Первый открытый фильм Blender Foundation: странное путешествие по механическому миру.", tags: ["фантастика", "атмосферно", "напряжённо"], seasons: [], runtime: 11, posterURL: "https://archive.org/services/img/elephants-dream_202403", providerName: "Archive.org · Public Domain", providerNote: "Открытый фильм, можно смотреть прямо в CineVault", videoURL: "https://archive.org/download/elephants-dream_202403/Elephants%20Dream.mp4"),
        CatalogTitle(id: "gentlemen-of-fortune-rutube", kind: "movie", title: "Джентльмены удачи", originalTitle: "Джентльмены удачи", year: 1971, description: "Легендарная советская комедия в официальной публикации Киноконцерна «Мосфильм» на RUTUBE.", tags: ["комедия", "уютно", "для нас"], seasons: [], runtime: 88, posterURL: nil, providerName: "RUTUBE · Мосфильм", providerNote: "Официальная публикация; просмотр откроется после подключения RUTUBE-плеера", videoURL: nil)
    ]
}

struct PlaybackProgress: Codable, Hashable {
    let position: Double
    let duration: Double
    let completed: Bool
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case position, duration, completed
        case updatedAt = "updatedAt"
    }
}

struct SkipSegment: Codable, Hashable, Identifiable {
    let type: String
    let start: Double
    let end: Double
    let confidence: Double?
    let submissionCount: Int?
    let source: String?

    var id: String { "\(type)-\(start)-\(end)" }

    var label: String {
        switch type {
        case "recap": return "Пропустить повторение"
        case "outro": return "Пропустить титры"
        default: return "Пропустить вступление"
        }
    }

    enum CodingKeys: String, CodingKey {
        case type, start, end, confidence
        case submissionCount = "submission_count"
        case source
    }
}

struct SkipSegmentsResponse: Codable {
    let available: Bool
    let source: String?
    let imdbID: String?
    let season: Int?
    let episode: Int?
    let fetchedAt: String?
    let segments: [SkipSegment]

    enum CodingKeys: String, CodingKey {
        case available, source
        case imdbID = "imdb_id"
        case season, episode
        case fetchedAt = "fetched_at"
        case segments
    }
}

struct Episode: Codable, Identifiable {
    let id: String
    let titleID: String?
    let title: String
    let kind: String
    let originalTitle: String?
    let year: Int?
    let overview: String?
    let posterURL: String?
    let season: Int?
    let episode: Int?
    let episodeTitle: String
    let status: String
    let hlsURL: String?
    let availableQualities: [String]?
    let sourceURL: String?
    let offlineManifestURL: String?
    var skipSegments: [SkipSegment]?
    var progress: PlaybackProgress?

    enum CodingKeys: String, CodingKey {
        case id
        case titleID = "title_id"
        case title, kind
        case originalTitle = "original_title"
        case year, overview
        case posterURL = "poster_url"
        case season, episode
        case episodeTitle = "episode_title"
        case status
        case hlsURL = "hls_url"
        case availableQualities = "available_qualities"
        case sourceURL = "source_url"
        case offlineManifestURL = "offline_manifest_url"
        case skipSegments = "skip_segments"
        case progress
    }

    var episodeLabel: String {
        guard let season, let episode else { return title }
        return "S\(String(format: "%02d", season))E\(String(format: "%02d", episode))"
    }

    var displayTitle: String {
        episodeTitle.isEmpty ? episodeLabel : episodeTitle
    }
}

struct ProgressUpdate: Encodable {
    let position: Double
    let duration: Double
    let completed: Bool
}
