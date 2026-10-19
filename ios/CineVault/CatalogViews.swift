import SwiftUI

enum CatalogKind: String, CaseIterable, Hashable {
    case movies = "movie"
    case series = "series"
}

struct CatalogView: View {
    @EnvironmentObject private var store: AppStore
    @State private var kind: CatalogKind = .movies
    @State private var genre = ""
    @State private var sort = "rating"
    @State private var kindGenres: [String: Int] = [:]

    private var loadKey: String { "\(kind.rawValue)|\(genre)|\(sort)" }

    private var genreNames: [String] {
        kindGenres.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.map(\.key)
    }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 3)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    CineSegmented(options: [
                        (value: CatalogKind.movies, title: countLabel("Фильмы", store.catalogFacets?.movies)),
                        (value: CatalogKind.series, title: countLabel("Сериалы", store.catalogFacets?.series)),
                    ], selection: $kind)
                    .padding(.horizontal, CineMetrics.gutter)
                    genreChips
                    grid
                }
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .background(Color.cineBackground.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: CatalogTitle.self) { TitleDetailView(title: $0) }
            .task { await store.loadCatalogFacets() }
            .task(id: kind) {
                kindGenres = (try? await store.api.fetchCatalogFacets(kind: kind.rawValue))?.genres ?? [:]
                if kindGenres[genre] == nil { genre = "" }
            }
            .task(id: loadKey) { await loadPage(1) }
            .refreshable { await loadPage(1) }
        }
    }

    private var header: some View {
        HStack {
            Text("Каталог")
                .font(.cine(30, .semibold))
            Spacer()
            Menu {
                Picker("Сортировка", selection: $sort) {
                    Label("С высоким рейтингом", systemImage: "star").tag("rating")
                    Label("По числу оценок", systemImage: "chart.bar").tag("popular")
                    Label("Сначала новые", systemImage: "calendar").tag("new")
                    Label("По алфавиту", systemImage: "textformat.abc").tag("title")
                }
            } label: {
                Image(systemName: "line.3.horizontal.decrease")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.cineSurface)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.cineLine, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .accessibilityLabel("Сортировка")
        }
        .padding(.horizontal, CineMetrics.gutter)
    }

    private var genreChips: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                CineChip(title: "Все жанры", isSelected: genre.isEmpty) { genre = "" }
                ForEach(genreNames, id: \.self) { name in
                    CineChip(title: name, isSelected: genre == name) { genre = name }
                }
            }
            .padding(.horizontal, CineMetrics.gutter)
        }
        .scrollIndicators(.hidden)
    }

    @ViewBuilder
    private var grid: some View {
        if let error = store.catalogError, store.catalog.isEmpty {
            VStack(spacing: 12) {
                EmptyStateView(systemImage: "wifi.exclamationmark", title: "Каталог не загрузился", message: error)
                Button("Повторить") { Task { await loadPage(1) } }
                    .buttonStyle(CineSecondaryButtonStyle())
                    .padding(.horizontal, CineMetrics.gutter)
            }
        } else if store.catalog.isEmpty && !store.isCatalogLoading {
            EmptyStateView(systemImage: "film.stack", title: "Ничего не нашлось", message: "Попробуйте другой жанр.")
        } else {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(store.catalog) { title in
                    NavigationLink(value: title) { GridPoster(title: title) }
                        .buttonStyle(.plain)
                        .onAppear {
                            if title.id == store.catalog.last?.id { Task { await loadNextPage() } }
                        }
                }
            }
            .padding(.horizontal, CineMetrics.gutter)
            if store.isCatalogLoading {
                ProgressView().tint(.white).frame(maxWidth: .infinity).padding(.vertical, 16)
            }
        }
    }

    private func countLabel(_ title: String, _ count: Int?) -> String {
        guard let count, count > 0 else { return title }
        return "\(title) · \(count.formatted(.number.locale(Locale(identifier: "ru_RU"))))"
    }

    private func loadPage(_ page: Int) async {
        await store.loadCatalogPage(page, kind: kind.rawValue, genre: genre, sort: sort)
    }

    private func loadNextPage() async {
        guard !store.isCatalogLoading, store.catalogPage < store.catalogPages else { return }
        await loadPage(store.catalogPage + 1)
    }
}

struct GridPoster: View {
    let title: CatalogTitle

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            CatalogPosterArt(title: title)
                .aspectRatio(2 / 3, contentMode: .fit)
            Text(title.title)
                .font(.cine(12, .medium))
                .foregroundStyle(.white)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Search

struct SearchView: View {
    @EnvironmentObject private var store: AppStore
    @State private var query = ""
    @State private var filter = ""
    @State private var results: [CatalogTitle] = []
    @State private var total = 0
    @State private var isLoading = false
    @State private var errorMessage: String?
    @FocusState private var isFieldFocused: Bool

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                searchField
                if !trimmed.isEmpty {
                    HStack(spacing: 8) {
                        CineChip(title: total > 0 && filter.isEmpty ? "Всё · \(total)" : "Всё", isSelected: filter.isEmpty) { filter = "" }
                        CineChip(title: "Фильмы", isSelected: filter == "movie") { filter = "movie" }
                        CineChip(title: "Сериалы", isSelected: filter == "series") { filter = "series" }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, CineMetrics.gutter)
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        content
                    }
                    .padding(.horizontal, CineMetrics.gutter)
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.immediately)
            }
            .padding(.top, 8)
            .background(Color.cineBackground.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: CatalogTitle.self) { TitleDetailView(title: $0) }
            .task(id: "\(trimmed)|\(filter)") { await search() }
        }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.cineMuted)
                TextField("", text: $query, prompt: Text("Фильмы, сериалы, актёры").foregroundStyle(Color.cineMuted))
                    .font(.cine(16))
                    .foregroundStyle(.white)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($isFieldFocused)
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Color.cineSurface3)
                    }
                    .accessibilityLabel("Очистить")
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 48)
            .background(Color.cineSurface)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(isFieldFocused ? Color.cineAccent : Color.cineLine, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            if isFieldFocused {
                Button("Отмена") {
                    query = ""
                    isFieldFocused = false
                }
                .font(.cine(15, .medium))
                .foregroundStyle(Color.cineAccent)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.18), value: isFieldFocused)
        .padding(.horizontal, CineMetrics.gutter)
    }

    @ViewBuilder
    private var content: some View {
        if trimmed.isEmpty {
            let popular = store.homeShelves.first(where: { $0.id == "popular" })?.items ?? store.homeShelves.first?.items ?? []
            if popular.isEmpty {
                EmptyStateView(systemImage: "magnifyingglass", title: "Что посмотрим?", message: "Ищите по названию, актёру или режиссёру.")
            } else {
                Text("Часто смотрят")
                    .font(.cine(13, .semibold))
                    .foregroundStyle(Color.cineMuted)
                    .padding(.top, 4)
                ForEach(popular.prefix(10)) { title in
                    NavigationLink(value: title) { SearchResultRow(title: title) }.buttonStyle(.plain)
                }
            }
        } else if let errorMessage {
            EmptyStateView(systemImage: "wifi.exclamationmark", title: "Поиск не сработал", message: errorMessage)
        } else if results.isEmpty && !isLoading {
            EmptyStateView(systemImage: "film", title: "Ничего не нашлось", message: "Проверьте название или попробуйте оригинальное.")
        } else {
            ForEach(results) { title in
                NavigationLink(value: title) { SearchResultRow(title: title) }.buttonStyle(.plain)
            }
            if isLoading {
                ProgressView().tint(.white).frame(maxWidth: .infinity).padding(.vertical, 12)
            }
        }
    }

    private func search() async {
        guard !trimmed.isEmpty else {
            results = []
            total = 0
            errorMessage = nil
            return
        }
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard !Task.isCancelled else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let page = try await store.api.fetchCatalogPage(page: 1, search: trimmed, kind: filter, sort: "popular")
            guard !Task.isCancelled else { return }
            results = page.items.map(\.catalogTitle)
            total = page.total
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }
}

struct SearchResultRow: View {
    let title: CatalogTitle

    var body: some View {
        HStack(spacing: 14) {
            CatalogPosterArt(title: title, showsRating: false)
                .frame(width: 72, height: 108)
            VStack(alignment: .leading, spacing: 5) {
                Text(title.title)
                    .font(.cine(16, .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(meta)
                    .font(.cine(13))
                    .foregroundStyle(Color.cineMuted)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    if let rating = title.rating, rating > 0 {
                        Text("★ \(String(format: "%.1f", rating))")
                            .font(.cine(12, .semibold))
                            .foregroundStyle(Color.cineRating)
                    }
                    Text(title.kindLabel)
                        .font(.cine(12))
                        .foregroundStyle(Color.cineTextSoft)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Color.cineSurface2)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.cineMuted)
        }
        .contentShape(Rectangle())
    }

    private var meta: String {
        var parts: [String] = []
        if title.year > 0 { parts.append(String(title.year)) }
        if !title.genres.isEmpty { parts.append(title.genres.prefix(2).joined(separator: ", ")) }
        if title.isSeries, !title.seasons.isEmpty { parts.append("\(title.seasons.count) сез.") }
        return parts.joined(separator: " · ")
    }
}
