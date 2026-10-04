import Foundation
import Observation
import SwiftData
import TUSKit

/// Owns the tus upload queue (spec §12.1 `Uploader`): enqueues finished
/// recordings, reports progress into SwiftData, retries with backoff, and
/// recovers in-flight uploads after a process kill.
///
/// Concurrency / lifecycle trade-off (spec §12.2): uploads run **in the app
/// process** with a normal (non-background) URLSession. While a recording is
/// active the app stays alive anyway (audio background mode), so the upload
/// window overlaps the recorder. If the app is killed mid-upload, TUSKit's
/// on-disk metadata store (which includes the server-issued tus upload URL and
/// last committed offset) plus `TUSClient.start()` on next launch resume the
/// upload from the persisted offset instead of restarting. Background
/// `URLSession` upload tasks + VPN are undocumented territory, so we don't
/// rely on them (ADR-0008 consequence).
///
/// Retry policy: TUSKit retries internally a few times; on top of that this
/// coordinator applies exponential backoff (5 s doubling, capped at 5 min) and
/// calls `retry(id:)`, which resumes from the server-confirmed offset via a
/// tus HEAD request. When the device is offline the backoff loop keeps the
/// upload queued until connectivity returns.
@MainActor
@Observable
final class UploadCoordinator {

    /// Backoff bounds, seconds.
    private let backoffBase: TimeInterval = 5
    private let backoffCap: TimeInterval = 5 * 60

    private(set) var hubURL: URL = HubSettings.baseURL

    /// Mirror of the TUSClient's (private) `serverURL`, for change detection.
    private var currentServerURL: URL?

    /// Set by the view (main actor) after the model container exists.
    var modelContext: ModelContext?

    private var tus: TUSClient?
    /// TUSKit upload id -> our RecordingSession id. TUSKit's `context`
    /// (`recordingID` key) is the durable carrier of this mapping across
    /// relaunches; this dict is the in-memory cache.
    private var idMap: [UUID: UUID] = [:]
    private var backoffTasks: [UUID: Task<Void, Never>] = [:]
    private var backoffAttempts: [UUID: Int] = [:]

    // MARK: Setup

    /// (Re)create the TUSClient. Called on launch and when the Hub URL
    /// setting changes. Existing TUSKit-persisted tasks are re-scheduled by
    /// `recoverOnLaunch()`; a URL change only affects new creations.
    func configure() {
        let url = HubSettings.baseURL
        hubURL = url
        // TUSKit's `server:` param is the full tus creation endpoint (it POSTs
        // there directly), not the Hub base URL. The Hub serves tus at
        // /upload (spec §11).
        let tusURL = url.appending(path: "upload")
        guard tus == nil || currentServerURL != tusURL else { return }
        currentServerURL = tusURL
        let config = URLSessionConfiguration.default
        // NOTE: do NOT set waitsForConnectivity. With it enabled, URLSession
        // can park tasks indefinitely in this environment (path reported
        // satisfied yet tasks never started — reproduced in a host-side CLI
        // repro with TUSKit 3.7.0). Offline attempts fail fast instead
        // (-1009/-1004), which our exponential-backoff retry loop expects.
        config.timeoutIntervalForResource = 24 * 60 * 60
        do {
            // In-app (foreground-style) session on purpose; see class doc.
            tus = try TUSClient(
                server: tusURL,
                storageDirectory: nil, // default Documents/TUS
                session: URLSession(configuration: config),
                chunkSize: 64 * 1024
            )
            tus?.delegate = self
        } catch {
            // TUSClient init only throws on storage-directory problems;
            // surface via sessions' error field when we next touch them.
        }
    }

    /// Re-schedule uploads TUSKit persisted before a kill, then enqueue any
    /// finished recording that has no live TUSKit task ("联网即从队列重传").
    func recoverOnLaunch() {
        configure()
        guard let tus else { return }

        let resumed = tus.start()
        for (tusID, context) in resumed {
            if let rid = recordingID(fromContext: context) {
                idMap[tusID] = rid
                updateSession(rid) { session in
                    if session.uploadState != .done {
                        session.uploadState = .queued
                        session.lastUploadError = nil
                    }
                }
            }
        }
        mirrorStoredUploadURLs()

        // Enqueue finished recordings that TUSKit did not resume. Covers
        // first launch after the spike upgrade (uploadState == .none) and
        // sessions whose TUSKit metadata was dropped (e.g. error cap).
        guard let modelContext else { return }
        let descriptor = FetchDescriptor<RecordingSession>()
        do {
            let all = try modelContext.fetch(descriptor)
            for session in all where needsEnqueue(session) {
                enqueue(session)
            }
        } catch {
            // Fetch failure is not recoverable here; UI still shows states.
        }
    }

    private func needsEnqueue(_ session: RecordingSession) -> Bool {
        let finished = session.status == .completed || session.status == .interrupted
        let pending = session.uploadState != .done
        let notLive = !idMap.values.contains(session.recordingID)
        return finished && pending && notLive
    }

    // MARK: Enqueue / retry

    /// Enqueue one recording for upload. Safe to call repeatedly; sessions
    /// already tracked (or done) are skipped.
    func enqueue(_ session: RecordingSession) {
        configure()
        guard let tus else {
            session.uploadState = .failed
            session.lastUploadError = "Uploader unavailable"
            return
        }
        guard session.uploadState != .done,
              !idMap.values.contains(session.recordingID) else { return }
        guard FileManager.default.fileExists(atPath: session.fileURL.path) else {
            session.uploadState = .failed
            session.lastUploadError = "Recording file missing"
            return
        }

        session.uploadState = .queued
        session.lastUploadError = nil
        do {
            // TUSKit copies the file into its own storage and persists
            // metadata (Upload-Metadata: filename, filetype) before any
            // network activity, so a kill right after enqueue still resumes.
            let tusID = try tus.uploadFileAt(
                filePath: session.fileURL,
                context: ["recordingID": session.recordingID.uuidString]
            )
            idMap[tusID] = session.recordingID
            session.tusID = tusID
        } catch {
            session.uploadState = .failed
            session.lastUploadError = error.localizedDescription
        }
    }

    /// UI Retry: re-schedule from the last committed offset.
    func retry(_ session: RecordingSession) {
        configure()
        guard let tus else { return }
        session.lastUploadError = nil
        session.uploadState = .queued

        if let tusID = session.tusID {
            // TUSKit retry loads metadata from its store (which carries the
            // persisted upload URL + offset) and re-schedules; resumes, not
            // restarts.
            if (try? tus.retry(id: tusID)) == true {
                idMap[tusID] = session.recordingID
                return
            }
        }
        // No usable TUSKit task (never created / metadata gone): start over.
        session.tusID = nil
        session.uploadedBytes = 0
        idMap = idMap.filter { $0.value != session.recordingID }
        enqueue(session)
    }

    /// Called by the view when the Hub URL setting changes.
    func hubURLChanged() {
        let url = HubSettings.baseURL
        guard url != hubURL else { return }
        // Keep pending uploads pointed at the new base for future creations.
        configure()
    }

    // MARK: Delegate bridges (called from TUSKit delegate below)

    private func handleDidStart(tusID: UUID, context: [String: String]?) {
        backoffTasks[tusID]?.cancel()
        backoffTasks[tusID] = nil
        backoffAttempts[tusID] = 0
        if let rid = recordingID(fromContext: context) {
            idMap[tusID] = rid
        }
        mirrorStoredUploadURLs()
        if let rid = idMap[tusID] {
            updateSession(rid) { $0.uploadState = .uploading }
        }
    }

    private func handleProgress(tusID: UUID, uploaded: Int, total: Int) {
        guard let rid = idMap[tusID] else { return }
        updateSession(rid) {
            $0.uploadState = .uploading
            $0.uploadedBytes = uploaded
            $0.fileSizeBytes = max($0.fileSizeBytes, total)
        }
        // By first progress the creation has certainly happened; keep the
        // persisted tus Location fresh (spec §12.1).
        mirrorStoredUploadURLs()
    }

    private func handleFinished(tusID: UUID) {
        guard let rid = idMap[tusID] else { return }
        backoffTasks[tusID]?.cancel()
        backoffTasks[tusID] = nil
        backoffAttempts[tusID] = nil
        updateSession(rid) {
            $0.uploadState = .done
            $0.uploadedBytes = $0.fileSizeBytes
            $0.lastUploadError = nil
        }
        idMap[tusID] = nil
    }

    private func handleFailed(tusID: UUID, message: String, context: [String: String]?) {
        let rid = idMap[tusID] ?? recordingID(fromContext: context)
        guard let rid else { return }
        updateSession(rid) {
            $0.uploadState = .failed
            $0.lastUploadError = message
        }
        scheduleBackoffRetry(tusID: tusID, recordingID: rid)
    }

    // MARK: Backoff

    private func scheduleBackoffRetry(tusID: UUID, recordingID: UUID) {
        backoffTasks[tusID]?.cancel()
        let attempt = (backoffAttempts[tusID] ?? 0) + 1
        backoffAttempts[tusID] = attempt
        let delay = min(backoffCap, backoffBase * pow(2, Double(attempt - 1)))
        backoffTasks[tusID] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.performBackoffRetry(tusID: tusID, recordingID: recordingID)
        }
    }

    private func performBackoffRetry(tusID: UUID, recordingID: UUID) {
        guard let tus, idMap[tusID] == recordingID else { return }
        if (try? tus.retry(id: tusID)) == true {
            // Rescheduled from persisted offset; uploadFailed will fire again
            // (with a fresh backoff) if it keeps failing.
            return
        }
        // TUSKit no longer has this upload (metadata dropped): restart.
        idMap[tusID] = nil
        if let session = fetchSession(recordingID) {
            session.tusID = nil
            enqueue(session)
        }
    }

    // MARK: SwiftData helpers

    private func updateSession(_ recordingID: UUID, mutate: (RecordingSession) -> Void) {
        guard let session = fetchSession(recordingID) else { return }
        mutate(session)
        try? modelContext?.save()
    }

    private func fetchSession(_ recordingID: UUID) -> RecordingSession? {
        guard let modelContext else { return nil }
        var descriptor = FetchDescriptor<RecordingSession>(
            predicate: #Predicate { $0.recordingID == recordingID }
        )
        descriptor.fetchLimit = 1
        return try? modelContext.fetch(descriptor).first
    }

    /// Copy TUSKit's persisted tus upload URL (the creation `Location`) into
    /// SwiftData — the spec §12.1 "持久化 upload URL" requirement. TUSKit does
    /// the actual resuming from its own store; this mirror makes the state
    /// visible/queryable and survives even if TUSKit's cache is cleared.
    private func mirrorStoredUploadURLs() {
        guard let modelContext, let tus else { return }
        let stored = (try? tus.getStoredUploads()) ?? []
        for info in stored {
            guard let rid = recordingID(fromContext: info.context) else { continue }
            let location = info.remoteDestination ?? info.uploadURL
            updateSession(rid) {
                $0.uploadURLString = location.absoluteString
            }
        }
    }

    private func recordingID(fromContext context: [String: String]?) -> UUID? {
        context?["recordingID"].flatMap(UUID.init(uuidString:))
    }
}

// MARK: - TUSClientDelegate

extension UploadCoordinator: TUSClientDelegate {

    /// TUSKit reports on the main queue but the protocol is nonisolated; hop
    /// Sendable primitives to the main actor and drop the client reference.
    nonisolated private func hop(_ body: @escaping @MainActor () -> Void) {
        Task { @MainActor in body() }
    }

    nonisolated func didStartUpload(id: UUID, context: [String: String]?, client: TUSClient) {
        hop { self.handleDidStart(tusID: id, context: context) }
    }

    nonisolated func didFinishUpload(id: UUID, url: URL, context: [String: String]?, client: TUSClient) {
        hop { self.handleFinished(tusID: id) }
    }

    nonisolated func uploadFailed(id: UUID, error: Error, context: [String: String]?, client: TUSClient) {
        let message = error.localizedDescription
        hop { self.handleFailed(tusID: id, message: message, context: context) }
    }

    nonisolated func fileError(error: TUSClientError, client: TUSClient) {
        // File-level errors without an upload id: nothing per-session to do.
    }

    nonisolated func fileError(id: UUID?, error: TUSClientError, client: TUSClient) {
        guard let id else { return }
        let message = error.localizedDescription
        hop { [weak self] in
            guard let self, let rid = self.idMap[id] else { return }
            self.updateSession(rid) {
                $0.uploadState = .failed
                $0.lastUploadError = message
            }
            self.scheduleBackoffRetry(tusID: id, recordingID: rid)
        }
    }

    nonisolated func totalProgress(bytesUploaded: Int, totalBytes: Int, client: TUSClient) {
        // Per-file progress is what the UI shows; aggregate not needed.
    }

    nonisolated func progressFor(id: UUID, context: [String: String]?, bytesUploaded: Int, totalBytes: Int, client: TUSClient) {
        hop { self.handleProgress(tusID: id, uploaded: bytesUploaded, total: totalBytes) }
    }
}
