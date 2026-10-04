import Foundation

// MARK: - Flexible JSON values (the pinned contract leaves `payload` open)

/// A decoded JSON value of any shape. Used for the inbox item `payload`,
/// whose keys vary by classifier. Never assume a key exists in UI code.
nonisolated enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let b = try? container.decode(Bool.self) { self = .bool(b); return }
        if let d = try? container.decode(Double.self) { self = .number(d); return }
        if let s = try? container.decode(String.self) { self = .string(s); return }
        if let a = try? container.decode([JSONValue].self) { self = .array(a); return }
        self = .object(try container.decode([String: JSONValue].self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let d): try container.encode(d)
        case .bool(let b): try container.encode(b)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        case .null: try container.encodeNil()
        }
    }

    /// Human-readable rendering for the detail view.
    var displayText: String {
        switch self {
        case .string(let s): return s
        case .number(let d):
            return d == d.rounded() && abs(d) < 1e15
                ? String(Int64(d))
                : String(d)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a): return "[" + a.map(\.displayText).joined(separator: ", ") + "]"
        case .object(let o):
            return "{" + o.sorted { $0.key < $1.key }
                .map { "\($0.key): \($0.value.displayText)" }
                .joined(separator: ", ") + "}"
        }
    }
}

// MARK: - Pinned Hub contract DTOs (docs pinned 2026-10; do not reshape)

/// One inbox item, exactly the shape of `GET /inbox` entries and the entries
/// inside `GET /changes`. `kind`/`status` stay raw strings so unknown values
/// from future Hub versions never break decoding.
nonisolated struct InboxItem: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kindRaw: String
    let subjectType: String?
    let subjectID: String?
    let payload: [String: JSONValue]
    let confidence: Double
    let abstained: Bool
    let statusRaw: String
    /// Epoch milliseconds (contract: `created_at`).
    let createdAtMs: Double

    enum CodingKeys: String, CodingKey {
        case id, payload, confidence, abstained
        case kindRaw = "kind"
        case statusRaw = "status"
        case subjectType = "subject_type"
        case subjectID = "subject_id"
        case createdAtMs = "created_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kindRaw = try c.decodeIfPresent(String.self, forKey: .kindRaw) ?? InboxKind.unknown.rawValue
        subjectType = try c.decodeIfPresent(String.self, forKey: .subjectType)
        subjectID = try c.decodeIfPresent(String.self, forKey: .subjectID)
        payload = try c.decodeIfPresent([String: JSONValue].self, forKey: .payload) ?? [:]
        confidence = try c.decodeIfPresent(Double.self, forKey: .confidence) ?? 0
        abstained = try c.decodeIfPresent(Bool.self, forKey: .abstained) ?? false
        statusRaw = try c.decodeIfPresent(String.self, forKey: .statusRaw) ?? InboxItemStatus.pending.rawValue
        createdAtMs = try c.decodeIfPresent(Double.self, forKey: .createdAtMs) ?? 0
    }

    init(
        id: String,
        kindRaw: String,
        subjectType: String? = nil,
        subjectID: String? = nil,
        payload: [String: JSONValue],
        confidence: Double,
        abstained: Bool,
        statusRaw: String,
        createdAtMs: Double
    ) {
        self.id = id
        self.kindRaw = kindRaw
        self.subjectType = subjectType
        self.subjectID = subjectID
        self.payload = payload
        self.confidence = confidence
        self.abstained = abstained
        self.statusRaw = statusRaw
        self.createdAtMs = createdAtMs
    }

    var kind: InboxKind { InboxKind(rawValue: kindRaw) ?? .unknown }
    var status: InboxItemStatus { InboxItemStatus(rawValue: statusRaw) ?? .pending }
}

nonisolated enum InboxKind: String, CaseIterable, Sendable {
    case requirement, idea, log, task, reference, question, unknown
}

nonisolated enum InboxItemStatus: String, Sendable {
    case pending, accepted, rejected, rerouted
}

/// `POST /inbox/:id/{accept|reject|reroute}` response.
nonisolated struct InboxActionResponse: Codable, Sendable {
    let ok: Bool
    let item: InboxItem
}

/// `GET /inbox` response.
nonisolated struct InboxResponse: Codable, Sendable {
    let items: [InboxItem]
}

/// `GET /changes?since=<epoch ms>` response.
nonisolated struct InboxChangesResponse: Codable, Sendable {
    let changes: [InboxItem]
    let deletions: [String]
    /// Epoch milliseconds to persist as the next `since` cursor.
    let timestampMs: Double

    enum CodingKeys: String, CodingKey {
        case changes, deletions
        case timestampMs = "timestamp"
    }
}

/// `GET /requirements` entry.
nonisolated struct HubRequirement: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let status: String
    let bodyPath: String?
    /// Epoch milliseconds (contract: `created_at`).
    let createdAtMs: Double
    let sourceRevisionID: String?

    enum CodingKeys: String, CodingKey {
        case id, title, status
        case bodyPath = "body_path"
        case createdAtMs = "created_at"
        case sourceRevisionID = "source_revision_id"
    }
}

/// `GET /requirements` response.
nonisolated struct RequirementsResponse: Codable, Sendable {
    let requirements: [HubRequirement]
}

// MARK: - Display helpers

nonisolated extension InboxKind {
    var label: String {
        switch self {
        case .requirement: "需求"
        case .idea: "想法"
        case .log: "日志"
        case .task: "疑似任务"
        case .reference: "参考"
        case .question: "问题"
        case .unknown: "未知"
        }
    }

    var colorKind: String {
        switch self {
        case .requirement: "blue"
        case .task: "orange"
        case .idea: "green"
        case .question: "purple"
        case .reference: "teal"
        case .log: "gray"
        case .unknown: "secondary"
        }
    }

    /// Sort weight for the grouped first screen (requirements first, per §9).
    var sortOrder: Int {
        switch self {
        case .requirement: 0
        case .task: 1
        case .idea: 2
        case .question: 3
        case .reference: 4
        case .log: 5
        case .unknown: 6
        }
    }
}

nonisolated extension InboxItem {
    /// Best-effort summary across payload shapes: prefer `summary`, then
    /// `text`, then `title` (mock classifiers emit `summary`).
    var summary: String? {
        for key in ["summary", "text", "title"] {
            if case .string(let s)? = payload[key], !s.isEmpty { return s }
        }
        return nil
    }

    /// The requirement row this item refers to, matched best-effort.
    func matchingRequirement(_ requirements: [HubRequirement]) -> HubRequirement? {
        var candidates: [String] = []
        if let subjectID { candidates.append(subjectID) }
        for key in ["requirementId", "requirement_id", "id"] {
            if case .string(let s)? = payload[key] { candidates.append(s) }
        }
        for candidate in candidates {
            if let match = requirements.first(where: { $0.id == candidate }) { return match }
        }
        return nil
    }
}
