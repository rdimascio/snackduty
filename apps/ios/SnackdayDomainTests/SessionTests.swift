import Foundation
import SnackdayDomain
import Testing

private actor SessionSelectionStore: TeamSelectionStoring {
    var values: [String: TeamSeasonSelection] = [:]
    func selection(for personID: String) -> TeamSeasonSelection? { values[personID] }
    func saveSelection(_ selection: TeamSeasonSelection, for personID: String) { values[personID] = selection }
    func clearSelection(for personID: String) { values.removeValue(forKey: personID) }
}

private actor SessionTransport: SnackdayTransport {
    var currentIdentity: AdultIdentityDTO?
    var currentError: SnackdayAPIError?
    var signedOut = false
    private let signOutError: SnackdayAPIError?
    private let delaysSignOut: Bool
    private var pendingSignOut: CheckedContinuation<Void, Error>?
    let teams: TeamsResponse
    let roster: RosterResponse

    init(
        identity: AdultIdentityDTO? = sessionIdentity(),
        error: SnackdayAPIError? = nil,
        signOutError: SnackdayAPIError? = nil,
        delaysSignOut: Bool = false,
        teams: TeamsResponse = sessionTeams(),
        roster: RosterResponse = RosterResponse(roster: [])
    ) {
        currentIdentity = identity
        currentError = error
        self.signOutError = signOutError
        self.delaysSignOut = delaysSignOut
        self.teams = teams
        self.roster = roster
    }

    func currentSession() throws -> AdultIdentityDTO {
        if let currentError { throw currentError }
        guard let currentIdentity else { throw SnackdayAPIError.unauthorized }
        return currentIdentity
    }
    func beginAppleSignIn() -> AppleChallengeDTO {
        AppleChallengeDTO(challengeId: "challenge", nonce: "nonce")
    }
    func completeAppleSignIn(_ input: AppleSignInRequestDTO) throws -> AdultIdentityDTO {
        guard let currentIdentity else { throw SnackdayAPIError.unauthorized }
        return currentIdentity
    }
    func signOut() async throws {
        signedOut = true
        if delaysSignOut {
            try await withCheckedThrowingContinuation { pendingSignOut = $0 }
        }
        if let signOutError { throw signOutError }
    }
    func listTeams() -> TeamsResponse { teams }
    func loadRoster(teamId: String, seasonId: String) -> RosterResponse { roster }
    func isSignOutPending() -> Bool { pendingSignOut != nil }
    func finishSignOut() {
        pendingSignOut?.resume()
        pendingSignOut = nil
    }
}

private func sessionIdentity(
    accountID: String = "account_adult",
    personID: String = "person_adult"
) -> AdultIdentityDTO {
    AdultIdentityDTO(
        account: DevAccountDTO(id: accountID),
        person: DevPersonDTO(id: personID, displayName: "Adult")
    )
}

private func sessionTeams() -> TeamsResponse {
    let team = TeamDTO(
        id: "team_one",
        name: "Falcons",
        status: "active",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z"
    )
    let season = SeasonDTO(
        id: "season_one",
        teamId: team.id,
        label: "Fall 2026",
        startDate: "2026-09-01",
        endDate: "2026-12-01",
        timeZone: "America/Los_Angeles",
        status: "active",
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z"
    )
    return TeamsResponse(teams: [TeamWithSeasonsDTO(team: team, seasons: [season])])
}

@MainActor @Test func restoreLoadsCurrentSessionAndDirectory() async {
    let controller = SnackdayApplicationController(
        transport: SessionTransport(),
        selectionStore: SessionSelectionStore()
    )

    await controller.restore()

    guard case .ready(let identity, let directory, let snapshot) = controller.state else {
        Issue.record("Expected a ready restored session")
        return
    }
    #expect(identity.person.id == "person_adult")
    #expect(directory.selection == TeamSeasonSelection(teamID: "team_one", seasonID: "season_one"))
    #expect(snapshot.team.name == "Falcons")
}

@MainActor @Test func preparedAppleChallengeLeavesSignInFormVisible() async throws {
    let controller = SnackdayApplicationController(transport: SessionTransport(), selectionStore: SessionSelectionStore())
    _ = try await controller.beginAppleSignIn()
    #expect(controller.state == .signedOut)
}

@MainActor @Test func expiredOrRevokedSessionReturnsToSignedOut() async {
    let selections = SessionSelectionStore()
    await selections.saveSelection(
        TeamSeasonSelection(teamID: "team_one", seasonID: "season_one"),
        for: "person_adult"
    )
    let controller = SnackdayApplicationController(
        transport: SessionTransport(error: .unauthorized),
        selectionStore: selections
    )

    await controller.restore()

    #expect(controller.state == .signedOut)
}

@MainActor @Test func rejectedAppleCompletionSurfacesAnUnauthorizedFailure() async {
    let controller = SnackdayApplicationController(
        transport: SessionTransport(identity: nil),
        selectionStore: SessionSelectionStore()
    )

    await controller.completeAppleSignIn(
        challengeID: "challenge",
        identityToken: "rejected-token",
        displayName: nil,
        adultConsent: true
    )

    #expect(
        controller.state
            == .failed(identity: nil, directory: nil, failure: .unauthorized)
    )
}

@MainActor @Test func emptyTeamDirectoryIsAnHonestState() async {
    let controller = SnackdayApplicationController(
        transport: SessionTransport(teams: TeamsResponse(teams: [])),
        selectionStore: SessionSelectionStore()
    )

    await controller.restore()

    guard case .emptyTeams(let identity) = controller.state else {
        Issue.record("Expected an empty-teams state")
        return
    }
    #expect(identity.person.id == "person_adult")
}

@MainActor @Test func logoutClearsIdentityBoundSelection() async {
    let transport = SessionTransport()
    let selections = SessionSelectionStore()
    let controller = SnackdayApplicationController(transport: transport, selectionStore: selections)
    await controller.restore()

    await controller.signOut()

    #expect(controller.state == .signedOut)
    #expect(await transport.signedOut)
    #expect(await selections.selection(for: "person_adult") == nil)
}

@MainActor @Test func logoutClearsSignedInContextBeforeRevocationCompletes() async {
    let transport = SessionTransport(delaysSignOut: true)
    let selections = SessionSelectionStore()
    let controller = SnackdayApplicationController(transport: transport, selectionStore: selections)
    await controller.restore()

    let logout = Task { await controller.signOut() }
    for _ in 0..<1_000 {
        if await transport.isSignOutPending() { break }
        await Task.yield()
    }

    #expect(await transport.isSignOutPending())
    #expect(controller.state == .signingOut)
    #expect(await selections.selection(for: "person_adult") == nil)
    await transport.finishSignOut()
    await logout.value
    #expect(controller.state == .signedOut)
}

@MainActor @Test func failedLogoutLeavesNoSignedInContext() async {
    let transport = SessionTransport(signOutError: .offline)
    let selections = SessionSelectionStore()
    let controller = SnackdayApplicationController(transport: transport, selectionStore: selections)
    await controller.restore()

    await controller.signOut()

    #expect(controller.state == .failed(identity: nil, directory: nil, failure: .offline))
    #expect(await transport.signedOut)
    #expect(await selections.selection(for: "person_adult") == nil)
}

@MainActor @Test func staleLogoutCompletionCannotReplaceANewerRestoredSession() async {
    let transport = SessionTransport(delaysSignOut: true)
    let controller = SnackdayApplicationController(
        transport: transport,
        selectionStore: SessionSelectionStore()
    )
    await controller.restore()

    let logout = Task { await controller.signOut() }
    for _ in 0..<1_000 {
        if await transport.isSignOutPending() { break }
        await Task.yield()
    }
    #expect(await transport.isSignOutPending())

    await controller.restore()
    guard case .ready(let identity, _, _) = controller.state else {
        Issue.record("Expected the newer restored session to be ready")
        await transport.finishSignOut()
        await logout.value
        return
    }
    #expect(identity.person.id == "person_adult")

    await transport.finishSignOut()
    await logout.value
    guard case .ready(let finalIdentity, _, _) = controller.state else {
        Issue.record("A stale logout replaced the newer restored session")
        return
    }
    #expect(finalIdentity.person.id == "person_adult")
}

@MainActor @Test func safeFailuresNeverCarryServerPayloads() async {
    let controller = SnackdayApplicationController(
        transport: SessionTransport(error: .requestFailed(statusCode: 503)),
        selectionStore: SessionSelectionStore()
    )

    await controller.restore()

    #expect(
        controller.state
            == .failed(identity: nil, directory: nil, failure: .requestFailed(statusCode: 503))
    )
}

private actor DelayedChallengeTransport: SnackdayTransport {
    private var pending: CheckedContinuation<AppleChallengeDTO, Error>?
    func currentSession() -> AdultIdentityDTO { sessionIdentity() }
    func beginAppleSignIn() async throws -> AppleChallengeDTO {
        try await withCheckedThrowingContinuation { pending = $0 }
    }
    func completeAppleSignIn(_ input: AppleSignInRequestDTO) -> AdultIdentityDTO { sessionIdentity() }
    func signOut() {}
    func listTeams() -> TeamsResponse { sessionTeams() }
    func loadRoster(teamId: String, seasonId: String) -> RosterResponse { RosterResponse(roster: []) }
    func isPending() -> Bool { pending != nil }
    func fail() { pending?.resume(throwing: SnackdayAPIError.offline); pending = nil }
}

@MainActor @Test func lateChallengeFailureCannotReplaceRestoredSession() async throws {
    let transport = DelayedChallengeTransport()
    let controller = SnackdayApplicationController(transport: transport, selectionStore: SessionSelectionStore())
    let challenge = Task { try? await controller.beginAppleSignIn() }
    for _ in 0..<1_000 {
        if await transport.isPending() { break }
        await Task.yield()
    }
    #expect(await transport.isPending())
    await controller.restore()
    let restored = controller.state
    await transport.fail()
    _ = await challenge.value
    #expect(controller.state == restored)
}
