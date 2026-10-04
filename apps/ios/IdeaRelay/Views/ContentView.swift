import OSLog
import SwiftData
import SwiftUI

private let log = Logger(subsystem: "dev.idearelay.IdeaRelay", category: "spike")

/// Minimal spike UI: start/stop, elapsed timer, and the resulting file's path
/// and size, plus per-recording upload state (spec §12.1 Uploader) and the Hub
/// URL setting (spec §12.1 Networking, dev-mode HTTP).
struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \RecordingSession.startedAt, order: .reverse)
    private var sessions: [RecordingSession]

    @State private var recorder = RecorderController()
    @State private var uploader = UploadCoordinator()
    @State private var activeSession: RecordingSession?
    @AppStorage(HubSettings.baseURLKey) private var hubURLString = HubSettings.defaultBaseURLString

    var body: some View {
        NavigationStack {
            List {
                recorderSection
                settingsSection
                recordingsSection
            }
            .navigationTitle("IdeaRelay Spike")
        }
        .task {
            wirePersistence()
            recoverPendingSessions()
            uploader.modelContext = modelContext
            uploader.recoverOnLaunch()
            await runSimulatorTestHookIfNeeded()
        }
        .onChange(of: hubURLString) {
            uploader.hubURLChanged()
        }
    }

    /// Headless test hook for simulator verification: launch with
    /// `-autoRecord <seconds>` to start a recording and stop it after the
    /// given duration (so the upload pipeline can be exercised without
    /// tapping the UI). No-op in normal launches.
    private func runSimulatorTestHookIfNeeded() async {
        let arguments = ProcessInfo.processInfo.arguments
        log.notice("[hook] arguments: \(arguments, privacy: .public)")
        guard let index = arguments.firstIndex(of: "-autoRecord"),
              index + 1 < arguments.count,
              let seconds = Double(arguments[index + 1]) else { return }
        log.notice("[hook] starting recording for \(seconds, privacy: .public)s")
        try? await Task.sleep(for: .seconds(1))
        recorder.start()
        try? await Task.sleep(for: .seconds(seconds))
        log.notice("[hook] stopping recording")
        recorder.stop()
        log.notice("[hook] stopped")
    }

    // MARK: Hub settings

    private var settingsSection: some View {
        Section("Hub") {
            TextField("Hub URL", text: $hubURLString)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.caption.monospaced())
            Text("Dev default \(HubSettings.defaultBaseURLString). Production uses Tailscale HTTPS.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Recorder

    private var recorderSection: some View {
        Section("Recorder") {
            TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                HStack(spacing: 10) {
                    Circle()
                        .fill(recorder.isRecording ? Color.red : Color.secondary)
                        .frame(width: 10, height: 10)
                    Text(recorder.isRecording ? "Recording" : "Idle")
                    Spacer()
                    Text(Self.durationString(recorder.elapsedSeconds))
                        .monospacedDigit()
                        .foregroundStyle(.primary)
                }
            }

            if recorder.interruptionCount > 0 {
                LabeledContent("Interruptions", value: "\(recorder.interruptionCount)")
                    .foregroundStyle(.orange)
            }

            if recorder.isRecording {
                Button("Stop recording", role: .destructive) {
                    recorder.stop()
                }
            } else {
                Button("Start recording") {
                    recorder.start()
                }
            }

            if let url = recorder.currentFileURL {
                LabeledContent("File", value: url.lastPathComponent)
                LabeledContent("Size", value: Self.byteString(recorder.fileSizeBytes))
                Text(url.path)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            if let error = recorder.lastError {
                Text(error).foregroundStyle(.red).font(.footnote)
            }

            Text("Lock the screen after starting. The recording continues in the background; interruptions (calls, alarms) are counted.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Recordings

    private var recordingsSection: some View {
        Section("Recordings (\(sessions.count))") {
            if sessions.isEmpty {
                Text("No recordings yet").foregroundStyle(.secondary)
            }
            ForEach(sessions) { session in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(session.startedAt.formatted(date: .abbreviated, time: .standard))
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(statusLabel(session.status))
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(statusColor(session.status).opacity(0.18), in: Capsule())
                            .foregroundStyle(statusColor(session.status))
                    }
                    Text("\(Self.durationString(Double(session.durationMs) / 1000)) · \(Self.byteString(session.fileSizeBytes))"
                         + (session.interruptionCount > 0 ? " · \(session.interruptionCount) interruption(s)" : ""))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(session.filePath)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    uploadRow(session)
                }
                .padding(.vertical, 2)
            }
        }
    }

    // MARK: Upload state per recording

    @ViewBuilder
    private func uploadRow(_ session: RecordingSession) -> some View {
        HStack(spacing: 8) {
            switch session.uploadState {
            case .none:
                EmptyView()
            case .queued:
                ProgressView().controlSize(.small)
                Text("Upload queued")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .uploading:
                ProgressView(value: uploadFraction(session))
                    .progressViewStyle(.linear)
                Text("\(Int((uploadFraction(session) * 100).rounded()))%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            case .done:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
                Text("Uploaded")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .font(.caption)
                Text("Upload failed")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Spacer()
                Button("Retry") {
                    uploader.retry(session)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        if let error = session.lastUploadError {
            Text(error)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func uploadFraction(_ session: RecordingSession) -> Double {
        guard session.fileSizeBytes > 0 else { return 0 }
        return min(1, Double(session.uploadedBytes) / Double(session.fileSizeBytes))
    }

    // MARK: Persistence wiring

    private func wirePersistence() {
        recorder.onEvent = { event in
            log.notice("[recorder event] \(String(describing: event), privacy: .public)")
            switch event {
            case .started(let fileURL):
                let session = RecordingSession(startedAt: .now, filePath: fileURL.path)
                modelContext.insert(session)
                activeSession = session
                save()

            case .interruptionBegan(let count):
                activeSession?.interruptionCount = count
                save()

            case .resumed:
                save()

            case .stopped(let durationMs, let fileSizeBytes):
                if let session = activeSession {
                    session.endedAt = .now
                    session.durationMs = durationMs
                    session.fileSizeBytes = fileSizeBytes
                    session.status = .completed
                    // Session ended -> enqueue for tus upload (spec §13 step 2).
                    uploader.enqueue(session)
                }
                save()
                activeSession = nil

            case .failed:
                save()
            }
        }
    }

    /// A process killed mid-recording leaves a row in `.recording`. Mark it
    /// `.interrupted`, refresh the on-disk size, and keep the path so the file
    /// can still be retrieved from the app container.
    private func recoverPendingSessions() {
        let descriptor = FetchDescriptor<RecordingSession>(
            predicate: #Predicate { $0.statusRaw == "recording" }
        )
        guard let pending = try? modelContext.fetch(descriptor), !pending.isEmpty else { return }
        for session in pending {
            session.status = .interrupted
            session.endedAt = session.endedAt ?? .now
            session.refreshFileSize()
        }
        save()
    }

    private func save() {
        do {
            try modelContext.save()
        } catch {
            recorder.reportExternalError("SwiftData save failed: \(error.localizedDescription)")
        }
    }

    // MARK: Formatting

    private func statusLabel(_ status: RecordingStatus) -> String {
        switch status {
        case .recording: "REC"
        case .completed: "DONE"
        case .interrupted: "INTERRUPTED"
        }
    }

    private func statusColor(_ status: RecordingStatus) -> Color {
        switch status {
        case .recording: .red
        case .completed: .green
        case .interrupted: .orange
        }
    }

    private static func durationString(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%02d:%02d", m, s)
    }

    private static func byteString(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

#Preview {
    ContentView()
        .modelContainer(for: RecordingSession.self, inMemory: true)
}
