import Foundation

public struct TeamSummary: Equatable, Hashable, Sendable {
    public let name: String
    public let season: String

    public init(name: String, season: String) {
        self.name = name
        self.season = season
    }
}

public struct RosterGuardian: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let displayName: String
    public let relationship: String

    public init(id: String, displayName: String, relationship: String) {
        self.id = id
        self.displayName = displayName
        self.relationship = relationship
    }
}

public struct RosterMember: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let displayName: String
    public let guardians: [RosterGuardian]

    public init(id: String, displayName: String, guardians: [RosterGuardian]) {
        self.id = id
        self.displayName = displayName
        self.guardians = guardians
    }
}

public struct HomeSnapshot: Equatable, Sendable {
    public let greeting: String
    public let team: TeamSummary
    public let nextEvent: String
    public let roster: [RosterMember]

    public init(greeting: String, team: TeamSummary, nextEvent: String, roster: [RosterMember] = []) {
        self.greeting = greeting
        self.team = team
        self.nextEvent = nextEvent
        self.roster = roster
    }

    public static let preview = HomeSnapshot(
        greeting: "Good afternoon",
        team: TeamSummary(name: "T-Ball Tigers", season: "Spring 2026"),
        nextEvent: "Practice · Saturday at 9:00 AM"
    )
}
