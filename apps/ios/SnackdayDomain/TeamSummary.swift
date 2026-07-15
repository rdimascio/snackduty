import Foundation

public struct TeamSummary: Equatable, Hashable, Sendable {
    public let name: String
    public let season: String

    public init(name: String, season: String) {
        self.name = name
        self.season = season
    }
}

public struct HomeSnapshot: Equatable, Sendable {
    public let greeting: String
    public let team: TeamSummary
    public let nextEvent: String

    public init(greeting: String, team: TeamSummary, nextEvent: String) {
        self.greeting = greeting
        self.team = team
        self.nextEvent = nextEvent
    }

    public static let preview = HomeSnapshot(
        greeting: "Good afternoon",
        team: TeamSummary(name: "T-Ball Tigers", season: "Spring 2026"),
        nextEvent: "Practice · Saturday at 9:00 AM"
    )
}
