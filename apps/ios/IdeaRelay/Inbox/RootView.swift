import SwiftUI

/// Root tabs: the Inbox is the first screen (spec §1.1 goal 6); the recorder +
/// uploader spike UI stays available as the second tab.
struct RootView: View {
    var body: some View {
        TabView {
            InboxView()
                .tabItem { Label("收件箱", systemImage: "tray") }
            ContentView()
                .tabItem { Label("录音", systemImage: "mic") }
        }
    }
}

#Preview {
    RootView()
        .modelContainer(for: [RecordingSession.self, InboxItemRecord.self, InboxSyncState.self], inMemory: true)
}
