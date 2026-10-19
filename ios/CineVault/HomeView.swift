import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selectedTab: AppTab
    @State private var heroSelection = 0
    @State private var isSettingsPresented = false

    /// The hero rotates through the first recommendations that have wide artwork.
    private var heroItems: [CatalogTitle] {
        let candidates = store.homeShelves.flatMap(\.items)
        var seen = Set<String>()
        let unique = candidates.filter { seen.insert($0.id).inserted }
        let wide = unique.filter { $0.backdropURL != nil }
        return Array((wide.isEmpty ? unique : wide).prefix(6))
    }

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 30) {
                        hero(topInset: proxy.safeAreaInsets.top)
                        continueWatching
                        librarySeries
                        if let error = store.homeError, store.homeShelves.isEmpty {
                            VStack(spacing: 12) {
                                EmptyStateView(systemImage: "wifi.exclamationmark", title: "Не удалось загрузить подборки", message: error)
                                Button("Повторить") { Task { await store.loadHomeDiscovery(force: true) } }
                                    .buttonStyle(CineSecondaryButtonStyle())
                                    .padding(.horizontal, CineMetrics.gutter)
                            }
                        }
                        ForEach(store.homeShelves) { shelf in
                            PosterShelf(shelf: shelf)
                        }
                    }
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
                .ignoresSafeArea(edges: .top)
            }
            .background(Color.cineBackground.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: CatalogTitle.self) { TitleDetailView(title: $0) }
            .task { await store.loadHomeDiscovery() }
            .refreshable {
                await store.refresh()
                await store.loadHomeDiscovery(force: true)
            }
            .sheet(isPresented: $isSettingsPresented) { SettingsView() }
        }
    }

    // MARK: Hero

    @ViewBuilder
    private func hero(topInset: CGFloat) -> some View {
        let items = heroItems
        let height: CGFloat = 560 + topInset * 0.4
        ZStack(alignment: .top) {
            if items.isEmpty {
                LinearGradient(colors: [Color.cineSurface, Color.cineBackground], startPoint: .top, endPoint: .bottom)
                    .frame(height: height)
                    .overlay {
                        if store.homeLoading { ProgressView().tint(.white) }
                    }
            } else {
                TabView(selection: $heroSelection) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, title in
                        HeroPage(title: title, label: index == 0 ? "Советуем" : "Новинка")
                            .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .frame(height: height)
                .overlay(alignment: .bottom) {
                    if items.count > 1 {
                        HStack(spacing: 6) {
                            ForEach(items.indices, id: \.self) { index in
                                Capsule()
                                    .fill(index == heroSelection ? Color.white : Color.white.opacity(0.3))
                                    .frame(width: index == heroSelection ? 18 : 5, height: 5)
                            }
                        }
                        .animation(.easeOut(duration: 0.2), value: heroSelection)
                        .padding(.bottom, 2)
                        .accessibilityHidden(true)
                    }
                }
            }
            topBar.padding(.top, topInset + 6)
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 9) {
                Image(systemName: "play.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(Color.cineButton)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                Text("CineVault")
                    .font(.cine(19, .semibold))
            }
            .accessibilityElement(children: .combine)
            Spacer()
            Button { selectedTab = .search } label: { Image(systemName: "magnifyingglass") }
                .buttonStyle(CineOverlayButtonStyle())
                .accessibilityLabel("Поиск")
            Button { isSettingsPresented = true } label: { Image(systemName: "person") }
                .buttonStyle(CineOverlayButtonStyle())
                .accessibilityLabel("Настройки")
        }
        .padding(.horizontal, CineMetrics.gutter)
    }

    // MARK: Continue watching

    private var continueItems: [(title: CatalogTitle, progress: CatalogProgressEntry)] {
        store.watchedTitles.compactMap { title in
            guard let progress = store.progress(forTitle: title.id), progress.completed != true else { return nil }
            return (title, progress)
        }
    }

    @ViewBuilder
    private var continueWatching: some View {
        let items = continueItems
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                ShelfHeader(title: "Продолжить просмотр", actionTitle: "Все") { selectedTab = .mine }
                ScrollView(.horizontal) {
                    LazyHStack(alignment: .top, spacing: 12) {
                        ForEach(items, id: \.title.id) { item in
                            NavigationLink(value: item.title) {
                                ContinueCard(title: item.title, progress: item.progress)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, CineMetrics.gutter)
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    @ViewBuilder
    private var librarySeries: some View {
        if !store.continueWatching.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ShelfHeader(title: "Серии на сервере")
                VStack(spacing: 0) {
                    ForEach(store.continueWatching.prefix(5)) { episode in
                        EpisodeRow(episode: episode)
                            .padding(.horizontal, CineMetrics.gutter)
                    }
                }
            }
        }
    }
}

private struct HeroPage: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    let label: String

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottomLeading) {
                BackdropArt(title: title)
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()
                LinearGradient(
                    stops: [
                        .init(color: Color.cineBackground.opacity(0.55), location: 0),
                        .init(color: .clear, location: 0.22),
                        .init(color: .clear, location: 0.42),
                        .init(color: Color.cineBackground.opacity(0.85), location: 0.76),
                        .init(color: Color.cineBackground, location: 1),
                    ],
                    startPoint: .top, endPoint: .bottom
                )
                VStack(alignment: .leading, spacing: 12) {
                    Text(label)
                        .font(.cine(12, .semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.cineSurface.opacity(0.8))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    TitleLogo(title: title)
                    MetaLine(title: title)
                    HStack(spacing: 10) {
                        NavigationLink(value: title) {
                            Label("Смотреть", systemImage: "play.fill")
                        }
                        .buttonStyle(CinePrimaryButtonStyle())
                        Button { store.toggleFavorite(title) } label: {
                            Image(systemName: store.isFavorite(title.id) ? "checkmark" : "plus")
                        }
                        .buttonStyle(CineIconButtonStyle())
                        .accessibilityLabel(store.isFavorite(title.id) ? "Убрать из избранного" : "В избранное")
                        NavigationLink(value: title) { Image(systemName: "info.circle") }
                            .buttonStyle(CineIconButtonStyle())
                            .accessibilityLabel("Подробнее")
                    }
                    .padding(.top, 2)
                }
                .padding(.horizontal, CineMetrics.gutter)
                .padding(.bottom, 26)
            }
        }
    }
}

/// "★ 8.0 · IMDb 8.1 · 2026 · фантастика · 2 ч 25 мин"
struct MetaLine: View {
    let title: CatalogTitle

    var body: some View {
        HStack(spacing: 7) {
            if let rating = title.rating, rating > 0 {
                Text("★ \(String(format: "%.1f", rating))")
                    .font(.cine(13, .semibold))
                    .foregroundStyle(Color.cineRating)
            }
            Text(parts.joined(separator: " · "))
                .font(.cine(13))
                .foregroundStyle(Color.cineTextSoft)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
    }

    private var parts: [String] {
        [
            title.imdbRating.map { "IMDb \(String(format: "%.1f", $0))" },
            title.year > 0 ? String(title.year) : nil,
            title.genres.first,
            title.isSeries ? (title.seasons.isEmpty ? "Сериал" : "\(title.seasons.count) сез.") : (title.runtimeLabel.isEmpty ? nil : title.runtimeLabel),
        ].compactMap { $0 }
    }
}

struct ContinueCard: View {
    let title: CatalogTitle
    let progress: CatalogProgressEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ZStack(alignment: .bottom) {
                BackdropArt(title: title)
                    .frame(width: 220, height: 124)
                    .clipped()
                Image(systemName: "play.fill")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Color.cineBackground.opacity(0.6))
                    .clipShape(Circle())
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                if progress.fraction > 0 {
                    ProgressStrip(fraction: progress.fraction)
                }
            }
            .frame(width: 220, height: 124)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            Text(title.title)
                .font(.cine(14, .medium))
                .foregroundStyle(.white)
                .lineLimit(1)
            Text(subtitle)
                .font(.cine(12))
                .foregroundStyle(Color.cineMuted)
                .lineLimit(1)
        }
        .frame(width: 220, alignment: .leading)
    }

    private var subtitle: String {
        if let position = progress.position, let duration = progress.duration, duration > 0 {
            let left = Int(max(duration - position, 0) / 60)
            return left >= 60 ? "Осталось \(left / 60) ч \(left % 60) мин" : "Осталось \(left) мин"
        }
        var parts: [String] = []
        if let season = progress.seasonNumber, let episode = progress.episodeNumber { parts.append("\(season) сезон, \(episode) серия") }
        if let provider = progress.providerId { parts.append(provider.capitalized) }
        if let voice = progress.translationName, !voice.isEmpty { parts.append(voice) }
        return parts.isEmpty ? title.shortMeta : parts.joined(separator: " · ")
    }
}

struct PosterShelf: View {
    let shelf: CatalogShelf

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ShelfHeader(title: shelf.title, subtitle: shelf.subtitle)
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(shelf.items) { title in
                        NavigationLink(value: title) { PosterCard(title: title) }
                            .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, CineMetrics.gutter)
            }
            .scrollIndicators(.hidden)
        }
    }
}
