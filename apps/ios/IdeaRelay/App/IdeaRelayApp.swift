import SwiftData
import SwiftUI

@main
struct IdeaRelayApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(for: [RecordingSession.self, InboxItemRecord.self, InboxSyncState.self])
    }
}
