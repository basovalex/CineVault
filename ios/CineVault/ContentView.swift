import SwiftUI
import UIKit

enum AppTab: String, CaseIterable, Identifiable {
    case home
    case catalog
    case search
    case mine
    case downloads

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return "Главная"
        case .catalog: return "Каталог"
        case .search: return "Поиск"
        case .mine: return "Моё"
        case .downloads: return "Загрузки"
        }
    }

    var systemImage: String {
        switch self {
        case .home: return "house"
        case .catalog: return "square.grid.2x2"
        case .search: return "magnifyingglass"
        case .mine: return "heart"
        case .downloads: return "arrow.down.to.line"
        }
    }

    var selectedImage: String {
        switch self {
        case .home: return "house.fill"
        case .catalog: return "square.grid.2x2.fill"
        case .search: return "magnifyingglass"
        case .mine: return "heart.fill"
        case .downloads: return "arrow.down.to.line"
        }
    }
}

@MainActor
final class AppChrome: ObservableObject {
    @Published private(set) var isTabBarHidden = false
    private var playerScreens: Set<UUID> = []

    func hideTabBar(for screen: UUID) {
        playerScreens.insert(screen)
        update()
    }

    func showTabBar(for screen: UUID) {
        playerScreens.remove(screen)
        update()
    }

    private func update() {
        isTabBarHidden = !playerScreens.isEmpty
        OrientationPolicy.setAllowsLandscape(!playerScreens.isEmpty)
    }
}

/// iPhone screens stay upright, except while a player is on screen: then the
/// phone may turn sideways and the video fills the display. iPad turns freely.
@MainActor
enum OrientationPolicy {
    private(set) static var allowsLandscape = false

    static var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    static var mask: UIInterfaceOrientationMask {
        guard isPhone else { return .all }
        return allowsLandscape ? .allButUpsideDown : .portrait
    }

    static func setAllowsLandscape(_ allowed: Bool) {
        guard allowed != allowsLandscape else { return }
        allowsLandscape = allowed
        for scene in windowScenes {
            var controller = scene.keyWindow?.rootViewController
            while let current = controller {
                current.setNeedsUpdateOfSupportedInterfaceOrientations()
                controller = current.presentedViewController
            }
        }
        if !allowed { returnUpright() }
    }

    /// Turns an iPhone interface back to portrait, as if the phone had been rotated.
    static func returnUpright() {
        guard isPhone else { return }
        rotate(to: .portrait)
    }

    /// Landscape with the camera housing on the left edge (the phone turned anticlockwise).
    static var cameraIsOnLeft: Bool {
        windowScenes.first?.effectiveGeometry.interfaceOrientation != .landscapeLeft
    }

    static func rotate(to orientations: UIInterfaceOrientationMask) {
        for scene in windowScenes where !orientations.contains(scene.effectiveGeometry.interfaceOrientation.mask) {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientations))
        }
    }

    private static var windowScenes: [UIWindowScene] {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    }
}

private extension UIInterfaceOrientation {
    var mask: UIInterfaceOrientationMask {
        switch self {
        case .portrait: return .portrait
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return []
        }
    }
}

struct HideTabBarWhileVisible: ViewModifier {
    @EnvironmentObject private var chrome: AppChrome
    @State private var screenID = UUID()

    func body(content: Content) -> some View {
        content
            .toolbar(.hidden, for: .tabBar)
            .onAppear { chrome.hideTabBar(for: screenID) }
            .onDisappear { chrome.showTabBar(for: screenID) }
    }
}

struct ContentView: View {
    @StateObject private var store = AppStore()
    @StateObject private var chrome = AppChrome()
    @State private var selectedTab: AppTab = Self.initialTab
    @Environment(\.scenePhase) private var scenePhase

    /// Debug builds accept `-cinevault.initialTab catalog` as a launch argument for screenshots.
    private static var initialTab: AppTab {
        #if DEBUG
        AppTab(rawValue: UserDefaults.standard.string(forKey: "cinevault.initialTab") ?? "") ?? .home
        #else
        .home
        #endif
    }

    var body: some View {
        tabs
            .environmentObject(store)
            .environmentObject(chrome)
            .tint(.cineAccent)
            .preferredColorScheme(.dark)
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
    private var tabs: some View {
        if #available(iOS 26.0, *) {
            // The system tab bar is Liquid Glass here: it floats over the content,
            // morphs the selection between tabs and shrinks while scrolling down.
            TabView(selection: $selectedTab) {
                ForEach(AppTab.allCases) { tab in
                    Tab(tab.title, systemImage: tab.systemImage, value: tab, role: tab == .search ? .search : nil) {
                        screen(for: tab)
                    }
                }
            }
            .tabBarMinimizeBehavior(.onScrollDown)
        } else {
            ZStack {
                // Every tab stays alive so its scroll position and navigation survive switching.
                ForEach(AppTab.allCases) { tab in
                    screen(for: tab)
                        .opacity(selectedTab == tab ? 1 : 0)
                        .allowsHitTesting(selectedTab == tab)
                        .accessibilityHidden(selectedTab != tab)
                }
            }
            // A real safe-area inset reserves the bar's space in each scroll view.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !chrome.isTabBarHidden {
                    CineVaultTabBar(selection: $selectedTab)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.2), value: chrome.isTabBarHidden)
        }
    }

    @ViewBuilder
    private func screen(for tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView(selectedTab: $selectedTab)
        case .catalog: CatalogView()
        case .search: SearchView()
        case .mine: MineView()
        case .downloads: DownloadsView()
        }
    }
}

private struct CineVaultTabBar: View {
    @Binding var selection: AppTab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.allCases) { tab in
                let isSelected = selection == tab
                Button {
                    selection = tab
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: isSelected ? tab.selectedImage : tab.systemImage)
                            .font(.system(size: 21, weight: isSelected ? .semibold : .regular))
                            .frame(height: 26)
                        Text(tab.title)
                            .font(.cine(10, .medium))
                    }
                    .frame(maxWidth: .infinity, minHeight: CineMetrics.tabBarHeight)
                    .foregroundStyle(isSelected ? Color.cineAccent : Color.cineMuted)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(.horizontal, 8)
        .background {
            Color.cineBackground.opacity(0.94)
                .background(.ultraThinMaterial)
                .ignoresSafeArea(edges: .bottom)
        }
        .overlay(alignment: .top) {
            Rectangle().fill(Color.cineLine).frame(height: 1)
        }
    }
}

// MARK: - Downloads

struct DownloadsView: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject private var downloads = DownloadManager.shared

    var active: [Episode] { store.episodes.filter { downloads.isDownloading($0.id) } }
    var downloaded: [Episode] { store.episodes.filter { downloads.isDownloaded($0.id) } }
    var failed: [Episode] { store.episodes.filter { downloads.errorMessage(for: $0.id) != nil } }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    Text("Загрузки")
                        .font(.cine(30, .semibold))
                        .padding(.horizontal, CineMetrics.gutter)
                    section("Загружается", active)
                    section("Не удалось скачать", failed)
                    section("На iPhone", downloaded)
                    if active.isEmpty && downloaded.isEmpty && failed.isEmpty {
                        EmptyStateView(
                            systemImage: "arrow.down.to.line",
                            title: "Пока ничего не скачано",
                            message: "Нажмите стрелку у серии из медиатеки — она сохранится в приложении и будет доступна без интернета."
                        )
                    }
                    if !store.episodes.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ShelfHeader(title: "Медиатека на сервере", subtitle: "\(store.episodes.count) серий можно скачать")
                            ForEach(store.episodes.filter { !downloads.isDownloaded($0.id) && !downloads.isDownloading($0.id) }.prefix(30)) { episode in
                                EpisodeRow(episode: episode).padding(.horizontal, CineMetrics.gutter)
                            }
                        }
                    }
                }
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .background(Color.cineBackground.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await store.refresh() }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ episodes: [Episode]) -> some View {
        if !episodes.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ShelfHeader(title: title)
                ForEach(episodes) { episode in
                    EpisodeRow(episode: episode).padding(.horizontal, CineMetrics.gutter)
                }
            }
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Сервер CineVault") {
                    TextField("https://ваш-сервер.example", text: $store.serverAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("Переподключить и обновить") { Task { await store.connect() } }
                        .foregroundStyle(Color.cineAccent)
                    Text(store.statusMessage).font(.footnote).foregroundStyle(Color.cineMuted)
                }
                Section {
                    Label("Избранное хранится на этом iPhone", systemImage: "heart")
                    Label("История просмотра хранится на этом iPhone", systemImage: "clock.arrow.circlepath")
                    Label("Скачанные серии доступны без интернета", systemImage: "arrow.down.to.line")
                } header: {
                    Text("Данные")
                } footer: {
                    Text("Вход выполняется автоматически: данные доступа заданы в приватной сборке. Для просмотра вне дома сервер должен быть доступен по HTTPS.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.cineBackground.ignoresSafeArea())
            .navigationTitle("Настройки")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
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

