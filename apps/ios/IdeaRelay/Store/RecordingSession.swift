import Foundation
import SwiftData

/// Lifecycle of a single continuous `.m4a` capture.
enum RecordingStatus: String, Codable, CaseIterable, Sendable {
    /// A file is being written right now.
    case recording
    /// The user tapped Stop and the file was finalized.
    case completed
    /// The process died (or the session could not resume) before Stop.
    /// The metadata is recovered on next launch; the `.m4a` may be truncated.
    case interrupted
}

/// Metadata for one recording. Persisted to SwiftData so a killed process can
/// recover the pending recording on next launch (spec §12.1 / §13).
///
/// NOTE: this is the spike's minimal shape. The Hub's authoritative
/// `recordings` table (spec §5.1) is the eventual contract; keep field names
/// aligned when this graduates.
@Model
final class RecordingSession {
    var recordingID: UUID
    var startedAt: Date
    var endedAt: Date?
    /// Absolute path to the single continuous `.m4a` in the app container.
    var filePath: String
    var durationMs: Int
    var fileSizeBytes: Int
    /// Number of system interruptions (calls/alarms) observed during capture.
    var interruptionCount: Int
    /// Raw storage for `status` so it is queryable with `#Predicate`.
    var statusRaw: String
    var note: String?

    init(
        recordingID: UUID = UUID(),
        startedAt: Date = .now,
        filePath: String,
        status: RecordingStatus = .recording
    ) {
        self.recordingID = recordingID
        self.startedAt = startedAt
        self.endedAt = nil
        self.filePath = filePath
        self.durationMs = 0
        self.fileSizeBytes = 0
        self.interruptionCount = 0
        self.statusRaw = status.rawValue
    }

    var status: RecordingStatus {
        get { RecordingStatus(rawValue: statusRaw) ?? .interrupted }
        set { statusRaw = newValue.rawValue }
    }

    var fileURL: URL {
        URL(fileURLWithPath: filePath)
    }

    /// Recompute `fileSizeBytes` from disk (e.g. after a kill).
    func refreshFileSize() {
        let attrs = try? FileManager.default.attributesOfItem(atPath: filePath)
        fileSizeBytes = (attrs?[.size] as? NSNumber)?.intValue ?? 0
    }
}
