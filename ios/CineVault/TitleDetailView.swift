import SwiftUI
import UIKit

private enum DetailTab: String, CaseIterable {
    case similar = "Похожие"
    case cast = "Актёры"
    case about = "О фильме"
}

struct TitleDetailView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let title: CatalogTitle

    @State private var fullTitle: CatalogTitle?
    @State private var detailError: String?
    @State private var isDescriptionExpanded = false
    @State private var tab: DetailTab = .similar
    @State private var similar: [CatalogTitle] = []
    @State private var season = 1
    @State private var isRequesting = false
    @State private var requestError: String?
    @State private var trailers: [Trailer] = []
    @State private var playingTrailer: Trailer?

    private var item: CatalogTitle { fullTitle ?? title }

    /// Server titles play through Lampac, found by their Kinopoisk, TMDB or IMDb id;
    /// the built-in open films keep their own direct file.
    private var canWatch: Bool {
        if !item.isServerTitle { return item.videoURL != nil }
        return item.kinopoiskID != nil || item.tmdbID != nil || !(item.imdbID ?? "").isEmpty
    }

    private var libraryEpisodes: [Episode] {
        store.episodes.filter {
            $0.titleID == title.id ||
            $0.title.localizedCaseInsensitiveCompare(title.title) == .orderedSame ||
            $0.originalTitle?.localizedCaseInsensitiveCompare(title.originalTitle) == .orderedSame
        }
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    hero(topInset: proxy.safeAreaInsets.top)
                    VStack(alignment: .leading, spacing: 16) {
                        TitleLogo(title: item, maxWidth: 240, maxHeight: 70, fontSize: 30)
                        metaRow
                        actions
                        detailNotice
                        description
                        if !item.genres.isEmpty {
                            FlowRow(items: item.genres) { GenrePill(text: $0) }
                        }
                        if item.isSeries { seasons }
                        if !item.isServerTitle && !canWatch { requestButton }
                        tabs
                    }
                    .padding(.horizontal, CineMetrics.gutter)
                    .padding(.top, -64)
                    .padding(.bottom, 32)
                }
                .frame(width: proxy.size.width)
            }
            .scrollIndicators(.hidden)
            .ignoresSafeArea(edges: .top)
        }
        .background(Color.cineBackground.ignoresSafeArea())
        .navigationBarBackButtonHidden()
        .toolbar(.hidden, for: .navigationBar)
        .task(id: title.id) { await load() }
    }

    // MARK: Hero

    private func hero(topInset: CGFloat) -> some View {
        ZStack(alignment: .top) {
            // Overlay keeps the fill-scaled backdrop from widening the column past the screen.
            Color.clear
                .frame(maxWidth: .infinity)
                .frame(height: 330 + topInset)
                .overlay { BackdropArt(title: item) }
                .clipped()
            LinearGradient(
                stops: [
                    .init(color: Color.cineBackground.opacity(0.5), location: 0),
                    .init(color: .clear, location: 0.3),
                    .init(color: Color.cineBackground.opacity(0.6), location: 0.7),
                    .init(color: Color.cineBackground, location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
            HStack(spacing: 10) {
                Button { dismiss() } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(CineOverlayButtonStyle())
                    .accessibilityLabel("Назад")
                Spacer()
                Button { store.toggleFavorite(item) } label: {
                    Image(systemName: store.isFavorite(item.id) ? "heart.fill" : "heart")
                }
                .buttonStyle(CineOverlayButtonStyle())
                .accessibilityLabel(store.isFavorite(item.id) ? "Убрать из избранного" : "В избранное")
                ShareLink(item: shareURL, subject: Text(item.title)) {
                    Image(systemName: "square.and.arrow.up")
                }
                .buttonStyle(CineOverlayButtonStyle())
                .accessibilityLabel("Поделиться")
            }
            .padding(.horizontal, 16)
            .padding(.top, topInset + 4)
        }
        .frame(height: 330 + topInset)
    }

    private var shareURL: URL {
        store.api.configuration.baseURL.appendingPathComponent("title/\(item.id)/")
    }

    private var metaRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                MetaLine(title: item)
                if !item.ageLabel.isEmpty {
                    Text(item.ageLabel)
                        .font(.cine(12))
                        .foregroundStyle(Color.cineTextSoft)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.2), lineWidth: 1))
                }
            }
            if !item.tagline.isEmpty {
                Text(item.tagline)
                    .font(.cine(14).italic())
                    .foregroundStyle(Color.cineMuted)
            }
        }
    }

    // MARK: Actions

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 10) {
            if canWatch {
                NavigationLink { playerDestination } label: {
                    Label(resumeLabel, systemImage: "play.fill")
                }
                .buttonStyle(CinePrimaryButtonStyle())
            }
            if let trailer = trailers.first {
                Button { playingTrailer = trailer } label: { Image(systemName: "film") }
                    .buttonStyle(CineIconButtonStyle())
                    .accessibilityLabel("Трейлер")
            }
            Button { store.toggleFavorite(item) } label: {
                Image(systemName: store.isFavorite(item.id) ? "checkmark" : "plus")
            }
            .buttonStyle(CineIconButtonStyle())
            .accessibilityLabel(store.isFavorite(item.id) ? "Убрать из избранного" : "В избранное")
        }
        .fullScreenCover(item: $playingTrailer) { TrailerPlayerView(trailer: $0) }
        if !item.nextAir.isEmpty {
            Text("Следующая серия: \(item.nextAir)").font(.cine(12)).foregroundStyle(Color.cineMuted)
        }
    }

    /// «Смотреть» goes on from where it stopped: the unfinished episode, or the one after a finished one.
    private var resumeLabel: String {
        if item.isSeries, let next = store.nextUp(item) {
            let record = store.catalogProgress[LampacProgress.key(item.id, season: next.season, episode: next.episode)]
            let resuming = (record?.position ?? 0) >= 15 && record?.completed != true
            return "\(resuming ? "Продолжить" : "Смотреть") · \(next.season) сез. \(next.episode) сер."
        }
        guard let progress = store.progress(forTitle: item.id), progress.completed != true, (progress.position ?? 0) >= 15 else { return "Смотреть" }
        return "Продолжить"
    }

    @ViewBuilder
    private var detailNotice: some View {
        if let detailError {
            Text("Карточка обновилась не полностью: \(detailError)")
                .font(.cine(12))
                .foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private var playerDestination: some View {
        if !item.isServerTitle, let raw = item.videoURL, let url = URL(string: raw) {
            CatalogExternalPlayerView(title: item, url: url)
                .modifier(PlayerFullscreenButton())
        } else if let next = store.nextUp(item) {
            LampacChooserView(title: item, season: next.season, episode: next.episode)
        } else {
            LampacChooserView(title: item)
        }
    }

    // MARK: Text

    @ViewBuilder
    private var description: some View {
        if !item.description.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.description)
                    .font(.cine(14))
                    .lineSpacing(3)
                    .foregroundStyle(Color.cineTextSoft)
                    .lineLimit(isDescriptionExpanded ? nil : 4)
                if item.description.count > 180 {
                    Button(isDescriptionExpanded ? "Свернуть" : "Ещё") {
                        withAnimation(.easeOut(duration: 0.2)) { isDescriptionExpanded.toggle() }
                    }
                    .font(.cine(14, .semibold))
                    .foregroundStyle(.white)
                }
            }
        }
    }

    // MARK: Seasons

    @ViewBuilder
    private var seasons: some View {
        if !item.seasons.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Сезоны")
                    .font(.cine(19, .semibold))
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(item.seasons.indices, id: \.self) { index in
                            CineChip(title: "Сезон \(index + 1)", isSelected: season == index + 1) { season = index + 1 }
                        }
                    }
                }
                .scrollIndicators(.hidden)
                let count = item.seasons.indices.contains(season - 1) ? item.seasons[season - 1] : 0
                let onServer = libraryEpisodes.filter { $0.season == season }.sorted { ($0.episode ?? 0) < ($1.episode ?? 0) }
                HStack {
                    Text(count > 0 ? "\(count) серий" : "Серии ещё не объявлены")
                        .font(.cine(13))
                        .foregroundStyle(Color.cineMuted)
                    Spacer()
                    if canWatch && item.isServerTitle && count > 0 {
                        NavigationLink { LampacChooserView(title: item, season: season) } label: {
                            Label("Серии \(season) сезона", systemImage: "list.bullet")
                                .font(.cine(13, .semibold))
                        }
                        .foregroundStyle(Color.cineAccent)
                    }
                }
                ForEach(onServer) { episode in EpisodeRow(episode: episode) }
                if !item.nextAir.isEmpty {
                    Text("Ближайшая серия: \(item.nextAir)").font(.cine(12)).foregroundStyle(Color.cineMuted)
                }
            }
        }
    }

    @ViewBuilder
    private var requestButton: some View {
        let requested = store.isCatalogTitleRequested(item)
        Button {
            isRequesting = true
            requestError = nil
            Task {
                do { try await store.requestCatalogTitle(item) } catch { requestError = error.localizedDescription }
                isRequesting = false
            }
        } label: {
            Label(requested ? "Запрос уже отправлен" : "Запросить добавление на сервер",
                  systemImage: requested ? "checkmark.circle" : "arrow.up.circle")
        }
        .buttonStyle(CineSecondaryButtonStyle())
        .disabled(requested || isRequesting)
        if let requestError {
            Text("Не удалось отправить: \(requestError)").font(.cine(12)).foregroundStyle(.orange)
        }
    }

    // MARK: Tabs

    private var tabs: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 22) {
                ForEach(DetailTab.allCases, id: \.self) { option in
                    Button {
                        tab = option
                    } label: {
                        Text(item.isSeries && option == .about ? "О сериале" : option.rawValue)
                            .font(.cine(15, tab == option ? .semibold : .medium))
                            .foregroundStyle(tab == option ? .white : Color.cineMuted)
                            .padding(.vertical, 10)
                            .overlay(alignment: .bottom) {
                                if tab == option { Rectangle().fill(Color.cineAccent).frame(height: 2) }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(tab == option ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            .overlay(alignment: .bottom) { Rectangle().fill(Color.cineLine).frame(height: 1) }

            switch tab {
            case .similar: similarRow
            case .cast: castList
            case .about: aboutTable
            }
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private var similarRow: some View {
        if similar.isEmpty {
            Text("Подбираю похожее…").font(.cine(13)).foregroundStyle(Color.cineMuted)
        } else {
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 10) {
                    ForEach(similar) { other in
                        NavigationLink(value: other) { PosterCard(title: other, width: 108) }
                            .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.hidden)
            .padding(.horizontal, -CineMetrics.gutter)
            .contentMargins(.horizontal, CineMetrics.gutter, for: .scrollContent)
        }
    }

    @ViewBuilder
    private var castList: some View {
        let people = item.directors.map { ($0, "Режиссёр") } + item.actors.prefix(15).map { ($0, "Актёр") }
        if people.isEmpty {
            Text("Сервер не прислал состав.").font(.cine(13)).foregroundStyle(Color.cineMuted)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(people.enumerated()), id: \.offset) { _, person in
                    HStack(spacing: 12) {
                        Text(initials(person.0))
                            .font(.cine(14, .semibold))
                            .frame(width: 42, height: 42)
                            .background(Color.cineSurface2)
                            .clipShape(Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text(person.0).font(.cine(15, .medium))
                            Text(person.1).font(.cine(12)).foregroundStyle(Color.cineMuted)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private var aboutTable: some View {
        let rows: [(String, String)] = [
            ("Оригинальное название", item.originalTitle == item.title ? "" : item.originalTitle),
            ("Год", item.year > 0 ? String(item.year) : ""),
            ("Страна", item.countries.joined(separator: ", ")),
            ("Режиссёр", item.directors.joined(separator: ", ")),
            ("Возраст", item.ageLabel),
            ("Хронометраж", item.runtimeLabel),
            ("Сезоны", item.isSeries ? item.seasonLabel : ""),
        ].filter { !$0.1.isEmpty }
        return VStack(spacing: 0) {
            ForEach(rows, id: \.0) { row in
                HStack(alignment: .top, spacing: 12) {
                    Text(row.0)
                        .font(.cine(13))
                        .foregroundStyle(Color.cineMuted)
                        .frame(width: 120, alignment: .leading)
                    Text(row.1)
                        .font(.cine(14))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(Color.cineLine).frame(height: 1) }
            }
        }
    }

    private func initials(_ name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined()
    }

    // MARK: Loading

    private func load() async {
        if title.isServerTitle {
            do {
                fullTitle = try await store.fetchTitle(title.id)
                detailError = nil
            } catch {
                detailError = error.localizedDescription
            }
        }
        async let similarTitles = TMDBService.shared.similar(item)
        async let found = TMDBService.shared.trailers(item)
        similar = await similarTitles
        trailers = await found
    }
}

/// Wraps pills onto as many lines as needed.
struct FlowRow<Item: Hashable, Content: View>: View {
    let items: [Item]
    @ViewBuilder let content: (Item) -> Content

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(items, id: \.self) { content($0) }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxX, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// Keeps the edge swipe back working on screens that draw their own back button.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}
