import AVFAudio
import Foundation
import Observation

/// Records ONE continuous `.m4a` and survives the app being backgrounded /
/// lock-screened for the duration of the recording.
///
/// Design notes (see docs/spikes/iphone-background-recording.md):
/// - The audio session is configured and activated **in the foreground only**,
///   then left active. Apple DTS: the `audio` background category plus an active
///   session is all that is required to stay alive indefinitely; do not
///   deactivate on backgrounding.
/// - Never segment the file. On an interruption we pause; on resume we call
///   `record()` again, which appends to the same file. (Whether AVAudioRecorder
///   reliably appends after every interruption is one of the things the device
///   test must confirm.)
/// - A process kill cannot be caught, so the caller persists metadata on start
///   and on every state change, and recovers `status == .recording` rows on the
///   next launch.
@MainActor
@Observable
final class RecorderController {

    enum Event {
        case started(fileURL: URL)
        case interruptionBegan(count: Int)
        case resumed
        case stopped(durationMs: Int, fileSizeBytes: Int)
        case failed(message: String)
    }

    enum RecorderError: LocalizedError {
        case couldNotStart
        case permissionDenied

        var errorDescription: String? {
            switch self {
            case .couldNotStart: "AVAudioRecorder refused to start."
            case .permissionDenied: "Microphone permission was denied."
            }
        }
    }

    // MARK: Observable state

    private(set) var isRecording = false
    private(set) var interruptionCount = 0
    private(set) var currentFileURL: URL?
    private(set) var fileSizeBytes = 0
    private(set) var lastError: String?

    /// Called on the main actor for every lifecycle transition. The view uses
    /// this to keep SwiftData in sync. Set once by the view.
    var onEvent: ((Event) -> Void)?

    // MARK: Private state

    private var recorder: AVAudioRecorder?
    private var interruptionObserver: NSObjectProtocol?
    private var segmentStartedAt: Date?
    /// Seconds accumulated across completed segments (before any interruption).
    private var accumulated: TimeInterval = 0
    /// True from Start until Stop, independent of a transient interruption.
    private var sessionRequested = false

    /// Elapsed capture time, excluding interruption gaps. Re-read on a timer by
    /// the view; no internal ticking task.
    var elapsedSeconds: TimeInterval {
        accumulated + (isRecording ? Date.now.timeIntervalSince(segmentStartedAt ?? .now) : 0)
    }

    // MARK: Public API

    func start() {
        guard !sessionRequested else { return }
        lastError = nil
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                guard granted else {
                    let message = RecorderError.permissionDenied.localizedDescription
                    self.lastError = message
                    self.onEvent?(.failed(message: message))
                    return
                }
                self.beginRecording()
            }
        }
    }

    func stop() {
        guard sessionRequested else { return }
        sessionRequested = false
        finalizeAndReport()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// Surfaced by the view when a non-audio error occurs (e.g. SwiftData save).
    func reportExternalError(_ message: String) {
        lastError = message
    }

    // MARK: Recording setup

    private func beginRecording() {
        do {
            try configureAudioSession()
            let url = try makeFileURL()
            try beginRecorder(at: url)

            currentFileURL = url
            segmentStartedAt = .now
            accumulated = 0
            interruptionCount = 0
            isRecording = true
            sessionRequested = true
            installInterruptionObserver()
            onEvent?(.started(fileURL: url))
        } catch {
            lastError = error.localizedDescription
            sessionRequested = false
            teardownRecorder()
            onEvent?(.failed(message: error.localizedDescription))
        }
    }

    /// Configure + activate. Called only from the foreground.
    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        // `.playAndRecord` matches Apple's own background-recording sample apps
        // and leaves the door open to audition the clip later without a category
        // change. Recording-only would work too; `.default` mode is required.
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true, options: [])
    }

    private func makeFileURL() throws -> URL {
        let documents = try FileManager.default.url(
            for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        let directory = documents.appendingPathComponent("Recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = formatter.string(from: .now)
        let suffix = UUID().uuidString.prefix(8)
        return directory.appendingPathComponent("recording-\(stamp)-\(suffix).m4a")
    }

    private func beginRecorder(at url: URL) throws {
        let settings: [String: Any] = {
            var settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            #if targetEnvironment(simulator)
            // Simulator-only: setting AVEncoderBitRateKey hangs in
            // AudioQueueSetProperty (setBitRate) against the sim host's audio
            // HAL (observed on iOS 26.5 sim, process sample shows a blocked
            // mach_msg to the audio server). Device builds keep the explicit
            // 64 kbps target.
            #else
            settings[AVEncoderBitRateKey] = 64_000
            #endif
            return settings
        }()
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.prepareToRecord()
        guard recorder.record() else { throw RecorderError.couldNotStart }
        self.recorder = recorder
    }

    // MARK: Interruptions (calls, alarms, other nonmixable sessions)

    private func installInterruptionObserver() {
        removeInterruptionObserver()
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            // Extract Sendable primitives before crossing to the main actor;
            // `Notification` / its `userInfo` are not Sendable.
            let info = notification.userInfo
            let rawType = info?[AVAudioSessionInterruptionTypeKey] as? UInt
            Task { @MainActor in
                self?.handleInterruption(rawType: rawType)
            }
        }
    }

    private func removeInterruptionObserver() {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        interruptionObserver = nil
    }

    private func handleInterruption(rawType: UInt?) {
        guard
            let rawType,
            let type = AVAudioSession.InterruptionType(rawValue: rawType)
        else { return }

        switch type {
        case .began:
            // AVAudioRecorder stops itself; account for the live segment and
            // leave the session as-is (do NOT deactivate).
            accumulateCurrentSegment()
            isRecording = false
            interruptionCount += 1
            onEvent?(.interruptionBegan(count: interruptionCount))

        case .ended:
            // A recorder always wants to keep capturing, so attempt resume
            // regardless of `.shouldResume`; if the session cannot be
            // reactivated we finalize the file instead.
            resumeAfterInterruption()

        @unknown default:
            break
        }
    }

    private func resumeAfterInterruption() {
        guard sessionRequested, let recorder else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true, options: [])
            if recorder.record() {
                segmentStartedAt = .now
                isRecording = true
                onEvent?(.resumed)
            } else {
                finishDueToUnrecoverableInterruption()
            }
        } catch {
            finishDueToUnrecoverableInterruption()
        }
    }

    private func finishDueToUnrecoverableInterruption() {
        sessionRequested = false
        finalizeAndReport()
    }

    // MARK: Teardown

    /// Stops the recorder, reports the final numbers, and returns the duration.
    @discardableResult
    private func finalizeAndReport() -> Int {
        accumulateCurrentSegment()
        recorder?.stop()
        recorder = nil
        isRecording = false
        removeInterruptionObserver()
        segmentStartedAt = nil
        let durationMs = Int((accumulated * 1000).rounded())
        fileSizeBytes = currentFileSize()
        onEvent?(.stopped(durationMs: durationMs, fileSizeBytes: fileSizeBytes))
        return durationMs
    }

    private func teardownRecorder() {
        recorder?.stop()
        recorder = nil
        isRecording = false
        removeInterruptionObserver()
        segmentStartedAt = nil
    }

    private func accumulateCurrentSegment() {
        if isRecording, let segmentStartedAt {
            accumulated += Date.now.timeIntervalSince(segmentStartedAt)
        }
        segmentStartedAt = nil
    }

    private func currentFileSize() -> Int {
        guard let url = currentFileURL else { return 0 }
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? NSNumber)?.intValue ?? 0
    }
}
