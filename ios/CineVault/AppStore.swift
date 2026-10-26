import Foundation
import SwiftUI
import UIKit
import CryptoKit
import Security

private enum SecretStore {
    private static let service = "com.cinevault.personal"

    static func read(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func write(_ value: String, account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if value.isEmpty {
            let result = SecItemDelete(query as CFDictionary)
            return result == errSecSuccess || result == errSecItemNotFound
        }
        var item = query
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let result = SecItemAdd(item as CFDictionary, nil)
        if result == errSecDuplicateItem {
            let changes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
            return SecItemUpdate(query as CFDictionary, changes as CFDictionary) == errSecSuccess
        }
        return result == errSecSuccess
    }
}

actor PosterImageCache {
    static let shared = PosterImageCache()

    private var memory: [String: UIImage] = [:]
    private let fileManager = FileManager.default

    func image(for url: URL) async -> UIImage? {
        let key = url.absoluteString
        if let cached = memory[key] {
            return cached
        }

        let diskURL = diskURL(for: key)
        if let data = try? Data(contentsOf: diskURL), let image = UIImage(data: data) {
            remember(image, for: key)
            return image
        }

        do {
            let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 20)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let image = UIImage(data: data) else {
                return nil
            }
            try? fileManager.createDirectory(at: diskURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: diskURL, options: .atomic)
            remember(image, for: key)
            return image
        } catch {
            return nil
        }
    }

    func prefetch(urls: [URL]) async {
        let uniqueURLs = Array(Set(urls))
        await withTaskGroup(of: Void.self) { group in
            for url in uniqueURLs {
                group.addTask {
                    _ = await self.image(for: url)
                }
            }
        }
    }

    private func remember(_ image: UIImage, for key: String) {
        memory[key] = image
        if memory.count > 80, let firstKey = memory.keys.first {
            memory.removeValue(forKey: firstKey)
        }
    }

    private func diskURL(for key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        let directory = fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CineVaultPosters", isDirectory: true)
        return directory.appendingPathComponent("\(digest).jpg")
    }
}

@MainActor
final class AppStore: ObservableObject {
    static let defaultServerAddress = "https://cinevault-aleksandr.duckdns.org"

    private static var bundledBasicUsername: String {
        (Bundle.main.object(forInfoDictionaryKey: "CineVaultBasicUsername") as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static var bundledBasicPassword: String {
        Bundle.main.object(forInfoDictionaryKey: "CineVaultBasicPassword") as? String ?? ""
    }

    @Published var episodes: [Episode] = []
    @Published var catalog: [CatalogTitle] = []
    @Published private(set) var catalogPage = 1
    @Published private(set) var catalogPages = 1
    @Published private(set) var catalogTotal = 0
    @Published private(set) var catalogFacets: CatalogFacets?
    @Published private(set) var homeShelves: [CatalogShelf] = []
    @Published private(set) var homeLoading = false
    @Published private(set) var homeError: String?
    @Published private(set) var homePopularAvailable = false
    @Published private(set) var homeMood: String
    @Published private(set) var isCatalogLoading = false
    @Published private(set) var catalogError: String?
    @Published var history: [Episode] = []
    @Published var isLoading = false
    @Published var statusMessage = "Подключите сервер CineVault"
    @Published var serverAddress: String
    @Published var viewerToken: String
    @Published var basicUsername: String
    @Published var basicPassword: String
    @Published private(set) var catalogRequestIDs: Set<String> = []
    @Published private(set) var favorites: [FavoriteTitle] = []
    /// Progress shared with the website, keyed like the site's `state.progress`.
    @Published private(set) var catalogProgress: [String: CatalogProgressEntry] = [:]
    /// Full cards for titles in the shared history, newest first.
    @Published private(set) var watchedTitles: [CatalogTitle] = []

    let api: CineVaultAPI
    let downloads = DownloadManager.shared
    private var refreshInFlight = false
    private var catalogRequestVersion = 0
    private var catalogSelection = ""
    private var homeCandidates: [CatalogTitle] = []
    private var homeFeedLoaded = false
    private var homeLoadTask: Task<Void, Never>?
    private let cacheFileName = "library-cache.json"
    private let progressFileName = "device-progress.json"
    private let catalogRequestsFileName = "catalog-requests.json"
    private let favoritesFileName = "favorites.json"
    private let catalogProgressFileName = "catalog-progress.json"
    private var titleCache: [String: CatalogTitle] = [:]
    private var localProgress: [String: PlaybackProgress] = [:]

    init() {
        let defaults = UserDefaults.standard
        let savedServerAddress = defaults.string(forKey: "cinevault.serverAddress") ?? Self.defaultServerAddress
        let configuredBasicUsername = Self.bundledBasicUsername
        let configuredBasicPassword = Self.bundledBasicPassword
        let savedBasicUsername = configuredBasicUsername.isEmpty
            ? (defaults.string(forKey: "cinevault.basicUsername") ?? "") : configuredBasicUsername
        let savedBasicPassword = configuredBasicPassword.isEmpty
            ? (SecretStore.read("basicPassword") ?? "") : configuredBasicPassword
        let storedViewerToken = SecretStore.read("viewerToken")
            ?? defaults.string(forKey: "cinevault.viewerToken") ?? ""
        let savedViewerToken = savedBasicUsername.isEmpty ? storedViewerToken : ""
        if defaults.object(forKey: "cinevault.viewerToken") != nil {
            if SecretStore.write(savedViewerToken, account: "viewerToken") {
                defaults.removeObject(forKey: "cinevault.viewerToken")
            }
        }
        if SecretStore.read("basicPassword") == nil, !savedBasicPassword.isEmpty {
            _ = SecretStore.write(savedBasicPassword, account: "basicPassword")
        } else if !configuredBasicPassword.isEmpty, configuredBasicPassword != SecretStore.read("basicPassword") {
            _ = SecretStore.write(configuredBasicPassword, account: "basicPassword")
        }

        self.serverAddress = savedServerAddress
        self.viewerToken = savedViewerToken
        self.basicUsername = savedBasicUsername
        self.basicPassword = savedBasicPassword
        self.homeMood = defaults.string(forKey: "cinevault.homeMood") ?? "уютно"

        let configuration = ServerConfiguration(
            address: savedServerAddress, viewerToken: savedViewerToken,
            basicUsername: savedBasicUsername, basicPassword: savedBasicPassword
        )
            ?? ServerConfiguration(address: Self.defaultServerAddress, viewerToken: "")!
        self.api = CineVaultAPI(configuration: configuration)
        if defaults.string(forKey: "cinevault.basicUsername") == nil, !savedBasicUsername.isEmpty {
            defaults.set(savedBasicUsername, forKey: "cinevault.basicUsername")
        }
        loadLocalProgress()
        loadCatalogRequests()
        loadFavorites()
        loadCatalogProgressFromDisk()
        loadCachedLibrary()
        prefetchPosters()
    }

    func connect() async {
        guard let configuration = ServerConfiguration(
            address: serverAddress, viewerToken: viewerToken,
            basicUsername: basicUsername, basicPassword: basicPassword
        ) else {
            statusMessage = "Проверь адрес и выбери один способ входа: Basic или viewer-токен"
            return
        }
        guard SecretStore.write(viewerToken, account: "viewerToken"),
              SecretStore.write(basicPassword, account: "basicPassword") else {
            statusMessage = "Не удалось сохранить пароль в защищённом хранилище iPhone"
            return
        }
        api.configuration = configuration
        UserDefaults.standard.set(serverAddress, forKey: "cinevault.serverAddress")
        UserDefaults.standard.set(basicUsername, forKey: "cinevault.basicUsername")
        await loadCatalogPage(1)
        await refresh()
        await loadHomeDiscovery(force: true)
    }

    func loadCatalogFacets() async {
        guard catalogFacets == nil else { return }
        do {
            catalogFacets = try await api.fetchCatalogFacets()
        } catch {
            // Facets are optional; the catalog itself remains usable if this endpoint fails.
        }
    }

    func loadHomeDiscovery(force: Bool = false) async {
        // A view's task is cancelled when the view goes away or a pull-to-refresh ends;
        // the shelves load in a task of their own, so a half-done load is never thrown away.
        if let running = homeLoadTask {
            await running.value
            return
        }
        guard force || !homeFeedLoaded else { return }
        let task = Task { await performHomeDiscovery() }
        homeLoadTask = task
        await task.value
        homeLoadTask = nil
    }

    private func performHomeDiscovery() async {
        homeLoading = true
        homeError = nil
        defer { homeLoading = false }
        // Each collection loads on its own: one that fails only leaves its shelf out.
        async let popular = homePage(sort: "popular", collection: "popular")
        async let recent = homePage(sort: "new", collection: "new")
        async let evening = homePage(sort: "rating", collection: "evening")
        async let anime = homePage(sort: "rating", collection: "anime")
        async let tense = homePage(sort: "rating", collection: "tense")
        async let together = homePage(sort: "rating", collection: "together")
        let results = await [popular, recent, evening, anime, tense, together]
        let pages = results.map { try? $0.get() }
        guard pages.contains(where: { $0 != nil }) else {
            if case .failure(let error)? = results.first { homeError = error.localizedDescription }
            return
        }
        func titles(_ index: Int) -> [CatalogTitle] {
            pages[index]?.items.map(\.catalogTitle) ?? []
        }
        let entries = pages.indices.flatMap(titles)
        var unique: [String: CatalogTitle] = [:]
        entries.forEach { unique[$0.id] = $0 }
        homeCandidates = Array(unique.values)

        var tasteGenres: [String: Int] = [:]
        var seenTitleIDs = Set<String>()
        // Taste comes from what was watched on this device only.
        let watchedOnDevice = latestProgressByTitle.map(\.titleId) + history.compactMap(\.titleID)
        let watchedTitleIDs = watchedOnDevice.filter { seenTitleIDs.insert($0).inserted }.prefix(3)
        for titleID in watchedTitleIDs {
            if let watched = try? await api.fetchCatalogTitle(id: titleID) {
                for genre in watched.tags.map({ $0.localizedLowercase }) {
                    tasteGenres[genre, default: 0] += 1
                }
            }
        }
        let popularTitles = titles(0)
        let recentTitles = titles(1)
        let personal = rankedPersonalTitles(
            homeCandidates, tasteGenres: tasteGenres,
            watchedTitleIDs: Set(watchedOnDevice)
        )
        let moodItems = homeCandidates
            .filter { title in title.tags.contains(where: { moodGenres.contains($0.localizedLowercase) }) }
            .sorted(by: discoveryOrder)
        homeShelves = [
            CatalogShelf(id: "personal", title: "Советуем вам", subtitle: tasteGenres.isEmpty ? "Первые рекомендации — со временем подстроятся под просмотры" : "Похоже на то, что вы уже смотрели", items: personal),
            CatalogShelf(id: "popular", title: "Популярное", subtitle: "Сначала карточки с большим числом оценок Kinopoisk", items: popularTitles),
            CatalogShelf(id: "recent", title: "Новое и обсуждаемое", subtitle: "Свежие карточки, о которых уже голосуют", items: recentTitles),
            CatalogShelf(id: "mood", title: moodShelfTitle, subtitle: moodShelfDescription, items: moodItems),
            CatalogShelf(id: "evening", title: "На один вечер", subtitle: "Фильмы, которые удобно включить сегодня", items: titles(2)),
            CatalogShelf(id: "anime", title: "Аниме", subtitle: "Анимационные фильмы и сериалы", items: titles(3)),
            CatalogShelf(id: "together", title: "Для двоих", subtitle: "Романтика и истории для совместного вечера", items: titles(5)),
            CatalogShelf(id: "tense", title: "Держит в напряжении", subtitle: "Триллеры, детективы и криминальные истории", items: titles(4)),
        ].filter { !$0.items.isEmpty }
        homePopularAvailable = !popularTitles.isEmpty
        homeFeedLoaded = true
        prefetchPosters()
    }

    private func homePage(sort: String, collection: String) async -> Result<RemoteCatalogPage, Error> {
        do {
            return .success(try await api.fetchCatalogPage(page: 1, sort: sort, collection: collection))
        } catch {
            return .failure(error)
        }
    }

    func selectHomeMood(_ mood: String) {
        guard ["уютно", "романтично", "смеяться", "напряжённо"].contains(mood) else { return }
        homeMood = mood
        UserDefaults.standard.set(mood, forKey: "cinevault.homeMood")
        guard homeFeedLoaded else { return }
        let moodItems = homeCandidates
            .filter { title in title.tags.contains(where: { moodGenres(for: mood).contains($0.localizedLowercase) }) }
            .sorted(by: discoveryOrder)
        let shelf = CatalogShelf(id: "mood", title: moodShelfTitle, subtitle: moodShelfDescription, items: moodItems)
        if let index = homeShelves.firstIndex(where: { $0.id == "mood" }) {
            homeShelves[index] = shelf
        } else if !moodItems.isEmpty {
            homeShelves.insert(shelf, at: min(3, homeShelves.count))
        }
        homeShelves.removeAll { $0.id == "mood" && $0.items.isEmpty }
    }

    private var moodGenres: [String] { moodGenres(for: homeMood) }

    private func moodGenres(for mood: String) -> [String] {
        switch mood {
        case "романтично": return ["мелодрама", "комедия", "драма", "романтика"]
        case "смеяться": return ["комедия", "мультфильм", "семейный"]
        case "напряжённо": return ["триллер", "детектив", "ужасы", "криминал", "боевик"]
        default: return ["комедия", "семейный", "мультфильм", "приключения", "фэнтези", "мелодрама"]
        }
    }

    private var moodShelfTitle: String {
        switch homeMood {
        case "романтично": return "Для двоих"
        case "смеяться": return "Чтобы посмеяться"
        case "напряжённо": return "Держит в напряжении"
        default: return "Уютное на вечер"
        }
    }

    private var moodShelfDescription: String {
        switch homeMood {
        case "романтично": return "Мелодрамы, романтические комедии и истории о людях"
        case "смеяться": return "Комедии и лёгкие истории для отдыха"
        case "напряжённо": return "Триллеры, детективы и истории с сильной интригой"
        default: return "Тёплые истории, приключения и семейное кино"
        }
    }

    private func discoveryOrder(_ lhs: CatalogTitle, _ rhs: CatalogTitle) -> Bool {
        if lhs.voteCount != rhs.voteCount { return (lhs.voteCount ?? 0) > (rhs.voteCount ?? 0) }
        if lhs.rating != rhs.rating { return (lhs.rating ?? 0) > (rhs.rating ?? 0) }
        return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
    }

    private func rankedPersonalTitles(
        _ items: [CatalogTitle], tasteGenres: [String: Int], watchedTitleIDs: Set<String>
    ) -> [CatalogTitle] {
        items.filter { !watchedTitleIDs.contains($0.id) }
            .sorted { lhs, rhs in
                let lhsTaste = lhs.tags.reduce(0) { $0 + (tasteGenres[$1.localizedLowercase] ?? 0) }
                let rhsTaste = rhs.tags.reduce(0) { $0 + (tasteGenres[$1.localizedLowercase] ?? 0) }
                if lhsTaste != rhsTaste { return lhsTaste > rhsTaste }
                return discoveryOrder(lhs, rhs)
            }
            .prefix(12).map { $0 }
    }

    func loadCatalogPage(
        _ page: Int, search: String = "", kind: String = "", genre: String = "",
        sort: String = "rating", collection: String = ""
    ) async {
        guard let configuration = ServerConfiguration(
            address: serverAddress, viewerToken: viewerToken,
            basicUsername: basicUsername, basicPassword: basicPassword
        ), configuration == api.configuration else {
            catalogError = "Укажи адрес в Настройках и нажми «Подключить и обновить»."
            return
        }
        if page > 1 && isCatalogLoading { return }
        let selection = "\(search)|\(kind)|\(genre)|\(sort)|\(collection)"
        if page == 1 && selection != catalogSelection {
            catalog = []
            catalogPage = 1
            catalogPages = 1
            catalogTotal = 0
            catalogSelection = selection
        }
        catalogRequestVersion += 1
        let requestVersion = catalogRequestVersion
        isCatalogLoading = true
        catalogError = nil
        defer {
            if requestVersion == catalogRequestVersion { isCatalogLoading = false }
        }
        do {
            let response = try await api.fetchCatalogPage(
                page: page, search: search, kind: kind, genre: genre, sort: sort, collection: collection
            )
            guard requestVersion == catalogRequestVersion, !Task.isCancelled else { return }
            let items = response.items.map(\.catalogTitle)
            if page > 1 {
                let known = Set(catalog.map(\.id))
                catalog += items.filter { !known.contains($0.id) }
            } else {
                catalog = items
            }
            catalogPage = response.page
            catalogPages = response.pages
            catalogTotal = response.total
            prefetchPosters()
        } catch {
            guard requestVersion == catalogRequestVersion, !Task.isCancelled else { return }
            catalogError = error.localizedDescription
        }
    }

    func refresh() async {
        guard let configuration = ServerConfiguration(
            address: serverAddress, viewerToken: viewerToken,
            basicUsername: basicUsername, basicPassword: basicPassword
        ), configuration == api.configuration else { return }
        guard !refreshInFlight else { return }
        refreshInFlight = true
        isLoading = true
        defer {
            isLoading = false
            refreshInFlight = false
        }
        do {
            let response = try await api.fetchLibrary()
            episodes = applyLocalProgress(to: response.items)
            rebuildLocalHistory()
            saveCachedLibrary(LibraryResponse(items: episodes, history: history))
            prefetchPosters()
            statusMessage = episodes.isEmpty ? "Сервер подключён · личная медиатека пока пуста" : "Подключено серий: \(episodes.count)"
            await loadCatalogProgress()
        } catch {
            if episodes.isEmpty {
                statusMessage = error.localizedDescription
            } else {
                statusMessage = "Офлайн-кэш · сервер временно недоступен"
            }
        }
    }

    func refreshPeriodically() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 120_000_000_000)
            guard !Task.isCancelled else { return }
            await refresh()
        }
    }

    // MARK: Favourites (on this iPhone, like the site keeps them in its browser)

    func isFavorite(_ id: String) -> Bool {
        favorites.contains { $0.id == id }
    }

    func toggleFavorite(_ title: CatalogTitle) {
        if isFavorite(title.id) {
            favorites.removeAll { $0.id == title.id }
        } else {
            favorites.insert(FavoriteTitle(title), at: 0)
        }
        saveFavorites()
    }

    // MARK: Watch history (on this iPhone; the site keeps its own per browser)

    func loadCatalogProgress() async {
        await resolveWatchedTitles()
    }

    /// The newest progress entry per title, newest first.
    var latestProgressByTitle: [CatalogProgressEntry] {
        var newest: [String: CatalogProgressEntry] = [:]
        for entry in catalogProgress.values where entry.updatedAt > (newest[entry.titleId]?.updatedAt ?? 0) {
            newest[entry.titleId] = entry
        }
        return newest.values.sorted { $0.updatedAt > $1.updatedAt }
    }

    func progress(forTitle id: String) -> CatalogProgressEntry? {
        latestProgressByTitle.first { $0.titleId == id }
    }

    /// Marks a title as opened in an embedded player, as the site does: those
    /// players keep the position themselves, so only the moment is recorded.
    func recordEmbedOpened(_ title: CatalogTitle, providerID: String, translationName: String? = nil) {
        var entry = CatalogProgressEntry(titleId: title.id, updatedAt: Int(Date().timeIntervalSince1970 * 1000))
        entry.providerId = providerID
        entry.player = "embed:\(providerID)"
        entry.translationName = translationName
        entry.position = 0
        entry.duration = 0
        entry.completed = false
        storeProgress(entry, contentID: "\(title.id)-embed", title: title)
    }

    func recordPlayback(_ title: CatalogTitle, position: Double, duration: Double) {
        guard duration > 0 else { return }
        var entry = CatalogProgressEntry(titleId: title.id, updatedAt: Int(Date().timeIntervalSince1970 * 1000))
        entry.player = "cinevault"
        entry.position = position
        entry.duration = duration
        entry.completed = position / duration > 0.95
        storeProgress(entry, contentID: title.id, title: title)
    }

    private func storeProgress(_ entry: CatalogProgressEntry, contentID: String, title: CatalogTitle) {
        catalogProgress[contentID] = entry
        titleCache[title.id] = title
        watchedTitles.removeAll { $0.id == title.id }
        watchedTitles.insert(title, at: 0)
        saveCatalogProgress()
    }

    private func resolveWatchedTitles() async {
        let ids = latestProgressByTitle.prefix(30).map(\.titleId)
        var resolved: [CatalogTitle] = []
        for id in ids {
            if let cached = titleCache[id] {
                resolved.append(cached)
            } else if let title = try? await api.fetchCatalogTitle(id: id) {
                titleCache[id] = title
                resolved.append(title)
            }
        }
        watchedTitles = resolved
    }

    func download(_ episode: Episode) {
        downloads.download(episode, using: api)
    }

    func isCatalogTitleRequested(_ title: CatalogTitle) -> Bool {
        catalogRequestIDs.contains(title.id)
    }

    func requestCatalogTitle(_ title: CatalogTitle) async throws {
        guard !isCatalogTitleRequested(title) else { return }
        _ = try await api.createCatalogRequest(for: title)
        catalogRequestIDs.insert(title.id)
        saveCatalogRequests()
    }

    func progress(for episode: Episode) -> Double {
        guard let progress = episode.progress, progress.duration > 0 else { return 0 }
        return min(max(progress.position / progress.duration, 0), 1)
    }

    var continueWatching: [Episode] {
        history.filter { !($0.progress?.completed ?? false) }
    }

    func recordLocalProgress(episodeID: String, position: Double, duration: Double, completed: Bool) {
        let progress = PlaybackProgress(
            position: max(0, position),
            duration: max(0, duration),
            completed: completed,
            updatedAt: ISO8601DateFormatter().string(from: Date())
        )
        localProgress[episodeID] = progress
        episodes = episodes.map { episode in
            guard episode.id == episodeID else { return episode }
            var updated = episode
            updated.progress = progress
            return updated
        }
        rebuildLocalHistory()
        saveLocalProgress()
    }

    func cacheSkipSegments(_ segments: [SkipSegment], for episodeID: String) {
        episodes = episodes.map { episode in
            guard episode.id == episodeID else { return episode }
            var updated = episode
            updated.skipSegments = segments
            return updated
        }
        rebuildLocalHistory()
        saveCachedLibrary(LibraryResponse(items: episodes, history: history))
    }

    private func prefetchPosters() {
        let urls = (catalog.compactMap { $0.posterURL }
            + episodes.compactMap { $0.posterURL })
            .compactMap(URL.init(string:))
        Task {
            await PosterImageCache.shared.prefetch(urls: urls)
        }
    }

    private func loadCachedLibrary() {
        guard let url = cacheURL,
              let data = try? Data(contentsOf: url),
              let cached = try? JSONDecoder().decode(LibraryResponse.self, from: data) else {
            return
        }
        episodes = applyLocalProgress(to: cached.items)
        rebuildLocalHistory()
        statusMessage = "Кэш каталога загружен · обновляю в фоне"
    }

    private func applyLocalProgress(to items: [Episode]) -> [Episode] {
        items.map { episode in
            var updated = episode
            updated.progress = localProgress[episode.id]
            return updated
        }
    }

    private func rebuildLocalHistory() {
        history = episodes.compactMap { episode in
            guard let progress = localProgress[episode.id], progress.position > 0 || progress.completed else {
                return nil
            }
            var updated = episode
            updated.progress = progress
            return updated
        }
        .sorted { left, right in
            (left.progress?.updatedAt ?? "") > (right.progress?.updatedAt ?? "")
        }
    }

    private func loadLocalProgress() {
        guard let url = storageURL(progressFileName),
              let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode([String: PlaybackProgress].self, from: data) else {
            return
        }
        localProgress = stored
    }

    private func saveLocalProgress() {
        guard let url = storageURL(progressFileName),
              let data = try? JSONEncoder().encode(localProgress) else {
            return
        }
        try? data.write(to: url, options: .atomic)
    }

    private func loadCatalogRequests() {
        guard let url = storageURL(catalogRequestsFileName),
              let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode(Set<String>.self, from: data) else {
            return
        }
        catalogRequestIDs = stored
    }

    private func saveCatalogRequests() {
        guard let url = storageURL(catalogRequestsFileName),
              let data = try? JSONEncoder().encode(catalogRequestIDs) else {
            return
        }
        try? data.write(to: url, options: .atomic)
    }

    private func loadFavorites() {
        guard let url = storageURL(favoritesFileName),
              let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode([FavoriteTitle].self, from: data) else {
            return
        }
        favorites = stored
    }

    private func loadCatalogProgressFromDisk() {
        guard let url = storageURL(catalogProgressFileName),
              let data = try? Data(contentsOf: url),
              let stored = try? JSONDecoder().decode([String: CatalogProgressEntry].self, from: data) else {
            return
        }
        catalogProgress = stored
    }

    private func saveCatalogProgress() {
        guard let url = storageURL(catalogProgressFileName),
              let data = try? JSONEncoder().encode(catalogProgress) else {
            return
        }
        try? data.write(to: url, options: .atomic)
    }

    private func saveFavorites() {
        guard let url = storageURL(favoritesFileName),
              let data = try? JSONEncoder().encode(favorites) else {
            return
        }
        try? data.write(to: url, options: .atomic)
    }

    private func saveCachedLibrary(_ response: LibraryResponse) {
        guard let url = cacheURL,
              let data = try? JSONEncoder().encode(response) else {
            return
        }
        try? data.write(to: url, options: .atomic)
    }

    private var cacheURL: URL? {
        storageURL(cacheFileName)
    }

    private func storageURL(_ filename: String) -> URL? {
        guard let directory = try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else {
            return nil
        }
        let directoryURL = directory.appendingPathComponent("CineVault", isDirectory: true)
        try? FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        return directoryURL.appendingPathComponent(filename)
    }
}
