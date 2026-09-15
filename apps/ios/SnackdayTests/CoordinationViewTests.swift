import Foundation
import SnackdayDomain
import Testing
@testable import Snackday

private let coordinationContext = CoordinationContext(
    personID: "person-adult",
    teamID: "team-a",
    seasonID: "season-a",
    timeZone: "America/Los_Angeles",
    canManage: true
)

@MainActor
@Test func createEventRetainsARequestIDForRetryAndChangesItWithTheDraft() async throws {
    let controller = RecordingCoordinationController(context: coordinationContext)
    controller.createResult = false
    let now = try #require(ISO8601DateFormatter().date(from: "2027-01-01T00:00:00Z"))
    let ids = UUIDSequence([
        try #require(UUID(uuidString: "11111111-1111-1111-1111-111111111111")),
        try #require(UUID(uuidString: "22222222-2222-2222-2222-222222222222")),
    ])
    let model = CreateEventFormModel(
        context: coordinationContext,
        controller: controller,
        now: { now },
        makeRequestID: { ids.next() }
    )
    model.title = "Saturday Practice"
    model.eventDate = now.addingTimeInterval(48 * 60 * 60)

    #expect(await model.submit() == false)
    #expect(await model.submit() == false)
    #expect(controller.createdInputs.count == 2)
    #expect(controller.createdInputs[0].requestId == controller.createdInputs[1].requestId)

    model.title = "Saturday Game"
    #expect(await model.submit() == false)
    #expect(controller.createdInputs[2].requestId == "22222222-2222-2222-2222-222222222222")
}

@MainActor
@Test func createEventUsesSeasonTimeZoneAndAnAtomicSnackSlot() async throws {
    let controller = RecordingCoordinationController(context: coordinationContext)
    let now = try #require(ISO8601DateFormatter().date(from: "2027-01-01T00:00:00Z"))
    let eventDate = try #require(ISO8601DateFormatter().date(from: "2027-01-02T01:30:00Z"))
    let model = CreateEventFormModel(
        context: coordinationContext,
        controller: controller,
        now: { now },
        makeRequestID: { UUID(uuidString: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")! }
    )
    model.title = "  Evening Game  "
    model.kind = .game
    model.eventDate = eventDate
    model.snackLabel = "  Halftime snacks "
    model.snackInstructions = "  Nut free  "

    #expect(await model.submit())
    let request = try #require(controller.createdInputs.first)
    #expect(request.title == "Evening Game")
    #expect(request.schedule.timeZone == "America/Los_Angeles")
    #expect(request.schedule.startDate == "2027-01-01")
    #expect(request.schedule.localTime == "17:30")
    #expect(request.schedule.frequency == .once)
    #expect(request.snackDuty == DutySlotInputDTO(label: "Halftime snacks", instructions: "Nut free"))
}

@MainActor
@Test func createEventFailsClosedForMissingManagementHintOrMismatchedContext() async throws {
    let controller = RecordingCoordinationController(context: coordinationContext)
    let noManagement = CoordinationContext(
        personID: coordinationContext.personID,
        teamID: coordinationContext.teamID,
        seasonID: coordinationContext.seasonID,
        timeZone: coordinationContext.timeZone,
        canManage: false
    )
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let model = CreateEventFormModel(
        context: noManagement,
        controller: controller,
        now: { now }
    )
    model.title = "Forbidden event"
    model.eventDate = now.addingTimeInterval(60)

    #expect(model.canSubmit == false)
    #expect(await model.submit() == false)
    #expect(controller.createdInputs.isEmpty)
}

@MainActor
@Test func emptyScheduleRefreshDelegatesForTheMatchingContextOnly() async {
    let controller = RecordingCoordinationController(context: coordinationContext)
    let model = CoordinationViewModel(controller: controller)

    await model.reloadSchedule(for: coordinationContext)
    #expect(controller.reloadCount == 1)

    let otherSeason = CoordinationContext(
        personID: coordinationContext.personID,
        teamID: coordinationContext.teamID,
        seasonID: "season-b",
        timeZone: coordinationContext.timeZone,
        canManage: true
    )
    await model.reloadSchedule(for: otherSeason)
    #expect(controller.reloadCount == 1)
}

@Test func scheduleRowsSortOccurrencesWithoutHidingCancellation() {
    let later = fixtureEvent(
        seriesID: "series-later",
        occurrenceID: "occurrence-later",
        startsAt: "2027-05-02T17:00:00Z",
        status: .scheduled
    )
    let cancelled = fixtureEvent(
        seriesID: "series-cancelled",
        occurrenceID: "occurrence-cancelled",
        startsAt: "2027-05-01T17:00:00Z",
        status: .cancelled
    )

    let rows = scheduleRows([later, cancelled])
    #expect(rows.map(\.occurrence.id) == ["occurrence-cancelled", "occurrence-later"])
    #expect(rows.first?.occurrence.status == .cancelled)
}

@Test func eventFormattingAcceptsCanonicalAndWholeSecondServerTimestamps() throws {
    let canonical = "2026-10-03T17:00:00.000Z"
    let wholeSecond = "2026-10-03T17:00:00Z"
    let offset = "2026-10-03T10:00:00.125-07:00"

    let canonicalDate = try #require(CoordinationFormatting.instant(canonical))
    let wholeSecondDate = try #require(CoordinationFormatting.instant(wholeSecond))
    #expect(canonicalDate == wholeSecondDate)
    let offsetDate = try #require(CoordinationFormatting.instant(offset))
    #expect(abs(offsetDate.timeIntervalSince(wholeSecondDate) - 0.125) < 0.001)
    #expect(
        CoordinationFormatting.eventDate(canonical, timeZoneID: "America/Los_Angeles")
            != "Date unavailable"
    )
    #expect(CoordinationFormatting.instant("not-a-timestamp") == nil)
}

@Test func unauthorizedDetectionCoversEveryControllerFailureSurface() {
    #expect(
        CoordinationViewModel.containsUnauthorized(
            CoordinationState(context: coordinationContext, schedule: .failed(.unauthorized))
        )
    )
    #expect(
        CoordinationViewModel.containsUnauthorized(
            CoordinationState(context: coordinationContext, detail: .failed(.unauthorized))
        )
    )
    #expect(
        CoordinationViewModel.containsUnauthorized(
            CoordinationState(context: coordinationContext, mutation: .failed(.unauthorized))
        )
    )
    #expect(!CoordinationViewModel.containsUnauthorized(CoordinationState(context: coordinationContext)))
}

@MainActor
@Test func unauthorizedTransitionClearsPresentedContextAndExpiresSessionOnce() async {
    let controller = StreamingCoordinationController(context: coordinationContext)
    let model = CoordinationViewModel(controller: controller)
    var expirationCount = 0
    let observation = Task {
        await model.observe { expirationCount += 1 }
    }
    await Task.yield()

    controller.send(CoordinationState(context: coordinationContext, schedule: .failed(.unauthorized)))
    await waitUntil { expirationCount == 1 }
    #expect(model.state.context == nil)

    controller.send(CoordinationState(context: coordinationContext, mutation: .failed(.unauthorized)))
    for _ in 0..<10 { await Task.yield() }
    #expect(expirationCount == 1)

    controller.send(CoordinationState(context: coordinationContext, schedule: .loaded([])))
    await waitUntil { model.state.context == coordinationContext }
    controller.send(CoordinationState(context: coordinationContext, detail: .failed(.unauthorized)))
    await waitUntil { expirationCount == 2 }

    controller.finish()
    await observation.value
}

@MainActor
private final class RecordingCoordinationController: SnackdayCoordinationControlling {
    var state: CoordinationState
    var createResult = true
    private(set) var reloadCount = 0
    private(set) var createdInputs: [CreateEventRequestDTO] = []

    init(context: CoordinationContext) {
        state = CoordinationState(context: context, schedule: .loaded([]))
    }

    func stateUpdates() -> AsyncStream<CoordinationState> { AsyncStream { $0.finish() } }
    func setContext(_ context: CoordinationContext?) async { state.context = context }
    func reloadSchedule() async { reloadCount += 1 }
    func openOccurrence(_: String?) async {}
    func recordAttendance(participantID _: String, status _: AttendanceStatusDTO) async {}
    func claimDuty(slotID _: String) async {}

    func createEvent(_ input: CreateEventRequestDTO) async -> Bool {
        createdInputs.append(input)
        state.mutation = createResult ? .idle : .failed(.offline)
        return createResult
    }
}

@MainActor
private final class StreamingCoordinationController: SnackdayCoordinationControlling {
    var state: CoordinationState
    private let updates = AsyncStream.makeStream(of: CoordinationState.self)

    init(context: CoordinationContext) {
        state = CoordinationState(context: context, schedule: .loaded([]))
    }

    func stateUpdates() -> AsyncStream<CoordinationState> { updates.stream }
    func send(_ update: CoordinationState) { state = update; updates.continuation.yield(update) }
    func finish() { updates.continuation.finish() }
    func setContext(_ context: CoordinationContext?) async { state.context = context }
    func reloadSchedule() async {}
    func openOccurrence(_: String?) async {}
    func createEvent(_: CreateEventRequestDTO) async -> Bool { false }
    func recordAttendance(participantID _: String, status _: AttendanceStatusDTO) async {}
    func claimDuty(slotID _: String) async {}
}

private final class UUIDSequence: @unchecked Sendable {
    private var values: [UUID]
    init(_ values: [UUID]) { self.values = values }
    func next() -> UUID { values.removeFirst() }
}

@MainActor
private func waitUntil(_ condition: () -> Bool) async {
    for _ in 0..<100 where !condition() { await Task.yield() }
}

private func fixtureEvent(
    seriesID: String,
    occurrenceID: String,
    startsAt: String,
    status: EventOccurrenceStatus
) -> ScheduleEventDTO {
    let series = EventSeriesDTO(
        id: seriesID,
        teamId: "team-a",
        seasonId: "season-a",
        title: "Fixture",
        kind: .practice,
        timeZone: "America/Los_Angeles",
        localTime: "10:00",
        durationMinutes: 60,
        frequency: .once,
        startDate: "2027-05-01",
        status: .active,
        createdAt: startsAt,
        updatedAt: startsAt
    )
    let occurrence = EventOccurrenceDTO(
        id: occurrenceID,
        seriesId: seriesID,
        localDate: "2027-05-01",
        startsAt: startsAt,
        durationMinutes: 60,
        status: status,
        createdAt: startsAt,
        updatedAt: startsAt
    )
    return ScheduleEventDTO(series: series, occurrences: [occurrence])
}
