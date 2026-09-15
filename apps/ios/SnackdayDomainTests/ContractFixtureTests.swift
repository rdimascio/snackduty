import Foundation
import SnackdayDomain
import Testing

@Test func canonicalInvitationFixturesDecode() throws {
    let decoder = JSONDecoder()
    let preview = try decoder.decode(InvitationPreviewDTO.self, from: contractFixture(named: "invitation-preview"))
    let accepted = try decoder.decode(InvitationAcceptanceDTO.self, from: contractFixture(named: "invitation-accepted"))
    #expect(preview.invitedRole == .adult)
    #expect(accepted.membership.role == .adult)
    #expect(accepted.team.name == preview.teamName)
}

private final class ContractFixtureBundleToken {}

private func contractFixture(named name: String) throws -> Data {
    let bundle = Bundle(for: ContractFixtureBundleToken.self)
    let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "fixtures")
        ?? bundle.url(forResource: name, withExtension: "json")
    return try Data(contentsOf: #require(url))
}

@Test func canonicalIdentityAndChallengeFixturesDecode() throws {
    let decoder = JSONDecoder()
    let identity = try decoder.decode(
        AdultIdentityDTO.self,
        from: contractFixture(named: "adult-identity")
    )
    let challenge = try decoder.decode(
        AppleChallengeDTO.self,
        from: contractFixture(named: "apple-challenge")
    )

    #expect(identity.account.id == "account_fixture_adult")
    #expect(identity.person.id == "person_fixture_adult")
    #expect(challenge.challengeId == "challenge_fixture")
    #expect(challenge.nonce == "fixture-nonce-not-a-credential")
}

@Test func canonicalTeamDirectoryFailsClosedCapabilitiesAndDecodesAccess() throws {
    let response = try JSONDecoder().decode(
        TeamsResponse.self,
        from: contractFixture(named: "team-directory")
    )
    let coached = try #require(response.teams.first)
    let family = try #require(response.teams.last)

    #expect(coached.access == "manage")
    #expect(coached.capabilities == TeamCapabilities(read: true, manage: true, delegate: false))
    #expect(family.access == "read")
    #expect(family.capabilities?.manage == false)
    #expect(family.capabilities?.delegate == false)

    let withoutHints = TeamWithSeasonsDTO(team: coached.team, seasons: coached.seasons)
    #expect(withoutHints.access == nil)
    #expect(withoutHints.capabilities == nil)
}

@Test func canonicalEmptyAndRosterPrivacyFixturesDecode() throws {
    let decoder = JSONDecoder()
    let empty = try decoder.decode(
        TeamsResponse.self,
        from: contractFixture(named: "empty-directory")
    )
    let roster = try decoder.decode(
        RosterResponse.self,
        from: contractFixture(named: "roster-privacy")
    )
    let signedOut = try decoder.decode(
        SignOutResponseDTO.self,
        from: contractFixture(named: "session-signed-out")
    )

    #expect(empty.teams.isEmpty)
    #expect(roster.roster.first?.birthDate == "2018-04-09")
    #expect(roster.roster.last?.birthDate == nil)
    #expect(roster.roster.last?.guardians.isEmpty == true)
    #expect(signedOut.signedOut)
}
