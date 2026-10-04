import Foundation

/// Hub connection settings (spec §12.1 `Networking`).
///
/// Dev: plain HTTP against a locally started Hub (simulator).
/// Production: Tailscale HTTPS — `https://<machine>.<tailnet>.ts.net` (spec
/// §12.1; ADR-0008 explicitly bans bare IP/HTTP for the real deployment). The
/// ATS local-networking exception in Info.plist exists only for the dev case.
enum HubSettings {
    static let baseURLKey = "hubBaseURL"
    /// Matches the Hub's default (`IDEA_RELAY_HTTP_PORT`, 8787).
    static let defaultBaseURLString = "http://127.0.0.1:8787"

    /// The configured base URL, falling back to the default when unset or
    /// unparseable. Trailing slashes trimmed so join works predictably.
    static var baseURL: URL {
        let stored = UserDefaults.standard.string(forKey: baseURLKey)
            ?? defaultBaseURLString
        return sanitized(stored)
    }

    static func sanitized(_ raw: String) -> URL {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        guard let url = URL(string: trimmed), url.scheme != nil else {
            return URL(string: defaultBaseURLString)!
        }
        return url
    }
}
