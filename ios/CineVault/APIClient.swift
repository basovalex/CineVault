import Foundation

enum CineVaultAPIError: LocalizedError {
    case invalidServerAddress
    case unauthorized
    case server(status: Int, message: String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidServerAddress:
            return "Проверь адрес сервера. Нужен URL вида https://..."
        case .unauthorized:
            return "Сервер не принял viewer-токен. Проверь токен доступа."
        case let .server(_, message):
            return message
        case .invalidResponse:
            return "Сервер вернул некорректный ответ."
        }
    }
}

final class CineVaultAPI {
    var configuration: ServerConfiguration

    init(configuration: ServerConfiguration) {
        self.configuration = configuration
    }

    func fetchLibrary() async throws -> LibraryResponse {
        try await request(path: "api/library")
    }

    func fetchOfflineManifest(for episode: Episode, quality: String) async throws -> OfflineManifest {
        guard let path = episode.offlineManifestURL else {
            throw CineVaultAPIError.server(status: 409, message: "Для этой серии нет офлайн-манифеста")
        }
        return try await request(path: path, queryItems: [URLQueryItem(name: "quality", value: quality)])
    }

    func fetchSkipSegments(for episode: Episode) async throws -> SkipSegmentsResponse {
        try await request(path: "api/library/episodes/\(episode.id)/skip-segments")
    }

    func updateProgress(episodeID: String, update: ProgressUpdate) async throws {
        var request = try makeRequest(path: "api/progress/\(episodeID)", method: "PUT")
        request.httpBody = try JSONEncoder().encode(update)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await send(request, expecting: EmptyResponse.self)
    }

    func createCatalogRequest(for title: CatalogTitle) async throws -> CatalogRequestResponse {
        var request = try makeRequest(path: "api/catalog/requests", method: "POST")
        request.httpBody = try JSONEncoder().encode(CatalogRequestPayload(title: title))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(request, expecting: CatalogRequestResponse.self)
    }

    func url(for relativePath: String?) -> URL? {
        guard let relativePath, !relativePath.isEmpty else { return nil }
        return configuration.baseURL.appendingPathComponent(relativePath.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }

    func authorizedRequest(for relativePath: String) throws -> URLRequest {
        try makeRequest(path: relativePath, method: "GET")
    }

    private func request<T: Decodable>(path: String, queryItems: [URLQueryItem] = []) async throws -> T {
        let request = try makeRequest(path: path, method: "GET", queryItems: queryItems)
        return try await send(request, expecting: T.self)
    }

    private func makeRequest(path: String, method: String, queryItems: [URLQueryItem] = []) throws -> URLRequest {
        guard let url = url(for: path) else { throw CineVaultAPIError.invalidServerAddress }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let requestURL = components?.url else { throw CineVaultAPIError.invalidServerAddress }
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !configuration.viewerToken.isEmpty {
            request.setValue("Bearer \(configuration.viewerToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest, expecting type: T.Type) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CineVaultAPIError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 { throw CineVaultAPIError.unauthorized }
            let message = (try? JSONDecoder().decode(ServerError.self, from: data).error) ?? "HTTP \(httpResponse.statusCode)"
            throw CineVaultAPIError.server(status: httpResponse.statusCode, message: message)
        }
        if type == EmptyResponse.self { return EmptyResponse() as! T }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct ServerError: Decodable {
    let error: String
}

private struct CatalogRequestPayload: Encodable {
    let catalogID: String
    let kind: String
    let title: String
    let originalTitle: String
    let year: Int

    enum CodingKeys: String, CodingKey {
        case catalogID = "catalog_id"
        case kind, title
        case originalTitle = "original_title"
        case year
    }

    init(title: CatalogTitle) {
        catalogID = title.id
        kind = title.kind
        self.title = title.title
        originalTitle = title.originalTitle
        year = title.year
    }
}

struct CatalogRequestResponse: Decodable {
    let requestID: String
    let catalogID: String
    let kind: String
    let title: String
    let status: String
    let alreadyExists: Bool

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case catalogID = "catalog_id"
        case kind, title, status
        case alreadyExists = "already_exists"
    }
}

private struct EmptyResponse: Decodable {}
