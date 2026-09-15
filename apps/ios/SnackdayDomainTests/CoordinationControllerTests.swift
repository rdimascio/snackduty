import Foundation
import SnackdayDomain
import Testing

private func coordinationTestContext(
    personID: String = "person_one",
    teamID: String = "team_one",
    seasonID: String = "season_one"
) -> CoordinationContext {
    CoordinationContext(
        personID: personID,
        teamID: teamID,
        seasonID: seasonID,
        timeZone: "America/Los_Angeles",
        canManage: false
    )
}

private func coordinationTestSeries(
    teamID: String,
    seasonID: String,
    title: String = "Practice"
) -> EventSeriesDTO {
    EventSeriesDTO(
        id: "series_\(teamID)_\(seasonID)",
        teamId: teamID,
        seasonId: seasonID,
        title: title,
        kind: .practice,
        timeZone: "America/Los_Angeles",
        localTime: "10:00",
        durationMinutes: 60,
        frequency: .once,
        startDate: "2026-10-03",
        status: .active,
        createdAt: "2026-09-14T18:00:00.000Z",
        updatedAt: "2026-09-14T18:00:00.000Z"
    )
}

private func coordinationTestOccurrence(
    seriesID: String,
    id: String = "occurrence_one",
    attendance: AttendanceCountsDTO? = AttendanceCountsDTO(yes: 0, no: 0, maybe: 0)
) -> EventOccurrenceDTO {
    EventOccurrenceDTO(
        id: id,
        seriesId: seriesID,
        localDate: "2026-10-03",
        startsAt: "2026-10-03T17:00:00.000Z",
        durationMinutes: 60,
        status: .scheduled,
        createdAt: "2026-09-14T18:00:00.000Z",
        updatedAt: "2026-09-14T18:00:00.000Z",
        attendance: attendance
    )
}

private func coordinationTestSchedule(
    teamID: String,
    seasonID: String,
    title: String = "Practice"
) -> SeasonEventsResponseDTO {
    let series = coordinationTestSeries(teamID: teamID, seasonID: seasonID, title: title)
    return SeasonEventsResponseDTO(events: [
        ScheduleEventDTO(
            series: series,
            occurrences: [coordinationTestOccurrence(seriesID: series.id)]
        )
    ])
}

private func coordinationTestCreation(
    teamID: String,
    seasonID: String,
    title: String = "Practice"
) -> CreateEventResponseDTO {
    let series = coordinationTestSeries(teamID: teamID, seasonID: seasonID, title: title)
    return CreateEventResponseDTO(
        series: series,
        occurrences: [coordinationTestOccurrence(seriesID: series.id, attendance: nil)],
        dutySlots: []
    )
}

private func coordinationTestAttendance(
    status: AttendanceStatusDTO? = nil
) -> AttendanceReadResponseDTO {
    AttendanceReadResponseDTO(
        attendance: AttendanceReadDTO(
            counts: AttendanceCountsDTO(yes: status == .yes ? 1 : 0, no: 0, maybe: 0),
            entries: status.map {
                [AttendanceEntryDTO(
                    participantId: "participant_own_child",
                    displayName: "Own Child",
                    status: $0
                )]
            } ?? [],
            responseOptions: [
                AttendanceOptionDTO(
                    participantId: "participant_own_child",
                    displayName: "Own Child",
                    status: status
                )
            ]
        )
    )
}

private func coordinationTestSlot(
    occurrenceID: String = "occurrence_one",
    assignee: DutyAssigneeDTO? = nil
) -> DutySlotDTO {
    DutySlotDTO(
        id: "slot_one",
        occurrenceId: occurrenceID,
        label: "Snacks",
        assignee: assignee,
        createdAt: "2026-09-14T18:00:00.000Z",
        updatedAt: "2026-09-14T18:00:00.000Z"
    )
}

private func coordinationTestInput(
    requestID: String = "f15f9510-7369-4d5f-a33e-68b6d59eb768"
) -> CreateEventRequestDTO {
    CreateEventRequestDTO(
        title: "Practice",
        kind: .practice,
        schedule: EventScheduleDTO(
            timeZone: "America/Los_Angeles",
            localTime: "10:00",
            durationMinutes: 60,
            frequency: .once,
            startDate: "2026-10-03"
        ),
        requestId: requestID
    )
}

private actor CoordinationTransportProbe: SnackdayCoordinationTransport {
    private var scheduleCalls: [(teamID: String, seasonID: String)] = []
    private var scheduleWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
    private var controlledSchedules = false
    private var pendingSchedules: [Int: CheckedContinuation<SeasonEventsResponseDTO, any Error>] = [:]
    private var queuedSchedules: [Result<SeasonEventsResponseDTO, CoordinationFailure>] = []

    private var controlledDetail = false
    private var pendingAttendance: [String: CheckedContinuation<AttendanceReadResponseDTO, any Error>] = [:]
    private var pendingDuty: [String: CheckedContinuation<DutySlotsResponseDTO, any Error>] = [:]
    private var detailWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    private var controlledCreate = false
    private var pendingCreate: CheckedContinuation<CreateEventResponseDTO, any Error>?
    private var createWaiters: [CheckedContinuation<Void, Never>] = []
    private var createResults: [Result<CreateEventResponseDTO, CoordinationFailure>] = []
    private var createInputs: [CreateEventRequestDTO] = []
    private var controlledRecord = false
    private var pendingRecord: CheckedContinuation<AttendanceResponseDTO, any Error>?
    private var recordWaiters: [CheckedContinuation<Void, Never>] = []
    private var recordResults: [Result<AttendanceResponseDTO, CoordinationFailure>] = []
    private var recordInputs: [AttendanceRequestDTO] = []
    private var claimResults: [Result<DutySlotResponseDTO, CoordinationFailure>] = []
    private var claimSlotIDs: [String] = []
    private var currentAttendance = coordinationTestAttendance()
    private var currentSlots = DutySlotsResponseDTO(dutySlots: [coordinationTestSlot()])

    func controlSchedules() { controlledSchedules = true }
    func controlDetail() { controlledDetail = true }
    func controlCreate() { controlledCreate = true }
    func controlRecord() { controlledRecord = true }
    func enqueueSchedule(_ result: Result<SeasonEventsResponseDTO, CoordinationFailure>) {
        queuedSchedules.append(result)
    }
    func enqueueCreate(_ result: Result<CreateEventResponseDTO, CoordinationFailure>) {
        createResults.append(result)
    }
    func enqueueRecord(_ result: Result<AttendanceResponseDTO, CoordinationFailure>) {
        recordResults.append(result)
    }
    func enqueueClaim(_ result: Result<DutySlotResponseDTO, CoordinationFailure>) {
        claimResults.append(result)
    }
    func createdInputs() -> [CreateEventRequestDTO] { createInputs }
    func claimedSlots() -> [String] { claimSlotIDs }
    func recordedAttendance() -> [AttendanceRequestDTO] { recordInputs }

    func listEvents(teamID: String, seasonID: String) async throws -> SeasonEventsResponseDTO {
        scheduleCalls.append((teamID, seasonID))
        let call = scheduleCalls.count
        resumeScheduleWaiters()
        if !queuedSchedules.isEmpty { return try queuedSchedules.removeFirst().get() }
        if controlledSchedules {
            return try await withCheckedThrowingContinuation { pendingSchedules[call] = $0 }
        }
        return coordinationTestSchedule(teamID: teamID, seasonID: seasonID)
    }

    func waitForScheduleCalls(_ count: Int) async {
        if scheduleCalls.count >= count { return }
        await withCheckedContinuation { continuation in
            if scheduleCalls.count >= count {
                continuation.resume()
            } else {
                scheduleWaiters.append((count, continuation))
            }
        }
    }

    func resumeSchedule(
        call: Int,
        with result: Result<SeasonEventsResponseDTO, CoordinationFailure>
    ) {
        guard let continuation = pendingSchedules.removeValue(forKey: call) else { return }
        switch result {
        case .success(let response): continuation.resume(returning: response)
        case .failure(let error): continuation.resume(throwing: error)
        }
    }

    func createEvent(
        teamID: String,
        seasonID: String,
        input: CreateEventRequestDTO
    ) async throws -> CreateEventResponseDTO {
        createInputs.append(input)
        if controlledCreate {
            return try await withCheckedThrowingContinuation { continuation in
                pendingCreate = continuation
                let waiters = createWaiters
                createWaiters.removeAll()
                waiters.forEach { $0.resume() }
            }
        }
        if !createResults.isEmpty { return try createResults.removeFirst().get() }
        return coordinationTestCreation(teamID: teamID, seasonID: seasonID, title: input.title)
    }

    func waitForCreate() async {
        if pendingCreate != nil { return }
        await withCheckedContinuation { continuation in
            if pendingCreate != nil {
                continuation.resume()
            } else {
                createWaiters.append(continuation)
            }
        }
    }

    func resumeCreate(with response: CreateEventResponseDTO) {
        controlledCreate = false
        pendingCreate?.resume(returning: response)
        pendingCreate = nil
    }

    func readAttendance(
        teamID _: String,
        occurrenceID: String
    ) async throws -> AttendanceReadResponseDTO {
        if controlledDetail {
            return try await withCheckedThrowingContinuation { continuation in
                pendingAttendance[occurrenceID] = continuation
                resumeDetailWaiters(for: occurrenceID)
            }
        }
        return currentAttendance
    }

    func recordAttendance(
        teamID _: String,
        occurrenceID _: String,
        input: AttendanceRequestDTO
    ) async throws -> AttendanceResponseDTO {
        recordInputs.append(input)
        if controlledRecord {
            return try await withCheckedThrowingContinuation { continuation in
                pendingRecord = continuation
                let waiters = recordWaiters
                recordWaiters.removeAll()
                waiters.forEach { $0.resume() }
            }
        }
        if !recordResults.isEmpty { return try recordResults.removeFirst().get() }
        currentAttendance = coordinationTestAttendance(status: input.status)
        return AttendanceResponseDTO(attendance: input)
    }

    func waitForRecord() async {
        if pendingRecord != nil { return }
        await withCheckedContinuation { continuation in
            if pendingRecord != nil {
                continuation.resume()
            } else {
                recordWaiters.append(continuation)
            }
        }
    }

    func resumeRecord(with response: AttendanceResponseDTO) {
        controlledRecord = false
        currentAttendance = coordinationTestAttendance(status: response.attendance.status)
        pendingRecord?.resume(returning: response)
        pendingRecord = nil
    }

    func listDutySlots(
        teamID _: String,
        occurrenceID: String
    ) async throws -> DutySlotsResponseDTO {
        if controlledDetail {
            return try await withCheckedThrowingContinuation { continuation in
                pendingDuty[occurrenceID] = continuation
                resumeDetailWaiters(for: occurrenceID)
            }
        }
        return currentSlots
    }

    func claimDutySlot(
        teamID _: String,
        occurrenceID: String,
        slotID: String
    ) throws -> DutySlotResponseDTO {
        claimSlotIDs.append(slotID)
        if !claimResults.isEmpty { return try claimResults.removeFirst().get() }
        let claimed = coordinationTestSlot(
            occurrenceID: occurrenceID,
            assignee: DutyAssigneeDTO(personId: "person_one", displayName: "Adult")
        )
        currentSlots = DutySlotsResponseDTO(dutySlots: [claimed])
        return DutySlotResponseDTO(dutySlot: claimed)
    }

    func waitForDetail(_ occurrenceID: String) async {
        if pendingAttendance[occurrenceID] != nil, pendingDuty[occurrenceID] != nil { return }
        await withCheckedContinuation { continuation in
            if pendingAttendance[occurrenceID] != nil, pendingDuty[occurrenceID] != nil {
                continuation.resume()
            } else {
                detailWaiters[occurrenceID, default: []].append(continuation)
            }
        }
    }

    func resumeDetail(
        _ occurrenceID: String,
        attendance: AttendanceReadResponseDTO,
        dutySlots: DutySlotsResponseDTO
    ) {
        pendingAttendance.removeValue(forKey: occurrenceID)?.resume(returning: attendance)
        pendingDuty.removeValue(forKey: occurrenceID)?.resume(returning: dutySlots)
    }

    private func resumeScheduleWaiters() {
        var remaining: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
        for waiter in scheduleWaiters {
            if scheduleCalls.count >= waiter.count {
                waiter.continuation.resume()
            } else {
                remaining.append(waiter)
            }
        }
        scheduleWaiters = remaining
    }

    private func resumeDetailWaiters(for occurrenceID: String) {
        guard pendingAttendance[occurrenceID] != nil,
              pendingDuty[occurrenceID] != nil
        else { return }
        detailWaiters.removeValue(forKey: occurrenceID)?.forEach { $0.resume() }
    }
}

@MainActor @Test func staleAdultTeamAndSeasonSchedulesCannotReplaceCurrentState() async {
    let changes = [
        coordinationTestContext(personID: "person_two"),
        coordinationTestContext(teamID: "team_two"),
        coordinationTestContext(seasonID: "season_two"),
    ]

    for current in changes {
        let original = coordinationTestContext()
        let transport = CoordinationTransportProbe()
        await transport.controlSchedules()
        let controller = SnackdayCoordinationController(transport: transport)
        let first = Task { await controller.setContext(original) }
        await transport.waitForScheduleCalls(1)
        let second = Task { await controller.setContext(current) }
        await transport.waitForScheduleCalls(2)

        await transport.resumeSchedule(
            call: 2,
            with: .success(coordinationTestSchedule(
                teamID: current.teamID,
                seasonID: current.seasonID,
                title: "Current"
            ))
        )
        await second.value
        await transport.resumeSchedule(
            call: 1,
            with: .success(coordinationTestSchedule(
                teamID: original.teamID,
                seasonID: original.seasonID,
                title: "Stale"
            ))
        )
        await first.value

        #expect(controller.state.context == current)
        guard case .loaded(let events) = controller.state.schedule else {
            Issue.record("Expected current schedule after context change")
            continue
        }
        #expect(events.first?.series.title == "Current")
    }
}

@MainActor @Test func clearingOccurrenceCancelsAndDropsLateDetailData() async {
    let context = coordinationTestContext()
    let transport = CoordinationTransportProbe()
    let controller = SnackdayCoordinationController(transport: transport)
    await controller.setContext(context)
    await transport.controlDetail()
    let detail = Task { await controller.openOccurrence("occurrence_one") }
    await transport.waitForDetail("occurrence_one")

    await controller.openOccurrence(nil)
    await transport.resumeDetail(
        "occurrence_one",
        attendance: coordinationTestAttendance(status: .yes),
        dutySlots: DutySlotsResponseDTO(dutySlots: [coordinationTestSlot()])
    )
    await detail.value

    #expect(controller.state.selectedOccurrenceID == nil)
    #expect(controller.state.detail == .idle)
    #expect(controller.state.mutation == .idle)
}

@MainActor @Test func createRetryRetainsRequestIDAndCommittedWriteSurvivesRefreshFailure() async {
    let context = coordinationTestContext()
    let transport = CoordinationTransportProbe()
    let controller = SnackdayCoordinationController(transport: transport)
    await controller.setContext(context)
    let input = coordinationTestInput()
    await transport.enqueueCreate(.failure(.offline))

    #expect(await controller.createEvent(input) == false)
    #expect(controller.state.mutation == .failed(.offline))
    await transport.enqueueSchedule(.failure(.offline))
    #expect(await controller.createEvent(input))

    #expect(controller.state.mutation == .idle)
    #expect(controller.state.schedule == .failed(.offline))
    let createdInputs = await transport.createdInputs()
    #expect(createdInputs.map(\.requestId) == [input.requestId, input.requestId])
}

@MainActor @Test func staleWriteCompletionsCannotPopulateANewerContext() async {
    let original = coordinationTestContext()
    let current = coordinationTestContext(
        personID: "person_two",
        teamID: "team_two",
        seasonID: "season_two"
    )
    let transport = CoordinationTransportProbe()
    let controller = SnackdayCoordinationController(transport: transport)
    await controller.setContext(original)
    await transport.controlCreate()
    let creation = Task { await controller.createEvent(coordinationTestInput()) }
    await transport.waitForCreate()

    await controller.setContext(current)
    await transport.resumeCreate(with: coordinationTestCreation(
        teamID: original.teamID,
        seasonID: original.seasonID
    ))
    #expect(await creation.value)

    #expect(controller.state.context == current)
    #expect(controller.state.mutation == .idle)
    guard case .loaded(let events) = controller.state.schedule else {
        Issue.record("Expected the newer context schedule")
        return
    }
    #expect(events.first?.series.teamId == current.teamID)

    await controller.openOccurrence("occurrence_one")
    await transport.controlRecord()
    let recording = Task {
        await controller.recordAttendance(participantID: "participant_own_child", status: .yes)
    }
    await transport.waitForRecord()
    await controller.setContext(original)
    let recorded = AttendanceRequestDTO(participantId: "participant_own_child", status: .yes)
    await transport.resumeRecord(with: AttendanceResponseDTO(attendance: recorded))
    await recording.value

    #expect(controller.state.context == original)
    #expect(controller.state.selectedOccurrenceID == nil)
    #expect(controller.state.detail == .idle)
    #expect(controller.state.mutation == .idle)
}

@MainActor @Test func detailUsesServerOptionsAndDutyFailureCanRetry() async {
    let context = coordinationTestContext()
    let transport = CoordinationTransportProbe()
    let controller = SnackdayCoordinationController(transport: transport)
    await controller.setContext(context)
    await controller.openOccurrence("occurrence_one")

    guard case .loaded(let detail) = controller.state.detail else {
        Issue.record("Expected loaded detail")
        return
    }
    #expect(detail.attendance.responseOptions.map(\.participantId) == ["participant_own_child"])

    await transport.enqueueClaim(.failure(.dutyTaken))
    await controller.claimDuty(slotID: "slot_one")
    #expect(controller.state.mutation == .failed(.dutyTaken))
    await controller.claimDuty(slotID: "slot_one")

    #expect(controller.state.mutation == .idle)
    #expect(await transport.claimedSlots() == ["slot_one", "slot_one"])
    guard case .loaded(let refreshed) = controller.state.detail else {
        Issue.record("Expected refreshed detail after retry")
        return
    }
    #expect(refreshed.dutySlots.first?.assignee?.personId == "person_one")

    await controller.setContext(nil)
    #expect(controller.state == CoordinationState())
}

@MainActor @Test func aPendingAttendanceWriteSerializesOtherMutations() async {
    let transport = CoordinationTransportProbe()
    let controller = SnackdayCoordinationController(transport: transport)
    await controller.setContext(coordinationTestContext())
    await controller.openOccurrence("occurrence_one")
    await transport.controlRecord()
    let recording = Task {
        await controller.recordAttendance(participantID: "participant_own_child", status: .yes)
    }
    await transport.waitForRecord()

    #expect(controller.state.mutation == .saving)
    await controller.claimDuty(slotID: "slot_one")
    #expect((await transport.claimedSlots()).isEmpty)
    let recorded = AttendanceRequestDTO(participantId: "participant_own_child", status: .yes)
    await transport.resumeRecord(with: AttendanceResponseDTO(attendance: recorded))
    await recording.value

    let recordedInputs = await transport.recordedAttendance()
    #expect(recordedInputs == [recorded])
    #expect(controller.state.mutation == .idle)
    guard case .loaded(let refreshed) = controller.state.detail else {
        Issue.record("Expected refreshed attendance after serialized write")
        return
    }
    #expect(refreshed.attendance.responseOptions.first?.status == .yes)
}

@MainActor @Test func unauthorizedScheduleClearsContextButKeepsVisibleFailure() async {
    let transport = CoordinationTransportProbe()
    await transport.enqueueSchedule(.failure(.unauthorized))
    let controller = SnackdayCoordinationController(transport: transport)

    await controller.setContext(coordinationTestContext())

    #expect(controller.state.context == nil)
    #expect(controller.state.schedule == .failed(.unauthorized))
    #expect(controller.state.selectedOccurrenceID == nil)
    #expect(controller.state.detail == .idle)
}
