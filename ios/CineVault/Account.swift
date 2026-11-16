import Foundation

/// The site's account (/api/account/*): favourites, history and «where it stopped» follow the person
/// across the site, the TV and this iPhone through /api/account/site-state, the same merge the site uses.
/// Signed out, everything stays on the iPhone. The session is the site's own cookie, kept by URLSession.
extension AppStore {
    private var accountDefaults: UserDefaults { .standard }

    func loadAccountState() {
        accountUser = accountDefaults.string(forKey: "cinevault.account.user")
        accountCSRF = accountDefaults.string(forKey: "cinevault.account.csrf") ?? ""
        pendingRecoveryCode = accountDefaults.string(forKey: "cinevault.account.recovery")
        if let data = accountDefaults.data(forKey: "cinevault.account.marks"),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            savedMarks = json
        }
        siteHistory = accountDefaults.dictionary(forKey: "cinevault.siteHistory") as? [String: Double] ?? [:]
        historyRemoved = accountDefaults.dictionary(forKey: "cinevault.historyRemoved") as? [String: Double] ?? [:]
    }

    func saveAccountState() {
        accountDefaults.set(accountUser, forKey: "cinevault.account.user")
        accountDefaults.set(accountCSRF, forKey: "cinevault.account.csrf")
        accountDefaults.set(siteHistory, forKey: "cinevault.siteHistory")
        accountDefaults.set(historyRemoved, forKey: "cinevault.historyRemoved")
        if let data = try? JSONSerialization.data(withJSONObject: savedMarks) {
            accountDefaults.set(data, forKey: "cinevault.account.marks")
        }
    }

    private func accountURL(_ route: String) -> URL? {
        TMDBService.serverURL("api/account/\(route)", base: api.configuration.baseURL)
    }

    private func accountRequest(_ route: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let url = accountURL(route) else { throw CineVaultAPIError.invalidServerAddress }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authorization = api.authorizationHeader(for: url) { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if !accountCSRF.isEmpty { request.setValue(accountCSRF, forHTTPHeaderField: "X-CineVault-CSRF") }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(status) else {
            throw CineVaultAPIError.server(status: status, message: json["error"] as? String ?? "Сервер ответил \(status)")
        }
        return json
    }

    private static func displayName(_ user: [String: Any]?) -> String? {
        guard let user else { return nil }
        let name = (user["display_name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? user["username"] as? String : name
    }

    private func finishSignIn(_ answer: [String: Any], fallback: String) async {
        accountCSRF = answer["csrf"] as? String ?? accountCSRF
        accountUser = Self.displayName(answer["user"] as? [String: Any]) ?? fallback
        if let code = answer["recovery_code"] as? String, !code.isEmpty {
            pendingRecoveryCode = code
            accountDefaults.set(code, forKey: "cinevault.account.recovery")
        }
        saveAccountState()
        await syncAccount()
    }

    func login(username: String, password: String) async throws {
        let answer = try await accountRequest("login", body: ["username": username, "password": password])
        await finishSignIn(answer, fallback: username)
    }

    /// A new account, as the site's «Создать аккаунт»; the answer carries the recovery code shown once.
    func register(username: String, displayName: String, password: String) async throws {
        let answer = try await accountRequest("register", body: ["username": username, "display_name": displayName, "password": password])
        await finishSignIn(answer, fallback: displayName.isEmpty ? username : displayName)
    }

    /// A new password with the recovery code; the answer carries a fresh code.
    func recover(username: String, code: String, newPassword: String) async throws {
        let answer = try await accountRequest("recover", body: ["username": username, "recovery_code": code.trimmingCharacters(in: .whitespaces), "new_password": newPassword])
        await finishSignIn(answer, fallback: username)
    }

    func acknowledgeRecoveryCode() {
        pendingRecoveryCode = nil
        accountDefaults.removeObject(forKey: "cinevault.account.recovery")
    }

    func logout() async {
        _ = try? await accountRequest("logout", body: [:])
        if let url = accountURL("session"), let cookies = HTTPCookieStorage.shared.cookies(for: url) {
            cookies.filter { $0.name == "cinevault_session" }.forEach(HTTPCookieStorage.shared.deleteCookie)
        }
        accountUser = nil
        accountCSRF = ""
        saveAccountState()
    }

    // MARK: Sync

    private func payload() -> [String: Any] {
        let now = Date().timeIntervalSince1970 * 1000
        var marks = savedMarks
        var own = marks["favorites"] as? [String: [String: Any]] ?? [:]
        let current = Set(favorites.map(\.id))
        for id in current where (own[id]?["on"] as? Bool) != true { own[id] = ["on": true, "at": now] }
        for (id, mark) in own where (mark["on"] as? Bool) == true && !current.contains(id) { own[id] = ["on": false, "at": now] }
        marks["favorites"] = own
        savedMarks = marks
        var progress: [String: Any] = [:]
        let encoder = JSONEncoder()
        for (key, entry) in catalogProgress {
            if let data = try? encoder.encode(entry), let json = try? JSONSerialization.jsonObject(with: data) { progress[key] = json }
        }
        var result: [String: Any] = ["history": siteHistory, "historyRemoved": historyRemoved, "progress": progress]
        for name in ["favorites", "subscriptions", "watchlist"] { if let list = marks[name] { result[name] = list } }
        return result
    }

    private func apply(_ merged: [String: Any]) {
        savedMarks = [
            "favorites": merged["favorites"] ?? [:],
            "subscriptions": merged["subscriptions"] ?? [:],
            "watchlist": merged["watchlist"] ?? [:],
        ]
        let marks = merged["favorites"] as? [String: [String: Any]] ?? [:]
        let ordered = marks.compactMap { id, mark -> (String, Double)? in
            (mark["on"] as? Bool) == true ? (id, (mark["at"] as? NSNumber)?.doubleValue ?? 0) : nil
        }.sorted { $0.1 > $1.1 }
        let known = Dictionary(favorites.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        favorites = ordered.map { id, at in
            known[id] ?? FavoriteTitle(placeholder: id, addedAt: Date(timeIntervalSince1970: at / 1000))
        }
        siteHistory = (merged["history"] as? [String: NSNumber] ?? [:]).mapValues(\.doubleValue)
        historyRemoved = (merged["historyRemoved"] as? [String: NSNumber] ?? [:]).mapValues(\.doubleValue)
        var progress: [String: CatalogProgressEntry] = [:]
        let decoder = JSONDecoder()
        for (key, value) in merged["progress"] as? [String: Any] ?? [:] {
            guard var record = value as? [String: Any] else { continue }
            if record["titleId"] == nil {
                record["titleId"] = key.replacingOccurrences(of: "-(s\\d+e\\d+|alt|embed)$", with: "", options: .regularExpression)
            }
            if let number = record["updatedAt"] as? NSNumber { record["updatedAt"] = number.intValue }
            if let data = try? JSONSerialization.data(withJSONObject: record),
               let entry = try? decoder.decode(CatalogProgressEntry.self, from: data) { progress[key] = entry }
        }
        catalogProgress = progress
    }

    /// Sends this iPhone's lists to the account and takes the merged result, as the site's syncAccountState.
    func syncAccount() async {
        guard !accountSyncing else { return }
        accountSyncing = true
        defer { accountSyncing = false }
        do {
            let session = try await accountRequest("session")
            guard let user = session["user"] as? [String: Any] else {
                if accountUser != nil { accountUser = nil; accountCSRF = ""; saveAccountState() }
                return
            }
            accountUser = Self.displayName(user)
            accountCSRF = session["csrf"] as? String ?? ""
            let answer = try await accountRequest("site-state", body: ["state": payload()])
            if let state = answer["state"] as? [String: Any] { apply(state) }
            accountError = nil
            saveAccountState()
            saveFavoritesToDisk()
            saveCatalogProgressToDisk()
            await resolveMissingTitles()
        } catch {
            accountError = error.localizedDescription
        }
    }

    /// Changes go to the account a few seconds later, several at once.
    func scheduleAccountPush() {
        saveAccountState()
        guard accountUser != nil else { return }
        accountPushTask?.cancel()
        accountPushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, let self else { return }
            _ = try? await self.accountRequest("site-state", body: ["state": self.payload()])
            self.saveAccountState()
        }
    }

    func noteHistory(_ title: CatalogTitle) {
        siteHistory[title.id] = Date().timeIntervalSince1970 * 1000
    }

    /// Removed from the history on every device: the account keeps a removal mark.
    func removeFromHistory(_ id: String) {
        catalogProgress = catalogProgress.filter { $0.value.titleId != id && $0.key != id && !$0.key.hasPrefix("\(id)-") }
        siteHistory.removeValue(forKey: id)
        historyRemoved[id] = Date().timeIntervalSince1970 * 1000
        watchedTitles.removeAll { $0.id == id }
        saveCatalogProgressToDisk()
        scheduleAccountPush()
    }
}
