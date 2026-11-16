import SwiftUI
import AVKit

// MARK: - Lampac

/// The Lampac server that finds a title on many sources and returns seasons, voices
/// and direct streams; the app draws the choice and plays the stream in AVPlayer,
/// as the website does. Its address and the device id come from Secrets.xcconfig.
struct LampacClient {
    let origin: URL
    let uid: String

    /// Set from the server's /config.local.js at launch; the build's own values until then.
    nonisolated(unsafe) static var shared: LampacClient? = {
        let host = (Bundle.main.object(forInfoDictionaryKey: "CineVaultLampacHost") as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let uid = (Bundle.main.object(forInfoDictionaryKey: "CineVaultLampacUID") as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, let origin = URL(string: "https://\(host)") else { return nil }
        return LampacClient(origin: origin, uid: uid)
    }()

    /// The client once the server's config has come (it is asked at launch; asked again here if that failed).
    static func ready() async -> LampacClient? {
        if let config = try? await TMDBService.shared.siteConfig(), !config.lampacOrigin.isEmpty, let origin = URL(string: config.lampacOrigin) {
            shared = LampacClient(origin: origin, uid: config.lampacUID)
        }
        return shared
    }

    /// Lampac lets in only known device ids: its own /lite and /lifeevents links get the uid.
    func withUID(_ raw: String) -> URL? {
        guard !raw.isEmpty, var components = URLComponents(string: URL(string: raw, relativeTo: origin)?.absoluteString ?? "") else { return nil }
        if !uid.isEmpty, components.host == origin.host,
           components.path.hasPrefix("/lite") || components.path.hasPrefix("/lifeevents"),
           !(components.queryItems ?? []).contains(where: { $0.name == "uid" }) {
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "uid", value: uid)]
        }
        return components.url
    }

    func json(_ raw: String, timeout: TimeInterval = 15) async throws -> Any? {
        guard let url = withUID(raw), var components = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return nil }
        var items = (components.queryItems ?? []).filter { $0.name != "rjson" }
        items.append(URLQueryItem(name: "rjson", value: "true"))
        components.queryItems = items
        guard let target = components.url else { return nil }
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CineVaultAPIError.server(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "Lampac не ответил")
        }
        return try? JSONSerialization.jsonObject(with: data)
    }

    func query(for title: CatalogTitle) -> [URLQueryItem] {
        var items = [
            URLQueryItem(name: "kinopoisk_id", value: title.kinopoiskID.map(String.init) ?? ""),
            URLQueryItem(name: "title", value: title.title),
            URLQueryItem(name: "original_title", value: title.originalTitle.isEmpty ? title.title : title.originalTitle),
            URLQueryItem(name: "year", value: title.year > 0 ? String(title.year) : ""),
            URLQueryItem(name: "serial", value: title.isSeries ? "1" : "0"),
        ]
        if let imdb = title.imdbID, !imdb.isEmpty { items.append(URLQueryItem(name: "imdb_id", value: imdb)) }
        if let tmdb = title.tmdbID { items.append(URLQueryItem(name: "id", value: String(tmdb))) }
        return items
    }

    private func queryString(for title: CatalogTitle) -> String {
        var components = URLComponents()
        components.queryItems = query(for: title)
        return components.percentEncodedQuery ?? ""
    }

    /// The list of sources as Lampa gets it: "life" mode answers at once with a key, then
    /// /lifeevents hands over every source the moment it is found. Falls back to the one-shot list.
    func sources(for title: CatalogTitle, onEntries: @escaping @MainActor ([[String: Any]]) -> Void,
                 onProgress: @escaping @MainActor (Int, Int) -> Void) async -> Int {
        let query = queryString(for: title)
        var seen = Set<String>()
        func hand(_ entries: [[String: Any]]) async {
            let fresh = entries.filter { entry in
                let id = String(describing: entry["balanser"] ?? entry["name"] ?? entry["url"] ?? "")
                if (entry["show"] as? Bool) == false || seen.contains(id) { return false }
                seen.insert(id)
                return true
            }
            if !fresh.isEmpty { await onEntries(fresh) }
        }
        func online(_ answer: Any?) -> [[String: Any]] {
            if let list = answer as? [[String: Any]] { return list }
            return (answer as? [String: Any])?["online"] as? [[String: Any]] ?? []
        }
        if let start = try? await json("/lite/events?\(query)&life=true", timeout: 10) {
            if let memkey = (start as? [String: Any])?["memkey"] as? String {
                let deadline = Date().addingTimeInterval(25)
                var delay = 0.3
                while Date() < deadline, !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    delay = min(1.2, delay + 0.25)
                    let key = memkey.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? memkey
                    guard let answer = try? await json("/lifeevents?memkey=\(key)&\(query)", timeout: 10) else { continue }
                    let list = online(answer)
                    await hand(list)
                    if let info = answer as? [String: Any] {
                        if let tasks = info["tasks"] as? Int, tasks > 0 { await onProgress(min(list.count, tasks), tasks) }
                        if (info["ready"] as? Bool) == true { break }
                    }
                }
                if !seen.isEmpty || Task.isCancelled { return seen.count }
            } else {
                await hand(online(start))
                if !seen.isEmpty { return seen.count }
            }
        }
        if Task.isCancelled { return seen.count }
        await hand(online(try? await json("/lite/events?\(query)&life=false", timeout: 30)))
        return seen.count
    }

    /// A source answers with the title itself or with look-alikes; a look-alike is
    /// taken only when its year matches, never guessed.
    func resolve(_ raw: String, title: CatalogTitle) async -> LampacNode? {
        var node = LampacNode(try? await json(raw, timeout: 10))
        var hops = 0
        while let current = node, current.type == "similar", hops < 2 {
            hops += 1
            let year = title.year > 0 ? String(title.year) : ""
            guard !year.isEmpty,
                  let match = current.data.first(where: { LampacNode.text($0["year"]) == year }),
                  let url = match["url"] as? String else { return nil }
            node = LampacNode(try? await json(url, timeout: 10))
        }
        guard let node, ["movie", "season", "episode"].contains(node.type), !node.data.isEmpty else { return nil }
        return node
    }

    /// "play" carries the link itself; "call" has to be asked and answers with every quality.
    func stream(_ entry: [String: Any]) async -> LampacStream {
        func pack(_ source: [String: Any]) -> LampacStream {
            var qualities: [String: URL] = [:]
            for (label, link) in source["quality"] as? [String: Any] ?? [:] {
                if let link = link as? String, let url = withUID(link) { qualities[label] = url }
            }
            return LampacStream(url: withUID(source["url"] as? String ?? ""), qualities: qualities)
        }
        if (entry["method"] as? String) == "play" { return pack(entry) }
        if let url = entry["url"] as? String, let answer = try? await json(url) as? [String: Any], answer["url"] is String {
            return pack(answer)
        }
        return LampacStream(url: withUID(entry["stream"] as? String ?? ""), qualities: [:])
    }

    /// Quality as a line count: "1080p" -> 1080, "4K" -> 2160.
    static func lines(_ label: String) -> Int {
        if label.range(of: "4k|uhd", options: [.regularExpression, .caseInsensitive]) != nil { return 2160 }
        if label.range(of: "2k", options: .caseInsensitive) != nil { return 1440 }
        guard let match = label.range(of: "\\d{3,4}", options: .regularExpression) else { return 0 }
        return Int(label[match]) ?? 0
    }
}

struct LampacNode {
    let type: String
    let data: [[String: Any]]
    let voices: [[String: Any]]

    init?(_ json: Any?) {
        guard let object = json as? [String: Any], let type = object["type"] as? String else { return nil }
        self.type = type
        data = object["data"] as? [[String: Any]] ?? []
        voices = object["voice"] as? [[String: Any]] ?? []
    }

    static func text(_ value: Any?) -> String {
        switch value {
        case let string as String: return string
        case let number as NSNumber: return number.stringValue
        default: return ""
        }
    }

    static func number(_ entry: [String: Any], fallback: Int) -> Int {
        for key in ["s", "id"] {
            if let value = Int(text(entry[key])), value > 0 { return value }
        }
        let name = text(entry["name"])
        if let match = name.range(of: "\\d+", options: .regularExpression), let value = Int(name[match]), value > 0 { return value }
        return fallback
    }
}

struct LampacStream {
    let url: URL?
    let qualities: [String: URL]

    /// The best stream up to 1080p by default: 4K files are heavy for a phone on mobile data.
    func preferred(maxLines: Int = 1080) -> (label: String, url: URL)? {
        let ranked = qualities.map { (label: $0.key, url: $0.value, lines: LampacClient.lines($0.key)) }
            .sorted { $0.lines > $1.lines }
        if let pick = ranked.first(where: { $0.lines <= maxLines && $0.lines > 0 }) ?? ranked.last {
            return (pick.label, pick.url)
        }
        return url.map { ("Авто", $0) }
    }
}

/// Source and voice are remembered per title, as in Lampa; the last choice anywhere
/// is the fallback for a title opened for the first time.
enum LampacChoiceStore {
    private static let key = "cinevault.lampacChoice"

    static func choice(for titleID: String) -> (source: String, voice: String) {
        let store = UserDefaults.standard.dictionary(forKey: key) ?? [:]
        if let own = (store["titles"] as? [String: [String: String]])?[titleID] {
            return (own["source"] ?? "", own["voice"] ?? "")
        }
        return (store["source"] as? String ?? "", store["voice"] as? String ?? "")
    }

    static func remember(source: String? = nil, voice: String? = nil, titleID: String) {
        var store = UserDefaults.standard.dictionary(forKey: key) ?? [:]
        var titles = store["titles"] as? [String: [String: String]] ?? [:]
        var own = titles[titleID] ?? [:]
        if let source { store["source"] = source; own["source"] = source }
        if let voice { store["voice"] = voice; own["voice"] = voice }
        titles[titleID] = own
        if titles.count > 500 { titles.removeValue(forKey: titles.keys.first { $0 != titleID } ?? "") }
        store["titles"] = titles
        UserDefaults.standard.set(store, forKey: key)
    }
}

// MARK: - Choice: source, voice, season, episode

private struct LampacSource: Identifiable {
    let id: String
    let name: String
    let node: LampacNode
    var lines = 0
}

private struct LampacPick: Identifiable {
    let id = UUID()
    let entry: [String: Any]
    let label: String
    let note: String
    let season: Int?
    let episode: Int?
}

/// What the player needs to start: the chosen entry, where it sits, and what comes next.
struct LampacPlayRequest: Identifiable {
    let id = UUID()
    let entry: [String: Any]
    let voice: String
    let source: String
    let season: Int?
    let episode: Int?
    let next: [LampacPlayRequest]
}

struct LampacChooserView: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    var season: Int?
    var episode: Int?

    @State private var sources: [LampacSource] = []
    /// Sources Lampac listed that are still looking for the title: shown dimmed at once.
    @State private var pending: [(id: String, name: String)] = []
    @State private var activeID = ""
    @State private var status = "Ищу источники…"
    @State private var searching = true
    @State private var finished = false
    @State private var progress: (done: Int, total: Int) = (0, 0)
    @State private var node: LampacNode?
    @State private var seasons: [[String: Any]] = []
    @State private var seasonNumber = 1
    @State private var loading = false
    @State private var touched = false
    @State private var playing: LampacPlayRequest?
    @State private var searchTask: Task<Void, Never>?

    private var client: LampacClient? { LampacClient.shared }
    private var saved: (source: String, voice: String) { LampacChoiceStore.choice(for: title.id) }
    private var activeName: String { sources.first { $0.id == activeID }?.name ?? "" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if !sources.isEmpty || !pending.isEmpty { sourceChips }
                if searching || !status.isEmpty { statusLine }
                content
            }
            .padding(.horizontal, CineMetrics.gutter)
            .padding(.vertical, 16)
        }
        .background(Color.cineBackground.ignoresSafeArea())
        .navigationTitle("Где смотреть")
        .navigationBarTitleDisplayMode(.inline)
        .modifier(HideTabBarWhileVisible())
        .task(id: title.id) { start() }
        .onDisappear { searchTask?.cancel() }
        .fullScreenCover(item: $playing) { request in
            LampacPlayerView(title: title, request: request)
                .environmentObject(store)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.title).font(.cine(22, .semibold))
            if title.year > 0 {
                Text([String(title.year), title.kindLabel].joined(separator: " · "))
                    .font(.cine(13)).foregroundStyle(Color.cineMuted)
            }
        }
    }

    private var sourceChips: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(sources) { source in
                    let quality = source.lines > 0 ? " · \(Self.qualityLabel(source.lines))" : ""
                    CineChip(title: source.name + quality, isSelected: source.id == activeID) {
                        touched = true
                        select(source.id)
                    }
                }
                ForEach(pending, id: \.id) { source in
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini).tint(Color.cineMuted)
                        Text(source.name).font(.cine(13, .medium)).lineLimit(1)
                    }
                    .foregroundStyle(Color.cineMuted)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 34)
                    .overlay(Capsule().stroke(Color.white.opacity(0.08), lineWidth: 1))
                    .accessibilityLabel("\(source.name): проверяю")
                }
            }
        }
        .scrollIndicators(.hidden)
        .padding(.horizontal, -CineMetrics.gutter)
        .contentMargins(.horizontal, CineMetrics.gutter, for: .scrollContent)
    }

    private var statusLine: some View {
        HStack(spacing: 8) {
            if searching || loading { ProgressView().tint(.white) }
            Text(statusText).font(.cine(13)).foregroundStyle(Color.cineMuted)
        }
    }

    private var statusText: String {
        if !status.isEmpty { return status }
        let counted = progress.total > 0 ? ", проверено \(progress.done) из \(progress.total)" : ""
        return sources.isEmpty ? "Проверяю источники\(counted)…" : "Ищу ещё источники… найдено \(sources.count)\(counted)"
    }

    @ViewBuilder
    private var content: some View {
        if client == nil && finished {
            ContentUnavailableView("Источники недоступны", systemImage: "play.slash",
                                   description: Text("Сервер не прислал адрес Lampac. Проверьте интернет и повторите."))
        } else if let node, !loading {
            if node.type == "movie" {
                movieList(node)
            } else if node.type == "episode" {
                episodeList(node)
            }
        } else if finished && sources.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Ни один источник пока не нашёл «\(title.title)». Новинки обычно появляются в течение нескольких дней.")
                    .font(.cine(14)).foregroundStyle(Color.cineTextSoft)
                Button("Повторить") { start() }.buttonStyle(CineSecondaryButtonStyle())
            }
        }
    }

    private func movieList(_ node: LampacNode) -> some View {
        let picks = node.data.enumerated().map { index, entry in
            LampacPick(entry: entry,
                       label: Self.firstText(entry, ["translate", "title"]) ?? "Вариант \(index + 1)",
                       note: Array(Set([LampacNode.text(entry["maxquality"]), LampacNode.text(entry["voice_name"])].filter { !$0.isEmpty })).sorted().joined(separator: " · "),
                       season: nil, episode: nil)
        }
        let remembered = picks.firstIndex { $0.label == saved.voice } ?? 0
        let resume = resumeNote(season: nil, episode: nil)
        return VStack(alignment: .leading, spacing: 10) {
            if !picks.isEmpty {
                Button { play(picks, index: remembered, voice: picks[remembered].label) } label: {
                    Label("\(resume.isEmpty || resume == "Просмотрено" ? "Смотреть" : "Продолжить") · \(picks[remembered].label)", systemImage: "play.fill")
                }
                .buttonStyle(CinePrimaryButtonStyle())
                if !resume.isEmpty { Text(resume).font(.cine(12)).foregroundStyle(Color.cineMuted) }
            }
            Text("Озвучка").font(.cine(13, .semibold)).foregroundStyle(Color.cineMuted).padding(.top, 6)
            ForEach(Array(picks.enumerated()), id: \.element.id) { index, pick in
                Button { play(picks, index: index, voice: pick.label) } label: {
                    LampacRow(title: pick.label, note: pick.note, isCurrent: index == remembered)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func episodeList(_ node: LampacNode) -> some View {
        let activeVoice = node.voices.first { ($0["active"] as? Bool) == true }.map { LampacNode.text($0["name"]) } ?? ""
        let picks = node.data.enumerated().map { index, entry -> LampacPick in
            let s = Int(LampacNode.text(entry["s"])) ?? seasonNumber
            let e = Int(LampacNode.text(entry["e"])) ?? index + 1
            return LampacPick(entry: entry, label: LampacNode.text(entry["name"]).isEmpty ? "\(e) серия" : LampacNode.text(entry["name"]),
                              note: resumeNote(season: s, episode: e), season: s, episode: e)
        }
        let start = startIndex(picks)
        return VStack(alignment: .leading, spacing: 10) {
            if picks.indices.contains(start) {
                let pick = picks[start]
                let resuming = !pick.note.isEmpty && pick.note != "Просмотрено"
                Button { play(picks, index: start, voice: activeVoice) } label: {
                    Label("\(resuming ? "Продолжить" : "Смотреть") · \(pick.season ?? seasonNumber) сезон, \(pick.episode ?? 1) серия", systemImage: "play.fill")
                }
                .buttonStyle(CinePrimaryButtonStyle())
            }
            if !node.voices.isEmpty {
                Text("Озвучка").font(.cine(13, .semibold)).foregroundStyle(Color.cineMuted).padding(.top, 6)
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(Array(node.voices.enumerated()), id: \.offset) { _, voice in
                            let name = LampacNode.text(voice["name"])
                            CineChip(title: name, isSelected: (voice["active"] as? Bool) == true) {
                                touched = true
                                LampacChoiceStore.remember(voice: name, titleID: title.id)
                                if let url = voice["url"] as? String { Task { await load(url) } }
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
            if seasons.count > 1 {
                Text("Сезон").font(.cine(13, .semibold)).foregroundStyle(Color.cineMuted).padding(.top, 6)
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(Array(seasons.enumerated()), id: \.offset) { index, entry in
                            let number = LampacNode.number(entry, fallback: index + 1)
                            CineChip(title: "\(number) сезон", isSelected: number == seasonNumber) {
                                touched = true
                                seasonNumber = number
                                if let url = entry["url"] as? String { Task { await load(url) } }
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
            Text("Серии").font(.cine(13, .semibold)).foregroundStyle(Color.cineMuted).padding(.top, 6)
            ForEach(Array(picks.enumerated()), id: \.element.id) { index, pick in
                Button { play(picks, index: index, voice: activeVoice) } label: {
                    LampacRow(title: pick.label, note: pick.note, isCurrent: index == start)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Logic

    private func resumeNote(season: Int?, episode: Int?) -> String {
        guard let record = store.catalogProgress[LampacProgress.key(title.id, season: season, episode: episode)],
              let duration = record.duration, duration > 0 else { return "" }
        if record.completed == true { return "Просмотрено" }
        let position = record.position ?? 0
        return position < 15 ? "" : "Остановились на \(LampacProgress.time(position))"
    }

    private func startIndex(_ picks: [LampacPick]) -> Int {
        let progress = store.progress(forTitle: title.id)
        let wantSeason = season ?? progress?.seasonNumber ?? seasonNumber
        let wantEpisode = episode ?? progress?.episodeNumber ?? 0
        guard var index = picks.firstIndex(where: { $0.season == wantSeason && $0.episode == wantEpisode }) else { return 0 }
        if store.catalogProgress[LampacProgress.key(title.id, season: wantSeason, episode: wantEpisode)]?.completed == true,
           picks.indices.contains(index + 1) { index += 1 }
        return index
    }

    private func play(_ picks: [LampacPick], index: Int, voice: String) {
        LampacChoiceStore.remember(source: activeID, voice: voice, titleID: title.id)
        let requests = picks.map {
            LampacPlayRequest(entry: $0.entry, voice: voice, source: activeName, season: $0.season, episode: $0.episode, next: [])
        }
        let current = requests[index]
        playing = LampacPlayRequest(entry: current.entry, voice: voice, source: activeName, season: current.season,
                                    episode: current.episode, next: current.season == nil ? [] : Array(requests.dropFirst(index + 1)))
    }

    private func start() {
        searchTask?.cancel()
        sources = []
        pending = []
        activeID = ""
        node = nil
        status = ""
        searching = true
        finished = false
        progress = (0, 0)
        seasonNumber = season ?? store.progress(forTitle: title.id)?.seasonNumber ?? 1
        let title = self.title
        searchTask = Task {
            guard let client = await LampacClient.ready() else { searching = false; finished = true; return }
            let lookups = LampacTaskBag()
            let found = await client.sources(for: title, onEntries: { entries in
                for entry in entries {
                    let id = LampacNode.text(entry["balanser"] ?? entry["name"] ?? entry["url"])
                    let name = LampacNode.text(entry["name"])
                    pending.append((id, name.isEmpty ? id : name))
                    lookups.tasks.append(Task { await lookup(entry, client: client) })
                }
            }, onProgress: { done, total in progress = (done, total) })
            for task in lookups.tasks { await task.value }
            guard !Task.isCancelled else { lookups.tasks.forEach { $0.cancel() }; return }
            pending = []
            searching = false
            finished = true
            status = found == 0 ? "Сервер с источниками не отвечает." : ""
        }
    }

    private func lookup(_ entry: [String: Any], client: LampacClient) async {
        let id = LampacNode.text(entry["balanser"] ?? entry["name"] ?? entry["url"])
        defer { Task { @MainActor in pending.removeAll { $0.id == id } } }
        guard let raw = entry["url"] as? String, let base = URL(string: raw, relativeTo: client.origin),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: true) else { return }
        var items = components.queryItems ?? []
        for item in client.query(for: title) where !items.contains(where: { $0.name == item.name }) { items.append(item) }
        components.queryItems = items
        guard let url = components.url, let node = await client.resolve(url.absoluteString, title: title), !Task.isCancelled else { return }
        await MainActor.run {
            sources.append(LampacSource(id: id, name: LampacNode.text(entry["name"]).isEmpty ? id : LampacNode.text(entry["name"]), node: node,
                                        lines: Self.bestLines(node)))
            if activeID.isEmpty || (id == saved.source && !touched) { select(id) }
        }
    }

    private func select(_ id: String) {
        guard let source = sources.first(where: { $0.id == id }) else { return }
        activeID = id
        seasons = []
        switch source.node.type {
        case "season":
            let list = source.node.data
            let maxSeason = title.seasons.isEmpty ? Int.max : title.seasons.count
            let fitting = list.enumerated().filter { LampacNode.number($0.element, fallback: $0.offset + 1) <= maxSeason }.map(\.element)
            seasons = fitting.isEmpty ? list : fitting
            let index = seasons.enumerated().first { LampacNode.number($0.element, fallback: $0.offset + 1) == seasonNumber }?.offset ?? 0
            seasonNumber = LampacNode.number(seasons[index], fallback: index + 1)
            if let url = seasons[index]["url"] as? String { Task { await load(url, preferSavedVoice: true) } }
        default:
            node = source.node
        }
    }

    /// A source's episode list opens on its default voice; switch once to the one chosen before.
    private func load(_ url: String, preferSavedVoice: Bool = false) async {
        guard let client else { return }
        let target = activeID
        loading = true
        defer { loading = false }
        var next = LampacNode(try? await client.json(url))
        if preferSavedVoice, let current = next, current.type == "episode", !saved.voice.isEmpty,
           let voice = current.voices.first(where: { LampacNode.text($0["name"]) == saved.voice && ($0["active"] as? Bool) != true }),
           let voiceURL = voice["url"] as? String {
            next = LampacNode(try? await client.json(voiceURL)) ?? current
        }
        guard target == activeID else { return }
        if let next, next.type == "episode", !next.data.isEmpty {
            node = next
        } else if let next, next.type == "season", !next.data.isEmpty {
            seasons = next.data
            if let url = next.data.first?["url"] as? String { await load(url, preferSavedVoice: preferSavedVoice) }
        } else {
            node = nil
            status = "Источник не ответил. Выберите другой."
        }
    }

    private static func bestLines(_ node: LampacNode) -> Int {
        node.data.map { entry in
            let listed = (entry["quality"] as? [String: Any])?.keys.map(LampacClient.lines) ?? []
            return max(LampacClient.lines(LampacNode.text(entry["maxquality"])), listed.max() ?? 0)
        }.max() ?? 0
    }

    static func qualityLabel(_ lines: Int) -> String {
        lines >= 2000 ? "4K" : lines >= 1400 ? "2K" : lines > 0 ? "\(lines)p" : ""
    }

    private static func firstText(_ entry: [String: Any], _ keys: [String]) -> String? {
        keys.lazy.map { LampacNode.text(entry[$0]) }.first { !$0.isEmpty }
    }
}

@MainActor
private final class LampacTaskBag {
    var tasks: [Task<Void, Never>] = []
}

private struct LampacRow: View {
    let title: String
    let note: String
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "play.fill")
                .font(.system(size: 12, weight: .semibold))
                .frame(width: 34, height: 34)
                .background(isCurrent ? Color.cineAccent.opacity(0.25) : Color.cineSurface2, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.cine(15, .medium)).foregroundStyle(.white).lineLimit(2)
                if !note.isEmpty { Text(note).font(.cine(12)).foregroundStyle(Color.cineMuted) }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color.cineSurface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(isCurrent ? Color.cineAccent : Color.cineLine, lineWidth: 1))
        .contentShape(Rectangle())
    }
}

enum LampacProgress {
    /// The same keys as the website: "<id>" for a film, "<id>-s2e7" for an episode.
    static func key(_ titleID: String, season: Int?, episode: Int?) -> String {
        guard let season, let episode else { return titleID }
        return "\(titleID)-s\(season)e\(episode)"
    }

    static func time(_ seconds: Double) -> String {
        let total = max(0, Int(seconds))
        let hours = total / 3600, minutes = total % 3600 / 60, rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }
}

// MARK: - Player

struct LampacPlayerView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let title: CatalogTitle
    @State var request: LampacPlayRequest

    @State private var player: AVPlayer?
    @State private var stream: LampacStream?
    @State private var qualityLabel = ""
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var timeObserver: Any?
    @State private var tickObserver: Any?
    /// IntroDB marks of what plays now; the skip button is offered while inside one.
    @State private var segments: [SkipSegment] = []
    @State private var activeSegment: SkipSegment?

    private var heading: String {
        guard let season = request.season, let episode = request.episode else { return title.title }
        return "\(title.title) · \(season) сезон, \(episode) серия"
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let player {
                VideoPlayer(player: player).ignoresSafeArea()
            }
            if isLoading {
                VStack(spacing: 10) {
                    ProgressView().tint(.white)
                    Text("Подключаю видео…").font(.footnote.weight(.semibold)).foregroundStyle(.white)
                }
                .padding(18)
                .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 14))
            }
            if let errorMessage {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(errorMessage).font(.footnote).multilineTextAlignment(.center).foregroundStyle(.white)
                    Button("Повторить") { Task { await open(request) } }
                        .buttonStyle(.borderedProminent).tint(.cineAccent)
                }
                .padding(20)
                .background(.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .overlay(alignment: .top) { topBar }
        .overlay(alignment: .bottomTrailing) {
            if let segment = activeSegment {
                Button {
                    if segment.type == "outro", request.next.first != nil {
                        playNext()
                    } else {
                        player?.seek(to: CMTime(seconds: segment.end, preferredTimescale: 600))
                        activeSegment = nil
                    }
                } label: {
                    Label(segment.type == "outro" && request.next.first != nil ? "Следующая серия" : segment.label, systemImage: "forward.fill")
                        .font(.cine(14, .semibold))
                        .padding(.horizontal, 16).padding(.vertical, 11)
                        .background(.white, in: Capsule())
                        .foregroundStyle(.black)
                }
                .padding(.trailing, 24)
                .padding(.bottom, 90)
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: activeSegment)
        .statusBarHidden()
        .task { await open(request) }
        .onReceive(NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification)) { notification in
            guard (notification.object as? AVPlayerItem) === player?.currentItem else { return }
            save(completed: true)
            if request.next.first != nil { playNext() }
        }
        .onDisappear { close() }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { dismiss() } label: { Image(systemName: "xmark") }
                .buttonStyle(CineOverlayButtonStyle())
                .accessibilityLabel("Закрыть")
            VStack(alignment: .leading, spacing: 1) {
                Text(heading).font(.cine(14, .semibold)).lineLimit(1)
                Text([request.voice, request.source].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.cine(11)).foregroundStyle(Color.cineMuted).lineLimit(1)
            }
            .foregroundStyle(.white)
            Spacer(minLength: 0)
            if let stream, stream.qualities.count > 1 {
                Menu {
                    ForEach(stream.qualities.keys.sorted { LampacClient.lines($0) > LampacClient.lines($1) }, id: \.self) { label in
                        Button {
                            if let url = stream.qualities[label] { switchQuality(label, url) }
                        } label: {
                            if label == qualityLabel { Label(label, systemImage: "checkmark") } else { Text(label) }
                        }
                    }
                } label: {
                    Text(qualityLabel.isEmpty ? "Качество" : qualityLabel)
                        .font(.cine(12, .semibold))
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(.black.opacity(0.6), in: Capsule())
                        .foregroundStyle(.white)
                }
            }
            if request.next.first != nil {
                Button { playNext() } label: { Image(systemName: "forward.end.fill") }
                .buttonStyle(CineOverlayButtonStyle())
                .accessibilityLabel("Следующая серия")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    private func playNext() {
        guard let next = request.next.first else { return }
        save(completed: true)
        Task { await open(LampacPlayRequest(entry: next.entry, voice: next.voice, source: next.source, season: next.season,
                                            episode: next.episode, next: Array(request.next.dropFirst()))) }
    }

    private func open(_ next: LampacPlayRequest) async {
        save(completed: false)
        teardown()
        request = next
        errorMessage = nil
        isLoading = true
        segments = []
        activeSegment = nil
        let title = self.title
        Task {
            let imdb = await TMDBService.shared.imdbID(title)
            let found = await TMDBService.shared.skipSegments(imdb: imdb, season: next.season ?? 0, episode: next.episode ?? 0)
            if request.id == next.id { segments = found }
        }
        guard let client = LampacClient.shared else { errorMessage = "Lampac не настроен."; isLoading = false; return }
        let found = await client.stream(next.entry)
        stream = found
        guard let pick = found.preferred() else {
            isLoading = false
            errorMessage = "Источник не отдал ссылку. Выберите другую озвучку или источник."
            return
        }
        qualityLabel = pick.label
        start(pick.url, at: savedPosition())
    }

    private func switchQuality(_ label: String, _ url: URL) {
        let position = player?.currentTime().seconds ?? 0
        save(completed: false)
        teardown()
        qualityLabel = label
        start(url, at: position.isFinite ? position : 0)
    }

    private func start(_ url: URL, at position: Double) {
        let item = AVPlayerItem(url: url)
        let next = AVPlayer(playerItem: item)
        next.automaticallyWaitsToMinimizeStalling = true
        if position > 5 { next.seek(to: CMTime(seconds: position, preferredTimescale: 600)) }
        timeObserver = next.addPeriodicTimeObserver(forInterval: CMTime(seconds: 10, preferredTimescale: 1), queue: .main) { _ in
            Task { @MainActor in
                if isLoading, next.currentItem?.status == .readyToPlay { isLoading = false }
                if next.currentItem?.status == .failed {
                    isLoading = false
                    errorMessage = "Видео не открылось. Попробуйте другое качество, озвучку или источник."
                }
                save(completed: false)
            }
        }
        tickObserver = next.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { time in
            Task { @MainActor in
                let now = time.seconds
                let inside = segments.first { now >= $0.start && now < $0.end - 1 }
                if inside != activeSegment { activeSegment = inside }
            }
        }
        player = next
        next.play()
        Task {
            for _ in 0..<40 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard player === next else { return }
                if next.currentItem?.status == .readyToPlay { isLoading = false; return }
                if next.currentItem?.status == .failed {
                    isLoading = false
                    errorMessage = "Видео не открылось. Попробуйте другое качество, озвучку или источник."
                    return
                }
            }
            if player === next, isLoading { isLoading = false }
        }
    }

    private func savedPosition() -> Double {
        guard let record = store.catalogProgress[LampacProgress.key(title.id, season: request.season, episode: request.episode)],
              record.completed != true else { return 0 }
        return record.position ?? 0
    }

    private func save(completed: Bool) {
        guard let player, let item = player.currentItem else { return }
        let duration = item.duration.seconds
        let position = player.currentTime().seconds
        guard duration.isFinite, duration > 0, position.isFinite, position >= 3 || completed else { return }
        store.recordLampacPlayback(title, season: request.season, episode: request.episode,
                                   position: completed ? duration : position, duration: duration, voice: request.voice)
    }

    private func teardown() {
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        if let tickObserver { player?.removeTimeObserver(tickObserver) }
        timeObserver = nil
        tickObserver = nil
        activeSegment = nil
        player?.pause()
        player = nil
    }

    private func close() {
        save(completed: false)
        teardown()
    }
}

// MARK: - Plain stream (open demo films)

struct CatalogExternalPlayerView: View {
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
                    .modifier(LandscapeVideoFill())
            } else {
                Color.black
            }
            if isLoading {
                VStack(spacing: 10) {
                    ProgressView().tint(.white)
                    Text("Загружаю видео…")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white)
                }
                .padding(18)
                .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 14))
            }
            if let errorMessage {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(errorMessage).font(.footnote).multilineTextAlignment(.center).foregroundStyle(.white)
                    Button("Повторить") { startPlayer() }
                        .buttonStyle(.borderedProminent).tint(.cineAccent)
                }
                .padding(20)
                .background(.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .modifier(HideTabBarWhileVisible())
        .modifier(LandscapePlayerChrome())
        .task { startPlayer() }
        .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemFailedToPlayToEndTime)) { notification in
            guard let currentItem = player?.currentItem,
                  let failedItem = notification.object as? AVPlayerItem,
                  currentItem === failedItem else { return }
            isLoading = false
            errorMessage = "Поток оборвался. Попробуй ещё раз."
        }
        .onDisappear {
            if let player, let item = player.currentItem {
                let duration = item.duration.seconds
                if duration.isFinite { store.recordPlayback(title, position: player.currentTime().seconds, duration: duration) }
            }
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
                    throw NSError(domain: "CineVault", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "Источник не сообщил, что видео готово к воспроизведению."])
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

/// iPhone turned sideways: the player takes the whole screen. The navigation bar,
/// status bar and home indicator step aside; turning the phone upright brings them back.
struct LandscapePlayerChrome: ViewModifier {
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var isLandscape: Bool { verticalSizeClass == .compact }

    func body(content: Content) -> some View {
        content
            .toolbar(isLandscape ? .hidden : .automatic, for: .navigationBar)
            .statusBarHidden(isLandscape)
            .persistentSystemOverlays(isLandscape ? .hidden : .automatic)
    }
}

/// In landscape the video runs to the top and bottom edges; the sides keep their
/// safe-area margins so the player's controls stay clear of the camera housing.
struct LandscapeVideoFill: ViewModifier {
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    func body(content: Content) -> some View {
        content.ignoresSafeArea(edges: verticalSizeClass == .compact ? .vertical : [])
    }
}

/// A full-screen button: it turns the picture sideways.
struct PlayerFullscreenButton: ViewModifier {
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var exitVisible = false
    @State private var hideExitID = UUID()

    private func revealExit() {
        withAnimation(.easeOut(duration: 0.2)) { exitVisible = true }
        hideExitID = UUID()
    }

    func body(content: Content) -> some View {
        content
            .overlay(alignment: OrientationPolicy.cameraIsOnLeft ? .trailing : .leading) {
                // Full screen hides the navigation bar, so it needs a way out of its own.
                // It sits in the black margin beside the video, on the side away from the camera.
                if OrientationPolicy.isPhone && verticalSizeClass == .compact && exitVisible {
                    Button {
                        OrientationPolicy.returnUpright()
                    } label: {
                        Image(systemName: "arrow.down.right.and.arrow.up.left")
                    }
                    .buttonStyle(CineOverlayButtonStyle())
                    .scaleEffect(0.85)
                    .accessibilityLabel("Выйти из полноэкранного режима")
                    .padding(.horizontal, 2)
                    .ignoresSafeArea()
                    .transition(.opacity)
                }
            }
            // Like the player's own controls: shown after a tap, gone after a few seconds.
            .onReceive(NotificationCenter.default.publisher(for: .playerTouched)) { _ in revealExit() }
            .onChange(of: verticalSizeClass) { _, sizeClass in
                if sizeClass == .compact { revealExit() } else { exitVisible = false }
            }
            .task(id: hideExitID) {
                guard exitVisible else { return }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: 0.3)) { exitVisible = false }
            }
            .toolbar {
            if OrientationPolicy.isPhone && verticalSizeClass != .compact {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("На весь экран", systemImage: "arrow.up.left.and.arrow.down.right") {
                        OrientationPolicy.rotate(to: .landscapeRight)
                    }
                }
            }
        }
    }
}

extension Notification.Name {
    static let playerTouched = Notification.Name("CineVaultPlayerTouched")
}

// MARK: - Trailer (Rutube's own HLS in AVPlayer)

struct TrailerPlayerView: View {
    @Environment(\.dismiss) private var dismiss
    let trailer: Trailer
    @State private var player: AVPlayer?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let player {
                VideoPlayer(player: player).ignoresSafeArea()
            } else if failed {
                Text("Трейлер не открылся.").font(.cine(14)).foregroundStyle(.white)
            } else {
                ProgressView().tint(.white)
            }
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 10) {
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(CineOverlayButtonStyle())
                    .accessibilityLabel("Закрыть")
                Text(trailer.title).font(.cine(13, .semibold)).foregroundStyle(.white).lineLimit(1)
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
        .statusBarHidden()
        .task {
            guard let url = await TMDBService.shared.rutubeStream(trailer.id) else { failed = true; return }
            let next = AVPlayer(url: url)
            player = next
            next.play()
        }
        .onDisappear { player?.pause(); player = nil }
    }
}
