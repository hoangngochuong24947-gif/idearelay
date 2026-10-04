import Foundation

/// Typed failures for the pinned Hub Inbox contract.
enum InboxAPIError: Error, LocalizedError {
    /// 404 — unknown inbox id.
    case notFound
    /// 409 — item is no longer pending.
    case conflict
    case http(status: Int, body: String?)
    case badResponse

    var errorDescription: String? {
        switch self {
        case .notFound: return "条目不存在（404）"
        case .conflict: return "该条目已不是待处理状态（409）"
        case .http(let status, _): return "Hub 返回 HTTP \(status)"
        case .badResponse: return "Hub 响应无法解析"
        }
    }
}

/// Client for the pinned Hub Inbox contract (`/inbox`, `/changes`,
/// `/requirements`, and the per-item action endpoints). Base URL comes from
/// the shared `HubSettings`. No auth in MVP — the tailnet is the boundary
/// (ADR-0001).
struct InboxAPI: Sendable {
    var session: URLSession = .shared

    private var base: URL { HubSettings.baseURL }

    // MARK: Reads

    /// Pending-only inbox items (`GET /inbox`).
    func fetchPendingItems() async throws -> [InboxItem] {
        let response: InboxResponse = try await get("inbox")
        return response.items
    }

    /// Incremental pull since the given epoch-ms cursor (`GET /changes`).
    func fetchChanges(sinceMs: Double) async throws -> InboxChangesResponse {
        try await get("changes", query: [URLQueryItem(name: "since", value: String(Int64(sinceMs)))])
    }

    /// All requirements (`GET /requirements`).
    func fetchRequirements() async throws -> [HubRequirement] {
        let response: RequirementsResponse = try await get("requirements")
        return response.requirements
    }

    // MARK: Actions (all return the updated item)

    func accept(id: String) async throws -> InboxItem {
        try await action(id: id, path: "accept")
    }

    func reject(id: String) async throws -> InboxItem {
        try await action(id: id, path: "reject")
    }

    func reroute(id: String, toKind: InboxKind) async throws -> InboxItem {
        try await post(
            "inbox/\(id)/reroute",
            body: ["to_kind": .string(toKind.rawValue)]
        )
    }

    private func action(id: String, path: String) async throws -> InboxItem {
        let response: InboxActionResponse = try await post("inbox/\(id)/\(path)", body: nil)
        return response.item
    }

    // MARK: Plumbing

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        var components = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw InboxAPIError.badResponse }
        let (data, response) = try await session.data(from: url)
        try Self.checkStatus(response, data: data)
        return try Self.decode(T.self, from: data)
    }

    private func post<T: Decodable>(_ path: String, body: [String: JSONValue]?) async throws -> T {
        guard let url = URL(string: base.appendingPathComponent(path).absoluteString) else {
            throw InboxAPIError.badResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: request)
        try Self.checkStatus(response, data: data)
        return try Self.decode(T.self, from: data)
    }

    private static func checkStatus(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw InboxAPIError.badResponse }
        switch http.statusCode {
        case 200...299: return
        case 404: throw InboxAPIError.notFound
        case 409: throw InboxAPIError.conflict
        default:
            throw InboxAPIError.http(
                status: http.statusCode,
                body: String(data: data.prefix(300), encoding: .utf8)
            )
        }
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw InboxAPIError.badResponse
        }
    }
}
