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

/// Lifecycle of the tus upload of a finished recording to the Hub.
enum UploadState: String, Codable, CaseIterable, Sendable {
    /// Never enqueued (recording still in progress, or enqueue failed).
    case none
    /// Enqueued, waiting for TUSKit to schedule it.
    case queued
    /// Creation/PATCH in flight.
    case uploading
    /// Server accepted the final byte.
    case done
    /// Last attempt failed; retry pending (backoff) or via the UI button.
    case failed
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

    // MARK: Upload state (spec §12.1 Uploader: persist the tus upload URL so a
    // killed app resumes rather than restarts)

    /// Raw storage for `uploadState` so it is queryable with `#Predicate`.
    var uploadStateRaw: String = UploadState.none.rawValue
    /// TUSKit's per-upload identifier (stable across relaunches via TUSKit's
    /// own metadata store).
    var tusID: UUID?
    /// The tus upload URL the server returned at creation (the `Location`).
    /// Persisted here so a killed app can prove/observe resume state; TUSKit
    /// re-creates its own task list from its on-disk metadata store.
    var uploadURLString: String?
    /// Bytes confirmed by the server (from progress callbacks).
    var uploadedBytes: Int = 0
    /// Last failure message, shown with the Retry affordance.
    var lastUploadError: String?

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
        self.uploadStateRaw = UploadState.none.rawValue
    }

    var status: RecordingStatus {
        get { RecordingStatus(rawValue: statusRaw) ?? .interrupted }
        set { statusRaw = newValue.rawValue }
    }

    var uploadState: UploadState {
        get { UploadState(rawValue: uploadStateRaw) ?? .none }
        set { uploadStateRaw = newValue.rawValue }
    }

    var fileURL: URL {
        let url = URL(fileURLWithPath: filePath)
        if FileManager.default.fileExists(atPath: filePath) { return url }
        // App reinstall/restore can change the data-container UUID, leaving
        // the stored absolute path stale. Re-resolve by filename under the
        // current Documents/Recordings and heal the stored path.
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let candidate = documents
            .appendingPathComponent("Recordings", isDirectory: true)
            .appendingPathComponent(url.lastPathComponent)
        if FileManager.default.fileExists(atPath: candidate.path) {
            filePath = candidate.path
            return candidate
        }
        return url
    }

    /// Recompute `fileSizeBytes` from disk (e.g. after a kill).
    func refreshFileSize() {
        let attrs = try? FileManager.default.attributesOfItem(atPath: filePath)
        fileSizeBytes = (attrs?[.size] as? NSNumber)?.intValue ?? 0
    }
}
