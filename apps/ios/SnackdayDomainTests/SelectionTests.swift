import Foundation
import SnackdayDomain
import Testing

private actor SelectionMemoryStore: TeamSelectionStoring {
    var values: [String: TeamSeasonSelection] = [:]
    func selection(for personID: String) -> TeamSeasonSelection? { values[personID] }
    func saveSelection(_ selection: TeamSeasonSelection, for personID: String) { values[personID] = selection }
    func clearSelection(for personID: String) { values.removeValue(forKey: personID) }
}

private actor DelayedRosterTransport: SnackdayTransport {
    let identity = AdultIdentityDTO(
        account: DevAccountDTO(id: "account_dual"),
        person: DevPersonDTO(id: "person_dual", displayName: "Coach Parent")
    )
    let teams: TeamsResponse
    private var continuations: [String: CheckedContinuation<RosterResponse, Error>] = [:]

    init(teams: TeamsResponse = selectionTeams()) { self.teams = teams }

    func currentSession() -> AdultIdentityDTO { identity }
    func beginAppleSignIn() -> AppleChallengeDTO {
        AppleChallengeDTO(challengeId: "challenge", nonce: "nonce")
    }
    func completeAppleSignIn(_ input: AppleSignInRequestDTO) -> AdultIdentityDTO { identity }
    func signOut() {}
    func listTeams() -> TeamsResponse { teams }
    func loadRoster(teamId: String, seasonId: String) async throws -> RosterResponse {
        try await withCheckedThrowingContinuation { continuation in
            continuations[teamId] = continuation
        }
    }

    func hasPendingRoster(for teamID: String) -> Bool { continuations[teamID] != nil }
    func finishRoster(for teamID: String, player: String) {
        continuations.removeValue(forKey: teamID)?.resume(
            returning: RosterResponse(roster: [
                RosterParticipantDTO(
                    participantId: "participant_\(teamID)",
                    displayName: player,
                    birthDate: nil,
                    status: "active",
                    guardians: []
                )
            ])
        )
    }
}

private func selectionTeams() -> TeamsResponse {
    func entry(teamID: String, seasonID: String, name: String) -> TeamWithSeasonsDTO {
        let team = TeamDTO(
            id: teamID,
            name: name,
            status: "active",
            createdAt: "2026-09-14T00:00:00.000Z",
            updatedAt: "2026-09-14T00:00:00.000Z"
        )
        return TeamWithSeasonsDTO(
            team: team,
            seasons: [
                SeasonDTO(
                    id: seasonID,
                    teamId: teamID,
                    label: "Fall 2026",
                    startDate: "2026-09-01",
                    endDate: "2026-12-01",
                    timeZone: "America/Los_Angeles",
                    status: "active",
                    createdAt: "2026-09-14T00:00:00.000Z",
                    updatedAt: "2026-09-14T00:00:00.000Z"
                )
            ]
        )
    }
    return TeamsResponse(teams: [
        entry(teamID: "team_coached", seasonID: "season_coached", name: "Falcons"),
        entry(teamID: "team_family", seasonID: "season_family", name: "Comets"),
    ])
}

@Test func userDefaultsSelectionsAreScopedPerAdult() async throws {
    let suite = "snackday-selection-tests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = UserDefaultsTeamSelectionStore(suiteName: suite, keyPrefix: "test.")
    let coached = TeamSeasonSelection(teamID: "team_coached", seasonID: "season_coached")
    let family = TeamSeasonSelection(teamID: "team_family", seasonID: "season_family")

    await store.saveSelection(coached, for: "person_coach")
    await store.saveSelection(family, for: "person_parent")

    #expect(await store.selection(for: "person_coach") == coached)
    #expect(await store.selection(for: "person_parent") == family)
}

@MainActor @Test func latestTeamSelectionWinsWhenEarlierResponseFinishesLast() async {
    let transport = DelayedRosterTransport()
    let controller = SnackdayApplicationController(
        transport: transport,
        selectionStore: SelectionMemoryStore()
    )

    let restore = Task { await controller.restore() }
    while !(await transport.hasPendingRoster(for: "team_coached")) { await Task.yield() }

    let switchTeam = Task { await controller.selectTeam("team_family") }
    while !(await transport.hasPendingRoster(for: "team_family")) { await Task.yield() }
    await transport.finishRoster(for: "team_family", player: "Family Player")
    await switchTeam.value

    await transport.finishRoster(for: "team_coached", player: "Late Coached Player")
    await restore.value

    guard case .ready(_, let directory, let snapshot) = controller.state else {
        Issue.record("Expected the latest team to remain ready")
        return
    }
    #expect(directory.selection?.teamID == "team_family")
    #expect(snapshot.team.name == "Comets")
    #expect(snapshot.roster.map(\.displayName) == ["Family Player"])
}

@MainActor @Test func seasonlessTeamProducesEmptyStateWithoutRequest() async {
    let original = selectionTeams().teams[0]
    let seasonless = TeamsResponse(teams: [
        TeamWithSeasonsDTO(
            team: original.team,
            seasons: [],
            access: original.access,
            capabilities: original.capabilities
        )
    ])
    let transport = DelayedRosterTransport(teams: seasonless)
    let controller = SnackdayApplicationController(
        transport: transport,
        selectionStore: SelectionMemoryStore()
    )

    await controller.restore()

    guard case .emptySeasons(_, let directory, let teamID) = controller.state else {
        Issue.record("Expected an empty-seasons state")
        return
    }
    #expect(teamID == "team_coached")
    #expect(directory.selection == nil)
}
