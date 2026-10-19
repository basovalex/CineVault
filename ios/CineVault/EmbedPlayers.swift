import SwiftUI
import AVKit
import WebKit

struct CatalogEmbedPlayerView: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    let url: URL

    var body: some View {
        ExternalEmbedWebView(url: url, siteURL: store.api.configuration.baseURL)
            .modifier(LandscapeVideoFill())
            .background(Color.black.ignoresSafeArea())
            .navigationTitle(title.title)
            .navigationBarTitleDisplayMode(.inline)
            .modifier(LandscapePlayerChrome())
    }
}

struct CatalogFreshPlayerView: View {
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
        .modifier(LandscapePlayerChrome())
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

struct CatalogAllohaPlayerView: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    let preferredTranslation: String
    @State private var translations: [ExternalPlayerTranslation] = []
    @State private var selectedID: String?
    @State private var isLoading = true
    @State private var errorMessage: String?

    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var selected: ExternalPlayerTranslation? {
        translations.first(where: { $0.id == selectedID }) ?? translations.first
    }

    var body: some View {
        VStack(spacing: 0) {
            if translations.count > 1 && verticalSizeClass != .compact {
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
                    .modifier(LandscapeVideoFill())
            } else if isLoading {
                ProgressView("Получаю свежую ссылку Alloha…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Alloha недоступен", systemImage: "play.slash", description: Text(errorMessage ?? "Нет доступных озвучек"))
            }
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Обновить ссылку", systemImage: "arrow.clockwise") {
                Task { await loadOptions() }
            }
        }
        .modifier(HideTabBarWhileVisible())
        .modifier(LandscapePlayerChrome())
        .task { await loadOptions() }
        .onChange(of: selected?.id) { _, _ in
            guard let selected else { return }
            store.recordEmbedOpened(title, providerID: "alloha", translationName: selected.name)
        }
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

struct ExternalEmbedWebView: UIViewRepresentable {
    let url: URL
    let siteURL: URL

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var loadedURL: URL?

        /// Taps still reach the provider's player; this only tells our own controls to show up.
        @objc func touched() {
            NotificationCenter.default.post(name: .playerTouched, object: nil)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Lets the provider's own full-screen button take the whole display,
        // its controls and voice menus included, instead of a bare system player.
        configuration.preferences.isElementFullscreenEnabled = true
        if let filterURL = Bundle.main.url(forResource: "filter", withExtension: "js"),
           let source = try? String(contentsOf: filterURL, encoding: .utf8) {
            configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page)
            )
        }
        PlayerAdBlocker.apply(to: configuration.userContentController)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        // SwiftUI already places the view inside the safe area.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.touched))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        webView.addGestureRecognizer(tap)
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
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .modifier(HideTabBarWhileVisible())
        .modifier(LandscapePlayerChrome())
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

/// Collaps, Veoveo, Turbo: one embed per title; voice, season and episode are
/// chosen inside the provider's own player, as on the website.
struct EmbedProviderPlayerView: View {
    @EnvironmentObject private var store: AppStore
    let title: CatalogTitle
    let provider: ExternalPlayerProvider
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var url: URL? {
        guard let raw = provider.embedURL, let url = URL(string: raw), url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    var body: some View {
        VStack(spacing: 0) {
            if let url {
                ExternalEmbedWebView(url: url, siteURL: store.api.configuration.baseURL)
                    .modifier(LandscapeVideoFill())
            } else {
                ContentUnavailableView("Плеер недоступен", systemImage: "play.slash", description: Text("\(provider.name) не отдал ссылку"))
            }
            if verticalSizeClass != .compact, !provider.voices.isEmpty || title.isSeries {
                Text(hint)
                    .font(.cine(12))
                    .foregroundStyle(Color.cineMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, CineMetrics.gutter)
                    .padding(.vertical, 10)
            }
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .modifier(HideTabBarWhileVisible())
        .modifier(LandscapePlayerChrome())
        .onAppear { store.recordEmbedOpened(title, providerID: provider.id) }
    }

    private var hint: String {
        let voices = provider.voices.prefix(8).joined(separator: ", ")
        var text = voices.isEmpty ? "Озвучка выбирается внутри плеера." : "Озвучки внутри плеера: \(voices)\(provider.voices.count > 8 ? "…" : "")."
        if title.isSeries { text += " Сезон и серию — тоже там." }
        return text
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

/// A full-screen button that works with every provider: it turns the picture
/// sideways. The providers' own buttons often do nothing inside an iPhone app.
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

/// Refuses requests to known ad networks inside every embedded player, the way iOS
/// ad blockers do. The players themselves and their video servers load as before;
/// ads baked into the video itself cannot be removed this way.
@MainActor
enum PlayerAdBlocker {
    private static let adHosts = [
        // Yandex and AdFox ad serving and counters
        "an.yandex.ru", "yabs.yandex.ru", "mc.yandex.ru", "adfox.ru", "adfox.yandex.ru",
        // Google ad serving
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
        // VK / Mail.ru (myTarget)
        "ad.mail.ru", "ads.vk.com", "target.my.com", "r.mradx.net",
        // Video ad networks common in Russian players
        "adriver.ru", "betweendigital.com", "buzzoola.com", "otm-r.com", "mediasniper.ru",
        "videoroll.net", "moevideo.biz", "adhigh.net", "hybrid.ai", "adlook.me", "propellerads.com",
        "exoclick.com", "adsterra.com", "popads.net", "onclickads.net",
    ]
    private static var ruleList: WKContentRuleList?
    private static var waiting: [WKUserContentController] = []
    private static var isCompiling = false

    /// Compiled once per launch; players opened before it is ready get it as soon as it is.
    static func prepare() {
        guard ruleList == nil, !isCompiling else { return }
        isCompiling = true
        let rules = adHosts.map { host -> [String: Any] in
            let escaped = host.replacingOccurrences(of: ".", with: "\\.")
            return ["trigger": ["url-filter": "^https?://([^/]*\\.)?\(escaped)[:/]"], "action": ["type": "block"]]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rules),
              let json = String(data: data, encoding: .utf8) else { return }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "cinevault-player-ads", encodedContentRuleList: json) { list, error in
            #if DEBUG
            NSLog("PlayerAdBlocker: %@", error.map { "\($0)" } ?? "\(adHosts.count) rules ready")
            #endif
            Task { @MainActor in
                isCompiling = false
                guard let list else { return }
                ruleList = list
                waiting.forEach { $0.add(list) }
                waiting = []
            }
        }
    }

    static func apply(to controller: WKUserContentController) {
        if let ruleList {
            controller.add(ruleList)
        } else {
            waiting.append(controller)
            prepare()
        }
    }
}
