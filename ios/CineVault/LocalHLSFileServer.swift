import Foundation
import Network

/// Serves already-downloaded HLS files over loopback so AVPlayer can play them
/// offline. AVPlayer is reliable with HTTP HLS, but a local file URL pointing at
/// an m3u8 playlist can remain stuck in an indefinitely loading state on iOS.
final class LocalHLSFileServer {
    static let shared = LocalHLSFileServer()

    private let queue = DispatchQueue(label: "com.cinevault.local-hls", qos: .userInitiated)
    private var listener: NWListener?
    private var rootDirectory: URL?
    private var port: NWEndpoint.Port?

    private init() {}

    func playbackURL(for playlist: URL) async throws -> URL {
        guard playlist.pathExtension.lowercased() == "m3u8" else {
            return playlist
        }

        let root = playlist
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .standardizedFileURL
        let activePort = try await startIfNeeded(rootDirectory: root)
        let relativePath = playlist.path.replacingOccurrences(of: root.path + "/", with: "")
        guard !relativePath.isEmpty, relativePath != playlist.path else {
            throw LocalHLSFileServerError.invalidPlaylistPath
        }
        let encodedPath = relativePath
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
        guard let url = URL(string: "http://127.0.0.1:\(activePort)/\(encodedPath)") else {
            throw LocalHLSFileServerError.invalidPlaylistPath
        }
        return url
    }

    private func startIfNeeded(rootDirectory root: URL) async throws -> UInt16 {
        if let listener, let port, self.rootDirectory == root {
            _ = listener
            return port.rawValue
        }

        listener?.cancel()
        listener = nil
        port = nil
        rootDirectory = root

        let newListener = try NWListener(using: .tcp)
        listener = newListener
        newListener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }

        return try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            newListener.stateUpdateHandler = { [weak self, weak newListener] state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    guard let port = newListener?.port else {
                        resumed = true
                        continuation.resume(throwing: LocalHLSFileServerError.listenerUnavailable)
                        return
                    }
                    self?.port = port
                    resumed = true
                    continuation.resume(returning: port.rawValue)
                case .failed(let error):
                    resumed = true
                    continuation.resume(throwing: error)
                case .cancelled:
                    resumed = true
                    continuation.resume(throwing: LocalHLSFileServerError.listenerUnavailable)
                default:
                    break
                }
            }
            newListener.start(queue: queue)
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .ready:
                self.receiveRequest(on: connection, buffer: Data())
            case .failed, .cancelled:
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receiveRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak connection] data, _, isComplete, error in
            guard let self, let connection else { return }
            var request = buffer
            if let data { request.append(data) }

            if request.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(to: request, on: connection)
            } else if isComplete || error != nil {
                connection.cancel()
            } else {
                self.receiveRequest(on: connection, buffer: request)
            }
        }
    }

    private func respond(to requestData: Data, on connection: NWConnection) {
        guard let request = String(data: requestData, encoding: .utf8),
              let requestLine = request.components(separatedBy: "\r\n").first else {
            send(status: 400, reason: "Bad Request", body: Data(), method: "HEAD", on: connection)
            return
        }

        let requestParts = requestLine.split(separator: " ", maxSplits: 2).map(String.init)
        guard requestParts.count >= 2 else {
            send(status: 400, reason: "Bad Request", body: Data(), method: "HEAD", on: connection)
            return
        }
        let method = requestParts[0].uppercased()
        guard method == "GET" || method == "HEAD" else {
            send(status: 405, reason: "Method Not Allowed", body: Data(), method: "HEAD", on: connection)
            return
        }

        let headers = parseHeaders(request)
        guard let target = requestParts[safe: 1],
              let path = decodedPath(from: target),
              let root = rootDirectory else {
            send(status: 400, reason: "Bad Request", body: Data(), method: method, on: connection)
            return
        }

        let candidate = root.appendingPathComponent(path).standardizedFileURL
        guard isInsideRoot(candidate, root: root),
              FileManager.default.fileExists(atPath: candidate.path),
              let fileData = try? Data(contentsOf: candidate) else {
            send(status: 404, reason: "Not Found", body: Data(), method: method, on: connection)
            return
        }

        let mimeType = mimeType(for: candidate.pathExtension)
        if let range = byteRange(from: headers["range"], count: fileData.count) {
            let body = fileData.subdata(in: range.start..<range.end)
            send(
                status: 206,
                reason: "Partial Content",
                body: body,
                method: method,
                contentType: mimeType,
                extraHeaders: ["Content-Range": "bytes \(range.start)-\(range.end - 1)/\(fileData.count)"],
                on: connection
            )
        } else {
            send(status: 200, reason: "OK", body: fileData, method: method, contentType: mimeType, on: connection)
        }
    }

    private func send(
        status: Int,
        reason: String,
        body: Data,
        method: String,
        contentType: String = "application/octet-stream",
        extraHeaders: [String: String] = [:],
        on connection: NWConnection
    ) {
        var headers = [
            "HTTP/1.1 \(status) \(reason)",
            "Content-Length: \(method == "HEAD" ? 0 : body.count)",
            "Content-Type: \(contentType)",
            "Accept-Ranges: bytes",
            "Cache-Control: no-store",
            "Connection: close",
        ]
        headers.append(contentsOf: extraHeaders.map { "\($0.key): \($0.value)" })
        headers.append("")
        headers.append("")

        var response = Data(headers.joined(separator: "\r\n").utf8)
        if method != "HEAD" { response.append(body) }
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func parseHeaders(_ request: String) -> [String: String] {
        request.components(separatedBy: "\r\n").dropFirst().reduce(into: [:]) { result, line in
            guard let separator = line.firstIndex(of: ":") else { return }
            let name = String(line[..<separator]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            result[name] = value
        }
    }

    private func decodedPath(from target: String) -> String? {
        let withoutQuery = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? target
        let encoded = withoutQuery.hasPrefix("/") ? String(withoutQuery.dropFirst()) : withoutQuery
        let decoded = encoded.removingPercentEncoding
        guard let decoded, !decoded.isEmpty, !decoded.contains("\\") else { return nil }
        return decoded
    }

    private func isInsideRoot(_ candidate: URL, root: URL) -> Bool {
        candidate.path == root.path || candidate.path.hasPrefix(root.path + "/")
    }

    private func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "m3u8": return "application/vnd.apple.mpegurl"
        case "ts": return "video/mp2t"
        case "mp4": return "video/mp4"
        default: return "application/octet-stream"
        }
    }

    private func byteRange(from value: String?, count: Int) -> (start: Int, end: Int)? {
        guard let value, value.lowercased().hasPrefix("bytes=") else { return nil }
        let range = value.dropFirst("bytes=".count).split(separator: "-", maxSplits: 1).map(String.init)
        guard let first = range.first, let start = Int(first), start >= 0, start < count else { return nil }
        let requestedEnd = range.count > 1 ? Int(range[1]) : nil
        let end = min(max(requestedEnd ?? (count - 1), start), count - 1) + 1
        return (start, end)
    }
}

private enum LocalHLSFileServerError: LocalizedError {
    case invalidPlaylistPath
    case listenerUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidPlaylistPath: return "Не удалось открыть локальный офлайн-плейлист"
        case .listenerUnavailable: return "Не удалось запустить локальный офлайн-плеер"
        }
    }
}

private extension Array {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
