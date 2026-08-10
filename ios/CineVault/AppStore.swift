import Foundation
import SwiftUI
import UIKit
import CryptoKit

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
    @Published var episodes: [Episode] = []
    @Published var catalog: [CatalogTitle] = CatalogTitle.featured
    @Published var history: [Episode] = []
    @Published var isLoading = false
    @Published var statusMessage = "Подключите сервер CineVault"
    @Published var serverAddress: String
    @Published var viewerToken: String
    @Published private(set) var catalogRequestIDs: Set<String> = []

    let api: CineVaultAPI
    let downloads = DownloadManager.shared
    private var refreshInFlight = false
    private let cacheFileName = "library-cache.json"
    private let progressFileName = "device-progress.json"
    private let catalogRequestsFileName = "catalog-requests.json"
    private var localProgress: [String: PlaybackProgress] = [:]

    init() {
        let defaults = UserDefaults.standard
        let savedServerAddress = defaults.string(forKey: "cinevault.serverAddress") ?? "http://127.0.0.1:8080"
        let savedViewerToken = defaults.string(forKey: "cinevault.viewerToken") ?? ""

        self.serverAddress = savedServerAddress
        self.viewerToken = savedViewerToken

        let configuration = ServerConfiguration(address: savedServerAddress, viewerToken: savedViewerToken)
            ?? ServerConfiguration(address: "http://127.0.0.1:8080", viewerToken: "")!
        self.api = CineVaultAPI(configuration: configuration)
        loadLocalProgress()
        loadCatalogRequests()
        loadCachedLibrary()
        prefetchPosters()
    }

    func connect() async {
        guard let configuration = ServerConfiguration(address: serverAddress, viewerToken: viewerToken) else {
            statusMessage = "Некорректный адрес сервера"
            return
        }
        api.configuration = configuration
        UserDefaults.standard.set(serverAddress, forKey: "cinevault.serverAddress")
        UserDefaults.standard.set(viewerToken, forKey: "cinevault.viewerToken")
        await refresh()
    }

    func refresh() async {
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
            statusMessage = episodes.isEmpty ? "Сервер подключён, но каталог пока пуст" : "Подключено серий: \(episodes.count)"
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
