import SwiftUI

private enum MineSection: Hashable {
    case favorites, history
}

struct MineView: View {
    @EnvironmentObject private var store: AppStore
    @State private var section: MineSection = .favorites
    @State private var isSettingsPresented = false

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 3)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("Моё").font(.cine(30, .semibold))
                        Spacer()
                        Button { isSettingsPresented = true } label: {
                            Image(systemName: "gearshape")
                                .font(.system(size: 18, weight: .medium))
                                .foregroundStyle(.white)
                                .frame(width: 44, height: 44)
                                .background(Color.cineSurface)
                                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.cineLine, lineWidth: 1))
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                        }
                        .accessibilityLabel("Настройки")
                    }
                    CineSegmented(options: [
                        (value: MineSection.favorites, title: store.favorites.isEmpty ? "Избранное" : "Избранное · \(store.favorites.count)"),
                        (value: MineSection.history, title: "История"),
                    ], selection: $section)
                    switch section {
                    case .favorites: favorites
                    case .history: history
                    }
                }
                .padding(.horizontal, CineMetrics.gutter)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .background(Color.cineBackground.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: CatalogTitle.self) { TitleDetailView(title: $0) }
            .refreshable { await store.loadCatalogProgress() }
            .sheet(isPresented: $isSettingsPresented) { SettingsView() }
        }
    }

    @ViewBuilder
    private var favorites: some View {
        if store.favorites.isEmpty {
            EmptyStateView(systemImage: "heart", title: "Здесь будет избранное", message: "Нажмите «В избранное» на карточке фильма или сериала.")
        } else {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(store.favorites) { favorite in
                    NavigationLink(value: favorite.catalogTitle) { GridPoster(title: favorite.catalogTitle) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Убрать из избранного", systemImage: "heart.slash", role: .destructive) {
                                store.toggleFavorite(favorite.catalogTitle)
                            }
                        }
                }
            }
        }
    }

    @ViewBuilder
    private var history: some View {
        let items = store.watchedTitles.compactMap { title in
            store.progress(forTitle: title.id).map { (title: title, progress: $0) }
        }
        if items.isEmpty {
            EmptyStateView(systemImage: "clock", title: "История пуста", message: "Здесь появится всё, что вы начали смотреть — на iPhone или на сайте.")
        } else {
            LazyVStack(alignment: .leading, spacing: 4) {
                ForEach(items, id: \.title.id) { item in
                    NavigationLink(value: item.title) {
                        HistoryRow(title: item.title, progress: item.progress)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct HistoryRow: View {
    let title: CatalogTitle
    let progress: CatalogProgressEntry

    var body: some View {
        HStack(spacing: 14) {
            ZStack(alignment: .bottom) {
                BackdropArt(title: title)
                    .frame(width: 150, height: 84)
                    .clipped()
                if progress.fraction > 0 { ProgressStrip(fraction: progress.fraction) }
            }
            .frame(width: 150, height: 84)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 4) {
                Text(title.title)
                    .font(.cine(15, .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                Text([title.kindLabel, title.year > 0 ? String(title.year) : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.cine(12))
                    .foregroundStyle(Color.cineMuted)
                Text(status)
                    .font(.cine(12))
                    .foregroundStyle(Color.cineAccent)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private var status: String {
        if progress.completed == true { return "Досмотрено" }
        if let position = progress.position, let duration = progress.duration, duration > 0 {
            let left = Int(max(duration - position, 0) / 60)
            return left >= 60 ? "Осталось \(left / 60) ч \(left % 60) мин" : "Осталось \(left) мин"
        }
        let date = Date(timeIntervalSince1970: TimeInterval(progress.updatedAt) / 1000)
        let when = date.formatted(.relative(presentation: .named).locale(Locale(identifier: "ru_RU")))
        let player = progress.providerId?.capitalized ?? "CineVault"
        return "\(player) · \(when)"
    }
}
