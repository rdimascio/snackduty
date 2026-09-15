import SnackdayDomain
import SwiftUI

@main
struct SnackdayApp: App {
    private let controller: (any SnackdayApplicationControlling)?
    private let invitationTransport: (any SnackdayInvitationTransport)?
    private let coordinationController: (any SnackdayCoordinationControlling)?

    init() {
        var configuredURL = Bundle.main.object(forInfoDictionaryKey: "SNACKDAY_API_BASE_URL") as? String
#if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if ProcessInfo.processInfo.arguments.contains("-SNACKDAY_UI_TEST_FIXTURE") {
            controller = nil
            invitationTransport = nil
            coordinationController = nil
            return
        }
        configuredURL = environment["SNACKDAY_API_BASE_URL"] ?? configuredURL
#endif
        guard let configuredURL, let url = URL(string: configuredURL), url.host != nil else {
            controller = nil
            invitationTransport = nil
            coordinationController = nil
            return
        }
#if DEBUG
        if environment["SNACKDAY_DEV_SIGN_IN"] == "true" {
            let client = SnackdayAPIClient.development(baseURL: url)
            controller = SnackdayApplicationController(transport: DevelopmentScenarioTransport(
                client: client, explicitPersona: environment["SNACKDAY_DEV_PERSONA"]
            ))
            invitationTransport = client
            coordinationController = SnackdayCoordinationController(transport: client)
            return
        }
#endif
        let client = SnackdayAPIClient(baseURL: url)
        controller = SnackdayApplicationController(transport: client)
        invitationTransport = client
        coordinationController = SnackdayCoordinationController(transport: client)
    }

    var body: some Scene {
        WindowGroup {
            if let controller {
                AppLaunchView(controller: controller, invitationTransport: invitationTransport,
                              coordinationController: coordinationController)
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
    let explicitPersona: String?
    func currentSession() async throws -> AdultIdentityDTO {
        // Only a deliberately configured local scenario may choose a persona.
        // The server enforces the bounded allowlist; Release omits this adapter.
        if let explicitPersona { return try await client.signInDevelopment(persona: explicitPersona) }
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
