import Observation
import SnackdayDomain
import SwiftUI

struct AppLaunchView: View {
    @State private var model: NativeAppViewModel
    @State private var showingJoinTeam = false
    private let invitationTransport: (any SnackdayInvitationTransport)?

    @MainActor init(
        controller: any SnackdayApplicationControlling,
        invitationTransport: (any SnackdayInvitationTransport)? = nil
    ) {
        _model = State(initialValue: NativeAppViewModel(controller: controller))
        self.invitationTransport = invitationTransport
    }

    @MainActor init(arguments: [String] = ProcessInfo.processInfo.arguments) {
#if DEBUG
        if let controller = UITestApplicationController(arguments: arguments) {
            self.init(controller: controller)
            return
        }
#endif
        self.init(controller: UnavailableApplicationController())
    }

    var body: some View {
        NativeAppStateView(
            state: model.state,
            challenge: model.challenge,
            isPreparingSignIn: model.isPreparingSignIn,
            signInPreparationFailed: model.signInPreparationFailed,
            prepareSignIn: { await model.prepareSignIn() },
            completeSignIn: { challengeID, token, displayName, consent in
                await model.completeSignIn(
                    challengeID: challengeID,
                    identityToken: token,
                    displayName: displayName,
                    adultConsent: consent
                )
            },
            selectTeam: { teamID in Task { await model.selectTeam(teamID) } },
            selectSeason: { seasonID in Task { await model.selectSeason(seasonID) } },
            retry: { Task { await model.retry() } },
            signOut: { Task { await model.signOut() } },
            joinTeam: invitationTransport == nil ? nil : { showingJoinTeam = true }
        )
        .task { await model.observeState() }
        .task { await model.restoreOnce() }
        .sheet(isPresented: $showingJoinTeam) {
            if let invitationTransport {
                JoinTeamView(transport: invitationTransport) { await model.refreshAfterJoining() }
            }
        }
    }
}

@MainActor @Observable
final class NativeAppViewModel {
    private let controller: any SnackdayApplicationControlling
    private var didRestore = false
    var state: NativeAppState
    var challenge: AppleChallengeDTO?
    var isPreparingSignIn = false
    var signInPreparationFailed = false

    init(controller: any SnackdayApplicationControlling) {
        self.controller = controller
        state = controller.state
    }

    func observeState() async {
        for await update in controller.stateUpdates() {
            guard !Task.isCancelled else { return }
            state = update
            if case .signedOut = update {
                continue
            }
            challenge = nil
            signInPreparationFailed = false
        }
    }

    func restoreOnce() async {
        guard !didRestore else { return }
        didRestore = true
        await controller.restore()
        state = controller.state
    }

    func prepareSignIn() async {
        guard challenge == nil, !isPreparingSignIn else { return }
        isPreparingSignIn = true
        defer { isPreparingSignIn = false }
        do {
            challenge = try await controller.beginAppleSignIn()
            signInPreparationFailed = false
        } catch {
            challenge = nil
            signInPreparationFailed = true
        }
    }

    func completeSignIn(
        challengeID: String,
        identityToken: String,
        displayName: String?,
        adultConsent: Bool
    ) async {
        challenge = nil
        await controller.completeAppleSignIn(
            challengeID: challengeID,
            identityToken: identityToken,
            displayName: displayName,
            adultConsent: adultConsent
        )
    }

    func selectTeam(_ teamID: String) async { await controller.selectTeam(teamID) }
    func selectSeason(_ seasonID: String) async { await controller.selectSeason(seasonID) }
    func retry() async { await controller.retry() }

    func refreshAfterJoining() async {
        // Membership is already committed. The application refresh outlives
        // the invitation sheet; a newer controller operation still cancels it.
        let refresh = Task { await controller.retry() }
        await refresh.value
    }

    func signOut() async {
        challenge = nil
        await controller.signOut()
    }
}

private enum UnavailableApplicationError: Error {
    case notConfigured
}

@MainActor
private final class UnavailableApplicationController: SnackdayApplicationControlling {
    private let updates: AsyncStream<NativeAppState>
    private let continuation: AsyncStream<NativeAppState>.Continuation
    let state = NativeAppState.failed(identity: nil, directory: nil, failure: .unavailable)

    init() {
        let channel = AsyncStream<NativeAppState>.makeStream()
        updates = channel.stream
        continuation = channel.continuation
        continuation.yield(state)
    }

    func stateUpdates() -> AsyncStream<NativeAppState> { updates }
    func restore() async {}
    func beginAppleSignIn() async throws -> AppleChallengeDTO {
        throw UnavailableApplicationError.notConfigured
    }
    func completeAppleSignIn(
        challengeID _: String,
        identityToken _: String,
        displayName _: String?,
        adultConsent _: Bool
    ) async {}
    func selectTeam(_: String) async {}
    func selectSeason(_: String) async {}
    func retry() async {}
    func signOut() async {}
}

#if DEBUG
@MainActor
private final class UITestApplicationController: SnackdayApplicationControlling {
    private let updates: AsyncStream<NativeAppState>
    private let continuation: AsyncStream<NativeAppState>.Continuation
    private(set) var state: NativeAppState

    init?(arguments: [String]) {
        guard arguments.contains("-SNACKDAY_UI_TEST_FIXTURE") else { return nil }
        let requestedState: String
        if
            let index = arguments.firstIndex(of: "-SNACKDAY_UI_TEST_STATE"),
            arguments.indices.contains(index + 1)
        {
            requestedState = arguments[index + 1]
        } else {
            requestedState = "ready"
        }
        guard let initialState = Self.fixtureState(named: requestedState) else { return nil }
        let channel = AsyncStream<NativeAppState>.makeStream()
        updates = channel.stream
        continuation = channel.continuation
        state = initialState
        continuation.yield(initialState)
    }

    func stateUpdates() -> AsyncStream<NativeAppState> { updates }
    func restore() async { continuation.yield(state) }
    func beginAppleSignIn() async throws -> AppleChallengeDTO {
        AppleChallengeDTO(challengeId: "ui-test-challenge", nonce: "ui-test-raw-nonce")
    }
    func completeAppleSignIn(
        challengeID _: String,
        identityToken _: String,
        displayName _: String?,
        adultConsent _: Bool
    ) async {
        transition(to: Self.readyState())
    }

    func selectTeam(_ teamID: String) async {
        guard let entry = Self.directory.teams.first(where: { $0.team.id == teamID }) else { return }
        guard let season = entry.seasons.first else {
            transition(
                to: .emptySeasons(
                    identity: Self.identity,
                    directory: TeamDirectory(teams: Self.directory.teams, selection: nil),
                    teamID: entry.team.id
                )
            )
            return
        }
        show(team: entry.team, season: season)
    }

    func selectSeason(_ seasonID: String) async {
        guard
            let selection = directory(from: state)?.selection,
            let entry = Self.directory.teams.first(where: { $0.team.id == selection.teamID }),
            let season = entry.seasons.first(where: { $0.id == seasonID })
        else { return }
        show(team: entry.team, season: season)
    }

    func retry() async { transition(to: .emptyTeams(identity: Self.identity)) }
    func signOut() async { transition(to: .signedOut) }

    private func show(team: TeamDTO, season: SeasonDTO) {
        let selection = TeamSeasonSelection(teamID: team.id, seasonID: season.id)
        let nextDirectory = TeamDirectory(teams: Self.directory.teams, selection: selection)
        let roster = team.id == "team-fixture-a" ? Self.roster : []
        transition(
            to: .ready(
                identity: Self.identity,
                directory: nextDirectory,
                snapshot: HomeSnapshot(
                    greeting: "Welcome back",
                    team: TeamSummary(name: team.name, season: season.label),
                    nextEvent: "No schedule details are available.",
                    roster: roster
                )
            )
        )
    }

    private func transition(to next: NativeAppState) {
        state = next
        continuation.yield(next)
    }

    private func directory(from state: NativeAppState) -> TeamDirectory? {
        switch state {
        case .ready(_, let directory, _), .emptySeasons(_, let directory, _): directory
        case .loading(_, let directory), .failed(_, let directory, _): directory
        default: nil
        }
    }

    private static func fixtureState(named name: String) -> NativeAppState? {
        switch name {
        case "ready": readyState()
        case "signed-out": .signedOut
        case "loading": .loading(identity: identity, directory: nil)
        case "empty-teams": .emptyTeams(identity: identity)
        case "empty-seasons":
            .emptySeasons(identity: identity, directory: emptySeasonDirectory, teamID: "team-empty")
        case "error": .failed(identity: identity, directory: directory, failure: .offline)
        default: nil
        }
    }

    private static func readyState() -> NativeAppState {
        let team = directory.teams[0].team
        let season = directory.teams[0].seasons[0]
        return .ready(
            identity: identity,
            directory: directory,
            snapshot: HomeSnapshot(
                greeting: "Welcome back",
                team: TeamSummary(name: team.name, season: season.label),
                nextEvent: "No schedule details are available.",
                roster: roster
            )
        )
    }

    private static let identity = AdultIdentityDTO(
        account: DevAccountDTO(id: "account-ui-test"),
        person: DevPersonDTO(id: "person-ui-test", displayName: "UI Test Adult")
    )
    private static let roster = [
        RosterMember(
            id: "fixture-private-guardians",
            displayName: "Private Fixture Player",
            guardians: [],
            guardianDetailsVisible: false
        ),
        RosterMember(
            id: "fixture-empty-guardians",
            displayName: "Empty Fixture Player",
            guardians: [],
            guardianDetailsVisible: true
        ),
    ]
    private static let directory = TeamDirectory(
        teams: [
            TeamWithSeasonsDTO(
                team: team(id: "team-fixture-a", name: "Fixture Team"),
                seasons: [
                    season(id: "season-fixture-spring", teamID: "team-fixture-a", label: "Fixture Spring"),
                    season(id: "season-fixture-fall", teamID: "team-fixture-a", label: "Fixture Fall"),
                ]
            ),
            TeamWithSeasonsDTO(
                team: team(id: "team-fixture-b", name: "Second Fixture Team"),
                seasons: [season(id: "season-fixture-b", teamID: "team-fixture-b", label: "Second Season")]
            ),
            TeamWithSeasonsDTO(
                team: team(id: "team-empty", name: "Seasonless Fixture Team"),
                seasons: []
            ),
        ],
        selection: TeamSeasonSelection(teamID: "team-fixture-a", seasonID: "season-fixture-spring")
    )
    private static let emptySeasonDirectory = TeamDirectory(
        teams: [
            TeamWithSeasonsDTO(
                team: team(id: "team-empty", name: "Seasonless Fixture Team"),
                seasons: []
            ),
        ],
        selection: nil
    )

    private static func team(id: String, name: String) -> TeamDTO {
        TeamDTO(
            id: id,
            name: name,
            status: "active",
            createdAt: "2026-09-14T18:00:00.000Z",
            updatedAt: "2026-09-14T18:00:00.000Z"
        )
    }

    private static func season(id: String, teamID: String, label: String) -> SeasonDTO {
        SeasonDTO(
            id: id,
            teamId: teamID,
            label: label,
            startDate: "2026-09-01",
            endDate: "2026-12-01",
            timeZone: "America/Los_Angeles",
            status: "active",
            createdAt: "2026-09-14T18:00:00.000Z",
            updatedAt: "2026-09-14T18:00:00.000Z"
        )
    }
}
#endif
