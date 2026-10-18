import SwiftUI
import UIKit
import AVKit
import WebKit

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
        case .home: return "Для вас"
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
    @Published private(set) var isTabBarHidden = false
    private var playerScreens: Set<UUID> = []

    func hideTabBar(for screen: UUID) {
        playerScreens.insert(screen)
        isTabBarHidden = !playerScreens.isEmpty
    }

    func showTabBar(for screen: UUID) {
        playerScreens.remove(screen)
        isTabBarHidden = !playerScreens.isEmpty
    }
}

private struct HideTabBarWhileVisible: ViewModifier {
    @EnvironmentObject private var chrome: AppChrome
    @State private var screenID = UUID()

    func body(content: Content) -> some View {
        content
            .onAppear { chrome.hideTabBar(for: screenID) }
            .onDisappear { chrome.showTabBar(for: screenID) }
    }
}

struct ContentView: View {
    @StateObject private var store = AppStore()
    @StateObject private var chrome = AppChrome()
    @State private var selectedTab: AppTab = .home
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        selectedView
            // A real safe-area inset reserves the dock's space in each scroll
            // view, so the final row and pagination can scroll fully above it.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !chrome.isTabBarHidden {
                    CineVaultTabBar(selection: $selectedTab)
                        .padding(.horizontal, 14)
                        .padding(.top, 7)
                        .padding(.bottom, 8)
                        .background {
                            Color.cineBackground.ignoresSafeArea(edges: .bottom)
                        }
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
        case .catalog: CatalogView(selectedTab: $selectedTab)
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
                VStack(alignment: .leading, spacing: 24) {
                    HStack(alignment: .center, spacing: 14) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Для вас")
                                .font(.largeTitle.bold())
                            Text("Мопс собрал кино под ваш вечер")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        PugMascot()
                            .frame(width: 76, height: 76)
                            .accessibilityLabel("Мопс, помощник CineVault")
                    }
                    if let pick = store.homeShelves.first(where: { $0.id == "personal" })?.items.first {
                        NavigationLink {
                            CatalogTitleDetailView(title: pick)
                        } label: {
                            HomeRecommendationCard(title: pick)
                        }
                        .buttonStyle(.plain)
                    } else if store.homeLoading {
                        ProgressView("Мопс выбирает фильм…")
                            .frame(maxWidth: .infinity, minHeight: 115)
                            .background(Color.cineSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 22))
                    } else if let error = store.homeError {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Не удалось загрузить подборки").font(.headline)
                            Text(error).font(.caption).foregroundStyle(.secondary)
                            Button("Повторить") { Task { await store.loadHomeDiscovery(force: true) } }
                                .buttonStyle(.borderedProminent)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.cineSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 20))
                    } else {
                        EmptyCard(text: "Подборка появится, когда загрузится каталог.")
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Какое настроение?")
                            .font(.headline)
                        HStack(spacing: 8) {
                            moodButton("уютно", title: "Уютно", icon: "sparkles")
                            moodButton("романтично", title: "Для двоих", icon: "heart")
                            moodButton("смеяться", title: "Посмеяться", icon: "face.smiling")
                            moodButton("напряжённо", title: "Интрига", icon: "eye")
                        }
                    }
                    if store.homePopularAvailable == false && !store.homeLoading && store.homeError == nil {
                        Text("Для настоящей популярности нужны счётчики оценок Kinopoisk. Пока они не пришли с сервера, не подменяю их рейтингом.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.cineSurface)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                    ForEach(store.homeShelves) { shelf in
                        CatalogDiscoveryShelf(shelf: shelf)
                    }
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
                // NavigationStack destinations do not always inherit the root
                // safe-area inset. Keep the final card above the persistent dock.
                .padding(.bottom, 112)
            }
            .background(Color.cineBackground.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .task { await store.loadHomeDiscovery() }
            .refreshable {
                await store.refresh()
                await store.loadHomeDiscovery(force: true)
            }
        }
    }

    private func moodButton(_ mood: String, title: String, icon: String) -> some View {
        Button {
            store.selectHomeMood(mood)
        } label: {
            VStack(spacing: 6) {
                Image(systemName: icon)
                Text(title).lineLimit(1).minimumScaleFactor(0.8)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(store.homeMood == mood ? Color.cineBackground : Color.white.opacity(0.86))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(store.homeMood == mood ? Color.cineAccent : Color.cineSurface)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }
}

private struct HomeRecommendationCard: View {
    let title: CatalogTitle

    var body: some View {
        HStack(spacing: 14) {
            CatalogPosterArt(title: title)
                .frame(width: 82, height: 116)
            VStack(alignment: .leading, spacing: 7) {
                Label("Рекомендация мопса", systemImage: "sparkles")
                    .font(.caption.bold())
                    .foregroundStyle(Color.cineAccent)
                Text(title.title)
                    .font(.headline)
                    .foregroundStyle(.white)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(String(title.year))
                        .font(.caption.weight(.semibold))
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color.cineBackground.opacity(0.72))
                        .clipShape(Capsule())
                    Text([title.kindLabel, title.rating.map { String(format: "КП %.1f", $0) }]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                Text(title.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(LinearGradient(colors: [Color.cineSurface, Color.cineAccent.opacity(0.18)], startPoint: .topLeading, endPoint: .bottomTrailing))
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.cineAccent.opacity(0.22), lineWidth: 1))
    }
}

private struct CatalogDiscoveryShelf: View {
    let shelf: CatalogShelf

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(shelf.title).font(.title3.bold())
                Text(shelf.subtitle).font(.caption).foregroundStyle(.secondary)
            }
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(shelf.items) { title in
                        NavigationLink {
                            CatalogTitleDetailView(title: title)
                        } label: {
                            VStack(alignment: .leading, spacing: 7) {
                                CatalogPosterArt(title: title)
                                    .frame(width: 124, height: 174)
                                Text(title.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .lineLimit(2)
                                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .topLeading)
                                if shelf.id == "popular" {
                                    Text("\(title.voteCount ?? 0) оценок КП")
                                        .font(.caption2)
                                        .foregroundStyle(Color.cineAccent)
                                } else {
                                    Text(title.rating.map { String(format: "КП %.1f", $0) } ?? title.kindLabel)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .frame(width: 124, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }
}

struct CatalogView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selectedTab: AppTab
    @State private var query = ""
    @State private var filter: CatalogFilter = .all
    @State private var selectedGenre = ""
    @State private var sort = "rating"
    @State private var collection = ""

    private var normalizedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var searchKey: String {
        "\(filter.rawValue)|\(normalizedQuery)|\(selectedGenre)|\(sort)|\(collection)"
    }
    private var genreNames: [String] {
        (store.catalogFacets?.genres ?? [:]).keys.sorted()
    }
    private var serverKind: String {
        switch filter {
        case .all: return ""
        case .movies: return "movie"
        case .series: return "series"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Фильмы и сериалы для вас")
                        .font(.title2.bold())
                    Text("Карточки, описания и доступные способы просмотра в одном месте.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                        TextField("Найти фильм или сериал", text: $query)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.search)
                        if !query.isEmpty {
                            Button {
                                query = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                            .accessibilityLabel("Очистить поиск")
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Color.cineSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
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
                    HStack(spacing: 10) {
                        Menu {
                            Button("Все жанры") { selectedGenre = "" }
                            if !genreNames.isEmpty { Divider() }
                            ForEach(genreNames, id: \.self) { genre in
                                Button("\(genre.capitalized) · \(store.catalogFacets?.genres[genre] ?? 0)") {
                                    selectedGenre = genre
                                }
                            }
                        } label: {
                            Label(selectedGenre.isEmpty ? "Жанр" : selectedGenre.capitalized, systemImage: "line.3.horizontal.decrease")
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .background(Color.cineSurface)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        }

                        Menu {
                            Button { sort = "popular" } label: {
                                Label("По числу оценок Kinopoisk", systemImage: sort == "popular" ? "checkmark" : "chart.bar.fill")
                            }
                            Button { sort = "rating" } label: {
                                Label("С высоким рейтингом", systemImage: sort == "rating" ? "checkmark" : "star")
                            }
                            Button { sort = "new" } label: {
                                Label("Сначала новые", systemImage: sort == "new" ? "checkmark" : "calendar")
                            }
                            Button { sort = "title" } label: {
                                Label("По алфавиту", systemImage: sort == "title" ? "checkmark" : "textformat.abc")
                            }
                        } label: {
                            Label(sortTitle, systemImage: "arrow.up.arrow.down")
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .background(Color.cineSurface)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            collectionChip(title: "Все карточки", value: "")
                            collectionChip(title: "Популярные по оценкам", value: "popular")
                        }
                    }
                    .scrollIndicators(.hidden)
                    Text("\(store.catalogTotal) карточек · 50 на страницу")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let error = store.catalogError {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Не удалось загрузить каталог").font(.headline)
                            Text(error).font(.caption).foregroundStyle(.secondary)
                            Button("Повторить") {
                                Task { await loadPage(1) }
                            }
                            Button("Настройки подключения") { selectedTab = .settings }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.cineSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                    }
                    if store.catalog.isEmpty && !store.isCatalogLoading && store.catalogError == nil {
                        EmptyCard(text: collection == "popular"
                            ? "Для рейтинга популярности нужны числа оценок Kinopoisk. Сервер пока не прислал такие данные для подходящих карточек."
                            : "По этому запросу карточек пока нет.")
                    }
                    LazyVStack(spacing: 12) {
                        ForEach(store.catalog) { title in
                            CatalogTitleRow(title: title)
                        }
                    }
                    if store.isCatalogLoading {
                        ProgressView("Загружаю каталог…")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                    } else if store.catalogTotal > 0 {
                        HStack(spacing: 18) {
                            Button {
                                Task { await loadPage(store.catalogPage - 1) }
                            } label: {
                                Label("Назад", systemImage: "chevron.left")
                            }
                            .disabled(store.catalogPage <= 1)

                            Text("Страница \(store.catalogPage) из \(store.catalogPages)")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .accessibilityLabel("Страница \(store.catalogPage) из \(store.catalogPages)")

                            Button {
                                Task { await loadPage(store.catalogPage + 1) }
                            } label: {
                                Label("Дальше", systemImage: "chevron.right")
                                    .labelStyle(.titleAndIcon)
                            }
                            .disabled(store.catalogPage >= store.catalogPages)
                        }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                }
                .padding()
                // The pagination row must remain reachable above the dock.
                .padding(.bottom, 112)
            }
            .scrollIndicators(.hidden)
            .background(Color.cineBackground)
            .navigationTitle("Каталог")
            .task(id: searchKey) {
                await store.loadCatalogFacets()
                if !normalizedQuery.isEmpty {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                }
                guard !Task.isCancelled else { return }
                await loadPage(1)
            }
            .refreshable {
                await loadPage(1)
            }
        }
    }

    private var sortTitle: String {
        switch sort {
        case "popular": return "По популярности"
        case "new": return "Сначала новые"
        case "title": return "По алфавиту"
        default: return "По рейтингу"
        }
    }

    private func collectionChip(title: String, value: String) -> some View {
        Button(title) {
            collection = value
            if value == "popular" { sort = "popular" }
            else if sort == "popular" { sort = "rating" }
        }
            .font(.caption.weight(.semibold))
            .foregroundStyle(collection == value ? Color.cineBackground : Color.white.opacity(0.82))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(collection == value ? Color.cineAccent : Color.cineSurface)
            .clipShape(Capsule())
    }

    private func loadPage(_ page: Int) async {
        await store.loadCatalogPage(
            page, search: normalizedQuery, kind: serverKind, genre: selectedGenre,
            sort: sort, collection: collection
        )
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
            $0.titleID == title.id ||
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
                    HStack(spacing: 6) {
                        Text(String(title.year))
                            .font(.caption.weight(.semibold))
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.cineBackground.opacity(0.72))
                            .clipShape(Capsule())
                        Text([title.kindLabel, title.rating.map { String(format: "КП %.1f", $0) }, title.voteCount.map { "\($0) оценок" }]
                            .compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    Text(title.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    HStack(spacing: 6) {
                        Text(title.isSeries ? (serverEpisodeCount > 0 ? "На сервере: \(serverEpisodeCount) серий" : title.seasonLabel) : (title.isServerTitle ? "Открыть карточку" : title.availabilityLabel))
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
    @State private var fullTitle: CatalogTitle?
    @State private var detailError: String?
    @State private var isLoadingDetails = false
    @State private var externalPlayers: [ExternalPlayerProvider] = []
    @State private var externalPlayerError: String?
    @State private var isLoadingExternalPlayers = false
    @State private var isRequesting = false
    @State private var requestError: String?
    @State private var expandedSeasons: Set<Int> = [1]

    private var activeTitle: CatalogTitle { fullTitle ?? title }

    private var libraryEpisodes: [Episode] {
        store.episodes.filter {
            $0.titleID == title.id ||
            $0.title.localizedCaseInsensitiveCompare(title.title) == .orderedSame ||
            $0.originalTitle?.localizedCaseInsensitiveCompare(title.originalTitle) == .orderedSame
        }
    }

    private var metadataLabel: String {
        [activeTitle.year > 0 ? String(activeTitle.year) : "", activeTitle.kindLabel, activeTitle.runtimeLabel]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 16) {
                    CatalogPosterArt(title: activeTitle)
                        .frame(width: 130, height: 190)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(activeTitle.title).font(.title2.bold())
                        Text(metadataLabel)
                            .foregroundStyle(.secondary)
                        Text(activeTitle.description)
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
                        ForEach(activeTitle.tags, id: \.self) { tag in
                            Text("#\(tag)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Color.cineAccent)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color.cineAccent.opacity(0.12))
                                .clipShape(Capsule())
                        }
                    }
                    if activeTitle.isSeries, !activeTitle.seasonLabel.isEmpty {
                        Label(activeTitle.seasonLabel, systemImage: "square.stack.3d.up")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Text(activeTitle.providerNote)
                        .font(.caption)
                        .foregroundStyle(Color.cineSteel)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.cineSurface)
                .clipShape(RoundedRectangle(cornerRadius: 16))

                if isLoadingDetails {
                    ProgressView("Проверяю доступные источники…")
                }
                if let detailError {
                    Text("Источники не обновились: \(detailError)")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    Button("Повторить") { Task { await loadDetails() } }
                }
                if !activeTitle.playbackSources.isEmpty {
                    SectionTitle(title: "Варианты просмотра", systemImage: "play.rectangle")
                    ForEach(activeTitle.playbackSources) { source in
                        if store.api.playbackURL(for: source.url) != nil {
                            NavigationLink {
                                CatalogFreshPlayerView(title: activeTitle, source: source)
                            } label: {
                                Label(source.label.isEmpty ? "Смотреть" : source.label, systemImage: "play.fill")
                                    .font(.headline)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(.cineAccent)
                        }
                    }
                } else if !activeTitle.isServerTitle,
                          let videoURL = activeTitle.videoURL,
                          let url = URL(string: videoURL) {
                    NavigationLink {
                        CatalogExternalPlayerView(title: activeTitle, url: url)
                    } label: {
                        Label("Смотреть в CineVault", systemImage: "play.fill")
                    }
                }

                if let kinopoiskID = activeTitle.kinopoiskID {
                    Button {
                        Task { await loadExternalPlayers(kinopoiskID: kinopoiskID) }
                    } label: {
                        Label("Показать внешние плееры и озвучки", systemImage: "film.stack")
                    }
                    .disabled(isLoadingExternalPlayers)
                    if isLoadingExternalPlayers { ProgressView("Проверяю плееры…") }
                    if let externalPlayerError {
                        Text(externalPlayerError).font(.caption).foregroundStyle(.orange)
                    }
                    ForEach(externalPlayers) { provider in
                        SectionTitle(title: provider.name, systemImage: "play.rectangle.on.rectangle")
                        ForEach(provider.translations) { translation in
                            if let url = URL(string: translation.embedURL),
                               url.scheme == "https", url.host == "theatre.stravers.live", url.port == nil {
                                NavigationLink {
                                    CatalogAllohaPlayerView(title: activeTitle, preferredTranslation: translation.name)
                                } label: {
                                    Label(
                                        [translation.name, translation.quality].filter { !$0.isEmpty }.joined(separator: " · "),
                                        systemImage: "play.fill"
                                    )
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                }

                if activeTitle.isSeries {
                    SectionTitle(title: "Сезоны и серии", systemImage: "film.stack")
                    Text("Серии, загруженные в вашу медиатеку, можно смотреть в приложении.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if !activeTitle.isServerTitle { requestButton }
                    if activeTitle.seasons.isEmpty {
                        EmptyCard(text: "Для этого сериала пока не удалось получить список сезонов.")
                    } else {
                        ForEach(Array(activeTitle.seasons.enumerated()), id: \.offset) { index, episodeCount in
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
                } else if activeTitle.playbackSources.isEmpty && activeTitle.videoURL == nil && !isLoadingDetails {
                    if !activeTitle.isServerTitle { requestButton }
                    EmptyCard(text: "У этой карточки пока нет доступного источника для iOS.")
                }
            }
            .padding()
            // A title can be much longer than the screen; reserve space for
            // the tab bar so its final actions and episodes are not covered.
            .padding(.bottom, 112)
        }
        .background(Color.cineBackground)
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: title.id) { await loadDetails() }
    }

    private func loadDetails() async {
        guard title.isServerTitle else { return }
        isLoadingDetails = true
        detailError = nil
        defer { isLoadingDetails = false }
        do {
            fullTitle = try await store.api.fetchCatalogTitle(id: title.id)
        } catch {
            detailError = error.localizedDescription
        }
    }

    private func loadExternalPlayers(kinopoiskID: Int) async {
        isLoadingExternalPlayers = true
        externalPlayerError = nil
        defer { isLoadingExternalPlayers = false }
        do {
            let response = try await store.api.fetchPlayerOptions(kinopoiskID: kinopoiskID)
            externalPlayers = response.providers
            if externalPlayers.isEmpty {
                externalPlayerError = "Сейчас внешние плееры недоступны для этой карточки."
            }
        } catch {
            externalPlayerError = "Не удалось получить плееры: \(error.localizedDescription)"
        }
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

private struct CatalogEmbedPlayerView: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    let url: URL

    var body: some View {
        ExternalEmbedWebView(url: url, siteURL: store.api.configuration.baseURL)
            .background(Color.black)
            .navigationTitle(title.title)
            .navigationBarTitleDisplayMode(.inline)
    }
}

private struct CatalogFreshPlayerView: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    let source: CatalogPlaybackSource
    @State private var currentSource: CatalogPlaybackSource?
    @State private var isLoading = true
    @State private var warning: String?

    var body: some View {
        Group {
            if let currentSource, let url = store.api.playbackURL(for: currentSource.url) {
                VStack(spacing: 0) {
                    if let warning {
                        Text(warning).font(.caption).foregroundStyle(.orange).padding(8)
                    }
                    if currentSource.isEmbed {
                        CatalogEmbedPlayerView(title: title, url: url)
                    } else {
                        CatalogExternalPlayerView(title: title, url: url)
                    }
                }
            } else if isLoading {
                ProgressView("Обновляю ссылку на видео…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Видео недоступно", systemImage: "play.slash", description: Text(warning ?? "Источник не отдал ссылку"))
            }
        }
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Обновить ссылку", systemImage: "arrow.clockwise") {
                Task { await refresh(force: true) }
            }
        }
        .modifier(HideTabBarWhileVisible())
        .task { await refresh(force: false) }
    }

    private func refresh(force: Bool) async {
        isLoading = true
        currentSource = nil
        warning = nil
        if let kinopoiskID = title.kinopoiskID {
            do {
                let response = try await store.api.refreshPlayback(kinopoiskID: kinopoiskID, force: force)
                if response.deleted == true {
                    warning = response.warning ?? "Карточка больше недоступна"
                    isLoading = false
                    return
                }
                let sources = response.entry?.catalogTitle.playbackSources ?? []
                currentSource = sources.first(where: { $0.id == source.id })
                    ?? sources.first(where: { $0.voice == source.voice && $0.quality == source.quality && $0.type == source.type })
                    ?? sources.first(where: { $0.isEmbed == source.isEmbed })
                warning = response.warning
            } catch {
                warning = "Свежую ссылку получить не удалось: \(error.localizedDescription). Пробую предыдущую."
            }
        }
        if currentSource == nil {
            currentSource = source
        }
        if store.api.playbackURL(for: currentSource?.url ?? "") == nil {
            currentSource = nil
            warning = "Некорректный адрес видео"
        }
        isLoading = false
    }
}

private struct CatalogAllohaPlayerView: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    let preferredTranslation: String
    @State private var translations: [ExternalPlayerTranslation] = []
    @State private var selectedID: String?
    @State private var isLoading = true
    @State private var errorMessage: String?

    private var selected: ExternalPlayerTranslation? {
        translations.first(where: { $0.id == selectedID }) ?? translations.first
    }

    var body: some View {
        VStack(spacing: 0) {
            if translations.count > 1 {
                Picker("Озвучка", selection: $selectedID) {
                    ForEach(translations) { translation in
                        Text(translation.name).tag(Optional(translation.id))
                    }
                }
                .pickerStyle(.menu)
                .padding(.horizontal)
            }
            if let selected, let url = URL(string: selected.embedURL),
               url.scheme == "https", url.host == "theatre.stravers.live", url.port == nil {
                ExternalEmbedWebView(url: url, siteURL: store.api.configuration.baseURL)
            } else if isLoading {
                ProgressView("Получаю свежую ссылку Alloha…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Alloha недоступен", systemImage: "play.slash", description: Text(errorMessage ?? "Нет доступных озвучек"))
            }
        }
        .background(Color.black)
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Обновить ссылку", systemImage: "arrow.clockwise") {
                Task { await loadOptions() }
            }
        }
        .modifier(HideTabBarWhileVisible())
        .task { await loadOptions() }
    }

    private func loadOptions() async {
        guard let kinopoiskID = title.kinopoiskID else {
            errorMessage = "У карточки нет Kinopoisk ID"
            isLoading = false
            return
        }
        let currentName = selected?.name ?? preferredTranslation
        isLoading = true
        translations = []
        errorMessage = nil
        do {
            let response = try await store.api.fetchPlayerOptions(kinopoiskID: kinopoiskID)
            translations = response.providers.first(where: { $0.id == "alloha" })?.translations ?? []
            selectedID = translations.first(where: { $0.name == currentName })?.id ?? translations.first?.id
            if translations.isEmpty { errorMessage = "Сейчас нет доступных озвучек" }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

private struct ExternalEmbedWebView: UIViewRepresentable {
    let url: URL
    let siteURL: URL

    final class Coordinator {
        var loadedURL: URL?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if let filterURL = Bundle.main.url(forResource: "filter", withExtension: "js"),
           let source = try? String(contentsOf: filterURL, encoding: .utf8) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page)
            )
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.scrollView.isScrollEnabled = false
        loadFrame(in: webView, coordinator: context.coordinator)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedURL != url else { return }
        loadFrame(in: webView, coordinator: context.coordinator)
    }

    private func loadFrame(in webView: WKWebView, coordinator: Coordinator) {
        coordinator.loadedURL = url
        let safeURL = url.absoluteString
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
        let html = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#000}</style></head>
        <body><iframe src="\(safeURL)" allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>
        """
        webView.loadHTMLString(html, baseURL: siteURL)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: ()) {
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }
}

private struct CatalogExternalPlayerView: View {
    @EnvironmentObject private var store: AppStore
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
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .modifier(HideTabBarWhileVisible())
        .task {
            startPlayer()
        }
        .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemFailedToPlayToEndTime)) { notification in
            guard let currentItem = player?.currentItem,
                  let failedItem = notification.object as? AVPlayerItem,
                  currentItem === failedItem else { return }
            isLoading = false
            errorMessage = "Поток оборвался. Попробуй обновить ссылку или выбрать другой плеер."
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
                let options: [String: Any]
                if let authorization = store.api.authorizationHeader(for: url) {
                    options = ["AVURLAssetHTTPHeaderFieldsKey": ["Authorization": authorization]]
                } else {
                    options = [:]
                }
                let asset = AVURLAsset(url: url, options: options)
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
                .padding(.bottom, 112)
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
                        .keyboardType(.URL)
                    Text("Вход выполняется автоматически. Данные доступа настроены в приватной сборке приложения.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Переподключить и обновить") { Task { await store.connect() } }
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
                    Text("Карточки, поиск и варианты источников приходят с вашего CineVault-сервера. Приложение само не ищет видеопотоки на сторонних сайтах.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
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
                Label("CineVault советует", systemImage: "sparkles")
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
