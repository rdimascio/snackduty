import Foundation

public typealias AdultIdentityDTO = DevIdentityDTO

public struct AppleChallengeDTO: Codable, Equatable, Sendable {
    public let challengeId: String
    public let nonce: String
    public init(challengeId: String, nonce: String) {
        self.challengeId = challengeId
        self.nonce = nonce
    }
}

public struct AppleSignInRequestDTO: Codable, Equatable, Sendable {
    public let challengeId: String
    public let identityToken: String
    public let displayName: String?
    public let adultConsent: Bool
    public init(challengeId: String, identityToken: String, displayName: String?, adultConsent: Bool) {
        self.challengeId = challengeId
        self.identityToken = identityToken
        self.displayName = displayName
        self.adultConsent = adultConsent
    }
}

public struct SignOutResponseDTO: Codable, Equatable, Sendable {
    public let signedOut: Bool
}

public struct TeamCapabilities: Codable, Equatable, Sendable {
    public let read: Bool
    public let manage: Bool
    public let delegate: Bool
    public init(read: Bool, manage: Bool, delegate: Bool) {
        self.read = read
        self.manage = manage
        self.delegate = delegate
    }
}

public struct TeamSeasonSelection: Codable, Equatable, Sendable {
    public let teamID: String
    public let seasonID: String
    public init(teamID: String, seasonID: String) {
        self.teamID = teamID
        self.seasonID = seasonID
    }
}

public struct TeamDirectory: Equatable, Sendable {
    public let teams: [TeamWithSeasonsDTO]
    public let selection: TeamSeasonSelection?
    public init(teams: [TeamWithSeasonsDTO], selection: TeamSeasonSelection?) {
        self.teams = teams
        self.selection = selection
    }
}

public enum NativeAppFailure: Equatable, Sendable {
    case offline, unauthorized, unavailable, invalidResponse
    case requestFailed(statusCode: Int)
}

public enum NativeAppState: Equatable, Sendable {
    case launching
    case signedOut
    case authenticating
    case signingOut
    case loading(identity: AdultIdentityDTO, directory: TeamDirectory?)
    case ready(identity: AdultIdentityDTO, directory: TeamDirectory, snapshot: HomeSnapshot)
    case emptyTeams(identity: AdultIdentityDTO)
    case emptySeasons(identity: AdultIdentityDTO, directory: TeamDirectory, teamID: String)
    case failed(identity: AdultIdentityDTO?, directory: TeamDirectory?, failure: NativeAppFailure)
}

public protocol SnackdayTransport: Sendable {
    func currentSession() async throws -> AdultIdentityDTO
    func beginAppleSignIn() async throws -> AppleChallengeDTO
    func completeAppleSignIn(_ input: AppleSignInRequestDTO) async throws -> AdultIdentityDTO
    func signOut() async throws
    func listTeams() async throws -> TeamsResponse
    func loadRoster(teamId: String, seasonId: String) async throws -> RosterResponse
}

public enum AdultTeamRole: String, Codable, Sendable { case owner, coach, adult }
public struct InvitationPreviewDTO: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case preview, accepted }
    public let state: State
    public let teamName: String
    public let inviterDisplayName: String?
    public let invitedRole: AdultTeamRole?
    public let grantedRole: AdultTeamRole?
    public init(state: State, teamName: String, inviterDisplayName: String? = nil, invitedRole: AdultTeamRole? = nil, grantedRole: AdultTeamRole? = nil) {
        self.state = state; self.teamName = teamName; self.inviterDisplayName = inviterDisplayName
        self.invitedRole = invitedRole; self.grantedRole = grantedRole
    }
}
public struct InvitationAcceptanceDTO: Codable, Equatable, Sendable {
    public struct Invitation: Codable, Equatable, Sendable { public let id: String; public let status: String }
    public struct Membership: Codable, Equatable, Sendable { public let role: AdultTeamRole }
    public let invitation: Invitation
    public let membership: Membership
    public let team: TeamDTO
}
public protocol SnackdayInvitationTransport: Sendable {
    func previewInvitation(token: String) async throws -> InvitationPreviewDTO
    func acceptInvitation(token: String) async throws -> InvitationAcceptanceDTO
}

@MainActor public protocol SnackdayApplicationControlling: AnyObject {
    var state: NativeAppState { get }
    func stateUpdates() -> AsyncStream<NativeAppState>
    func restore() async
    func beginAppleSignIn() async throws -> AppleChallengeDTO
    func completeAppleSignIn(challengeID: String, identityToken: String, displayName: String?, adultConsent: Bool) async
    func selectTeam(_ teamID: String) async
    func selectSeason(_ seasonID: String) async
    func retry() async
    func signOut() async
}
