import Foundation
import SnackdayDomain
import Testing

// Fixtures cover the server transport contract and older payload compatibility.
// `privacyScopedRosterFixture` mirrors the current privacy projection.

let teamsFixture = """
{
  "teams": [
    {
      "team": {
        "id": "team_11111111-1111-4111-8111-111111111111",
        "name": "T-Ball Tigers",
        "status": "active",
        "createdAt": "2026-02-01T12:00:00.000Z",
        "updatedAt": "2026-02-01T12:00:00.000Z"
      },
      "seasons": [
        {
          "id": "season_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "teamId": "team_11111111-1111-4111-8111-111111111111",
          "label": "Spring 2026",
          "startDate": "2026-03-01",
          "endDate": "2026-06-15",
          "timeZone": "America/Los_Angeles",
          "status": "active",
          "createdAt": "2026-02-01T12:05:00.000Z",
          "updatedAt": "2026-02-01T12:05:00.000Z"
        }
      ]
    }
  ]
}
"""

// Legacy payload without invitation counts: visible guardian names remain
// readable, while an empty guardian array is conservatively treated as private.
let rosterFixture = """
{
  "roster": [
    {
      "participantId": "participant_22222222-2222-4222-8222-222222222222",
      "displayName": "Avery Fixture",
      "birthDate": "2019-04-12",
      "status": "active",
      "guardians": [
        {
          "guardianId": "guardian_relationship_33333333-3333-4333-8333-333333333333",
          "displayName": "Jordan Fixture",
          "relationship": "parent",
          "permissions": ["participant.read", "participant.manage"],
          "status": "active"
        },
        {
          "guardianId": "guardian_relationship_44444444-4444-4444-8444-444444444444",
          "displayName": "Sam Fixture",
          "relationship": "caregiver",
          "permissions": ["participant.read"],
          "status": "active"
        }
      ]
    },
    {
      "participantId": "participant_55555555-5555-4555-8555-555555555555",
      "displayName": "Riley Fixture",
      "status": "active",
      "guardians": []
    }
  ]
}
"""

// A read-only team adult sees private fields for their own child and a
// deliberately minimal entry for every other player. Managers receive the
// same full shape as the first entry for every player.
let privacyScopedRosterFixture = """
{
  "roster": [
    {
      "participantId": "participant_own_child",
      "displayName": "Avery Own Child",
      "birthDate": "2019-04-12",
      "status": "active",
      "guardians": [
        {
          "guardianId": "guardian_relationship_own",
          "displayName": "Jordan Parent",
          "relationship": "parent",
          "permissions": ["participant.read", "participant.manage"],
          "status": "active"
        }
      ],
      "guardianInvitations": { "pending": 0, "expired": 0, "accepted": 1 }
    },
    {
      "participantId": "participant_teammate",
      "displayName": "Riley Teammate",
      "status": "active",
      "guardians": []
    }
  ]
}
"""

let identityFixture = """
{
  "account": { "id": "account_dev_adult" },
  "person": { "id": "person_dev_adult", "displayName": "Development Adult" }
}
"""

func decodeFixture<Payload: Decodable>(_ payload: Payload.Type, _ json: String) throws -> Payload {
    try JSONDecoder().decode(Payload.self, from: Data(json.utf8))
}

@Test func teamsResponseDecodesTeamAndSeasons() throws {
    let response = try decodeFixture(TeamsResponse.self, teamsFixture)

    #expect(response.teams.count == 1)
    let entry = try #require(response.teams.first)
    #expect(entry.team.id == "team_11111111-1111-4111-8111-111111111111")
    #expect(entry.team.name == "T-Ball Tigers")
    #expect(entry.team.status == "active")
    #expect(entry.team.createdAt == "2026-02-01T12:00:00.000Z")

    let season = try #require(entry.seasons.first)
    #expect(season.teamId == entry.team.id)
    #expect(season.label == "Spring 2026")
    #expect(season.startDate == "2026-03-01")
    #expect(season.endDate == "2026-06-15")
    #expect(season.timeZone == "America/Los_Angeles")
    #expect(season.status == "active")
}

@Test func rosterResponseDecodesBirthDatePresenceAndMultipleGuardians() throws {
    let response = try decodeFixture(RosterResponse.self, rosterFixture)

    #expect(response.roster.count == 2)

    let withBirthDate = try #require(response.roster.first)
    #expect(withBirthDate.displayName == "Avery Fixture")
    #expect(withBirthDate.birthDate == "2019-04-12")
    #expect(withBirthDate.status == "active")
    #expect(withBirthDate.guardians.count == 2)
    #expect(withBirthDate.guardians[0].displayName == "Jordan Fixture")
    #expect(withBirthDate.guardians[0].relationship == "parent")
    #expect(withBirthDate.guardians[0].permissions == ["participant.read", "participant.manage"])
    #expect(withBirthDate.guardians[1].relationship == "caregiver")
    #expect(withBirthDate.guardianInvitations == nil)

    let withoutBirthDate = try #require(response.roster.last)
    #expect(withoutBirthDate.displayName == "Riley Fixture")
    #expect(withoutBirthDate.birthDate == nil)
    #expect(withoutBirthDate.guardians.isEmpty)
    #expect(withoutBirthDate.guardianInvitations == nil)
}

@Test func privacyScopedRosterDecodesFullOwnChildAndRedactedTeammate() throws {
    let response = try decodeFixture(RosterResponse.self, privacyScopedRosterFixture)

    #expect(response.roster.count == 2)

    let ownChild = try #require(response.roster.first)
    #expect(ownChild.participantId == "participant_own_child")
    #expect(ownChild.birthDate == "2019-04-12")
    #expect(ownChild.guardians.map(\.displayName) == ["Jordan Parent"])
    #expect(ownChild.guardianInvitations == GuardianInvitationCountsDTO(pending: 0, expired: 0, accepted: 1))

    let teammate = try #require(response.roster.last)
    #expect(teammate.participantId == "participant_teammate")
    #expect(teammate.displayName == "Riley Teammate")
    #expect(teammate.birthDate == nil)
    #expect(teammate.guardians.isEmpty)
    #expect(teammate.guardianInvitations == nil)
}

@Test func devIdentityDecodesAccountAndPerson() throws {
    let identity = try decodeFixture(DevIdentityDTO.self, identityFixture)

    #expect(identity.account.id == "account_dev_adult")
    #expect(identity.person.id == "person_dev_adult")
    #expect(identity.person.displayName == "Development Adult")
}
