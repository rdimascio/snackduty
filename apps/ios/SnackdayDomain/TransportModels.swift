import Foundation

// Transport DTOs mirroring the server's authorized read payloads. These are a
// hand-written client boundary for now; per the module README they should
// eventually be generated from an explicit API contract instead of being
// maintained by hand.

public struct TeamDTO: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let status: String
    public let createdAt: String
    public let updatedAt: String

    public init(id: String, name: String, status: String, createdAt: String, updatedAt: String) {
        self.id = id
        self.name = name
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct SeasonDTO: Codable, Equatable, Sendable {
    public let id: String
    public let teamId: String
    public let label: String
    public let startDate: String
    public let endDate: String
    public let timeZone: String
    public let status: String
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String,
        teamId: String,
        label: String,
        startDate: String,
        endDate: String,
        timeZone: String,
        status: String,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.teamId = teamId
        self.label = label
        self.startDate = startDate
        self.endDate = endDate
        self.timeZone = timeZone
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct TeamWithSeasonsDTO: Codable, Equatable, Sendable {
    public let team: TeamDTO
    public let seasons: [SeasonDTO]

    public init(team: TeamDTO, seasons: [SeasonDTO]) {
        self.team = team
        self.seasons = seasons
    }
}

/// `GET /api/teams`
public struct TeamsResponse: Codable, Equatable, Sendable {
    public let teams: [TeamWithSeasonsDTO]

    public init(teams: [TeamWithSeasonsDTO]) {
        self.teams = teams
    }
}

public struct GuardianDTO: Codable, Equatable, Sendable {
    public let guardianId: String
    public let displayName: String
    public let relationship: String
    public let permissions: [String]
    public let status: String

    public init(
        guardianId: String,
        displayName: String,
        relationship: String,
        permissions: [String],
        status: String
    ) {
        self.guardianId = guardianId
        self.displayName = displayName
        self.relationship = relationship
        self.permissions = permissions
        self.status = status
    }
}

public struct RosterParticipantDTO: Codable, Equatable, Sendable {
    public let participantId: String
    public let displayName: String
    public let birthDate: String?
    public let status: String
    public let guardians: [GuardianDTO]

    public init(
        participantId: String,
        displayName: String,
        birthDate: String?,
        status: String,
        guardians: [GuardianDTO]
    ) {
        self.participantId = participantId
        self.displayName = displayName
        self.birthDate = birthDate
        self.status = status
        self.guardians = guardians
    }
}

/// `GET /api/teams/{teamId}/seasons/{seasonId}/roster`
public struct RosterResponse: Codable, Equatable, Sendable {
    public let roster: [RosterParticipantDTO]

    public init(roster: [RosterParticipantDTO]) {
        self.roster = roster
    }
}

public struct DevAccountDTO: Codable, Equatable, Sendable {
    public let id: String

    public init(id: String) {
        self.id = id
    }
}

public struct DevPersonDTO: Codable, Equatable, Sendable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

/// `POST /api/dev/sign-in` and `GET /api/dev/session`
public struct DevIdentityDTO: Codable, Equatable, Sendable {
    public let account: DevAccountDTO
    public let person: DevPersonDTO

    public init(account: DevAccountDTO, person: DevPersonDTO) {
        self.account = account
        self.person = person
    }
}

/// The team-and-season pair the Home screen renders.
public struct TeamSelection: Equatable, Sendable {
    public let team: TeamDTO
    public let season: SeasonDTO

    public init(team: TeamDTO, season: SeasonDTO) {
        self.team = team
        self.season = season
    }
}

extension TeamsResponse {
    /// The first team that carries at least one season, preferring its first
    /// `active` season. The server already sorts teams by creation and seasons
    /// by start date, so this preserves that ordering.
    public var primarySelection: TeamSelection? {
        for entry in teams {
            let season = entry.seasons.first(where: { $0.status == "active" }) ?? entry.seasons.first
            if let season {
                return TeamSelection(team: entry.team, season: season)
            }
        }
        return nil
    }
}

extension HomeSnapshot {
    /// Pure mapping from transport DTOs to the UI model. Deliberately drops
    /// `birthDate`: the Home screen has no use for it, so it never leaves the
    /// transport layer.
    public static func from(
        selection: TeamSelection,
        roster: [RosterParticipantDTO],
        greeting: String = "Welcome back"
    ) -> HomeSnapshot {
        HomeSnapshot(
            greeting: greeting,
            team: TeamSummary(name: selection.team.name, season: selection.season.label),
            nextEvent: "No events scheduled yet",
            roster: roster.map { participant in
                RosterMember(
                    id: participant.participantId,
                    displayName: participant.displayName,
                    guardians: participant.guardians.map { guardian in
                        RosterGuardian(
                            id: guardian.guardianId,
                            displayName: guardian.displayName,
                            relationship: guardian.relationship
                        )
                    }
                )
            }
        )
    }
}
