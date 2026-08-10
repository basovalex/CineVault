import SwiftUI
import UIKit
import AVKit

extension Color {
    static let cineBackground = Color(red: 0.035, green: 0.075, blue: 0.085)
    static let cineSurface = Color(red: 0.065, green: 0.135, blue: 0.145)
    static let cineAccent = Color(red: 0.24, green: 0.86, blue: 0.78)
    static let cineSteel = Color(red: 0.62, green: 0.72, blue: 0.73)
}

enum AppTab: String, CaseIterable, Identifiable {
    case home
    case catalog
    case downloads
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return "Для нас"
        case .catalog: return "Каталог"
        case .downloads: return "Скачано"
        case .settings: return "Настройки"
        }
    }

    var systemImage: String {
        switch self {
        case .home: return "house.fill"
        case .catalog: return "square.grid.2x2.fill"
        case .downloads: return "arrow.down.circle.fill"
        case .settings: return "gearshape.fill"
        }
    }
}

@MainActor
final class AppChrome: ObservableObject {
    @Published var isTabBarHidden = false
}

struct ContentView: View {
    @StateObject private var store = AppStore()
    @StateObject private var chrome = AppChrome()
    @State private var selectedTab: AppTab = .home
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack(alignment: .bottom) {
            selectedView
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if !chrome.isTabBarHidden {
                        Color.clear.frame(height: 92)
                    }
                }

            if !chrome.isTabBarHidden {
                VStack(spacing: 0) {
                    Spacer()
                    Color.cineBackground
                        .frame(height: 104)
                        .ignoresSafeArea(edges: .bottom)
                }

                CineVaultTabBar(selection: $selectedTab)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .environmentObject(store)
        .environmentObject(chrome)
        .tint(.cineAccent)
        .preferredColorScheme(.dark)
        .animation(.easeOut(duration: 0.2), value: chrome.isTabBarHidden)
        .task {
            await store.refresh()
            await store.refreshPeriodically()
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            Task { await store.refresh() }
        }
    }

    @ViewBuilder
    private var selectedView: some View {
        switch selectedTab {
        case .home: HomeView()
        case .catalog: CatalogView()
        case .downloads: DownloadsView()
        case .settings: SettingsView()
        }
    }
}

private struct CineVaultTabBar: View {
    @Binding var selection: AppTab

    var body: some View {
        HStack(spacing: 4) {
            ForEach(AppTab.allCases) { tab in
                Button {
                    selection = tab
                } label: {
                    VStack(spacing: 5) {
                        Image(systemName: tab.systemImage)
                            .font(.system(size: 22, weight: .semibold))
                        Text(tab.title)
                            .font(.caption.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 62)
                    .foregroundStyle(selection == tab ? Color.cineAccent : Color.white.opacity(0.78))
                    .background(selection == tab ? Color.cineAccent.opacity(0.14) : .clear)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
            }
        }
        .padding(7)
        .background(Color.cineSurface)
        .overlay {
            RoundedRectangle(cornerRadius: 34)
                .stroke(Color.cineAccent.opacity(0.28), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 34))
        .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
    }
}

struct HomeView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HeroCard()
                    if !store.continueWatching.isEmpty {
                        SectionTitle(title: "Продолжить просмотр", systemImage: "play.circle.fill")
                        ForEach(store.continueWatching) { episode in EpisodeRow(episode: episode) }
                    }
                    if !store.history.isEmpty {
                        SectionTitle(title: "История на этом iPhone", systemImage: "clock.arrow.circlepath")
                        ForEach(Array(store.history.prefix(8))) { episode in EpisodeRow(episode: episode) }
                    }
                }
                .padding()
            }
            .background(Color.cineBackground.ignoresSafeArea())
            .navigationTitle("CineVault")
            .refreshable { await store.refresh() }
        }
    }
}

struct CatalogView: View {
    @EnvironmentObject private var store: AppStore
    @State private var query = ""
    @State private var filter: CatalogFilter = .all

    private var filtered: [CatalogTitle] {
        store.catalog.filter { title in
            let matchesFilter = filter == .all || (filter == .movies && !title.isSeries) || (filter == .series && title.isSeries)
            let matchesQuery = query.isEmpty || "\(title.title) \(title.originalTitle) \(title.tags.joined(separator: " "))".localizedCaseInsensitiveContains(query)
            return matchesFilter && matchesQuery
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Фильмы и сериалы для нас")
                        .font(.title2.bold())
                    Text("Карточки, описания и доступные способы просмотра в одном месте.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        ForEach(CatalogFilter.allCases) { option in
                            Button(option.title) { filter = option }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(filter == option ? Color.cineBackground : Color.white.opacity(0.82))
                                .padding(.horizontal, 14)
                                .padding(.vertical, 9)
                                .background(filter == option ? Color.cineAccent : Color.cineSurface)
                                .clipShape(Capsule())
                        }
                    }
                    LazyVStack(spacing: 12) {
                        ForEach(filtered) { title in
                            CatalogTitleRow(title: title)
                        }
                    }
                }
                .padding()
            }
            .scrollIndicators(.hidden)
            .background(Color.cineBackground)
            .searchable(text: $query, prompt: "Найти фильм или сериал")
            .navigationTitle("Каталог")
        }
    }
}

private enum CatalogFilter: String, CaseIterable, Identifiable {
    case all, movies, series

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "Всё"
        case .movies: return "Фильмы"
        case .series: return "Сериалы"
        }
    }
}

private struct CatalogTitleRow: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle

    private var serverEpisodeCount: Int {
        store.episodes.filter {
            $0.title.localizedCaseInsensitiveCompare(title.title) == .orderedSame ||
            $0.originalTitle?.localizedCaseInsensitiveCompare(title.originalTitle) == .orderedSame
        }.count
    }

    var body: some View {
        NavigationLink { CatalogTitleDetailView(title: title) } label: {
            HStack(spacing: 14) {
                CatalogPosterArt(title: title)
                    .frame(width: 88, height: 126)
                VStack(alignment: .leading, spacing: 7) {
                    Text(title.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text("\(title.year) · \(title.kindLabel)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(title.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    HStack(spacing: 6) {
                        Text(title.isSeries ? (serverEpisodeCount > 0 ? "На сервере: \(serverEpisodeCount) серий" : title.seasonLabel) : title.availabilityLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(title.videoURL == nil ? Color.cineSteel : Color.cineAccent)
                        if title.videoURL != nil {
                            Image(systemName: "play.fill")
                                .font(.caption2)
                                .foregroundStyle(Color.cineAccent)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .padding(12)
            .background(Color.cineSurface)
            .clipShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
    }
}

private struct CatalogTitleDetailView: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    @State private var isRequesting = false
    @State private var requestError: String?
    @State private var expandedSeasons: Set<Int> = [1]

    private var libraryEpisodes: [Episode] {
        store.episodes.filter {
            $0.title.localizedCaseInsensitiveCompare(title.title) == .orderedSame ||
            $0.originalTitle?.localizedCaseInsensitiveCompare(title.originalTitle) == .orderedSame
        }
    }

    private var metadataLabel: String {
        [String(title.year), title.kindLabel, title.runtimeLabel]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 16) {
                    CatalogPosterArt(title: title)
                        .frame(width: 130, height: 190)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(title.title).font(.title2.bold())
                        Text(metadataLabel)
                            .foregroundStyle(.secondary)
                        Text(title.description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Подробнее")
                        .font(.headline)
                    HStack(spacing: 8) {
                        ForEach(title.tags, id: \.self) { tag in
                            Text("#\(tag)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.cineAccent)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color.cineAccent.opacity(0.12))
                                .clipShape(Capsule())
                        }
                    }
                    if title.isSeries, !title.seasonLabel.isEmpty {
                        Label(title.seasonLabel, systemImage: "square.stack.3d.up")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Text(title.providerNote)
                        .font(.caption)
                        .foregroundStyle(title.videoURL == nil ? Color.cineSteel : Color.cineAccent)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.cineSurface)
                .clipShape(RoundedRectangle(cornerRadius: 16))

                if let videoURL = title.videoURL, let url = URL(string: videoURL) {
                    NavigationLink {
                        CatalogExternalPlayerView(title: title, url: url)
                    } label: {
                        Label("Смотреть в CineVault", systemImage: "play.fill")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.cineAccent)
                }

                if title.isSeries {
                    SectionTitle(title: "Сезоны и серии", systemImage: "film.stack")
                    Text("Серии с галочкой уже есть на сервере. Остальные можно запросить к добавлению.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    requestButton
                    if title.seasons.isEmpty {
                        EmptyCard(text: "Для этого сериала пока не удалось получить список сезонов.")
                    } else {
                        ForEach(Array(title.seasons.enumerated()), id: \.offset) { index, episodeCount in
                            let season = index + 1
                            DisclosureGroup(isExpanded: seasonBinding(season)) {
                                LazyVStack(spacing: 8) {
                                    if episodeCount > 0 {
                                        ForEach(Array(1...episodeCount), id: \.self) { episodeNumber in
                                            CatalogEpisodeRow(
                                                season: season,
                                                episode: episodeNumber,
                                                serverEpisode: serverEpisode(season: season, episode: episodeNumber)
                                            )
                                        }
                                    } else {
                                        Text("Серии ещё не объявлены")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.top, 8)
                            } label: {
                                HStack {
                                    Text("Сезон \(season)")
                                        .font(.headline)
                                    Spacer()
                                    Text("\(availableEpisodeCount(for: season))/\(episodeCount) на сервере")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .tint(Color.cineAccent)
                            .padding(14)
                            .background(Color.cineSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                        }
                    }
                } else if title.videoURL == nil {
                    requestButton
                    EmptyCard(text: "Карточка и обложка уже готовы. После добавления разрешённого файла он появится здесь автоматически.")
                }
            }
            .padding()
        }
        .background(Color.cineBackground)
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func seasonBinding(_ season: Int) -> Binding<Bool> {
        Binding(
            get: { expandedSeasons.contains(season) },
            set: { isExpanded in
                if isExpanded {
                    expandedSeasons.insert(season)
                } else {
                    expandedSeasons.remove(season)
                }
            }
        )
    }

    private func serverEpisode(season: Int, episode: Int) -> Episode? {
        libraryEpisodes.first { $0.season == season && $0.episode == episode }
    }

    private func availableEpisodeCount(for season: Int) -> Int {
        libraryEpisodes.filter { $0.season == season }.count
    }

    @ViewBuilder
    private var requestButton: some View {
        Button {
            requestTitle()
        } label: {
            Label(
                store.isCatalogTitleRequested(title) ? "Запрос уже отправлен" : "Запросить добавление на сервер",
                systemImage: store.isCatalogTitleRequested(title) ? "checkmark.circle.fill" : "arrow.up.circle.fill"
            )
            .font(.headline)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(store.isCatalogTitleRequested(title) ? .green : .cineAccent)
        .disabled(store.isCatalogTitleRequested(title) || isRequesting)
        if isRequesting {
            ProgressView("Отправляю запрос на сервер…")
        }
        if let requestError {
            Text("Не удалось отправить: \(requestError)")
                .font(.caption)
                .foregroundStyle(.red.opacity(0.9))
        }
    }

    private func requestTitle() {
        isRequesting = true
        requestError = nil
        Task {
            do {
                try await store.requestCatalogTitle(title)
            } catch {
                requestError = error.localizedDescription
            }
            isRequesting = false
        }
    }
}

private struct CatalogEpisodeRow: View {
    let season: Int
    let episode: Int
    let serverEpisode: Episode?

    var body: some View {
        if let serverEpisode {
            EpisodeRow(episode: serverEpisode)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.cineBackground.opacity(0.72))
                .clipShape(RoundedRectangle(cornerRadius: 12))
        } else {
            HStack(spacing: 12) {
                Image(systemName: "circle.dashed")
                    .foregroundStyle(Color.cineSteel)
                VStack(alignment: .leading, spacing: 3) {
                    Text("S\(String(format: "%02d", season))E\(String(format: "%02d", episode))")
                        .font(.subheadline.weight(.semibold))
                    Text("Серия \(episode)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text("Нет на сервере")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.cineSteel)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
            .background(Color.cineBackground.opacity(0.72))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}

private struct CatalogPosterArt: View {
    let title: CatalogTitle

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottomLeading) {
                if let posterURL = title.posterURL, let url = URL(string: posterURL) {
                    CachedPosterImage(url: url) { posterGradient }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()
                } else {
                    posterGradient
                }
                LinearGradient(colors: [.clear, .black.opacity(0.76)], startPoint: .center, endPoint: .bottom)
                Text(title.title)
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .padding(8)
                    .lineLimit(3)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
    }

    private var posterGradient: some View {
        LinearGradient(colors: posterColors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    private var posterColors: [Color] {
        switch title.id {
        case "desperate-housewives": return [Color(red: 0.35, green: 0.14, blue: 0.29), Color(red: 0.12, green: 0.13, blue: 0.25)]
        case "interstellar": return [Color(red: 0.10, green: 0.18, blue: 0.32), .black]
        case "about-time": return [Color(red: 0.88, green: 0.45, blue: 0.60), Color(red: 0.35, green: 0.18, blue: 0.30)]
        case "the-office": return [Color(red: 0.75, green: 0.49, blue: 0.27), Color(red: 0.30, green: 0.19, blue: 0.16)]
        case "little-women": return [Color(red: 0.75, green: 0.55, blue: 0.47), Color(red: 0.24, green: 0.20, blue: 0.30)]
        case "sintel-open": return [Color(red: 0.85, green: 0.54, blue: 0.39), Color(red: 0.16, green: 0.13, blue: 0.26)]
        case "big-buck-bunny-open": return [Color(red: 0.45, green: 0.73, blue: 0.87), Color(red: 0.25, green: 0.37, blue: 0.20)]
        default: return [Color.cineAccent.opacity(0.62), Color.cineSurface]
        }
    }
}

private struct CachedPosterImage<Placeholder: View>: View {
    let url: URL?
    let placeholder: Placeholder
    @State private var image: UIImage?

    init(url: URL?, @ViewBuilder placeholder: () -> Placeholder) {
        self.url = url
        self.placeholder = placeholder()
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .task(id: url?.absoluteString) {
            image = nil
            guard let url else { return }
            image = await PosterImageCache.shared.image(for: url)
        }
    }
}

private struct CatalogExternalPlayerView: View {
    let title: CatalogTitle
    let url: URL
    @State private var player: AVPlayer?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            if let player {
                VideoPlayer(player: player)
                    .background(Color.black)
            } else {
                Color.black
            }
            if isLoading {
                VStack(spacing: 10) {
                    ProgressView()
                        .tint(.white)
                    Text("Загружаю видео…")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white)
                }
                .padding(18)
                .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 14))
            }
            if let errorMessage {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(errorMessage)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.white)
                    Button("Повторить") {
                        startPlayer()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.cineAccent)
                }
                .padding(20)
                .background(.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .background(Color.black)
        .ignoresSafeArea(edges: .bottom)
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            startPlayer()
        }
        .onDisappear {
            player?.pause()
            player = nil
        }
    }

    private func startPlayer() {
        errorMessage = nil
        isLoading = true
        player?.pause()
        player = nil
        Task {
            do {
                let asset = AVURLAsset(url: url)
                let playable = try await asset.load(.isPlayable)
                guard playable else {
                    throw NSError(
                        domain: "CineVault",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "Источник не сообщил, что видео готово к воспроизведению."]
                    )
                }
                let item = AVPlayerItem(asset: asset)
                let nextPlayer = AVPlayer(playerItem: item)
                nextPlayer.automaticallyWaitsToMinimizeStalling = true
                player = nextPlayer
                isLoading = false
                nextPlayer.play()
            } catch {
                isLoading = false
                errorMessage = "Видео не удалось загрузить. Проверь интернет-соединение и повтори попытку."
            }
        }
    }
}

struct DownloadsView: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var downloads = DownloadManager.shared

    var active: [Episode] { store.episodes.filter { downloads.isDownloading($0.id) } }
    var downloaded: [Episode] { store.episodes.filter { downloads.isDownloaded($0.id) } }
    var failed: [Episode] { store.episodes.filter { downloads.errorMessage(for: $0.id) != nil } }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    DownloadGuideCard()

                    if !active.isEmpty {
                        SectionTitle(title: "Загружается", systemImage: "arrow.down.circle.fill")
                            .padding(.top, 4)
                        ForEach(active) { episode in
                            EpisodeRow(episode: episode)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Color.cineSurface)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                        }
                    }

                    if !failed.isEmpty {
                        SectionTitle(title: "Не удалось скачать", systemImage: "exclamationmark.triangle.fill")
                            .padding(.top, active.isEmpty ? 4 : 12)
                        ForEach(failed) { episode in
                            EpisodeRow(episode: episode)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Color.cineSurface)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                        }
                    }

                    if !downloaded.isEmpty {
                        SectionTitle(title: "Офлайн на iPhone", systemImage: "checkmark.circle.fill")
                            .padding(.top, active.isEmpty ? 4 : 12)
                        ForEach(downloaded) { episode in
                            EpisodeRow(episode: episode)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Color.cineSurface)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                        }
                    }

                    if active.isEmpty && downloaded.isEmpty && failed.isEmpty {
                        EmptyCard(text: "Здесь будут серии, сохранённые внутри приложения для просмотра без интернета.")
                    }
                }
                .padding()
            }
            .background(Color.cineBackground)
            .navigationTitle("Скачано")
            .refreshable { await store.refresh() }
        }
    }
}

private struct DownloadGuideCard: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrow.down.circle.fill")
                .font(.title3)
                .foregroundStyle(Color.cineAccent)
            VStack(alignment: .leading, spacing: 4) {
                Text("Как работает загрузка")
                    .font(.headline)
                Text("Нажмите стрелку у серии — CineVault сам скачает исходный файл в лучшем доступном качестве и покажет процент, объём, скорость и примерное оставшееся время.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.cineSurface)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationStack {
            Form {
                Section("Сервер CineVault") {
                    TextField("https://ваш-сервер.example", text: $store.serverAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Viewer-токен", text: $store.viewerToken)
                    Button("Подключить и обновить") { Task { await store.connect() } }
                    Text(store.statusMessage).font(.footnote).foregroundStyle(.secondary)
                }
                Section("Скачивание") {
                    Label("Серии сохраняются внутри приложения", systemImage: "iphone.and.arrow.down.in")
                    Label("Для поездки лучше заранее подключиться по Wi‑Fi", systemImage: "wifi")
                    Label("История просмотра хранится отдельно на этом устройстве", systemImage: "iphone")
                }
                Section("Доступ") {
                    Text("Для удалённого просмотра сервер должен быть доступен по HTTPS. Адрес 127.0.0.1 работает только на том же устройстве.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("Метаданные каталога") {
                    Text("Постеры, описания и состав сезонов загружаются из TMDB. TMDB не является видеопровайдером: видео появляется только после добавления разрешённого файла на ваш сервер.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Link("Открыть TMDB", destination: URL(string: "https://www.themoviedb.org/")!)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.cineBackground)
            .navigationTitle("Настройки")
        }
    }
}

struct EpisodeRow: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var downloads = DownloadManager.shared
    @State private var isDeleteConfirmationPresented = false
    let episode: Episode

    var body: some View {
        HStack(spacing: 12) {
            NavigationLink { PlayerView(episode: episode, store: store) } label: {
                HStack(spacing: 12) {
                    CachedPosterImage(url: URL(string: episode.posterURL ?? "")) {
                        RoundedRectangle(cornerRadius: 10).fill(Color.cineSteel.opacity(0.25))
                    }
                    .frame(width: 58, height: 82)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 5) {
                        Text(episode.title).font(.headline)
                        Text("\(episode.episodeLabel) · \(episode.displayTitle)").font(.subheadline).foregroundStyle(.secondary)
                        if let progress = episode.progress, progress.duration > 0 {
                            ProgressView(value: progress.position, total: progress.duration)
                        }
                        if let error = downloads.errorMessage(for: episode.id) {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        } else if downloads.isDownloading(episode.id), let status = downloads.statusText(for: episode.id) {
                            Text("Загрузка · \(status)")
                                .font(.caption)
                                .foregroundStyle(Color.cineAccent)
                        } else if downloads.isDownloaded(episode.id) {
                            Text("Офлайн на iPhone")
                                .font(.caption)
                                .foregroundStyle(.green)
                        } else {
                            Text(episode.status == "ready" ? "Готово к просмотру" : "На сервере")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            if downloads.isDownloading(episode.id) {
                VStack(spacing: 4) {
                    ProgressView(value: downloads.progress[episode.id] ?? 0)
                        .frame(width: 42)
                    if let status = downloads.statusText(for: episode.id) {
                        Text(status)
                            .font(.caption2)
                            .foregroundStyle(Color.cineAccent)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 180, alignment: .trailing)
                    }
                    Button {
                        downloads.cancel(episodeID: episode.id)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Отменить загрузку")
                }
            } else if downloads.isDownloaded(episode.id) {
                Button {
                    isDeleteConfirmationPresented = true
                } label: {
                    Image(systemName: "trash.circle.fill")
                        .foregroundStyle(.red.opacity(0.85))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Удалить офлайн-копию")
            } else if episode.sourceURL != nil || episode.offlineManifestURL != nil {
                Button { store.download(episode) } label: { Image(systemName: "arrow.down.circle") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Скачать серию")
            }
        }
        .padding(.vertical, 4)
        .alert("Удалить серию с iPhone?", isPresented: $isDeleteConfirmationPresented) {
            Button("Удалить офлайн-копию", role: .destructive) {
                downloads.deleteDownloaded(episodeID: episode.id)
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Удалятся видеофайл, HLS-сегменты и временные файлы. Серия на сервере останется и будет доступна онлайн.")
        }
    }

}

struct HeroCard: View {
    var body: some View {
        HStack(alignment: .bottom, spacing: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Label("говно советует", systemImage: "sparkles")
                    .font(.caption.bold())
                    .foregroundStyle(.white.opacity(0.75))
                Text("Скачайте серии заранее и смотрите вместе даже в поездке")
                    .font(.title2.bold())
                Text("Ваш сервер хранит сериалы, а iPhone берёт их в приложение, запоминает позицию и продолжает просмотр без интернета.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.78))
            }
            PugMascot()
                .frame(width: 86, height: 86)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [.cineSurface, .cineAccent.opacity(0.42)], startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: 24))
    }
}

struct PugMascot: View {
    var body: some View {
        if let image = UIImage(named: "pug-mascot") {
            Image(uiImage: image).resizable().scaledToFit()
        } else {
            Text("🐶").font(.system(size: 58))
        }
    }
}

struct SectionTitle: View {
    let title: String
    let systemImage: String

    var body: some View {
        Label(title, systemImage: systemImage).font(.title3.bold())
    }
}

struct EmptyCard: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(Color.cineSurface)
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}
