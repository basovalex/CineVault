import AVFoundation
import AVKit
import SwiftUI

enum PlaybackQuality: String, CaseIterable, Identifiable {
    case auto
    case q1080
    case q720
    case q360

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return "Авто"
        case .q1080: return "1080p · Full HD"
        case .q720: return "720p · HD"
        case .q360: return "360p · экономия трафика"
        }
    }

    var peakBitRate: Double {
        switch self {
        case .auto: return 0
        case .q1080: return 5_000_000
        case .q720: return 2_500_000
        case .q360: return 600_000
        }
    }

    var maximumResolution: CGSize {
        switch self {
        case .auto: return .zero
        case .q1080: return CGSize(width: 1920, height: 1080)
        case .q720: return CGSize(width: 1280, height: 720)
        case .q360: return CGSize(width: 640, height: 360)
        }
    }
}

@MainActor
final class PlaybackModel: ObservableObject {
    @Published var player: AVPlayer?
    @Published var status = "Подготавливаю плеер…"
    @Published var quality: PlaybackQuality = .auto
    @Published private(set) var isOffline = false
    @Published private(set) var isLoading = true
    @Published private(set) var errorMessage: String?
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var skipSegments: [SkipSegment] = []

    var activeSkipSegment: SkipSegment? {
        guard !isLoading else { return nil }
        let duration = player?.currentItem?.duration.seconds ?? 0
        guard duration.isFinite, duration > 0 else { return nil }
        return skipSegments.first { segment in
            segment.start >= 0
                && segment.end > segment.start
                && segment.end <= duration + 5
                && currentTime >= max(0, segment.start - 3)
                && currentTime < segment.end
        }
    }

    var availableQualities: [PlaybackQuality] {
        guard let labels = episode.availableQualities, !labels.isEmpty else {
            return PlaybackQuality.allCases
        }
        return PlaybackQuality.allCases.filter { quality in
            quality == .auto || labels.contains(quality.serverLabel)
        }
    }

    private let episode: Episode
    private let api: CineVaultAPI
    private let downloads: DownloadManager
    private let progressStore: AppStore
    private var timeObserver: Any?
    private var itemObservers: [NSKeyValueObservation] = []
    private var playerObserver: NSKeyValueObservation?
    private var bufferingTask: Task<Void, Never>?
    private var skipTask: Task<Void, Never>?
    private var lastSaved = Date.distantPast
    private var pendingResume: Double?
    private var didApplyResume = false
    private var didFallbackToLowQuality = false
    private var startTask: Task<Void, Never>?

    init(episode: Episode, api: CineVaultAPI, downloads: DownloadManager, progressStore: AppStore) {
        self.episode = episode
        self.api = api
        self.downloads = downloads
        self.progressStore = progressStore
    }

    func start() {
        guard player == nil, startTask == nil else { return }
        isLoading = true
        errorMessage = nil
        let localURL = downloads.localFile(for: episode.id)
        guard localURL != nil || api.url(for: episode.hlsURL ?? episode.sourceURL) != nil else {
            status = "Для этой серии нет доступного потока"
            isLoading = false
            errorMessage = "Сервер не отдал ссылку на видео"
            return
        }
        let isLocal = localURL != nil
        isOffline = isLocal
        if let localURL {
            status = "Открываю офлайн-копию…"
            startTask = Task { @MainActor [weak self] in
                guard let self else { return }
                defer { self.startTask = nil }
                do {
                    let url = try await self.downloads.playbackURL(for: localURL)
                    guard !Task.isCancelled else { return }
                    self.configurePlayer(url: url, isLocal: true)
                } catch {
                    guard !Task.isCancelled else { return }
                    self.isLoading = false
                    self.status = "Офлайн-копию не удалось открыть"
                    self.errorMessage = error.localizedDescription
                }
            }
            return
        }

        guard let url = api.url(for: episode.hlsURL ?? episode.sourceURL) else {
            status = "Для этой серии нет доступного потока"
            isLoading = false
            errorMessage = "Сервер не отдал ссылку на видео"
            return
        }
        configurePlayer(url: url, isLocal: false)
    }

    private func configurePlayer(url: URL, isLocal: Bool) {
        skipSegments = episode.skipSegments ?? []
        loadSkipSegments()
        pendingResume = episode.progress.flatMap { progress in
            progress.position > 0 && !progress.completed ? progress.position : nil
        }
        didApplyResume = false
        didFallbackToLowQuality = false
        let options: [String: Any] = isLocal || api.configuration.viewerToken.isEmpty
            ? [:]
            : ["AVURLAssetHTTPHeaderFieldsKey": ["Authorization": "Bearer \(api.configuration.viewerToken)"]]
        let asset = AVURLAsset(url: url, options: options)
        let item = AVPlayerItem(asset: asset)
        applyQuality(to: item)
        let avPlayer = AVPlayer(playerItem: item)
        player = avPlayer
        status = isLocal ? "Открываю офлайн-копию…" : "Подключаюсь к серверу…"
        observe(item: item, player: avPlayer)
        timeObserver = avPlayer.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            guard time.seconds.isFinite else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.currentTime = time.seconds
                self.saveProgress(position: time.seconds, duration: avPlayer.currentItem?.duration.seconds ?? 0, completed: false)
            }
        }
    }

    func retry() {
        stop()
        start()
    }

    func setQuality(_ newQuality: PlaybackQuality) {
        quality = newQuality
        didFallbackToLowQuality = false
        guard !isOffline, let player, let item = player.currentItem else { return }
        applyQuality(to: item)
        if player.timeControlStatus == .waitingToPlayAtSpecifiedRate {
            isLoading = true
            status = "Переключаю качество на \(quality.title)…"
            beginBufferingWatch(player: player)
        } else {
            isLoading = false
            status = "Онлайн · качество: \(quality.title)"
        }
    }

    func stop() {
        startTask?.cancel()
        startTask = nil
        bufferingTask?.cancel()
        bufferingTask = nil
        skipTask?.cancel()
        skipTask = nil
        guard let player else { return }
        saveProgress(position: player.currentTime().seconds, duration: player.currentItem?.duration.seconds ?? 0, completed: false)
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        itemObservers.forEach { $0.invalidate() }
        itemObservers.removeAll()
        playerObserver?.invalidate()
        playerObserver = nil
        player.pause()
        self.player = nil
        self.timeObserver = nil
        self.pendingResume = nil
        self.didApplyResume = false
        self.currentTime = 0
        self.isLoading = false
    }

    func skip(_ segment: SkipSegment) {
        guard let player else { return }
        let target = CMTime(seconds: segment.end, preferredTimescale: 600)
        let shouldResume = player.timeControlStatus == .playing
        currentTime = segment.end
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak player] _ in
            guard shouldResume, let player else { return }
            player.play()
        }
    }

    private func saveProgress(position: Double, duration: Double, completed: Bool) {
        guard Date().timeIntervalSince(lastSaved) > 4 || completed else { return }
        lastSaved = Date()
        let safePosition = position.isFinite ? max(0, position) : 0
        let safeDuration = duration.isFinite ? max(0, duration) : 0
        progressStore.recordLocalProgress(
            episodeID: episode.id,
            position: safePosition,
            duration: safeDuration,
            completed: completed
        )
    }

    private func applyQuality(to item: AVPlayerItem) {
        item.preferredPeakBitRate = quality.peakBitRate
        item.preferredMaximumResolution = quality.maximumResolution
    }

    private func loadSkipSegments() {
        guard !isOffline else { return }
        skipTask?.cancel()
        skipTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let response = try await self.api.fetchSkipSegments(for: self.episode)
                guard !Task.isCancelled else { return }
                self.skipSegments = response.segments
                self.progressStore.cacheSkipSegments(response.segments, for: self.episode.id)
            } catch {
                // Skip metadata is optional and must never block playback.
            }
        }
    }

    private func observe(item: AVPlayerItem, player: AVPlayer) {
        itemObservers.append(item.observe(\AVPlayerItem.status, options: [.initial, .new]) { [weak self, weak player] item, _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player else { return }
                switch item.status {
                case .readyToPlay:
                    self.errorMessage = nil
                    let waitingForBuffer = player.timeControlStatus == .waitingToPlayAtSpecifiedRate
                        && item.isPlaybackBufferEmpty
                        && !item.isPlaybackLikelyToKeepUp
                    if waitingForBuffer {
                        self.isLoading = true
                        self.status = "Буферизация… проверяю поток"
                        self.beginBufferingWatch(player: player)
                    } else {
                        self.endBufferingWatch()
                        self.isLoading = false
                        self.status = self.isOffline
                            ? "Офлайн-копия · исходное качество"
                            : "Онлайн · качество: \(self.quality.title)"
                    }
                    if let position = self.pendingResume, !self.didApplyResume {
                        self.didApplyResume = true
                        player.seek(
                            to: CMTime(seconds: position, preferredTimescale: 600),
                            toleranceBefore: .zero,
                            toleranceAfter: .zero
                        )
                    }
                case .failed:
                    self.endBufferingWatch()
                    self.isLoading = false
                    self.status = "Видео не удалось открыть"
                    self.errorMessage = self.isOffline
                        ? (item.error?.localizedDescription ?? "Видео недоступно")
                        : "Сервер не отдаёт видео. Проверьте Wi‑Fi, свободное место на Mac и что исходный файл загружен локально."
                default:
                    break
                }
            }
        })

        playerObserver = player.observe(\AVPlayer.timeControlStatus, options: [.new]) { [weak self, weak player] _, _ in
            Task { @MainActor [weak self, weak player] in
                guard let self, let player else { return }
                if player.timeControlStatus == .waitingToPlayAtSpecifiedRate {
                    let item = player.currentItem
                    if item?.status == .readyToPlay && item?.isPlaybackBufferEmpty == true && item?.isPlaybackLikelyToKeepUp == false {
                        self.isLoading = true
                        self.status = "Буферизация… проверяю поток"
                        self.beginBufferingWatch(player: player)
                    }
                } else if player.timeControlStatus == .playing {
                    self.endBufferingWatch()
                    self.isLoading = false
                    self.status = self.isOffline
                        ? "Офлайн-копия · исходное качество"
                        : "Онлайн · качество: \(self.quality.title)"
                }
            }
        }
    }

    private func beginBufferingWatch(player: AVPlayer) {
        guard bufferingTask == nil else { return }
        bufferingTask = Task { @MainActor [weak self, weak player] in
            var elapsedSeconds = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let self, let player, let item = player.currentItem else { return }
                guard player.timeControlStatus == .waitingToPlayAtSpecifiedRate else { return }
                elapsedSeconds += 1

                if elapsedSeconds < 3 {
                    self.status = "Буферизация… ещё \(elapsedSeconds) с"
                } else if elapsedSeconds < 5 {
                    self.status = "Медленно загружаю поток… \(elapsedSeconds) с"
                } else if self.quality == .auto && !self.didFallbackToLowQuality && self.availableQualities.contains(.q360) {
                    self.didFallbackToLowQuality = true
                    self.quality = .q360
                    self.applyQuality(to: item)
                    self.status = "Сеть медленная · переключаюсь на 360p…"
                } else if elapsedSeconds < 12 {
                    self.status = "Проверяю соединение с сервером… \(elapsedSeconds) с"
                } else {
                    self.status = "Сервер отвечает медленно. Проверьте Wi‑Fi или выберите 360p."
                }
            }
        }
    }

    private func endBufferingWatch() {
        bufferingTask?.cancel()
        bufferingTask = nil
    }
}

private extension PlaybackQuality {
    var serverLabel: String {
        switch self {
        case .auto: return "auto"
        case .q1080: return "1080p"
        case .q720: return "720p"
        case .q360: return "360p"
        }
    }
}

struct PlayerView: View {
    @StateObject private var model: PlaybackModel
    @State private var isFullscreen = false
    @EnvironmentObject private var chrome: AppChrome
    let episode: Episode

    init(episode: Episode, store: AppStore) {
        self.episode = episode
        _model = StateObject(wrappedValue: PlaybackModel(episode: episode, api: store.api, downloads: store.downloads, progressStore: store))
    }

    var body: some View {
        VStack(spacing: 18) {
            PlayerSurface(model: model)
                .clipShape(RoundedRectangle(cornerRadius: 20))
            HStack(spacing: 10) {
                Label(model.isOffline ? "Офлайн" : "Онлайн", systemImage: model.isOffline ? "checkmark.circle.fill" : "wifi")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(model.isOffline ? .green : .cineAccent)
                Spacer()
                if !model.isOffline {
                    QualityMenu(model: model)
                }
                Button {
                    isFullscreen = true
                } label: {
                    Label("На весь экран", systemImage: "arrow.up.left.and.arrow.down.right")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.bordered)
                .tint(.cineAccent)
                .accessibilityLabel("Открыть на весь экран")
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(episode.title).font(.title2.bold())
                Text("\(episode.episodeLabel) · \(episode.displayTitle)").foregroundStyle(.secondary)
                Text(model.status).font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding()
        .background(Color.cineBackground.ignoresSafeArea())
        .navigationTitle("Смотреть")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .onAppear {
            chrome.isTabBarHidden = true
            model.start()
        }
        .onDisappear {
            if !isFullscreen {
                chrome.isTabBarHidden = false
                model.stop()
            }
        }
        .fullScreenCover(isPresented: $isFullscreen) {
            FullscreenPlayerView(model: model, isPresented: $isFullscreen)
        }
    }
}

private struct QualityMenu: View {
    @ObservedObject var model: PlaybackModel

    var body: some View {
        Menu {
            ForEach(model.availableQualities) { quality in
                Button {
                    model.setQuality(quality)
                } label: {
                    if quality == model.quality {
                        Label(quality.title, systemImage: "checkmark")
                    } else {
                        Text(quality.title)
                    }
                }
            }
        } label: {
            Label(model.quality.title, systemImage: "sparkles.tv")
                .font(.subheadline.weight(.semibold))
        }
        .buttonStyle(.bordered)
        .tint(.cineAccent)
        .accessibilityLabel("Качество видео")
    }
}

private struct PlayerSurface: View {
    @ObservedObject var model: PlaybackModel

    var body: some View {
        ZStack {
            Color.black
            if let player = model.player {
                VideoPlayer(player: player)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Color.cineSurface
            }

            if model.isLoading {
                Color.black.opacity(0.28)
                ProgressView {
                    Text(model.status)
                        .font(.footnote.weight(.semibold))
                        .multilineTextAlignment(.center)
                }
                .tint(.white)
                .foregroundStyle(.white)
                .padding(16)
                .background(.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 14))
            }

            if let segment = model.activeSkipSegment {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button(segment.label) {
                            model.skip(segment)
                        }
                        .font(.subheadline.weight(.bold))
                        .buttonStyle(.borderedProminent)
                        .tint(.cineAccent)
                        .padding(16)
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }

            if let error = model.errorMessage {
                Color.black.opacity(0.65)
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(error)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                    Button("Повторить") { model.retry() }
                        .buttonStyle(.borderedProminent)
                        .tint(.cineAccent)
                }
                .foregroundStyle(.white)
                .padding(20)
            }
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .clipped()
        .background(Color.black)
        .animation(.easeOut(duration: 0.18), value: model.activeSkipSegment)
    }
}

private struct FullscreenPlayerView: View {
    @ObservedObject var model: PlaybackModel
    @Binding var isPresented: Bool
    @State private var controlsVisible = false
    @State private var hideControlsID = UUID()

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            PlayerSurface(model: model)
                .simultaneousGesture(
                    TapGesture().onEnded {
                        revealControls()
                    }
                )
            if controlsVisible {
                HStack(spacing: 12) {
                    Button {
                        isPresented = false
                    } label: {
                        Label("Закрыть", systemImage: "xmark")
                    }
                    .buttonStyle(.bordered)
                    .tint(.white)
                    .accessibilityLabel("Закрыть полноэкранный режим")

                    Spacer()

                    if !model.isOffline {
                        QualityMenu(model: model)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .presentationBackground(.black)
        .animation(.easeOut(duration: 0.2), value: controlsVisible)
        .task(id: hideControlsID) {
            guard controlsVisible else { return }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) {
                controlsVisible = false
            }
        }
    }

    private func revealControls() {
        controlsVisible = true
        hideControlsID = UUID()
    }
}
