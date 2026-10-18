import Foundation

@main
enum RemoteCatalogContractSmoke {
    static func main() throws {
        let pageJSON = Data("""
        {"items":[{"id":"kinopoisk-1","kind":"movie","title":"Тест","year":"—","posterImage":"https://example.com/poster.jpg"}],"page":1,"pages":2,"total":51}
        """.utf8)
        let page = try JSONDecoder().decode(RemoteCatalogPage.self, from: pageJSON)
        precondition(page.items.count == 1 && page.items[0].catalogTitle.year == 0)
        precondition(page.pages == 2 && page.total == 51)

        let catalogURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let data = try Data(contentsOf: catalogURL)
        let entries = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        guard let rawTitle = entries.first(where: { $0["id"] as? String == "kinopoisk-412344" }) else {
            fatalError("Expected title is missing from the local fixture")
        }
        let title = try JSONDecoder().decode(RemoteCatalogEntry.self, from: JSONSerialization.data(withJSONObject: rawTitle)).catalogTitle
        precondition(title.id == "kinopoisk-412344")
        precondition(title.isSeries && title.kinopoiskID == 412344)
        precondition(title.playbackSources.isEmpty || title.playbackSources.allSatisfy { !$0.url.isEmpty })
        if let rawPlayable = entries.first(where: { ($0["videoSources"] as? [[String: Any]])?.isEmpty == false }) {
            let playable = try JSONDecoder().decode(
                RemoteCatalogEntry.self, from: JSONSerialization.data(withJSONObject: rawPlayable)
            ).catalogTitle
            precondition(!playable.playbackSources.isEmpty)
        }
        for entry in entries {
            guard entry["id"] is String, entry["title"] is String else { continue }
            _ = try JSONDecoder().decode(RemoteCatalogEntry.self, from: JSONSerialization.data(withJSONObject: entry))
        }
        var checked = entries.count
        for filename in CommandLine.arguments.dropFirst(2) {
            let extraData = try Data(contentsOf: URL(fileURLWithPath: filename))
            let extraEntries = try JSONSerialization.jsonObject(with: extraData) as! [[String: Any]]
            for entry in extraEntries {
                guard entry["id"] is String, entry["title"] is String else { continue }
                _ = try JSONDecoder().decode(RemoteCatalogEntry.self, from: JSONSerialization.data(withJSONObject: entry))
            }
            checked += extraEntries.count
        }

        precondition(ServerConfiguration(address: "https://example.com", viewerToken: "", basicUsername: "user", basicPassword: "pass") != nil)
        precondition(ServerConfiguration(address: "https://example.com", viewerToken: "token", basicUsername: "user", basicPassword: "pass") == nil)
        print("Remote catalog contract: OK (\(checked) local entries)")
    }
}
