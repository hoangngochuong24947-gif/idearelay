import SwiftData
import SwiftUI

@main
struct IdeaRelayApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: RecordingSession.self)
    }
}
