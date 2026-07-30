import Foundation
import SnackdayDomain
import Testing

private func season(
    id: String,
    teamId: String = "team_1",
    label: String,
    startDate: String,
    status: String
) -> SeasonDTO {
    SeasonDTO(
        id: id,
        teamId: teamId,
        label: label,
        startDate: startDate,
        endDate: "2026-12-31",
        timeZone: "America/Los_Angeles",
        status: status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
    )
}

private func team(id: String, name: String) -> TeamDTO {
    TeamDTO(
        id: id,
        name: name,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
    )
}

@Test func primarySelectionPrefersActiveSeason() throws {
    let response = TeamsResponse(teams: [
        TeamWithSeasonsDTO(
            team: team(id: "team_1", name: "Tigers"),
            seasons: [
                season(id: "season_1", label: "Fall 2025", startDate: "2025-09-01", status: "archived"),
                season(id: "season_2", label: "Spring 2026", startDate: "2026-03-01", status: "active"),
            ]
        )
    ])

    let selection = try #require(response.primarySelection)
    #expect(selection.team.id == "team_1")
    #expect(selection.season.id == "season_2")
    #expect(selection.season.label == "Spring 2026")
}

@Test func primarySelectionFallsBackToFirstSeasonAndSkipsSeasonlessTeams() throws {
    let response = TeamsResponse(teams: [
        TeamWithSeasonsDTO(team: team(id: "team_1", name: "No Seasons Yet"), seasons: []),
        TeamWithSeasonsDTO(
            team: team(id: "team_2", name: "Owls"),
            seasons: [
                season(
                    id: "season_9",
                    teamId: "team_2",
                    label: "Fall 2025",
                    startDate: "2025-09-01",
                    status: "archived"
                )
            ]
        ),
    ])

    let selection = try #require(response.primarySelection)
    #expect(selection.team.id == "team_2")
    #expect(selection.season.id == "season_9")
}

@Test func primarySelectionIsNilWithoutTeams() {
    #expect(TeamsResponse(teams: []).primarySelection == nil)
}

@Test func homeSnapshotMapsTeamSeasonAndRosterAndDropsBirthDate() throws {
    let selection = TeamSelection(
        team: team(id: "team_1", name: "T-Ball Tigers"),
        season: season(id: "season_1", label: "Spring 2026", startDate: "2026-03-01", status: "active")
    )
    let roster = try decodeFixture(RosterResponse.self, rosterFixture).roster

    let snapshot = HomeSnapshot.from(selection: selection, roster: roster, greeting: "Hello")

    #expect(snapshot.greeting == "Hello")
    #expect(snapshot.team == TeamSummary(name: "T-Ball Tigers", season: "Spring 2026"))
    #expect(snapshot.roster.count == 2)

    let first = try #require(snapshot.roster.first)
    #expect(first.id == "participant_22222222-2222-4222-8222-222222222222")
    #expect(first.displayName == "Avery Fixture")
    #expect(first.guardians.map(\.displayName) == ["Jordan Fixture", "Sam Fixture"])
    #expect(first.guardians.map(\.relationship) == ["parent", "caregiver"])

    let second = try #require(snapshot.roster.last)
    #expect(second.displayName == "Riley Fixture")
    #expect(second.guardians.isEmpty)
}

@Test func homeSnapshotRosterDefaultsEmptyForExistingCallSites() {
    let snapshot = HomeSnapshot(
        greeting: "Hi",
        team: TeamSummary(name: "Owls", season: "Fall 2026"),
        nextEvent: "Practice"
    )

    #expect(snapshot.roster.isEmpty)
    #expect(HomeSnapshot.preview.roster.isEmpty)
}
