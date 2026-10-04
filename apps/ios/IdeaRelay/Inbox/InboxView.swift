import OSLog
import SwiftData
import SwiftUI

private let log = Logger(subsystem: "dev.idearelay.IdeaRelay", category: "inbox")

/// The app's first screen (spec §1.1 goal 6: 首页是 Inbox，不是录音列表).
/// Grouped by kind with counts (§9), pending items first; pull-to-refresh and
/// a 15s foreground poll via `/changes?since=`.
struct InboxView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Query(sort: \InboxItemRecord.createdAtMs, order: .reverse)
    private var records: [InboxItemRecord]

    @State private var store = InboxStore()

    var body: some View {
        NavigationStack {
            Group {
                if records.isEmpty {
                    ContentUnavailableView(
                        "收件箱为空",
                        systemImage: "tray",
                        description: Text("录音上传并完成识别后，分类条目会出现在这里")
                    )
                } else {
                    groupedLists
                }
            }
            .navigationTitle("收件箱")
            .toolbar { toolbarContent }
            .overlay(alignment: .top) { feedbackBanner }
            .refreshable { await store.refresh(context: modelContext) }
            .task { await initialSyncAndPoll() }
            .onChange(of: scenePhase) { _, phase in
                store.isForegrounded = phase == .active
            }
        }
    }

    // MARK: List

    private var groupedLists: some View {
        List {
            ForEach(grouped, id: \.kind) { group in
                Section(group.title) {
                    // Pending first, then newest first.
                    let ordered = group.items.sorted {
                        let a = $0.item.status == .pending
                        let b = $1.item.status == .pending
                        if a != b { return a }
                        return $0.createdAtMs > $1.createdAtMs
                    }
                    ForEach(ordered) { record in
                        NavigationLink(value: record.id) {
                            InboxRowView(record: record)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            actionButtons(record)
                        }
                    }
                }
            }
        }
        .navigationDestination(for: String.self) { id in
            if let record = records.first(where: { $0.id == id }) {
                InboxItemDetailView(record: record, store: store)
            }
        }
    }

    private struct KindGroup {
        let kind: InboxKind
        let items: [InboxItemRecord]
        var title: String {
            let n = items.count
            switch kind {
            case .requirement: return "识别 \(n) 个需求"
            case .task: return "\(n) 个疑似任务"
            case .idea: return "\(n) 个普通想法"
            case .question: return "\(n) 个问题"
            case .reference: return "\(n) 个参考"
            case .log: return "\(n) 个日志"
            case .unknown: return "\(n) 个低置信"
            }
        }
    }

    private var grouped: [KindGroup] {
        let byKind = Dictionary(grouping: records, by: \.item.kind)
        return InboxKind.allCases
            .filter { (byKind[$0]?.isEmpty == false) }
            .map { KindGroup(kind: $0, items: byKind[$0] ?? []) }
    }

    // MARK: Actions

    @ViewBuilder
    private func actionButtons(_ record: InboxItemRecord) -> some View {
        Button {
            Task { await store.accept(record, context: modelContext) }
        } label: {
            Label("接受", systemImage: "checkmark")
        }
        .tint(.green)

        Menu {
            ForEach(InboxKind.allCases, id: \.self) { kind in
                Button("改为「\(kind.label)」") {
                    Task { await store.reroute(record, to: kind, context: modelContext) }
                }
            }
        } label: {
            Label("改判", systemImage: "arrow.triangle.2.circlepath")
        }

        Button(role: .destructive) {
            Task { await store.reject(record, context: modelContext) }
        } label: {
            Label("拒绝", systemImage: "xmark")
        }
        .tint(.red)
    }

    // MARK: Chrome

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                NavigationLink("Hub 设置") {
                    HubSettingsView()
                }
            } label: {
                Image(systemName: "gearshape")
            }
        }
    }

    @ViewBuilder
    private var feedbackBanner: some View {
        if let feedback = store.feedback {
            Text(feedback.text)
                .font(.footnote)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(feedback.isError ? Color.red.opacity(0.15) : Color.accentColor.opacity(0.15), in: Capsule())
                .foregroundStyle(feedback.isError ? .red : .primary)
                .padding(.top, 4)
                .transition(.opacity.combined(with: .move(edge: .top)))
                .animation(.easeInOut(duration: 0.2), value: feedback)
        }
    }

    // MARK: Sync lifecycle

    /// Full pull on appear, then an incremental `/changes` poll every 15s
    /// while the scene stays foregrounded.
    private func initialSyncAndPoll() async {
        store.isForegrounded = scenePhase == .active
        await store.refresh(context: modelContext)
        await runSimulatorTestHookIfNeeded()
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(15))
            guard store.isForegrounded, !Task.isCancelled else { continue }
            await store.pollChanges(context: modelContext)
        }
    }

    /// Headless test hook for simulator verification (same pattern as the
    /// recorder's `-autoRecord`): launch with `-autoInboxAction accept|reject`
    /// to run that action on the first pending item through the real
    /// `InboxAPI` POST path. No-op in normal launches.
    private func runSimulatorTestHookIfNeeded() async {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-autoInboxAction"),
              index + 1 < arguments.count else { return }
        let action = arguments[index + 1]
        guard let record = records.first(where: { $0.item.status == .pending }) else {
            log.notice("[hook] no pending inbox item for \(action, privacy: .public)")
            return
        }
        log.notice("[hook] \(action, privacy: .public) on \(record.id, privacy: .public)")
        switch action {
        case "accept":
            await store.accept(record, context: modelContext)
        case "reject":
            await store.reject(record, context: modelContext)
        case let reroute where reroute.hasPrefix("reroute:"):
            let kind = InboxKind(rawValue: String(reroute.dropFirst("reroute:".count))) ?? .task
            await store.reroute(record, to: kind, context: modelContext)
        default:
            log.notice("[hook] unknown action \(action, privacy: .public)")
        }
    }
}

// MARK: - Row

struct InboxRowView: View {
    let record: InboxItemRecord
    private var item: InboxItem { record.item }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                kindBadge
                if record.abstained {
                    Label("弃权", systemImage: "questionmark.circle")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                if record.item.status != .pending {
                    Text(statusLabel)
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(Self.relativeTime(record.createdAtMs))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Text(record.item.summary ?? "（无摘要）")
                .font(.subheadline)
                .lineLimit(2)
                .foregroundStyle(record.item.status == .pending ? .primary : .secondary)

            HStack(spacing: 6) {
                ProgressView(value: max(0.01, record.confidence))
                    .progressViewStyle(.linear)
                    .tint(record.confidence >= 0.7 ? .green : record.confidence >= 0.4 ? .orange : .red)
                Text(String(format: "%.0f%%", record.confidence * 100))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 34, alignment: .trailing)
            }
        }
        .padding(.vertical, 2)
    }

    private var statusLabel: String {
        switch record.item.status {
        case .pending: ""
        case .accepted: "已接受"
        case .rejected: "已拒绝"
        case .rerouted: "已改判"
        }
    }

    private var kindBadge: some View {
        Text(item.kind.label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color.blue.opacity(0.15), in: Capsule())
            .foregroundStyle(.blue)
    }

    private static func relativeTime(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}

// MARK: - Hub settings (reused key; also reachable from the 录音 tab)

struct HubSettingsView: View {
    @AppStorage(HubSettings.baseURLKey) private var hubURLString = HubSettings.defaultBaseURLString

    var body: some View {
        Form {
            Section("Hub 地址") {
                TextField("Hub URL", text: $hubURLString)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.caption.monospaced())
            }
            Section {
                Text("开发环境默认 \(HubSettings.defaultBaseURLString)。生产环境走 Tailscale HTTPS；MVP 不做鉴权，tailnet 即边界（ADR-0001）。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Hub 设置")
    }
}
