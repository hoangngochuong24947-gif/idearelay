import SwiftData
import SwiftUI

/// Minimal spike UI: start/stop, elapsed timer, and the resulting file's path
/// and size. No Uploader / Inbox / Tailscale — this slice exists to let the
/// owner record, lock the screen, and inspect the `.m4a`.
struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \RecordingSession.startedAt, order: .reverse)
    private var sessions: [RecordingSession]

    @State private var recorder = RecorderController()
    @State private var activeSession: RecordingSession?

    var body: some View {
        NavigationStack {
            List {
                recorderSection
                recordingsSection
            }
            .navigationTitle("IdeaRelay Spike")
        }
        .task {
            wirePersistence()
            recoverPendingSessions()
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
                }
                .padding(.vertical, 2)
            }
        }
    }

    // MARK: Persistence wiring

    private func wirePersistence() {
        recorder.onEvent = { event in
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
