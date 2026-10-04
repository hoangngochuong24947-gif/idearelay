import SwiftData
import SwiftUI

/// Detail for one inbox item: all payload fields, plus — for
/// requirement-kind items — the requirement's live status via
/// `GET /requirements`. Actions (accept/reject/reroute) also live here.
struct InboxItemDetailView: View {
    let record: InboxItemRecord
    let store: InboxStore

    @Environment(\.modelContext) private var modelContext
    @State private var requirements: [HubRequirement] = []
    @State private var requirementsError: String?
    @State private var rerouteTarget: InboxKind?

    private var item: InboxItem { record.item }

    var body: some View {
        List {
            Section("概要") {
                LabeledContent("类型", value: item.kind.label)
                LabeledContent("状态", value: statusLabel)
                LabeledContent("置信度", value: String(format: "%.0f%%", record.confidence * 100))
                if record.abstained {
                    LabeledContent("弃权", value: "是")
                }
                LabeledContent("时间", value: createdAtText)
            }

            if item.kind == .requirement {
                requirementSection
            }

            Section("字段") {
                ForEach(fieldRows, id: \.key) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.key)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(row.value)
                            .font(.footnote)
                            .textSelection(.enabled)
                    }
                }
            }

            Section {
                Button {
                    Task { await store.accept(record, context: modelContext) }
                } label: {
                    Label("接受", systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                }
                Menu {
                    ForEach(InboxKind.allCases, id: \.self) { kind in
                        Button("改为「\(kind.label)」") { rerouteTarget = kind }
                    }
                } label: {
                    Label("改判为其他类型…", systemImage: "arrow.triangle.2.circlepath")
                }
                Button(role: .destructive) {
                    Task { await store.reject(record, context: modelContext) }
                } label: {
                    Label("拒绝", systemImage: "xmark.circle")
                }
            } header: {
                Text("操作")
            } footer: {
                if item.status != .pending {
                    Text("仅待处理条目可以操作（Hub 对非 pending 返回 409）")
                }
            }
        }
        .navigationTitle("条目详情")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadRequirements() }
        .confirmationDialog(
            "改判为「\(rerouteTarget?.label ?? "")」？",
            isPresented: Binding(get: { rerouteTarget != nil }, set: { if !$0 { rerouteTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("确认改判") {
                guard let target = rerouteTarget else { return }
                rerouteTarget = nil
                Task { await store.reroute(record, to: target, context: modelContext) }
            }
            Button("取消", role: .cancel) { rerouteTarget = nil }
        }
    }

    // MARK: Requirement status

    @ViewBuilder
    private var requirementSection: some View {
        Section("关联需求") {
            if let error = requirementsError {
                Text("获取需求失败：\(error)")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            } else if let match = item.matchingRequirement(requirements) {
                LabeledContent("标题", value: match.title)
                LabeledContent("状态", value: match.status)
                LabeledContent("需求 ID", value: match.id)
                    .font(.footnote.monospaced())
                if let path = match.bodyPath {
                    LabeledContent("正文", value: path)
                        .font(.caption2.monospaced())
                }
            } else if requirements.isEmpty {
                Text("尚未拉取到需求列表")
                    .foregroundStyle(.secondary)
            } else {
                Text("未在 \(requirements.count) 条需求中找到对应项（subject_id: \(item.subjectID ?? "无")）")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                ForEach(requirements.prefix(5)) { requirement in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(requirement.title)
                            .font(.footnote)
                        Text("\(requirement.status) · \(requirement.id)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: Payload fields

    private var fieldRows: [(key: String, value: String)] {
        item.payload
            .sorted { $0.key < $1.key }
            .map { (key: $0.key, value: $0.value.displayText) }
    }

    private var statusLabel: String {
        switch item.status {
        case .pending: "待处理"
        case .accepted: "已接受"
        case .rejected: "已拒绝"
        case .rerouted: "已改判"
        }
    }

    private var createdAtText: String {
        Date(timeIntervalSince1970: record.createdAtMs / 1000)
            .formatted(date: .abbreviated, time: .standard)
    }

    private func loadRequirements() async {
        guard item.kind == .requirement else { return }
        do {
            requirements = try await InboxAPI().fetchRequirements()
            requirementsError = nil
        } catch let error as InboxAPIError {
            requirementsError = error.errorDescription ?? "\(error)"
        } catch {
            requirementsError = error.localizedDescription
        }
    }
}
