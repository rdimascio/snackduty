#if DEBUG
import Foundation
import SnackdayDomain

@MainActor
final class CoordinationFixtureController: SnackdayCoordinationControlling {
    private(set) var state: CoordinationState

    private let scenarioName: String
    private var continuation: AsyncStream<CoordinationState>.Continuation?

    init(context: CoordinationContext, scenarioName: String = "ready") {
        self.scenarioName = scenarioName
        state = Self.initialState(context: context, scenarioName: scenarioName)
    }

    func stateUpdates() -> AsyncStream<CoordinationState> {
        let pair = AsyncStream.makeStream(of: CoordinationState.self, bufferingPolicy: .bufferingNewest(1))
        continuation?.finish()
        continuation = pair.continuation
        pair.continuation.yield(state)
        return pair.stream
    }

    func setContext(_ context: CoordinationContext?) async {
        guard let context else {
            state = CoordinationState()
            publish()
            return
        }
        guard state.context != context else { return }
        state = Self.initialState(context: context, scenarioName: scenarioName)
        publish()
    }

    func reloadSchedule() async {
        guard let context = state.context else { return }
        state.schedule = .loading
        publish()
        await Task.yield()
        state = Self.initialState(
            context: context,
            scenarioName: scenarioName == "coordination-error" ? "empty" : scenarioName
        )
        publish()
    }

    func openOccurrence(_ occurrenceID: String?) async {
        guard let occurrenceID, state.context != nil else {
            state.selectedOccurrenceID = nil
            state.detail = .idle
            state.mutation = .idle
            publish()
            return
        }
        guard let row = fixtureRows.first(where: { $0.occurrence.id == occurrenceID }) else {
            state.selectedOccurrenceID = occurrenceID
            state.detail = .failed(.notFound)
            publish()
            return
        }
        state.selectedOccurrenceID = occurrenceID
        state.detail = .loading
        state.mutation = .idle
        publish()
        await Task.yield()
        state.detail = .loaded(Self.detail(for: row.occurrence.id))
        publish()
    }

    func createEvent(_ input: CreateEventRequestDTO) async -> Bool {
        guard state.context?.canManage == true else {
            state.mutation = .failed(.unauthorized)
            publish()
            return false
        }
        state.mutation = .saving
        publish()
        await Task.yield()
        guard let context = state.context else { return false }

        let occurrenceID = "occurrence-created"
        let timestamp = "2027-05-09T17:00:00.000Z"
        let series = EventSeriesDTO(
            id: "series-created",
            teamId: context.teamID,
            seasonId: context.seasonID,
            title: input.title,
            kind: input.kind,
            location: input.location,
            notes: input.notes,
            timeZone: input.schedule.timeZone,
            localTime: input.schedule.localTime,
            durationMinutes: input.schedule.durationMinutes,
            frequency: input.schedule.frequency,
            byWeekday: input.schedule.byWeekday,
            startDate: input.schedule.startDate,
            untilDate: input.schedule.untilDate,
            status: .active,
            createdAt: timestamp,
            updatedAt: timestamp
        )
        let occurrence = EventOccurrenceDTO(
            id: occurrenceID,
            seriesId: series.id,
            localDate: input.schedule.startDate,
            startsAt: timestamp,
            durationMinutes: input.schedule.durationMinutes,
            status: .scheduled,
            createdAt: timestamp,
            updatedAt: timestamp,
            attendance: AttendanceCountsDTO(yes: 0, no: 0, maybe: 0)
        )
        var events: [ScheduleEventDTO] = []
        if case .loaded(let existing) = state.schedule { events = existing }
        events.append(ScheduleEventDTO(series: series, occurrences: [occurrence]))
        state.schedule = .loaded(events)
        state.mutation = .idle
        publish()
        return true
    }

    func recordAttendance(participantID: String, status: AttendanceStatusDTO) async {
        guard case .loaded(let current) = state.detail,
              current.attendance.responseOptions.contains(where: { $0.participantId == participantID })
        else {
            state.mutation = .failed(.unauthorized)
            publish()
            return
        }
        state.mutation = .saving
        publish()
        await Task.yield()

        let entries = current.attendance.entries.filter { $0.participantId != participantID }
            + [AttendanceEntryDTO(participantId: participantID, displayName: displayName(participantID), status: status)]
        let options = current.attendance.responseOptions.map {
            AttendanceOptionDTO(
                participantId: $0.participantId,
                displayName: $0.displayName,
                status: $0.participantId == participantID ? status : $0.status
            )
        }
        let counts = AttendanceCountsDTO(
            yes: entries.filter { $0.status == .yes }.count,
            no: entries.filter { $0.status == .no }.count,
            maybe: entries.filter { $0.status == .maybe }.count
        )
        state.detail = .loaded(
            CoordinationDetail(
                occurrenceID: current.occurrenceID,
                attendance: AttendanceReadDTO(counts: counts, entries: entries, responseOptions: options),
                dutySlots: current.dutySlots
            )
        )
        state.mutation = .idle
        publish()
    }

    func claimDuty(slotID: String) async {
        guard case .loaded(let current) = state.detail,
              let context = state.context,
              current.dutySlots.contains(where: { $0.id == slotID && $0.assignee == nil })
        else {
            state.mutation = .failed(.dutyTaken)
            publish()
            return
        }
        state.mutation = .saving
        publish()
        await Task.yield()
        let slots = current.dutySlots.map { slot in
            guard slot.id == slotID else { return slot }
            return DutySlotDTO(
                id: slot.id,
                occurrenceId: slot.occurrenceId,
                label: slot.label,
                instructions: slot.instructions,
                assignee: DutyAssigneeDTO(personId: context.personID, displayName: "Fixture Parent"),
                createdAt: slot.createdAt,
                updatedAt: "2027-05-01T18:01:00.000Z"
            )
        }
        state.detail = .loaded(
            CoordinationDetail(
                occurrenceID: current.occurrenceID,
                attendance: current.attendance,
                dutySlots: slots
            )
        )
        state.mutation = .idle
        publish()
    }

    private var fixtureRows: [ScheduleRow] {
        guard case .loaded(let events) = state.schedule else { return [] }
        return scheduleRows(events)
    }

    private func displayName(_ participantID: String) -> String {
        guard case .loaded(let detail) = state.detail else { return "Player" }
        return detail.attendance.responseOptions.first(where: { $0.participantId == participantID })?.displayName
            ?? "Player"
    }

    private func publish() {
        continuation?.yield(state)
    }

    private static func initialState(
        context: CoordinationContext,
        scenarioName: String
    ) -> CoordinationState {
        if scenarioName == "coordination-loading" {
            return CoordinationState(context: context, schedule: .loading)
        }
        if scenarioName == "coordination-error" {
            return CoordinationState(context: context, schedule: .failed(.offline))
        }
        if scenarioName == "empty" || scenarioName == "coordination-empty" {
            return CoordinationState(context: context, schedule: .loaded([]))
        }
        let event = fixtureEvent(context: context, cancelled: scenarioName == "coordination-cancelled")
        return CoordinationState(context: context, schedule: .loaded([event]))
    }

    private static func fixtureEvent(
        context: CoordinationContext,
        cancelled: Bool
    ) -> ScheduleEventDTO {
        let timestamp = "2027-05-01T17:00:00.000Z"
        let series = EventSeriesDTO(
            id: "series-fixture",
            teamId: context.teamID,
            seasonId: context.seasonID,
            title: "Fixture Practice",
            kind: .practice,
            location: "Fixture Field",
            notes: "Bring water.",
            timeZone: context.timeZone,
            localTime: "10:00",
            durationMinutes: 60,
            frequency: .once,
            startDate: "2027-05-01",
            status: .active,
            createdAt: timestamp,
            updatedAt: timestamp
        )
        let occurrence = EventOccurrenceDTO(
            id: "occurrence-fixture",
            seriesId: series.id,
            localDate: "2027-05-01",
            startsAt: timestamp,
            durationMinutes: 60,
            status: cancelled ? .cancelled : .scheduled,
            cancelledReason: cancelled ? "Field closed" : nil,
            createdAt: timestamp,
            updatedAt: timestamp,
            attendance: AttendanceCountsDTO(yes: 0, no: 0, maybe: 0)
        )
        return ScheduleEventDTO(series: series, occurrences: [occurrence])
    }

    private static func detail(for occurrenceID: String) -> CoordinationDetail {
        let timestamp = "2027-05-01T17:00:00.000Z"
        return CoordinationDetail(
            occurrenceID: occurrenceID,
            attendance: AttendanceReadDTO(
                counts: AttendanceCountsDTO(yes: 0, no: 0, maybe: 0),
                entries: [],
                responseOptions: [
                    AttendanceOptionDTO(
                        participantId: "participant-fixture-child",
                        displayName: "Fixture Player"
                    )
                ]
            ),
            dutySlots: [
                DutySlotDTO(
                    id: occurrenceID == "occurrence-created" ? "slot-created" : "slot-fixture",
                    occurrenceId: occurrenceID,
                    label: "Snacks",
                    instructions: "Nut-free options, please.",
                    createdAt: timestamp,
                    updatedAt: timestamp
                )
            ]
        )
    }
}
#endif
