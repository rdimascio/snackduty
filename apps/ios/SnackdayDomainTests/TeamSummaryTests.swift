import SnackdayDomain
import Testing

@Test func homeSnapshotKeepsTeamIdentitySeparate() {
    let team = TeamSummary(name: "Owls", season: "Fall 2026")
    let snapshot = HomeSnapshot(greeting: "Hello", team: team, nextEvent: "Practice")

    #expect(snapshot.team == team)
    #expect(snapshot.team.name == "Owls")
}
