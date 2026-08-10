import Foundation
import Combine

final class DownloadManager: NSObject, ObservableObject, URLSessionDownloadDelegate {
    static let shared = DownloadManager()

    @Published private(set) var progress: [String: Double] = [:]
    @Published private(set) var downloadedFiles: [String: URL] = [:]
    @Published private(set) var activeDownloads: Set<String> = []
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var downloadedBytes: [String: Int64] = [:]
    @Published private(set) var totalBytes: [String: Int64] = [:]
    @Published private(set) var downloadSpeed: [String: Double] = [:]
    @Published private(set) var downloadStartedAt: [String: Date] = [:]
    var backgroundEventsCompletionHandler: (() -> Void)?

    private lazy var legacySession: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: "com.cinevault.ios.downloads")
        configuration.allowsCellularAccess = true
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    // HLS consists of small independent segments. Several requests at once are
    // much faster than downloading the original 1–1.5 GB MP4 as one task.
    private lazy var segmentSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.allowsCellularAccess = true
        configuration.waitsForConnectivity = true
        configuration.httpMaximumConnectionsPerHost = 8
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    private var taskToEpisode: [Int: String] = [:]
    private var hlsTasks: [String: Task<Void, Never>] = [:]
    private static let storageSafetyMargin: Int64 = 100 * 1024 * 1024

    override init() {
        super.init()
        restoreTasks()
        restoreFiles()
    }

    func reconnectBackgroundSession() {
        _ = legacySession
    }

    func localFile(for episodeID: String) -> URL? {
        guard let url = downloadedFiles[episodeID], FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }
        return url
    }

    func playbackURL(for localURL: URL) async throws -> URL {
        try await LocalHLSFileServer.shared.playbackURL(for: localURL)
    }

    func isDownloaded(_ episodeID: String) -> Bool {
        localFile(for: episodeID) != nil
    }

    func isDownloading(_ episodeID: String) -> Bool {
        activeDownloads.contains(episodeID)
    }

    func errorMessage(for episodeID: String) -> String? {
        errors[episodeID]
    }

    /// Downloads the original source file whenever the server has one. This is
    /// the best available quality and gives the offline player a single local
    /// MP4 instead of a user-selected HLS quality.
    func download(_ episode: Episode, using api: CineVaultAPI) {
        guard !isDownloaded(episode.id), !isDownloading(episode.id) else { return }

        if let sourcePath = episode.sourceURL,
           let request = try? api.authorizedRequest(for: sourcePath) {
            begin(episodeID: episode.id)
            hlsTasks[episode.id] = Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.preflightLegacyDownload(request)
                    try Task.checkCancellation()
                    let task = self.legacySession.downloadTask(with: request)
                    self.taskToEpisode[task.taskIdentifier] = episode.id
                    self.persistTasks()
                    task.resume()
                } catch is CancellationError {
                    self.cancelled(episodeID: episode.id)
                } catch {
                    self.finish(episodeID: episode.id, error: error.localizedDescription)
                }
                self.hlsTasks[episode.id] = nil
            }
            return
        }

        // Compatibility fallback for old entries that expose only HLS.
        guard episode.offlineManifestURL != nil else {
            finish(episodeID: episode.id, error: "На сервере нет файла для загрузки")
            return
        }
        let selectedQuality = preferredQuality(for: episode)
        begin(episodeID: episode.id)
        hlsTasks[episode.id] = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.downloadHLS(episode, quality: selectedQuality, using: api)
                self.finish(episodeID: episode.id, error: nil)
            } catch is CancellationError {
                self.cancelled(episodeID: episode.id)
            } catch {
                self.finish(episodeID: episode.id, error: error.localizedDescription)
            }
            self.hlsTasks[episode.id] = nil
        }
    }

    func cancel(episodeID: String) {
        cancelTasks(for: episodeID)
        removeTemporaryHLSDirectory(for: episodeID)
        cancelled(episodeID: episodeID)
    }

    func deleteDownloaded(episodeID: String) {
        cancelTasks(for: episodeID)
        guard let directory = try? downloadsDirectory() else { return }

        let finalHLSDirectory = directory.appendingPathComponent("episode-\(episodeID)-hls", isDirectory: true)
        let temporaryHLSDirectory = directory.appendingPathComponent(".episode-\(episodeID)-hls.tmp", isDirectory: true)
        let mp4File = directory.appendingPathComponent("episode-\(episodeID).mp4")
        let localURL = downloadedFiles[episodeID]

        // Remove only paths inside CineVaultDownloads: the server copy is never touched.
        for url in [localURL, finalHLSDirectory, temporaryHLSDirectory, mp4File].compactMap({ $0 }) {
            try? FileManager.default.removeItem(at: url)
        }

        downloadedFiles[episodeID] = nil
        progress[episodeID] = nil
        downloadedBytes[episodeID] = nil
        totalBytes[episodeID] = nil
        downloadSpeed[episodeID] = nil
        downloadStartedAt[episodeID] = nil
        errors[episodeID] = nil
        persistFiles()
    }

    private func cancelTasks(for episodeID: String) {
        hlsTasks[episodeID]?.cancel()
        hlsTasks[episodeID] = nil
        legacySession.getAllTasks { [weak self] tasks in
            guard let self else { return }
            tasks.filter { self.taskToEpisode[$0.taskIdentifier] == episodeID }.forEach { $0.cancel() }
        }
    }

    private func preferredQuality(for episode: Episode) -> String {
        let available = episode.availableQualities ?? []
        return available.max { lhs, rhs in
            let lhsHeight = Int(lhs.filter { $0.isNumber }) ?? 0
            let rhsHeight = Int(rhs.filter { $0.isNumber }) ?? 0
            return lhsHeight < rhsHeight
        } ?? "360p"
    }

    private func downloadHLS(_ episode: Episode, quality: String, using api: CineVaultAPI) async throws {
        let manifest = try await api.fetchOfflineManifest(for: episode, quality: quality)
        guard !manifest.resources.isEmpty else { throw DownloadError.emptyManifest }

        let directory = try downloadsDirectory()
        let temporaryDirectory = directory.appendingPathComponent(".episode-\(episode.id)-hls.tmp", isDirectory: true)
        let finalDirectory = directory.appendingPathComponent("episode-\(episode.id)-hls", isDirectory: true)
        removeTemporaryHLSDirectory(for: episode.id)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)

        var completedResources = 0
        let resourceSizes = manifest.resourceSizes ?? []
        let knownTotalBytes = resourceSizes.reduce(Int64(0), +)
        if knownTotalBytes > 0 {
            try ensureAvailableStorage(requiredBytes: knownTotalBytes)
        }
        setDownloadMetadata(episodeID: episode.id, total: knownTotalBytes > 0 ? knownTotalBytes : nil)
        let resources = Array(manifest.resources.enumerated())
        let session = segmentSession

        do {
            try await withThrowingTaskGroup(of: (Int, Data, Int64).self) { group in
                for (index, resource) in resources {
                    group.addTask {
                        try Task.checkCancellation()
                        let request = try api.authorizedRequest(for: resource)
                        let (data, response) = try await session.data(for: request)
                        guard let httpResponse = response as? HTTPURLResponse,
                              (200..<300).contains(httpResponse.statusCode) else {
                            throw DownloadError.resourceUnavailable
                        }
                        return (index, data, Int64(data.count))
                    }
                }

                var completedBytes: Int64 = 0
                for try await (index, data, bytes) in group {
                    try Task.checkCancellation()
                    let resource = resources[index].1
                    let filename = Self.safeFilename(for: resource)
                    do {
                        if knownTotalBytes == 0 {
                            try ensureAvailableStorage(requiredBytes: bytes)
                        }
                        try data.write(to: temporaryDirectory.appendingPathComponent(filename), options: .atomic)
                    } catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == 28 {
                        throw insufficientStorageError()
                    }
                    completedResources += 1
                    completedBytes += bytes
                    let fallbackProgress = Double(completedResources) / Double(resources.count)
                    updateProgress(
                        episodeID: episode.id,
                        value: knownTotalBytes > 0 ? Double(completedBytes) / Double(knownTotalBytes) : fallbackProgress,
                        downloaded: completedBytes,
                        total: knownTotalBytes > 0 ? knownTotalBytes : nil
                    )
                }
            }

            let playlist = temporaryDirectory.appendingPathComponent("index.m3u8")
            guard FileManager.default.fileExists(atPath: playlist.path) else {
                throw DownloadError.playlistMissing
            }
            try? FileManager.default.removeItem(at: finalDirectory)
            try FileManager.default.moveItem(at: temporaryDirectory, to: finalDirectory)
            DispatchQueue.main.async { [weak self] in
                self?.downloadedFiles[episode.id] = finalDirectory.appendingPathComponent("index.m3u8")
                self?.persistFiles()
            }
        } catch {
            try? FileManager.default.removeItem(at: temporaryDirectory)
            throw error
        }
    }

    private func preflightLegacyDownload(_ request: URLRequest) async throws {
        var headRequest = request
        headRequest.httpMethod = "HEAD"
        do {
            let (_, response) = try await URLSession.shared.data(for: headRequest)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode),
                  let contentLength = httpResponse.value(forHTTPHeaderField: "Content-Length"),
                  let bytes = Int64(contentLength),
                  bytes > 0 else { return }
            try ensureAvailableStorage(requiredBytes: bytes)
        } catch let error as DownloadError {
            throw error
        } catch {
            // Some legacy providers do not implement HEAD. The download task
            // remains the source of truth in that case.
        }
    }

    private static func safeFilename(for resource: String) -> String {
        let filename = URL(string: resource)?.lastPathComponent ?? "resource"
        return filename.isEmpty ? "resource" : filename
    }

    private func begin(episodeID: String) {
        DispatchQueue.main.async { [weak self] in
            self?.activeDownloads.insert(episodeID)
            self?.progress[episodeID] = 0
            self?.errors[episodeID] = nil
            self?.downloadedBytes[episodeID] = 0
            self?.totalBytes[episodeID] = 0
            self?.downloadSpeed[episodeID] = 0
            self?.downloadStartedAt[episodeID] = Date()
        }
    }

    private func setDownloadMetadata(episodeID: String, total: Int64?) {
        DispatchQueue.main.async { [weak self] in
            self?.totalBytes[episodeID] = total ?? 0
        }
    }

    private func ensureAvailableStorage(requiredBytes: Int64) throws {
        let attributes = try FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
        let freeBytes = (attributes[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        let requiredWithMargin = max(requiredBytes, 0) + Self.storageSafetyMargin
        guard freeBytes >= requiredWithMargin else {
            throw insufficientStorageError(freeBytes: freeBytes, requiredBytes: requiredWithMargin)
        }
    }

    private func insufficientStorageError(freeBytes: Int64? = nil, requiredBytes: Int64? = nil) -> DownloadError {
        let attributes = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
        let currentFreeBytes = freeBytes ?? (attributes?[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        let required = requiredBytes ?? Self.storageSafetyMargin
        return .insufficientStorage(freeBytes: currentFreeBytes, requiredBytes: required)
    }

    private func updateProgress(episodeID: String, value: Double, downloaded: Int64, total: Int64?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.progress[episodeID] = min(max(value, 0), 1)
            self.downloadedBytes[episodeID] = downloaded
            if let total { self.totalBytes[episodeID] = total }
            if let started = self.downloadStartedAt[episodeID] {
                let elapsed = max(Date().timeIntervalSince(started), 0.1)
                self.downloadSpeed[episodeID] = Double(downloaded) / elapsed
            }
        }
    }

    private func finish(episodeID: String, error: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.activeDownloads.remove(episodeID)
            if let error {
                self.progress[episodeID] = nil
                self.errors[episodeID] = error
            } else {
                self.progress[episodeID] = 1
                self.errors[episodeID] = nil
            }
        }
    }

    private func cancelled(episodeID: String) {
        DispatchQueue.main.async { [weak self] in
            self?.activeDownloads.remove(episodeID)
            self?.progress[episodeID] = nil
            self?.downloadedBytes[episodeID] = nil
            self?.totalBytes[episodeID] = nil
            self?.downloadSpeed[episodeID] = nil
            self?.downloadStartedAt[episodeID] = nil
        }
    }

    func statusText(for episodeID: String) -> String? {
        guard isDownloading(episodeID) else { return nil }
        let percent = Int((progress[episodeID] ?? 0) * 100)
        var parts = ["\(percent)%"]
        let downloaded = downloadedBytes[episodeID] ?? 0
        let total = totalBytes[episodeID] ?? 0
        if total > 0 {
            parts.append("\(Self.byteCount(downloaded)) из \(Self.byteCount(total))")
        }
        if let speed = downloadSpeed[episodeID], speed > 0 {
            parts.append("\(Self.byteCount(Int64(speed)))/с")
            if total > downloaded {
                let remaining = Double(total - downloaded) / speed
                parts.append("осталось \(Self.duration(remaining))")
            }
        }
        return parts.joined(separator: " · ")
    }

    private static func byteCount(_ value: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.includesUnit = true
        formatter.allowsNonnumericFormatting = false
        return formatter.string(fromByteCount: value)
    }

    private static func duration(_ seconds: Double) -> String {
        let totalSeconds = max(Int(seconds.rounded()), 1)
        let minutes = totalSeconds / 60
        let remainingSeconds = totalSeconds % 60
        if minutes > 0 { return "~\(minutes) мин" }
        return "~\(remainingSeconds) сек"
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let episodeID = taskToEpisode[downloadTask.taskIdentifier], totalBytesExpectedToWrite > 0 else { return }
        updateProgress(
            episodeID: episodeID,
            value: Double(totalBytesWritten) / Double(totalBytesExpectedToWrite),
            downloaded: totalBytesWritten,
            total: totalBytesExpectedToWrite
        )
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let episodeID = taskToEpisode[downloadTask.taskIdentifier] else { return }
        do {
            let destination = try downloadsDirectory().appendingPathComponent("episode-\(episodeID).mp4")
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            DispatchQueue.main.async { [weak self] in
                self?.downloadedFiles[episodeID] = destination
                self?.persistFiles()
            }
            finish(episodeID: episodeID, error: nil)
        } catch {
            finish(episodeID: episodeID, error: "Не удалось сохранить файл")
        }
        taskToEpisode[downloadTask.taskIdentifier] = nil
        persistTasks()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let episodeID = taskToEpisode[task.taskIdentifier], error != nil else { return }
        let nsError = error as NSError?
        let wasCancelled = nsError?.domain == NSURLErrorDomain && nsError?.code == NSURLErrorCancelled
        if wasCancelled {
            cancelled(episodeID: episodeID)
        } else {
            let message: String
            if nsError?.domain == NSPOSIXErrorDomain && nsError?.code == 28 {
                message = insufficientStorageError().localizedDescription ?? "Недостаточно памяти для скачивания"
            } else {
                message = "Загрузка прервалась. Проверьте соединение и попробуйте ещё раз."
            }
            finish(episodeID: episodeID, error: message)
        }
        taskToEpisode[task.taskIdentifier] = nil
        persistTasks()
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = backgroundEventsCompletionHandler
        backgroundEventsCompletionHandler = nil
        DispatchQueue.main.async { completion?() }
    }

    private func downloadsDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("CineVaultDownloads", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func removeTemporaryHLSDirectory(for episodeID: String) {
        guard let directory = try? downloadsDirectory() else { return }
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(".episode-\(episodeID)-hls.tmp"))
    }

    private func restoreFiles() {
        guard let directory = try? downloadsDirectory() else { return }
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        for url in files where url.pathExtension.lowercased() == "mp4" {
            let id = url.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "episode-", with: "")
            downloadedFiles[id] = url
        }
        for url in files where url.lastPathComponent.hasPrefix("episode-") && url.lastPathComponent.hasSuffix("-hls") {
            let playlist = url.appendingPathComponent("index.m3u8")
            guard FileManager.default.fileExists(atPath: playlist.path) else { continue }
            let id = url.lastPathComponent
                .replacingOccurrences(of: "episode-", with: "")
                .replacingOccurrences(of: "-hls", with: "")
            downloadedFiles[id] = playlist
        }
    }

    private func restoreTasks() {
        let stored = UserDefaults.standard.dictionary(forKey: "cinevault.downloadTasks") as? [String: String] ?? [:]
        taskToEpisode = stored.reduce(into: [:]) { result, entry in
            if let taskID = Int(entry.key) { result[taskID] = entry.value }
        }
        activeDownloads = Set(taskToEpisode.values)
    }

    private func persistTasks() {
        let stored = taskToEpisode.reduce(into: [String: String]()) { result, entry in
            result[String(entry.key)] = entry.value
        }
        UserDefaults.standard.set(stored, forKey: "cinevault.downloadTasks")
    }

    private func persistFiles() {
        UserDefaults.standard.set(downloadedFiles.mapValues(\.path), forKey: "cinevault.downloads")
    }
}

private enum DownloadError: LocalizedError {
    case emptyManifest
    case resourceUnavailable
    case playlistMissing
    case insufficientStorage(freeBytes: Int64, requiredBytes: Int64)

    var errorDescription: String? {
        switch self {
        case .emptyManifest: return "Сервер не вернул сегменты для загрузки"
        case .resourceUnavailable: return "Один из сегментов недоступен"
        case .playlistMissing: return "Не удалось сохранить офлайн-плейлист"
        case let .insufficientStorage(freeBytes, requiredBytes):
            return "Недостаточно памяти для скачивания. Свободно: \(Self.byteCount(freeBytes)), нужно минимум: \(Self.byteCount(requiredBytes)). Освободите место на iPhone и попробуйте снова."
        }
    }

    private static func byteCount(_ value: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.includesUnit = true
        formatter.allowsNonnumericFormatting = false
        return formatter.string(fromByteCount: value)
    }
}
