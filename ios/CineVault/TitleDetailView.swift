import SwiftUI
import UIKit

/// A player the viewer can pick on a title card, in the site's order:
/// CineVault first, then Alloha, then Collaps / Veoveo / Turbo.
private struct PlayerChoice: Identifiable, Hashable {
    enum Kind: Hashable { case cinevault, alloha, embed }

    let id: String
    let name: String
    let kind: Kind
    let voices: [VoiceChoice]
    /// Voices an embed lists but lets the viewer pick only inside itself.
    var embedVoices: [String] = []
}

private struct VoiceChoice: Identifiable, Hashable {
    let id: String
    let name: String
}

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
    @State private var providers: [ExternalPlayerProvider] = []
    @State private var isLoadingPlayers = false
    @State private var selectedPlayerID: String?
    @State private var selectedVoiceID: String?
    @State private var isDescriptionExpanded = false
    @State private var tab: DetailTab = .similar
    @State private var similar: [CatalogTitle] = []
    @State private var season = 1
    @State private var isRequesting = false
    @State private var requestError: String?

    private var item: CatalogTitle { fullTitle ?? title }

    private var choices: [PlayerChoice] {
        var result: [PlayerChoice] = []
        let sources = item.playbackSources.filter { store.api.playbackURL(for: $0.url) != nil }
        if !sources.isEmpty {
            let voices = sources.enumerated().map { index, source in
                VoiceChoice(id: source.id, name: source.label.isEmpty ? "Вариант \(index + 1)" : source.label)
            }
            result.append(PlayerChoice(id: "cinevault", name: "CineVault", kind: .cinevault, voices: voices))
        } else if !item.isServerTitle, item.videoURL != nil {
            result.append(PlayerChoice(id: "cinevault", name: "CineVault", kind: .cinevault, voices: []))
        }
        for provider in providers {
            if provider.id == "alloha" {
                let voices = provider.translations.map {
                    VoiceChoice(id: $0.id, name: [$0.name, $0.quality].filter { !$0.isEmpty }.joined(separator: " · "))
                }
                if !voices.isEmpty {
                    result.append(PlayerChoice(id: "alloha", name: "Alloha", kind: .alloha, voices: voices))
                }
            } else if provider.embedURL != nil {
                result.append(PlayerChoice(id: provider.id, name: provider.name, kind: .embed, voices: [], embedVoices: provider.voices))
            }
        }
        return result
    }

    private var selectedChoice: PlayerChoice? {
        choices.first { $0.id == selectedPlayerID } ?? choices.first
    }

    private var selectedVoice: VoiceChoice? {
        guard let selectedChoice else { return nil }
        return selectedChoice.voices.first { $0.id == selectedVoiceID } ?? selectedChoice.voices.first
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
                        playerPickers
                        description
                        if !item.genres.isEmpty {
                            FlowRow(items: item.genres) { GenrePill(text: $0) }
                        }
                        if item.isSeries { seasons }
                        if !item.isServerTitle && choices.isEmpty { requestButton }
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
            if selectedChoice != nil {
                NavigationLink { playerDestination } label: {
                    Label(resumeLabel, systemImage: "play.fill")
                }
                .buttonStyle(CinePrimaryButtonStyle())
            } else if isLoadingPlayers {
                Button {} label: {
                    HStack(spacing: 8) {
                        ProgressView().tint(.white)
                        Text("Ищу плееры…")
                    }
                }
                .buttonStyle(CinePrimaryButtonStyle())
                .disabled(true)
            } else {
                Button { Task { await loadPlayers() } } label: {
                    Label("Нет плееров · обновить", systemImage: "arrow.clockwise")
                }
                .buttonStyle(CineSecondaryButtonStyle())
            }
            Button { store.toggleFavorite(item) } label: {
                Label(store.isFavorite(item.id) ? "В избранном" : "В избранное",
                      systemImage: store.isFavorite(item.id) ? "checkmark" : "plus")
            }
            .buttonStyle(CineSecondaryButtonStyle())
        }
    }

    private var resumeLabel: String {
        guard let progress = store.progress(forTitle: item.id), progress.completed != true else { return "Смотреть" }
        return "Продолжить"
    }

    @ViewBuilder
    private var playerPickers: some View {
        let options = choices
        if let current = selectedChoice, options.count > 1 || !current.voices.isEmpty {
            HStack(spacing: 10) {
                Menu {
                    ForEach(options) { choice in
                        Button {
                            selectedPlayerID = choice.id
                            selectedVoiceID = nil
                        } label: {
                            if choice.id == current.id { Label(choice.name, systemImage: "checkmark") } else { Text(choice.name) }
                        }
                    }
                } label: {
                    PickerCard(caption: "Плеер", value: current.name)
                }
                if current.kind == .embed {
                    PickerCard(caption: "Озвучка", value: "В плеере", showsChevron: false)
                } else if !current.voices.isEmpty {
                    Menu {
                        ForEach(current.voices) { voice in
                            Button {
                                selectedVoiceID = voice.id
                            } label: {
                                if voice.id == selectedVoice?.id { Label(voice.name, systemImage: "checkmark") } else { Text(voice.name) }
                            }
                        }
                    } label: {
                        PickerCard(caption: "Озвучка", value: selectedVoice?.name ?? "—")
                    }
                }
            }
        }
        if let detailError {
            Text("Карточка обновилась не полностью: \(detailError)")
                .font(.cine(12))
                .foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private var playerDestination: some View {
        if let choice = selectedChoice {
            Group {
                switch choice.kind {
                case .cinevault:
                    if let source = item.playbackSources.first(where: { $0.id == selectedVoice?.id }) ?? item.playbackSources.first {
                        CatalogFreshPlayerView(title: item, source: source)
                    } else if let raw = item.videoURL, let url = URL(string: raw) {
                        CatalogExternalPlayerView(title: item, url: url)
                    }
                case .alloha:
                    CatalogAllohaPlayerView(title: item, preferredTranslation: providers
                        .first(where: { $0.id == "alloha" })?.translations
                        .first(where: { $0.id == selectedVoice?.id })?.name ?? "")
                case .embed:
                    if let provider = providers.first(where: { $0.id == choice.id }) {
                        EmbedProviderPlayerView(title: item, provider: provider)
                    }
                }
            }
            .modifier(PlayerFullscreenButton())
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
                Text(count > 0 ? "\(count) серий · выберите серию в плеере" : "Серии ещё не объявлены")
                    .font(.cine(13))
                    .foregroundStyle(Color.cineMuted)
                ForEach(onServer) { episode in EpisodeRow(episode: episode) }
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
                fullTitle = try await store.api.fetchCatalogTitle(id: title.id)
                detailError = nil
            } catch {
                detailError = error.localizedDescription
            }
        }
        async let players: Void = loadPlayers()
        async let others: Void = loadSimilar()
        _ = await (players, others)
    }

    private func loadPlayers() async {
        guard let kinopoiskID = item.kinopoiskID else { return }
        isLoadingPlayers = true
        defer { isLoadingPlayers = false }
        providers = (try? await store.api.fetchPlayerOptions(kinopoiskID: kinopoiskID).providers) ?? []
        // Reopen the player the viewer used last time, on this iPhone or on the site.
        if selectedPlayerID == nil, let last = store.progress(forTitle: item.id) {
            let lastID = last.providerId ?? last.player?.replacingOccurrences(of: "embed:", with: "")
            if let match = choices.first(where: { $0.id == lastID }) {
                selectedPlayerID = match.id
                if let voice = last.translationName {
                    selectedVoiceID = match.voices.first { $0.name.hasPrefix(voice) }?.id
                }
            }
        }
    }

    private func loadSimilar() async {
        guard let genre = item.genres.first else { return }
        let page = try? await store.api.fetchCatalogPage(page: 1, kind: item.kind, genre: genre, sort: "popular")
        similar = (page?.items.map(\.catalogTitle) ?? []).filter { $0.id != item.id }.prefix(12).map { $0 }
    }
}

private struct PickerCard: View {
    let caption: String
    let value: String
    var showsChevron = true

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(caption).font(.cine(11)).foregroundStyle(Color.cineMuted)
                Text(value).font(.cine(14, .medium)).foregroundStyle(.white).lineLimit(1)
            }
            Spacer(minLength: 4)
            if showsChevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.cineMuted)
            }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: 56)
        .background(Color.cineSurface)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.cineLine, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .contentShape(Rectangle())
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
