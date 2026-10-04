import Foundation
import SwiftData

// MARK: - SwiftData cache

/// Local cache of one Hub inbox item. Status is updated optimistically on
/// accept/reject/reroute and rolled back if the POST fails.
@Model
final class InboxItemRecord {
    @Attribute(.unique) var id: String
    var kindRaw: String
    var statusRaw: String
    var subjectType: String?
    var subjectID: String?
    /// The raw payload object, serialized so arbitrary shapes survive.
    var payloadJSON: String
    var confidence: Double
    var abstained: Bool
    var createdAtMs: Double

    init(item: InboxItem) {
        id = item.id
        kindRaw = item.kindRaw
        statusRaw = item.statusRaw
        subjectType = item.subjectType
        subjectID = item.subjectID
        payloadJSON = "{}"
        confidence = item.confidence
        abstained = item.abstained
        createdAtMs = item.createdAtMs
        apply(item)
    }

    func apply(_ item: InboxItem) {
        kindRaw = item.kindRaw
        statusRaw = item.statusRaw
        subjectType = item.subjectType
        subjectID = item.subjectID
        confidence = item.confidence
        abstained = item.abstained
        createdAtMs = item.createdAtMs
        payloadJSON = Self.encodePayload(item.payload)
    }

    var item: InboxItem {
        InboxItem(
            id: id,
            kindRaw: kindRaw,
            subjectType: subjectType,
            subjectID: subjectID,
            payload: Self.decodePayload(payloadJSON),
            confidence: confidence,
            abstained: abstained,
            statusRaw: statusRaw,
            createdAtMs: createdAtMs
        )
    }

    private static func encodePayload(_ payload: [String: JSONValue]) -> String {
        guard let data = try? JSONEncoder().encode(payload) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private static func decodePayload(_ json: String) -> [String: JSONValue] {
        guard let data = json.data(using: .utf8),
              let payload = try? JSONDecoder().decode([String: JSONValue].self, from: data)
        else { return [:] }
        return payload
    }
}

/// Singleton-ish sync cursor row: `key == "inbox"` holds the `/changes`
/// watermark (`lastPulledAt`).
@Model
final class InboxSyncState {
    @Attribute(.unique) var key: String
    /// Epoch milliseconds of the last successful `/changes` pull.
    var lastPulledAtMs: Double

    init(key: String, lastPulledAtMs: Double) {
        self.key = key
        self.lastPulledAtMs = lastPulledAtMs
    }
}

// MARK: - Store

/// Drives inbox sync and actions for the UI. Holds no item state of its own —
/// items live in SwiftData and views observe them with `@Query`.
@Observable
@MainActor
final class InboxStore {
    /// Transient status line shown under the nav title (success or rollback).
    struct Feedback: Equatable {
        let text: String
        let isError: Bool
    }

    private(set) var feedback: Feedback?
    private(set) var isSyncing = false
    /// True while the scene is foregrounded; the poll loop skips ticks otherwise.
    var isForegrounded = true

    private var api = InboxAPI()
    private var feedbackTask: Task<Void, Never>?

    // MARK: Sync

    /// Full refresh: replace locally-pending items with `GET /inbox`'s view.
    /// (The endpoint is pending-only, so non-pending local rows are kept.)
    func refresh(context: ModelContext) async {
        isSyncing = true
        defer { isSyncing = false }
        do {
            let items = try await api.fetchPendingItems()
            upsert(items: items, context: context)
            try context.save()
            showFeedback("已同步 \(items.count) 条待处理")
        } catch {
            showFeedback("同步失败：\(describe(error))", isError: true)
        }
    }

    /// Incremental poll: `GET /changes?since=<cursor>`, upsert + deletions,
    /// then persist the returned timestamp as the next cursor.
    func pollChanges(context: ModelContext) async {
        let cursor = fetchCursor(context: context)
        do {
            let response = try await api.fetchChanges(sinceMs: cursor)
            upsert(items: response.changes, context: context)
            for id in response.deletions {
                if let record = try fetchRecord(id: id, context: context) {
                    context.delete(record)
                }
            }
            let state = fetchOrCreateCursorState(context: context)
            state.lastPulledAtMs = response.timestampMs
            try context.save()
        } catch {
            // Silent for background polls; pull-to-refresh surfaces errors.
        }
    }

    // MARK: Actions (optimistic + rollback)

    func accept(_ record: InboxItemRecord, context: ModelContext) async {
        await performAction(record, context: context, optimistic: .accepted) { api, id in
            try await api.accept(id: id)
        }
    }

    func reject(_ record: InboxItemRecord, context: ModelContext) async {
        await performAction(record, context: context, optimistic: .rejected) { api, id in
            try await api.reject(id: id)
        }
    }

    func reroute(_ record: InboxItemRecord, to kind: InboxKind, context: ModelContext) async {
        await performAction(record, context: context, optimistic: .rerouted) { api, id in
            try await api.reroute(id: id, toKind: kind)
        }
        showFeedback("已改判为「\(kind.label)」")
    }

    private func performAction(
        _ record: InboxItemRecord,
        context: ModelContext,
        optimistic: InboxItemStatus,
        _ call: (InboxAPI, String) async throws -> InboxItem
    ) async {
        let previous = record.statusRaw
        record.statusRaw = optimistic.rawValue
        try? context.save()
        do {
            let updated = try await call(api, record.id)
            record.apply(updated)
            try context.save()
            switch updated.status {
            case .accepted: showFeedback("已接受")
            case .rejected: showFeedback("已拒绝")
            case .rerouted: showFeedback("已改判")
            case .pending: break
            }
        } catch {
            // Rollback the optimistic write.
            record.statusRaw = previous
            try? context.save()
            showFeedback("操作失败已回滚：\(describe(error))", isError: true)
        }
    }

    // MARK: Cursor helpers

    private func fetchCursor(context: ModelContext) -> Double {
        fetchOrCreateCursorState(context: context).lastPulledAtMs
    }

    private func fetchOrCreateCursorState(context: ModelContext) -> InboxSyncState {
        let key = "inbox"
        let descriptor = FetchDescriptor<InboxSyncState>(predicate: #Predicate { $0.key == key })
        if let existing = try? context.fetch(descriptor).first { return existing }
        let fresh = InboxSyncState(key: key, lastPulledAtMs: 0)
        context.insert(fresh)
        return fresh
    }

    private func upsert(items: [InboxItem], context: ModelContext) {
        for item in items {
            let record = (try? fetchRecord(id: item.id, context: context)) ?? nil
            if let record {
                record.apply(item)
            } else {
                context.insert(InboxItemRecord(item: item))
            }
        }
    }

    private func fetchRecord(id: String, context: ModelContext) throws -> InboxItemRecord? {
        let descriptor = FetchDescriptor<InboxItemRecord>(predicate: #Predicate { $0.id == id })
        return try context.fetch(descriptor).first
    }

    // MARK: Feedback

    private func showFeedback(_ text: String, isError: Bool = false) {
        feedbackTask?.cancel()
        feedback = Feedback(text: text, isError: isError)
        feedbackTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.feedback = nil
        }
    }

    private func describe(_ error: Error) -> String {
        (error as? InboxAPIError)?.errorDescription ?? error.localizedDescription
    }
}
