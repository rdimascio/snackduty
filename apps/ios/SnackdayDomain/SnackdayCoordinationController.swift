import Foundation

/// Native coordination state for one authenticated adult and selected season.
/// Capability fields are presentation hints; every write still reaches the
/// server's authoritative policy.
@MainActor public final class SnackdayCoordinationController: SnackdayCoordinationControlling {
    public private(set) var state = CoordinationState()

    private let transport: any SnackdayCoordinationTransport
    private var contextRevision: UInt64 = 0
    private var scheduleRevision: UInt64 = 0
    private var detailRevision: UInt64 = 0
    private var mutationRevision: UInt64 = 0
    private var scheduleTask: Task<Void, Never>?
    private var detailTask: Task<Void, Never>?
    private var cancelMutation: (@Sendable () -> Void)?
    private var continuations: [UUID: AsyncStream<CoordinationState>.Continuation] = [:]

    public init(transport: any SnackdayCoordinationTransport) {
        self.transport = transport
    }

    deinit {
        scheduleTask?.cancel()
        detailTask?.cancel()
        cancelMutation?()
        for continuation in continuations.values { continuation.finish() }
    }

    public func stateUpdates() -> AsyncStream<CoordinationState> {
        let id = UUID()
        return AsyncStream { continuation in
            continuations[id] = continuation
            continuation.yield(state)
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in self?.continuations.removeValue(forKey: id) }
            }
        }
    }

    public func setContext(_ context: CoordinationContext?) async {
        guard context != state.context || context == nil else { return }
        cancelAllWork()
        state = CoordinationState(context: context)
        publish()
        if context != nil { await reloadSchedule() }
    }

    public func reloadSchedule() async {
        guard let context = state.context else { return }

        scheduleTask?.cancel()
        scheduleRevision &+= 1
        let requestRevision = scheduleRevision
        let expectedContextRevision = contextRevision
        state.schedule = .loading
        publish()

        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let response = try await transport.listEvents(
                    teamID: context.teamID,
                    seasonID: context.seasonID
                )
                guard scheduleIsCurrent(
                    requestRevision,
                    contextRevision: expectedContextRevision,
                    context: context
                ) else { return }
                guard !Task.isCancelled else {
                    state.schedule = .idle
                    publish()
                    return
                }
                guard validSchedule(response, context: context) else {
                    state.schedule = .failed(.invalidResponse)
                    publish()
                    return
                }
                state.schedule = .loaded(response.events)
                publish()
            } catch {
                handleScheduleError(
                    error,
                    requestRevision: requestRevision,
                    contextRevision: expectedContextRevision,
                    context: context
                )
            }
        }
        scheduleTask = task
        await awaitTask(task)
    }

    public func openOccurrence(_ occurrenceID: String?) async {
        detailTask?.cancel()
        detailRevision &+= 1
        mutationRevision &+= 1
        cancelMutation?()
        cancelMutation = nil
        state.mutation = .idle

        guard let context = state.context else {
            state.selectedOccurrenceID = nil
            state.detail = .idle
            publish()
            return
        }
        state.selectedOccurrenceID = occurrenceID
        guard let occurrenceID else {
            state.detail = .idle
            publish()
            return
        }

        await loadDetail(
            occurrenceID: occurrenceID,
            context: context,
            contextRevision: contextRevision
        )
    }

    public func createEvent(_ input: CreateEventRequestDTO) async -> Bool {
        guard let context = state.context, state.mutation != .saving else { return false }
        mutationRevision &+= 1
        let requestRevision = mutationRevision
        let expectedContextRevision = contextRevision
        state.mutation = .saving
        publish()

        let task = Task { @MainActor [weak self] in
            guard let self else { return false }
            do {
                let response = try await transport.createEvent(
                    teamID: context.teamID,
                    seasonID: context.seasonID,
                    input: input
                )
                guard validCreation(response, context: context) else {
                    throw CoordinationFailure.invalidResponse
                }
                guard mutationIsCurrent(
                    requestRevision,
                    contextRevision: expectedContextRevision,
                    context: context
                ) else {
                    return true
                }
                state.mutation = .idle
                publish()
                await reloadSchedule()
                return true
            } catch {
                handleMutationError(
                    error,
                    requestRevision: requestRevision,
                    contextRevision: expectedContextRevision,
                    context: context
                )
                return false
            }
        }
        cancelMutation = { task.cancel() }
        let committed = await awaitTask(task)
        if mutationRevision == requestRevision { cancelMutation = nil }
        return committed
    }

    public func recordAttendance(participantID: String, status: AttendanceStatusDTO) async {
        guard let context = state.context,
              let occurrenceID = state.selectedOccurrenceID,
              state.mutation != .saving
        else { return }
        let input = AttendanceRequestDTO(participantId: participantID, status: status)
        await performDetailMutation(context: context, occurrenceID: occurrenceID) {
            let response = try await self.transport.recordAttendance(
                teamID: context.teamID,
                occurrenceID: occurrenceID,
                input: input
            )
            guard response.attendance == input else { throw CoordinationFailure.invalidResponse }
        }
    }

    public func claimDuty(slotID: String) async {
        guard let context = state.context,
              let occurrenceID = state.selectedOccurrenceID,
              state.mutation != .saving
        else { return }
        await performDetailMutation(context: context, occurrenceID: occurrenceID) {
            let response = try await self.transport.claimDutySlot(
                teamID: context.teamID,
                occurrenceID: occurrenceID,
                slotID: slotID
            )
            guard response.dutySlot.id == slotID,
                  response.dutySlot.occurrenceId == occurrenceID
            else {
                throw CoordinationFailure.invalidResponse
            }
        }
    }

    private func performDetailMutation(
        context: CoordinationContext,
        occurrenceID: String,
        operation: @escaping @MainActor @Sendable () async throws -> Void
    ) async {
        mutationRevision &+= 1
        let requestRevision = mutationRevision
        let expectedContextRevision = contextRevision
        state.mutation = .saving
        publish()

        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await operation()
                guard mutationIsCurrent(
                    requestRevision,
                    contextRevision: expectedContextRevision,
                    context: context,
                    occurrenceID: occurrenceID
                ) else { return }
                state.mutation = .idle
                publish()
                await loadDetail(
                    occurrenceID: occurrenceID,
                    context: context,
                    contextRevision: expectedContextRevision
                )
            } catch {
                handleMutationError(
                    error,
                    requestRevision: requestRevision,
                    contextRevision: expectedContextRevision,
                    context: context,
                    occurrenceID: occurrenceID
                )
            }
        }
        cancelMutation = { task.cancel() }
        await awaitTask(task)
        if mutationRevision == requestRevision { cancelMutation = nil }
    }

    private func loadDetail(
        occurrenceID: String,
        context: CoordinationContext,
        contextRevision expectedContextRevision: UInt64
    ) async {
        detailTask?.cancel()
        detailRevision &+= 1
        let requestRevision = detailRevision
        state.detail = .loading
        publish()

        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                async let attendance = transport.readAttendance(
                    teamID: context.teamID,
                    occurrenceID: occurrenceID
                )
                async let dutySlots = transport.listDutySlots(
                    teamID: context.teamID,
                    occurrenceID: occurrenceID
                )
                let (attendanceResponse, dutyResponse) = try await (attendance, dutySlots)
                guard detailIsCurrent(
                    requestRevision,
                    contextRevision: expectedContextRevision,
                    context: context,
                    occurrenceID: occurrenceID
                ) else { return }
                guard !Task.isCancelled else {
                    state.detail = .idle
                    publish()
                    return
                }
                guard dutyResponse.dutySlots.allSatisfy({ $0.occurrenceId == occurrenceID }) else {
                    state.detail = .failed(.invalidResponse)
                    publish()
                    return
                }
                state.detail = .loaded(
                    CoordinationDetail(
                        occurrenceID: occurrenceID,
                        attendance: attendanceResponse.attendance,
                        dutySlots: dutyResponse.dutySlots
                    )
                )
                updateScheduleAttendance(
                    occurrenceID: occurrenceID,
                    counts: attendanceResponse.attendance.counts
                )
                publish()
            } catch {
                handleDetailError(
                    error,
                    requestRevision: requestRevision,
                    contextRevision: expectedContextRevision,
                    context: context,
                    occurrenceID: occurrenceID
                )
            }
        }
        detailTask = task
        await awaitTask(task)
    }

    private func updateScheduleAttendance(occurrenceID: String, counts: AttendanceCountsDTO) {
        guard case .loaded(let events) = state.schedule else { return }
        state.schedule = .loaded(events.map { event in
            ScheduleEventDTO(series: event.series, occurrences: event.occurrences.map { occurrence in
                guard occurrence.id == occurrenceID else { return occurrence }
                return EventOccurrenceDTO(
                    id: occurrence.id, seriesId: occurrence.seriesId,
                    localDate: occurrence.localDate, startsAt: occurrence.startsAt,
                    durationMinutes: occurrence.durationMinutes, status: occurrence.status,
                    cancelledReason: occurrence.cancelledReason,
                    createdAt: occurrence.createdAt, updatedAt: occurrence.updatedAt,
                    attendance: counts
                )
            })
        })
    }

    private func handleScheduleError(
        _ error: any Error,
        requestRevision: UInt64,
        contextRevision expectedContextRevision: UInt64,
        context: CoordinationContext
    ) {
        guard scheduleIsCurrent(
            requestRevision,
            contextRevision: expectedContextRevision,
            context: context
        ) else { return }
        if isCancellation(error) {
            state.schedule = .idle
            publish()
            return
        }
        let failure = failure(for: error)
        if failure == .unauthorized {
            invalidateForUnauthorized()
            return
        }
        state.schedule = .failed(failure)
        publish()
    }

    private func handleDetailError(
        _ error: any Error,
        requestRevision: UInt64,
        contextRevision expectedContextRevision: UInt64,
        context: CoordinationContext,
        occurrenceID: String
    ) {
        guard detailIsCurrent(
            requestRevision,
            contextRevision: expectedContextRevision,
            context: context,
            occurrenceID: occurrenceID
        ) else { return }
        if isCancellation(error) {
            state.detail = .idle
            publish()
            return
        }
        let failure = failure(for: error)
        if failure == .unauthorized {
            invalidateForUnauthorized()
            return
        }
        state.detail = .failed(failure)
        publish()
    }

    private func handleMutationError(
        _ error: any Error,
        requestRevision: UInt64,
        contextRevision expectedContextRevision: UInt64,
        context: CoordinationContext,
        occurrenceID: String? = nil
    ) {
        guard mutationIsCurrent(
            requestRevision,
            contextRevision: expectedContextRevision,
            context: context,
            occurrenceID: occurrenceID
        ) else { return }
        if isCancellation(error) {
            state.mutation = .idle
            publish()
            return
        }
        let failure = failure(for: error)
        if failure == .unauthorized {
            invalidateForUnauthorized()
            return
        }
        state.mutation = .failed(failure)
        publish()
    }

    private func invalidateForUnauthorized() {
        cancelAllWork()
        state = CoordinationState(context: nil, schedule: .failed(.unauthorized))
        publish()
    }

    private func cancelAllWork() {
        contextRevision &+= 1
        scheduleRevision &+= 1
        detailRevision &+= 1
        mutationRevision &+= 1
        scheduleTask?.cancel()
        detailTask?.cancel()
        cancelMutation?()
        scheduleTask = nil
        detailTask = nil
        cancelMutation = nil
    }

    private func scheduleIsCurrent(
        _ requestRevision: UInt64,
        contextRevision expectedContextRevision: UInt64,
        context: CoordinationContext
    ) -> Bool {
        scheduleRevision == requestRevision
            && self.contextRevision == expectedContextRevision
            && state.context == context
    }

    private func detailIsCurrent(
        _ requestRevision: UInt64,
        contextRevision expectedContextRevision: UInt64,
        context: CoordinationContext,
        occurrenceID: String
    ) -> Bool {
        detailRevision == requestRevision
            && self.contextRevision == expectedContextRevision
            && state.context == context
            && state.selectedOccurrenceID == occurrenceID
    }

    private func mutationIsCurrent(
        _ requestRevision: UInt64,
        contextRevision expectedContextRevision: UInt64,
        context: CoordinationContext,
        occurrenceID: String? = nil
    ) -> Bool {
        mutationRevision == requestRevision
            && self.contextRevision == expectedContextRevision
            && state.context == context
            && (occurrenceID == nil || state.selectedOccurrenceID == occurrenceID)
    }

    private func validSchedule(
        _ response: SeasonEventsResponseDTO,
        context: CoordinationContext
    ) -> Bool {
        response.events.allSatisfy { event in
            event.series.teamId == context.teamID
                && event.series.seasonId == context.seasonID
                && event.occurrences.allSatisfy {
                    $0.seriesId == event.series.id && $0.attendance != nil
                }
        }
    }

    private func validCreation(
        _ response: CreateEventResponseDTO,
        context: CoordinationContext
    ) -> Bool {
        let occurrenceIDs = Set(response.occurrences.map(\.id))
        return response.series.teamId == context.teamID
            && response.series.seasonId == context.seasonID
            && response.occurrences.allSatisfy { $0.seriesId == response.series.id }
            && response.dutySlots.allSatisfy { occurrenceIDs.contains($0.occurrenceId) }
    }

    private func failure(for error: any Error) -> CoordinationFailure {
        if let failure = error as? CoordinationFailure { return failure }
        switch error {
        case SnackdayAPIError.unauthorized:
            return .unauthorized
        case SnackdayAPIError.offline:
            return .offline
        case SnackdayAPIError.invalidResponse, SnackdayAPIError.noTeamAvailable:
            return .invalidResponse
        case SnackdayAPIError.requestFailed(let statusCode):
            if statusCode == 404 { return .notFound }
            if statusCode == 400 || statusCode == 422 { return .invalidInput }
            return .requestFailed(statusCode: statusCode)
        default:
            return .unavailable
        }
    }

    private func isCancellation(_ error: any Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    private func awaitTask(_ task: Task<Void, Never>) async {
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func awaitTask<Value: Sendable>(_ task: Task<Value, Never>) async -> Value {
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func publish() {
        for continuation in continuations.values { continuation.yield(state) }
    }
}
