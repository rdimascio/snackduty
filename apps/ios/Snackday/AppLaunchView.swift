import SnackdayDomain
import SwiftUI

/// Composition seam for launch data. When `SNACKDAY_API_BASE_URL` is present in
/// the process environment (for example `http://localhost:3000` while
/// `SNACKDAY_DEV_SIGN_IN=true bun run --filter web dev` is running), the app
/// signs in to the development session and loads the real team through the
/// authorized read APIs. Without it, the app renders the preview snapshot
/// exactly as before.
struct AppLaunchView: View {
    static let baseURLEnvironmentKey = "SNACKDAY_API_BASE_URL"

    private let liveBaseURL: URL?
    private let uiTestSnapshot: HomeSnapshot?

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = ProcessInfo.processInfo.arguments
    ) {
#if DEBUG
        uiTestSnapshot = arguments.contains("-SNACKDAY_UI_TEST_FIXTURE")
            ? Self.uiTestFixture
            : nil
#else
        uiTestSnapshot = nil
#endif
        liveBaseURL = uiTestSnapshot == nil ? Self.liveBaseURL(from: environment) : nil
    }

    var body: some View {
        if let uiTestSnapshot {
            AppRootView(snapshot: uiTestSnapshot)
        } else if let liveBaseURL {
            LiveHomeView(client: SnackdayAPIClient(baseURL: liveBaseURL))
        } else {
            AppRootView(snapshot: .preview)
        }
    }

    static func liveBaseURL(from environment: [String: String]) -> URL? {
        guard
            let raw = environment[baseURLEnvironmentKey]?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
        else {
            return nil
        }
        return URL(string: raw)
    }

#if DEBUG
    /// Synthetic, deterministic content for XCUITest. Keeping this behind the
    /// Debug compilation condition prevents test-success state from entering a
    /// release build, and the values contain no account or participant data.
    private static let uiTestFixture = HomeSnapshot(
        greeting: "UI test fixture",
        team: TeamSummary(name: "Fixture Team", season: "Fixture Season"),
        nextEvent: "Fixture practice",
        roster: [
            RosterMember(
                id: "fixture_private_guardians",
                displayName: "Private Fixture Player",
                guardians: [],
                guardianDetailsVisible: false
            ),
            RosterMember(
                id: "fixture_empty_guardians",
                displayName: "Empty Fixture Player",
                guardians: [],
                guardianDetailsVisible: true
            ),
        ]
    )
#endif
}

private struct LiveHomeView: View {
    enum Phase {
        case loading
        case loaded(HomeSnapshot)
        case failed(String)
    }

    let client: SnackdayAPIClient
    @State private var phase = Phase.loading

    var body: some View {
        switch phase {
        case .loading:
            ProgressView("Loading your team…")
                .task { await load() }
        case .loaded(let snapshot):
            AppRootView(snapshot: snapshot)
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn’t load your team", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { phase = .loading }
            }
        }
    }

    private func load() async {
        do {
            phase = .loaded(try await client.loadHomeSnapshot())
        } catch {
            // Static copy only — failure messages never carry response payloads,
            // so no roster or child data can surface here.
            phase = .failed(Self.failureMessage(for: error))
        }
    }

    static func failureMessage(for error: any Error) -> String {
        switch error {
        case SnackdayAPIError.unauthorized:
            "The development session was refused. Restart the server with SNACKDAY_DEV_SIGN_IN=true."
        case SnackdayAPIError.noTeamAvailable:
            "Signed in, but no team with a season exists yet. Create one in the web app first."
        case SnackdayAPIError.requestFailed(let statusCode):
            "The server responded with status \(statusCode)."
        case SnackdayAPIError.invalidResponse:
            "The server response could not be read."
        default:
            "The server could not be reached. Is it running at the configured URL?"
        }
    }
}
