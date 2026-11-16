import Foundation

/// The site's own config (/config.local.js): where Lampac lives, the device id it lets in,
/// and the TMDB read token for when the server's TMDB route does not answer. Asked once per launch.
struct SiteConfig {
    let lampacOrigin: String
    let lampacUID: String
    let tmdbToken: String
}

/// The catalogue is the site's: TMDB, as Lampa uses it, through the server's /tmdb/3 route
/// (the key stays there). The same shelves, filters and rules as app/app.js and the TV app.
actor TMDBService {
    static let shared = TMDBService()

    /// The server and its site password, set by AppStore before anything is asked.
    nonisolated(unsafe) static var connection: (server: URL, authorization: String?) = (URL(string: AppStore.defaultServerAddress)!, nil)
    private var server: URL { Self.connection.server }
    private var authorization: String? { Self.connection.authorization }
    private var configuredServer: URL?
    private var cache: [String: [String: Any]] = [:]
    private var cacheOrder: [String] = []
    private var config: SiteConfig?
    private var configTask: Task<SiteConfig, Error>?

    func configure(server: URL, authorization: String?) {
        if configuredServer != nil, configuredServer != server { cache = [:]; cacheOrder = []; config = nil; configTask = nil }
        configuredServer = server
        Self.connection = (server, authorization)
    }

    nonisolated static func serverURL(_ path: String, base: URL) -> URL? {
        URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/" + path)
    }

    private func fetch(_ url: URL, timeout: TimeInterval, headers: [String: String] = [:]) async throws -> Data {
        var request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if url.host == server.host, let authorization { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
        headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw CineVaultAPIError.server(status: status, message: "Сервер ответил \(status)") }
        return data
    }

    func siteConfig() async throws -> SiteConfig {
        if let config { return config }
        if let configTask { return try await configTask.value }
        let url = Self.serverURL("config.local.js", base: server)!
        let task = Task<SiteConfig, Error> {
            let text = String(decoding: try await fetch(url, timeout: 15), as: UTF8.self)
            guard let open = text.firstIndex(of: "{"), let close = text.lastIndex(of: "}"),
                  let json = try JSONSerialization.jsonObject(with: Data(text[open...close].utf8)) as? [String: Any] else {
                throw CineVaultAPIError.invalidResponse
            }
            return SiteConfig(
                lampacOrigin: (json["lampacOrigin"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                lampacUID: json["lampacUid"] as? String ?? "",
                tmdbToken: json["tmdbApiKey"] as? String ?? ""
            )
        }
        configTask = task
        do {
            let value = try await task.value
            config = value
            return value
        } catch {
            configTask = nil
            throw error
        }
    }

    /// TMDB through our server; straight to TMDB with the site's read token if that fails.
    func get(_ path: String, timeout: TimeInterval = 12) async throws -> [String: Any] {
        if let cached = cache[path] { return cached }
        let data: Data
        do {
            data = try await fetch(Self.serverURL("tmdb/3/\(path)", base: server)!, timeout: timeout)
        } catch {
            guard let token = try? await siteConfig().tmdbToken, !token.isEmpty,
                  let direct = URL(string: "https://api.themoviedb.org/3/\(path)") else { throw error }
            if token.hasPrefix("eyJ") {
                data = try await fetch(direct, timeout: timeout, headers: ["Authorization": "Bearer \(token)"])
            } else {
                data = try await fetch(URL(string: direct.absoluteString + (path.contains("?") ? "&" : "?") + "api_key=\(token)")!, timeout: timeout)
            }
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CineVaultAPIError.invalidResponse }
        cache[path] = json
        cacheOrder.append(path)
        if cacheOrder.count > 400 {
            for old in cacheOrder.prefix(100) { cache.removeValue(forKey: old) }
            cacheOrder.removeFirst(100)
        }
        return json
    }

    func image(_ path: String?, size: String = "w500") -> String? {
        guard let path, !path.isEmpty, path != "null" else { return nil }
        return Self.serverURL("tmdb/t/p/\(size)\(path)", base: server)?.absoluteString
    }

    // MARK: Cards

    static let genres: [Int: String] = [
        28: "боевик", 12: "приключения", 16: "мультфильм", 35: "комедия", 80: "криминал", 99: "документальный", 18: "драма",
        10751: "семейный", 14: "фэнтези", 36: "история", 27: "ужасы", 10402: "музыка", 9648: "детектив", 10749: "мелодрама",
        878: "фантастика", 10770: "телефильм", 53: "триллер", 10752: "военный", 37: "вестерн",
        10759: "боевик", 10762: "детский", 10763: "новости", 10764: "реалити-шоу", 10765: "фантастика", 10766: "мыльная опера",
        10767: "ток-шоу", 10768: "военный",
    ]
    private static let movieGenreIDs: Set<Int> = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]
    private static let tvGenreIDs: Set<Int> = [10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37]
    private static let countries: [String: String] = [
        "US": "США", "GB": "Великобритания", "RU": "Россия", "FR": "Франция", "DE": "Германия", "IT": "Италия", "ES": "Испания",
        "JP": "Япония", "KR": "Южная Корея", "CN": "Китай", "CA": "Канада", "AU": "Австралия", "IN": "Индия", "SE": "Швеция",
        "DK": "Дания", "NO": "Норвегия", "BE": "Бельгия", "NL": "Нидерланды", "IE": "Ирландия", "NZ": "Новая Зеландия",
        "MX": "Мексика", "BR": "Бразилия", "TR": "Турция", "PL": "Польша", "UA": "Украина", "BY": "Беларусь", "KZ": "Казахстан",
        "CZ": "Чехия", "FI": "Финляндия", "AT": "Австрия", "CH": "Швейцария", "HK": "Гонконг", "TW": "Тайвань", "TH": "Таиланд",
        "AR": "Аргентина", "IS": "Исландия", "HU": "Венгрия", "RO": "Румыния", "SU": "СССР",
    ]

    static let catalogGenres = ["боевик", "комедия", "драма", "фантастика", "триллер", "ужасы", "мелодрама", "криминал", "приключения",
                                "фэнтези", "детектив", "семейный", "мультфильм", "аниме", "документальный", "история", "военный", "вестерн", "музыка"]

    nonisolated static func itemID(kind: String, tmdbID: Int) -> String { "tmdb-\(kind == "series" ? "tv" : "movie")-\(tmdbID)" }

    nonisolated static func parse(_ id: String) -> (kind: String, tmdbID: Int)? {
        let parts = id.split(separator: "-")
        guard parts.count == 3, parts[0] == "tmdb", let number = Int(parts[2]) else { return nil }
        return (parts[1] == "tv" ? "series" : "movie", number)
    }

    private static func string(_ value: Any?) -> String {
        switch value {
        case let text as String: return text == "null" ? "" : text
        case let number as NSNumber: return number.stringValue
        default: return ""
        }
    }

    private static func objects(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }

    private static func hasCyrillic(_ text: String) -> Bool { text.range(of: "[а-яёА-ЯЁ]", options: .regularExpression) != nil }

    private static func ageRating(_ raw: [String: Any]) -> String {
        func pick(_ list: [[String: Any]], _ field: ([String: Any]) -> String) -> String {
            for country in ["RU", "US"] {
                if let found = list.first(where: { string($0["iso_3166_1"]) == country }) {
                    let value = field(found)
                    if !value.isEmpty { return value }
                }
            }
            return ""
        }
        var value = ""
        if let ratings = raw["content_ratings"] as? [String: Any] {
            value = pick(objects(ratings["results"])) { string($0["rating"]) }
        } else if let dates = raw["release_dates"] as? [String: Any] {
            value = pick(objects(dates["results"])) { entry in objects(entry["release_dates"]).map { string($0["certification"]) }.first { !$0.isEmpty } ?? "" }
        }
        if let match = value.range(of: "\\d+", options: .regularExpression), let number = Int(value[match]) { return String(number) }
        let map = ["G": "0", "PG": "6", "PG-13": "12", "R": "18", "NC-17": "18", "TV-Y": "0", "TV-Y7": "6", "TV-G": "0",
                   "TV-PG": "12", "TV-14": "16", "TV-MA": "18"]
        return map[value] ?? ""
    }

    func item(_ raw: [String: Any], kindHint: String = "") -> CatalogTitle {
        let type = Self.string(raw["media_type"]).isEmpty ? kindHint : Self.string(raw["media_type"])
        let kind = type == "tv" || type == "series" || (type.isEmpty && raw["first_air_date"] != nil) ? "series" : "movie"
        let date = Self.string(raw["release_date"]).isEmpty ? Self.string(raw["first_air_date"]) : Self.string(raw["release_date"])
        let genreObjects = Self.objects(raw["genres"])
        let genreIDs = (raw["genre_ids"] as? [Int]) ?? genreObjects.compactMap { $0["id"] as? Int }
        var genres = genreObjects.isEmpty
            ? genreIDs.compactMap { Self.genres[$0] }
            : genreObjects.map { Self.genres[$0["id"] as? Int ?? 0] ?? Self.string($0["name"]).lowercased() }
        let origin = raw["origin_country"] as? [String] ?? []
        let anime = genreIDs.contains(16) && (Self.string(raw["original_language"]) == "ja" || origin.contains("JP"))
        if anime { genres = genres.map { $0 == "мультфильм" ? "аниме" : $0 } }
        var seenGenres = Set<String>()
        genres = genres.filter { seenGenres.insert($0).inserted }
        let tmdbID = raw["id"] as? Int ?? 0
        var title = [raw["title"], raw["name"], raw["original_title"], raw["original_name"]].map(Self.string).first { !$0.isEmpty } ?? ""
        if !Self.hasCyrillic(title), let alternatives = raw["alternative_titles"] as? [String: Any] {
            let russian = (Self.objects(alternatives["results"]) + Self.objects(alternatives["titles"]))
                .filter { Self.string($0["iso_3166_1"]) == "RU" && Self.hasCyrillic(Self.string($0["title"])) }
            if let pick = russian.first(where: { Self.string($0["type"]).isEmpty }) ?? russian.first { title = Self.string(pick["title"]) }
        }
        let credits = raw["credits"] as? [String: Any]
        let cast = Self.objects(credits?["cast"])
        let crew = Self.objects(credits?["crew"])
        var directors = crew.filter { Self.string($0["job"]) == "Director" }.map { Self.string($0["name"]) }.prefix(4).map { $0 }
        if directors.isEmpty { directors = Self.objects(raw["created_by"]).map { Self.string($0["name"]) } }
        var countries = Self.objects(raw["production_countries"]).map { Self.countries[Self.string($0["iso_3166_1"])] ?? Self.string($0["name"]) }
        if countries.isEmpty { countries = origin.map { Self.countries[$0] ?? $0 } }
        let seasons = Self.objects(raw["seasons"])
            .filter { ($0["season_number"] as? Int ?? 0) > 0 && ($0["episode_count"] as? Int ?? 0) > 0 }
            .sorted { ($0["season_number"] as? Int ?? 0) < ($1["season_number"] as? Int ?? 0) }
            .map { $0["episode_count"] as? Int ?? 0 }
        let votes = raw["vote_count"] as? Int ?? 0
        let average = (raw["vote_average"] as? NSNumber)?.doubleValue ?? 0
        let runtime = (raw["runtime"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? (raw["episode_run_time"] as? [Int])?.first ?? 0
        let externalIMDb = Self.string((raw["external_ids"] as? [String: Any])?["imdb_id"])
        let imdb = externalIMDb.hasPrefix("tt") ? externalIMDb : (Self.string(raw["imdb_id"]).hasPrefix("tt") ? Self.string(raw["imdb_id"]) : "")
        let logos = Self.objects((raw["images"] as? [String: Any])?["logos"])
        let logo = logos.first { Self.string($0["iso_639_1"]) == "ru" } ?? logos.first { Self.string($0["iso_639_1"]) == "en" } ?? logos.first

        var item = CatalogTitle(
            id: Self.itemID(kind: kind, tmdbID: tmdbID), kind: kind, title: title,
            originalTitle: [raw["original_title"], raw["original_name"]].map(Self.string).first { !$0.isEmpty } ?? title,
            year: Int(date.prefix(4)) ?? 0, description: Self.string(raw["overview"]), tags: genres, seasons: seasons,
            runtime: runtime, posterURL: image(Self.string(raw["poster_path"])), providerName: "TMDB", providerNote: "", videoURL: nil
        )
        item.isServerTitle = true
        item.rating = votes >= 5 ? (average * 10).rounded() / 10 : nil
        item.voteCount = votes
        item.actors = cast.prefix(20).map { Self.string($0["name"]) }
        item.directors = directors
        item.countries = countries
        item.backdropURL = image(Self.string(raw["backdrop_path"]), size: "w1280")
        item.logoURL = logo.flatMap { image(Self.string($0["file_path"]), size: "w500") }
        item.ageRating = Self.ageRating(raw)
        item.tagline = Self.string(raw["tagline"])
        item.imdbID = imdb.isEmpty ? nil : imdb
        item.premiere = date
        if let next = raw["next_episode_to_air"] as? [String: Any], !Self.string(next["air_date"]).isEmpty {
            item.nextAir = "\(Self.string(next["season_number"])) сезон, \(Self.string(next["episode_number"])) серия — \(Self.string(next["air_date"]))"
        }
        return item
    }

    func list(_ json: [String: Any]?, kindHint: String = "") -> [CatalogTitle] {
        Self.objects(json?["results"])
            .filter { entry in
                let type = Self.string(entry["media_type"]).isEmpty ? kindHint : Self.string(entry["media_type"])
                return type != "person" && (!Self.string(entry["poster_path"]).isEmpty || !Self.string(entry["backdrop_path"]).isEmpty)
            }
            .map { item($0, kindHint: kindHint) }
    }

    // MARK: Shelves

    private static func day(_ offset: Int = 0) -> String {
        let date = Calendar(identifier: .gregorian).date(byAdding: .day, value: offset, to: Date()) ?? Date()
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private struct ShelfSpec {
        let id, title, subtitle, path, kind: String
    }

    /// «Для вас»: the site's fixed TMDB rows on the home page; each shelf arrives on its own.
    func homeShelves(onShelf: @escaping @MainActor (Int, CatalogShelf) -> Void) async {
        let today = Self.day()
        let year = Calendar(identifier: .gregorian).component(.year, from: Date())
        let specs = [
            ShelfSpec(id: "now", title: "Сейчас смотрят", subtitle: "Вышли в цифре за последние три месяца — не экранки",
                      path: "discover/movie?with_release_type=4%7C5%7C6&release_date.lte=\(today)&release_date.gte=\(Self.day(-90))&sort_by=popularity.desc&vote_count.gte=10", kind: "movie"),
            ShelfSpec(id: "trend-day", title: "Тренды дня", subtitle: "", path: "trending/all/day", kind: ""),
            ShelfSpec(id: "popular-tv", title: "Популярные сериалы", subtitle: "", path: "trending/tv/week", kind: "tv"),
            ShelfSpec(id: "on-air", title: "Сейчас выходят", subtitle: "Новые серии на этой неделе",
                      path: "discover/tv?air_date.gte=\(Self.day(-7))&air_date.lte=\(today)&sort_by=popularity.desc&vote_count.gte=30", kind: "tv"),
            ShelfSpec(id: "trend-week", title: "Тренды недели", subtitle: "", path: "trending/movie/week", kind: "movie"),
            ShelfSpec(id: "upcoming", title: "Скоро", subtitle: "Премьеры ближайших двух месяцев",
                      path: "discover/movie?primary_release_date.gte=\(Self.day(1))&primary_release_date.lte=\(Self.day(60))&sort_by=popularity.desc", kind: "movie"),
            ShelfSpec(id: "this-year", title: "Новинки \(year) года", subtitle: "",
                      path: "discover/movie?primary_release_year=\(year)&primary_release_date.lte=\(today)&sort_by=popularity.desc&without_genres=16", kind: "movie"),
            ShelfSpec(id: "popular", title: "Популярные фильмы", subtitle: "", path: "movie/popular", kind: "movie"),
            ShelfSpec(id: "ru-movies", title: "Российские фильмы", subtitle: "", path: "discover/movie?with_origin_country=RU&sort_by=popularity.desc&vote_count.gte=20", kind: "movie"),
            ShelfSpec(id: "cartoons", title: "Мультфильмы", subtitle: "", path: "discover/movie?with_genres=16&sort_by=popularity.desc&vote_count.gte=50", kind: "movie"),
            ShelfSpec(id: "anime", title: "Аниме", subtitle: "", path: "discover/tv?with_genres=16&with_origin_country=JP&sort_by=popularity.desc&vote_count.gte=50", kind: "tv"),
            ShelfSpec(id: "top-movies", title: "Топ фильмов", subtitle: "", path: "movie/top_rated", kind: "movie"),
            ShelfSpec(id: "top-tv", title: "Топ сериалов", subtitle: "", path: "tv/top_rated", kind: "tv"),
        ]
        await withTaskGroup(of: Void.self) { group in
            for (index, spec) in specs.enumerated() {
                group.addTask {
                    let path = spec.path + (spec.path.contains("?") ? "&" : "?") + "language=ru-RU"
                    guard let json = try? await self.get(path) else { return }
                    var items = await self.list(json, kindHint: spec.kind)
                    if spec.id == "upcoming" { items = items.filter { $0.premiere.isEmpty || $0.premiere >= today } }
                    if spec.id == "cartoons" { items = items.filter { !$0.tags.contains("аниме") } }
                    guard !items.isEmpty else { return }
                    let shelf = CatalogShelf(id: spec.id, title: spec.title, subtitle: spec.subtitle, items: items)
                    await onShelf(index, shelf)
                }
            }
        }
    }

    // MARK: Catalogue and search

    /// One page of the catalogue grid: TMDB discover by kind, genre and sort (the site's tmdbDiscoverPath).
    func discoverPath(kind: String, page: Int, genre: String, sort: String) -> String {
        var params: [(String, String)] = [("language", "ru-RU"), ("page", String(page)), ("include_adult", "false")]
        let dateField = kind == "movie" ? "primary_release_date" : "first_air_date"
        switch sort {
        case "audience": params.append(("sort_by", "vote_count.desc"))
        case "rating": params += [("sort_by", "vote_average.desc"), ("vote_count.gte", kind == "movie" ? "500" : "200")]
        case "year": params += [("sort_by", "\(dateField).desc"), ("\(dateField).lte", Self.day()), ("vote_count.gte", "20")]
        case "title": params += [("sort_by", kind == "movie" ? "original_title.asc" : "name.asc"), ("vote_count.gte", "300")]
        default: params.append(("sort_by", "popularity.desc"))
        }
        if !genre.isEmpty {
            let valid = kind == "movie" ? Self.movieGenreIDs : Self.tvGenreIDs
            var ids = Self.genres.filter { $0.value == genre && valid.contains($0.key) }.keys.map(String.init)
            if genre == "мультфильм" || genre == "аниме" { ids.append("16") }
            if genre == "аниме" { params.append(("with_original_language", "ja")) }
            params.append(("with_genres", ids.isEmpty ? "0" : Array(Set(ids)).sorted().joined(separator: "|")))
        }
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+|"))
        return "discover/\(kind == "movie" ? "movie" : "tv")?" + params.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0.1)" }.joined(separator: "&")
    }

    func catalogPage(kind: String, page: Int, genre: String, sort: String) async throws -> (items: [CatalogTitle], pages: Int, total: Int) {
        let json = try await get(discoverPath(kind: kind, page: page, genre: genre, sort: sort), timeout: 15)
        return (list(json, kindHint: kind == "movie" ? "movie" : "tv"), min(500, max(1, json["total_pages"] as? Int ?? 1)), json["total_results"] as? Int ?? 0)
    }

    /// «Бегущие по краю 2», «Ведьмак 3 сезон»: a query that finds nothing is asked again without the trailing number.
    func search(_ query: String, kind: String = "") async throws -> (items: [CatalogTitle], total: Int) {
        func ask(_ text: String) async throws -> [String: Any] {
            let encoded = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))) ?? text
            let route = kind == "movie" ? "search/movie" : kind == "series" ? "search/tv" : "search/multi"
            return try await get("\(route)?query=\(encoded)&language=ru-RU&include_adult=false&page=1", timeout: 10)
        }
        var json = try await ask(query)
        let bare = query.replacingOccurrences(of: "[\\s:,.-]+(\\d{1,2}(\\s*(сезон|season|часть|part))?|(сезон|season|часть|part)\\s*\\d{1,2})\\s*$",
                                              with: "", options: [.regularExpression, .caseInsensitive]).trimmingCharacters(in: .whitespaces)
        if (json["total_results"] as? Int ?? 0) == 0, !bare.isEmpty, bare != query.trimmingCharacters(in: .whitespaces) { json = try await ask(bare) }
        let hint = kind == "movie" ? "movie" : kind == "series" ? "tv" : ""
        return (list(json, kindHint: hint), json["total_results"] as? Int ?? 0)
    }

    func title(_ id: String) async throws -> CatalogTitle {
        guard let (kind, tmdbID) = Self.parse(id) else { throw CineVaultAPIError.invalidResponse }
        let path = kind == "series" ? "tv" : "movie"
        let extra = kind == "series" ? "credits,external_ids,content_ratings,alternative_titles,images" : "credits,external_ids,release_dates,alternative_titles,images"
        return item(try await get("\(path)/\(tmdbID)?language=ru-RU&append_to_response=\(extra)&include_image_language=ru,en,null", timeout: 15), kindHint: path)
    }

    func similar(_ title: CatalogTitle) async -> [CatalogTitle] {
        guard let tmdbID = title.tmdbID else { return [] }
        let path = title.isSeries ? "tv" : "movie"
        async let recommended = try? get("\(path)/\(tmdbID)/recommendations?language=ru-RU")
        async let similar = try? get("\(path)/\(tmdbID)/similar?language=ru-RU")
        let all = list(await recommended, kindHint: path) + list(await similar, kindHint: path)
        var seen = Set<String>([title.id])
        return all.filter { seen.insert($0.id).inserted }.prefix(20).map { $0 }
    }

    /// IntroDB knows titles by IMDb id.
    func imdbID(_ title: CatalogTitle) async -> String {
        if let id = title.imdbID, id.hasPrefix("tt") { return id }
        guard let tmdbID = title.tmdbID else { return "" }
        let value = Self.string((try? await get("\(title.isSeries ? "tv" : "movie")/\(tmdbID)/external_ids"))?["imdb_id"])
        return value.hasPrefix("tt") ? value : ""
    }

    // MARK: Skip marks and trailers

    /// IntroDB marks of an episode (a film is season 0, episode 0), asked through our server, which caches them.
    func skipSegments(imdb: String, season: Int, episode: Int) async -> [SkipSegment] {
        guard !imdb.isEmpty, let url = Self.serverURL("api/skip-segments?imdb=\(imdb)&season=\(season)&episode=\(episode)", base: server),
              let data = try? await fetch(url, timeout: 10),
              let answer = try? JSONDecoder().decode(SkipMarks.self, from: data) else { return [] }
        return answer.segments.filter { $0.end > $0.start }
    }

    private struct SkipMarks: Decodable { let segments: [SkipSegment] }

    /// Trailers, as the site's «Трейлер»: Rutube, found by our server (works without a VPN).
    func trailers(_ title: CatalogTitle) async -> [Trailer] {
        func encode(_ text: String) -> String { text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))) ?? text }
        let path = "api/trailers?title=\(encode(title.title))&original=\(encode(title.originalTitle))&year=\(title.year > 0 ? String(title.year) : "")"
        guard let url = Self.serverURL(path, base: server), let data = try? await fetch(url, timeout: 15),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        return Self.objects(json["items"]).compactMap { entry in
            let id = Self.string(entry["id"])
            guard !id.isEmpty, (Self.string(entry["provider"]).isEmpty || Self.string(entry["provider"]) == "rutube") else { return nil }
            return Trailer(id: id, title: Self.string(entry["title"]), author: Self.string(entry["author"]).isEmpty ? "Rutube" : Self.string(entry["author"]),
                           duration: entry["duration"] as? Int ?? 0)
        }
    }

    /// Rutube's own HLS stream of a video, so AVPlayer plays it natively.
    func rutubeStream(_ id: String) async -> URL? {
        guard let url = URL(string: "https://rutube.ru/api/play/options/\(id)/?format=json&no_404=true"),
              let data = try? await fetch(url, timeout: 15),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let balancer = json["video_balancer"] as? [String: Any], let m3u8 = balancer["m3u8"] as? String else { return nil }
        return URL(string: m3u8)
    }
}

struct Trailer: Identifiable, Hashable {
    let id: String
    let title: String
    let author: String
    let duration: Int
}
