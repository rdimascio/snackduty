import Foundation

/// Main-actor state machine shared by SwiftUI and future native callers. Team
/// capabilities remain presentation hints; server authorization is authoritative.
@MainActor public final class SnackdayApplicationController: SnackdayApplicationControlling {
    public private(set) var state: NativeAppState = .launching

    private let transport: any SnackdayTransport
    private let selectionStore: any TeamSelectionStoring
    private var identity: AdultIdentityDTO?
    private var directory: TeamDirectory?
    private var generation = 0
    private var activeLoad: Task<Void, Never>?
    private var continuations: [UUID: AsyncStream<NativeAppState>.Continuation] = [:]

    public init(
        transport: any SnackdayTransport,
        selectionStore: any TeamSelectionStoring = UserDefaultsTeamSelectionStore()
    ) {
        self.transport = transport
        self.selectionStore = selectionStore
    }

    deinit {
        activeLoad?.cancel()
        for continuation in continuations.values { continuation.finish() }
    }

    public func stateUpdates() -> AsyncStream<NativeAppState> {
        let id = UUID()
        return AsyncStream { continuation in
            continuations[id] = continuation
            continuation.yield(state)
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in self?.continuations.removeValue(forKey: id) }
            }
        }
    }

    public func restore() async {
        let task = replaceLoad { [weak self] generation in
            guard let self else { return }
            do {
                let identity = try await transport.currentSession()
                guard isCurrent(generation) else { return }
                self.identity = identity
                await loadDirectory(for: identity, generation: generation)
            } catch {
                await handle(error, generation: generation)
            }
        }
        await awaitOperation(task)
    }

    public func beginAppleSignIn() async throws -> AppleChallengeDTO {
        cancelActiveLoad()
        identity = nil
        directory = nil
        let challengeGeneration = generation
        // Preparing a nonce must leave the consent/sign-in form on screen.
        publish(.signedOut)
        do {
            let challenge = try await transport.beginAppleSignIn()
            guard isCurrent(challengeGeneration) else { throw CancellationError() }
            return challenge
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            await handle(error, generation: challengeGeneration)
            throw sanitized(error)
        }
    }

    public func completeAppleSignIn(
        challengeID: String,
        identityToken: String,
        displayName: String?,
        adultConsent: Bool
    ) async {
        let task = replaceLoad { [weak self] generation in
            guard let self else { return }
            publish(.authenticating)
            do {
                let identity = try await transport.completeAppleSignIn(
                    AppleSignInRequestDTO(
                        challengeId: challengeID,
                        identityToken: identityToken,
                        displayName: displayName,
                        adultConsent: adultConsent
                    )
                )
                guard isCurrent(generation) else { return }
                self.identity = identity
                await loadDirectory(for: identity, generation: generation)
            } catch {
                guard isCurrent(generation), !isCancellation(error) else { return }
                identity = nil
                directory = nil
                publish(.failed(identity: nil, directory: nil, failure: failure(for: error)))
            }
        }
        await awaitOperation(task)
    }

    public func selectTeam(_ teamID: String) async {
        guard let identity, let currentDirectory = directory,
              let team = currentDirectory.teams.first(where: { $0.team.id == teamID })
        else { return }

        let task = replaceLoad { [weak self] generation in
            guard let self else { return }
            guard let season = preferredSeason(in: team.seasons) else {
                await selectionStore.clearSelection(for: identity.person.id)
                guard isCurrent(generation) else { return }
                let empty = TeamDirectory(teams: currentDirectory.teams, selection: nil)
                directory = empty
                publish(.emptySeasons(identity: identity, directory: empty, teamID: teamID))
                return
            }
            await loadSelection(
                TeamSeasonSelection(teamID: teamID, seasonID: season.id),
                identity: identity,
                teams: currentDirectory.teams,
                generation: generation
            )
        }
        await awaitOperation(task)
    }

    public func selectSeason(_ seasonID: String) async {
        guard let identity, let currentDirectory = directory,
              let teamID = currentDirectory.selection?.teamID,
              let team = currentDirectory.teams.first(where: { $0.team.id == teamID }),
              team.seasons.contains(where: { $0.id == seasonID })
        else { return }

        let task = replaceLoad { [weak self] generation in
            guard let self else { return }
            await loadSelection(
                TeamSeasonSelection(teamID: teamID, seasonID: seasonID),
                identity: identity,
                teams: currentDirectory.teams,
                generation: generation
            )
        }
        await awaitOperation(task)
    }

    public func retry() async {
        guard let identity else {
            await restore()
            return
        }
        let task = replaceLoad { [weak self] generation in
            await self?.loadDirectory(for: identity, generation: generation)
        }
        await awaitOperation(task)
    }

    public func signOut() async {
        let task = replaceLoad { [weak self] generation in
            guard let self else { return }
            let departingPersonID = identity?.person.id
            identity = nil
            directory = nil
            publish(.signingOut)
            if let departingPersonID { await selectionStore.clearSelection(for: departingPersonID) }
            guard isCurrent(generation) else { return }
            do {
                try await transport.signOut()
                guard isCurrent(generation) else { return }
                publish(.signedOut)
            } catch {
                guard isCurrent(generation), !isCancellation(error) else { return }
                publish(.failed(identity: nil, directory: nil, failure: failure(for: error)))
            }
        }
        await awaitOperation(task)
    }

    private func loadDirectory(for identity: AdultIdentityDTO, generation: Int) async {
        guard isCurrent(generation) else { return }
        publish(.loading(identity: identity, directory: directory))
        do {
            let response = try await transport.listTeams()
            guard isCurrent(generation) else { return }
            if response.teams.isEmpty {
                await selectionStore.clearSelection(for: identity.person.id)
                guard isCurrent(generation) else { return }
                directory = nil
                publish(.emptyTeams(identity: identity))
                return
            }

            let saved = await selectionStore.selection(for: identity.person.id)
            guard isCurrent(generation) else { return }
            if let selection = valid(saved, in: response.teams) ?? defaultSelection(in: response.teams) {
                await loadSelection(
                    selection,
                    identity: identity,
                    teams: response.teams,
                    generation: generation
                )
                return
            }

            await selectionStore.clearSelection(for: identity.person.id)
            guard isCurrent(generation) else { return }
            let empty = TeamDirectory(teams: response.teams, selection: nil)
            directory = empty
            publish(
                .emptySeasons(
                    identity: identity,
                    directory: empty,
                    teamID: response.teams[0].team.id
                )
            )
        } catch {
            await handle(error, generation: generation)
        }
    }

    private func loadSelection(
        _ selection: TeamSeasonSelection,
        identity: AdultIdentityDTO,
        teams: [TeamWithSeasonsDTO],
        generation: Int
    ) async {
        guard isCurrent(generation), let selected = selectedDTO(selection, in: teams) else { return }
        let selectedDirectory = TeamDirectory(teams: teams, selection: selection)
        directory = selectedDirectory
        publish(.loading(identity: identity, directory: selectedDirectory))
        do {
            let roster = try await transport.loadRoster(
                teamId: selection.teamID,
                seasonId: selection.seasonID
            )
            guard isCurrent(generation) else { return }
            await selectionStore.saveSelection(selection, for: identity.person.id)
            guard isCurrent(generation) else { return }
            let snapshot = HomeSnapshot.from(
                selection: TeamSelection(team: selected.team, season: selected.season),
                roster: roster.roster
            )
            publish(.ready(identity: identity, directory: selectedDirectory, snapshot: snapshot))
        } catch {
            await handle(error, generation: generation)
        }
    }

    private func handle(_ error: any Error, generation: Int) async {
        guard isCurrent(generation), !isCancellation(error) else { return }
        if case SnackdayAPIError.unauthorized = error {
            if let identity { await selectionStore.clearSelection(for: identity.person.id) }
            guard isCurrent(generation) else { return }
            self.identity = nil
            directory = nil
            publish(.signedOut)
            return
        }
        publish(.failed(identity: identity, directory: directory, failure: failure(for: error)))
    }

    private func replaceLoad(
        _ operation: @escaping @MainActor @Sendable (Int) async -> Void
    ) -> Task<Void, Never> {
        cancelActiveLoad()
        let operationGeneration = generation
        let task = Task { @MainActor in await operation(operationGeneration) }
        activeLoad = task
        return task
    }

    private func awaitOperation(_ task: Task<Void, Never>) async {
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func cancelActiveLoad() {
        activeLoad?.cancel()
        activeLoad = nil
        generation += 1
    }

    private func isCurrent(_ operationGeneration: Int) -> Bool {
        operationGeneration == generation && !Task.isCancelled
    }

    private func publish(_ newState: NativeAppState) {
        state = newState
        for continuation in continuations.values { continuation.yield(newState) }
    }

    private func valid(
        _ saved: TeamSeasonSelection?,
        in teams: [TeamWithSeasonsDTO]
    ) -> TeamSeasonSelection? {
        guard let saved, selectedDTO(saved, in: teams) != nil else { return nil }
        return saved
    }

    private func defaultSelection(in teams: [TeamWithSeasonsDTO]) -> TeamSeasonSelection? {
        for team in teams {
            if let season = preferredSeason(in: team.seasons) {
                return TeamSeasonSelection(teamID: team.team.id, seasonID: season.id)
            }
        }
        return nil
    }

    private func preferredSeason(in seasons: [SeasonDTO]) -> SeasonDTO? {
        seasons.first(where: { $0.status == "active" }) ?? seasons.first
    }

    private func selectedDTO(
        _ selection: TeamSeasonSelection,
        in teams: [TeamWithSeasonsDTO]
    ) -> (team: TeamDTO, season: SeasonDTO)? {
        guard let entry = teams.first(where: { $0.team.id == selection.teamID }),
              let season = entry.seasons.first(where: { $0.id == selection.seasonID })
        else { return nil }
        return (entry.team, season)
    }

    private func sanitized(_ error: any Error) -> SnackdayAPIError {
        if let apiError = error as? SnackdayAPIError { return apiError }
        return .unavailable
    }

    private func failure(for error: any Error) -> NativeAppFailure {
        switch error {
        case SnackdayAPIError.unauthorized:
            .unauthorized
        case SnackdayAPIError.offline:
            .offline
        case SnackdayAPIError.invalidResponse, SnackdayAPIError.noTeamAvailable:
            .invalidResponse
        case SnackdayAPIError.requestFailed(let statusCode):
            .requestFailed(statusCode: statusCode)
        default:
            .unavailable
        }
    }

    private func isCancellation(_ error: any Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }
}
