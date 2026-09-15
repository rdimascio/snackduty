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
    private let delaysRoster: Bool
    private var continuations: [String: CheckedContinuation<RosterResponse, Error>] = [:]
    private var requests: [TeamSeasonSelection] = []

    init(teams: TeamsResponse = selectionTeams(), delaysRoster: Bool = true) {
        self.teams = teams
        self.delaysRoster = delaysRoster
    }

    func currentSession() -> AdultIdentityDTO { identity }
    func beginAppleSignIn() -> AppleChallengeDTO {
        AppleChallengeDTO(challengeId: "challenge", nonce: "nonce")
    }
    func completeAppleSignIn(_ input: AppleSignInRequestDTO) -> AdultIdentityDTO { identity }
    func signOut() {}
    func listTeams() -> TeamsResponse { teams }
    func loadRoster(teamId: String, seasonId: String) async throws -> RosterResponse {
        requests.append(TeamSeasonSelection(teamID: teamId, seasonID: seasonId))
        if !delaysRoster { return RosterResponse(roster: []) }
        try await withCheckedThrowingContinuation { continuation in
            continuations[teamId] = continuation
        }
    }

    func hasPendingRoster(for teamID: String) -> Bool { continuations[teamID] != nil }
    func rosterRequests() -> [TeamSeasonSelection] { requests }
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

private func selectionSeason(
    id: String,
    teamID: String,
    status: String = "active"
) -> SeasonDTO {
    SeasonDTO(
        id: id,
        teamId: teamID,
        label: id,
        startDate: "2026-09-01",
        endDate: "2026-12-01",
        timeZone: "America/Los_Angeles",
        status: status,
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z"
    )
}

private func selectionEntry(
    teamID: String,
    status: String = "active",
    seasons: [SeasonDTO]
) -> TeamWithSeasonsDTO {
    TeamWithSeasonsDTO(
        team: TeamDTO(
            id: teamID,
            name: teamID,
            status: status,
            createdAt: "2026-09-14T00:00:00.000Z",
            updatedAt: "2026-09-14T00:00:00.000Z"
        ),
        seasons: seasons
    )
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

@MainActor @Test func archivedOnlySeasonsProduceEmptyStateWithoutRosterRequest() async {
    let teamID = "team_archived_seasons"
    let transport = DelayedRosterTransport(
        teams: TeamsResponse(teams: [
            selectionEntry(
                teamID: teamID,
                seasons: [selectionSeason(id: "season_archived", teamID: teamID, status: "archived")]
            )
        ]),
        delaysRoster: false
    )
    let controller = SnackdayApplicationController(
        transport: transport,
        selectionStore: SelectionMemoryStore()
    )

    await controller.restore()

    guard case .emptySeasons(_, let directory, let emptyTeamID) = controller.state else {
        Issue.record("Expected archived-only seasons to produce an empty-seasons state")
        return
    }
    #expect(emptyTeamID == teamID)
    #expect(directory.teams.map(\.team.id) == [teamID])
    #expect(directory.teams[0].seasons.isEmpty)
    #expect((await transport.rosterRequests()).isEmpty)
}

@MainActor @Test func archivedSavedSelectionFallsBackToAnActiveSeason() async {
    let teamID = "team_one"
    let archived = selectionSeason(id: "season_archived", teamID: teamID, status: "archived")
    let active = selectionSeason(id: "season_active", teamID: teamID)
    let transport = DelayedRosterTransport(
        teams: TeamsResponse(teams: [
            selectionEntry(teamID: teamID, seasons: [archived, active])
        ])
    )
    let selections = SelectionMemoryStore()
    await selections.saveSelection(
        TeamSeasonSelection(teamID: teamID, seasonID: archived.id),
        for: "person_dual"
    )
    let controller = SnackdayApplicationController(transport: transport, selectionStore: selections)

    let restore = Task { await controller.restore() }
    while (await transport.rosterRequests()).isEmpty { await Task.yield() }
    #expect(
        await transport.rosterRequests()
            == [TeamSeasonSelection(teamID: teamID, seasonID: active.id)]
    )
    await transport.finishRoster(for: teamID, player: "Active Player")
    await restore.value

    guard case .ready(_, let directory, _) = controller.state else {
        Issue.record("Expected fallback to the active season")
        return
    }
    #expect(directory.selection == TeamSeasonSelection(teamID: teamID, seasonID: active.id))
    #expect(await selections.selection(for: "person_dual") == directory.selection)
}

@MainActor @Test func explicitInactiveSelectionsCannotStartRosterRequests() async {
    let activeTeamID = "team_active"
    let archivedTeamID = "team_archived"
    let active = selectionSeason(id: "season_active", teamID: activeTeamID)
    let archived = selectionSeason(id: "season_archived", teamID: activeTeamID, status: "archived")
    let mismatched = selectionSeason(id: "season_mismatched", teamID: archivedTeamID)
    let transport = DelayedRosterTransport(
        teams: TeamsResponse(teams: [
            selectionEntry(teamID: activeTeamID, seasons: [active, archived, mismatched]),
            selectionEntry(
                teamID: archivedTeamID,
                status: "archived",
                seasons: [selectionSeason(id: "season_archived_team", teamID: archivedTeamID)]
            ),
        ])
    )
    let controller = SnackdayApplicationController(
        transport: transport,
        selectionStore: SelectionMemoryStore()
    )

    let restore = Task { await controller.restore() }
    while (await transport.rosterRequests()).isEmpty { await Task.yield() }
    await transport.finishRoster(for: activeTeamID, player: "Active Player")
    await restore.value
    let initialRequests = await transport.rosterRequests()

    await controller.selectSeason(archived.id)
    await controller.selectSeason(mismatched.id)
    await controller.selectTeam(archivedTeamID)

    #expect(await transport.rosterRequests() == initialRequests)
    guard case .ready(_, let directory, _) = controller.state else {
        Issue.record("Expected the active selection to remain ready")
        return
    }
    #expect(directory.teams.map(\.team.id) == [activeTeamID])
    #expect(directory.teams[0].seasons.map(\.id) == [active.id])
    #expect(directory.selection == TeamSeasonSelection(teamID: activeTeamID, seasonID: active.id))
}
