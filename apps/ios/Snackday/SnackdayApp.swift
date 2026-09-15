import SnackdayDomain
import SwiftUI

@main
struct SnackdayApp: App {
    private let controller: (any SnackdayApplicationControlling)?

    init() {
        var configuredURL = Bundle.main.object(forInfoDictionaryKey: "SNACKDAY_API_BASE_URL") as? String
#if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if ProcessInfo.processInfo.arguments.contains("-SNACKDAY_UI_TEST_FIXTURE") {
            controller = nil
            return
        }
        configuredURL = environment["SNACKDAY_API_BASE_URL"] ?? configuredURL
#endif
        guard let configuredURL, let url = URL(string: configuredURL), url.host != nil else {
            controller = nil
            return
        }
#if DEBUG
        if environment["SNACKDAY_DEV_SIGN_IN"] == "true" {
            controller = SnackdayApplicationController(transport: DevelopmentScenarioTransport(
                client: .development(baseURL: url)
            ))
            return
        }
#endif
        controller = SnackdayApplicationController(transport: SnackdayAPIClient(baseURL: url))
    }

    var body: some Scene {
        WindowGroup {
            if let controller {
                AppLaunchView(controller: controller)
            } else {
                AppLaunchView()
            }
        }
    }
}

#if DEBUG
/// An explicit, loopback-only development harness adapter, absent from Release.
private struct DevelopmentScenarioTransport: SnackdayTransport {
    let client: SnackdayAPIClient
    func currentSession() async throws -> AdultIdentityDTO {
        do { return try await client.currentSession() }
        catch SnackdayAPIError.unauthorized { return try await client.signInDevelopment() }
    }
    func beginAppleSignIn() async throws -> AppleChallengeDTO { try await client.beginAppleSignIn() }
    func completeAppleSignIn(_ input: AppleSignInRequestDTO) async throws -> AdultIdentityDTO {
        try await client.completeAppleSignIn(input)
    }
    func signOut() async throws { try await client.signOut() }
    func listTeams() async throws -> TeamsResponse { try await client.listTeams() }
    func loadRoster(teamId: String, seasonId: String) async throws -> RosterResponse {
        try await client.loadRoster(teamId: teamId, seasonId: seasonId)
    }
}
#endif
