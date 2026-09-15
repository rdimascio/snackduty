import Foundation

// Frozen wire contracts. Server policy remains authoritative for every call.
public enum EventKindDTO: String, Codable, CaseIterable, Sendable { case practice, game, other }
public enum EventFrequency: String, Codable, Sendable { case once, weekly }
public enum EventSeriesStatus: String, Codable, Sendable { case active, archived }
public enum EventOccurrenceStatus: String, Codable, Sendable { case scheduled, cancelled }
public enum AttendanceStatusDTO: String, Codable, CaseIterable, Sendable { case yes, no, maybe }

public struct EventScheduleDTO: Codable, Equatable, Sendable {
    public let timeZone: String
    public let localTime: String
    public let durationMinutes: Int
    public let frequency: EventFrequency
    public let byWeekday: [String]?
    public let startDate: String
    public let untilDate: String?
    public init(timeZone: String, localTime: String, durationMinutes: Int, frequency: EventFrequency, byWeekday: [String]? = nil, startDate: String, untilDate: String? = nil) {
        self.timeZone = timeZone
        self.localTime = localTime
        self.durationMinutes = durationMinutes
        self.frequency = frequency
        self.byWeekday = byWeekday
        self.startDate = startDate
        self.untilDate = untilDate
    }
}

public struct CreateEventRequestDTO: Codable, Equatable, Sendable {
    public let title: String
    public let kind: EventKindDTO
    public let location: String?
    public let notes: String?
    public let schedule: EventScheduleDTO
    public let requestId: String?
    public let snackDuty: DutySlotInputDTO?
    public init(title: String, kind: EventKindDTO, location: String? = nil, notes: String? = nil, schedule: EventScheduleDTO, requestId: String? = nil, snackDuty: DutySlotInputDTO? = nil) {
        self.title = title
        self.kind = kind
        self.location = location
        self.notes = notes
        self.schedule = schedule
        self.requestId = requestId
        self.snackDuty = snackDuty
    }
}

public struct DutySlotInputDTO: Codable, Equatable, Sendable {
    public let label: String
    public let instructions: String?
    public init(label: String, instructions: String? = nil) {
        self.label = label
        self.instructions = instructions
    }
}

public struct EventSeriesDTO: Codable, Equatable, Sendable {
    public let id: String
    public let teamId: String
    public let seasonId: String
    public let title: String
    public let kind: EventKindDTO
    public let location: String?
    public let notes: String?
    public let timeZone: String
    public let localTime: String
    public let durationMinutes: Int
    public let frequency: EventFrequency
    public let byWeekday: [String]?
    public let startDate: String
    public let untilDate: String?
    public let status: EventSeriesStatus
    public let createdAt: String
    public let updatedAt: String
    public init(id: String, teamId: String, seasonId: String, title: String, kind: EventKindDTO, location: String? = nil, notes: String? = nil, timeZone: String, localTime: String, durationMinutes: Int, frequency: EventFrequency, byWeekday: [String]? = nil, startDate: String, untilDate: String? = nil, status: EventSeriesStatus, createdAt: String, updatedAt: String) {
        self.id = id
        self.teamId = teamId
        self.seasonId = seasonId
        self.title = title
        self.kind = kind
        self.location = location
        self.notes = notes
        self.timeZone = timeZone
        self.localTime = localTime
        self.durationMinutes = durationMinutes
        self.frequency = frequency
        self.byWeekday = byWeekday
        self.startDate = startDate
        self.untilDate = untilDate
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct EventOccurrenceDTO: Codable, Equatable, Sendable {
    public let id: String
    public let seriesId: String
    public let localDate: String
    public let startsAt: String
    public let durationMinutes: Int
    public let status: EventOccurrenceStatus
    public let cancelledReason: String?
    public let createdAt: String
    public let updatedAt: String
    public let attendance: AttendanceCountsDTO?
    public init(id: String, seriesId: String, localDate: String, startsAt: String, durationMinutes: Int, status: EventOccurrenceStatus, cancelledReason: String? = nil, createdAt: String, updatedAt: String, attendance: AttendanceCountsDTO? = nil) {
        self.id = id
        self.seriesId = seriesId
        self.localDate = localDate
        self.startsAt = startsAt
        self.durationMinutes = durationMinutes
        self.status = status
        self.cancelledReason = cancelledReason
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.attendance = attendance
    }
}

public struct AttendanceCountsDTO: Codable, Equatable, Sendable {
    public let yes: Int
    public let no: Int
    public let maybe: Int
    public init(yes: Int, no: Int, maybe: Int) {
        self.yes = yes
        self.no = no
        self.maybe = maybe
    }
}

public struct ScheduleEventDTO: Codable, Equatable, Sendable {
    public let series: EventSeriesDTO
    public let occurrences: [EventOccurrenceDTO]
    public init(series: EventSeriesDTO, occurrences: [EventOccurrenceDTO]) {
        self.series = series
        self.occurrences = occurrences
    }
}

public struct SeasonEventsResponseDTO: Codable, Equatable, Sendable {
    public let events: [ScheduleEventDTO]
    public init(events: [ScheduleEventDTO]) {
        self.events = events
    }
}

public struct CreateEventResponseDTO: Codable, Equatable, Sendable {
    public let series: EventSeriesDTO
    public let occurrences: [EventOccurrenceDTO]
    public let dutySlots: [DutySlotDTO]
    public init(series: EventSeriesDTO, occurrences: [EventOccurrenceDTO], dutySlots: [DutySlotDTO]) {
        self.series = series
        self.occurrences = occurrences
        self.dutySlots = dutySlots
    }
}

public struct DutyAssigneeDTO: Codable, Equatable, Sendable {
    public let personId: String
    public let displayName: String
    public init(personId: String, displayName: String) {
        self.personId = personId
        self.displayName = displayName
    }
}

public struct DutySlotDTO: Codable, Equatable, Sendable {
    public let id: String
    public let occurrenceId: String
    public let label: String
    public let instructions: String?
    public let assignee: DutyAssigneeDTO?
    public let createdAt: String
    public let updatedAt: String
    public init(id: String, occurrenceId: String, label: String, instructions: String? = nil, assignee: DutyAssigneeDTO? = nil, createdAt: String, updatedAt: String) {
        self.id = id
        self.occurrenceId = occurrenceId
        self.label = label
        self.instructions = instructions
        self.assignee = assignee
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct DutySlotsResponseDTO: Codable, Equatable, Sendable {
    public let dutySlots: [DutySlotDTO]
    public init(dutySlots: [DutySlotDTO]) {
        self.dutySlots = dutySlots
    }
}

public struct DutySlotResponseDTO: Codable, Equatable, Sendable {
    public let dutySlot: DutySlotDTO
    public init(dutySlot: DutySlotDTO) {
        self.dutySlot = dutySlot
    }
}

public struct AttendanceRequestDTO: Codable, Equatable, Sendable {
    public let participantId: String
    public let status: AttendanceStatusDTO
    public init(participantId: String, status: AttendanceStatusDTO) {
        self.participantId = participantId
        self.status = status
    }
}

public struct AttendanceEntryDTO: Codable, Equatable, Sendable {
    public let participantId: String
    public let displayName: String
    public let status: AttendanceStatusDTO
    public init(participantId: String, displayName: String, status: AttendanceStatusDTO) {
        self.participantId = participantId
        self.displayName = displayName
        self.status = status
    }
}

public struct AttendanceOptionDTO: Codable, Equatable, Sendable {
    public let participantId: String
    public let displayName: String
    public let status: AttendanceStatusDTO?
    public init(participantId: String, displayName: String, status: AttendanceStatusDTO? = nil) {
        self.participantId = participantId
        self.displayName = displayName
        self.status = status
    }
}

public struct AttendanceReadDTO: Codable, Equatable, Sendable {
    public let counts: AttendanceCountsDTO
    public let entries: [AttendanceEntryDTO]
    public let responseOptions: [AttendanceOptionDTO]
    public init(counts: AttendanceCountsDTO, entries: [AttendanceEntryDTO], responseOptions: [AttendanceOptionDTO]) {
        self.counts = counts
        self.entries = entries
        self.responseOptions = responseOptions
    }
}

public struct AttendanceReadResponseDTO: Codable, Equatable, Sendable {
    public let attendance: AttendanceReadDTO
    public init(attendance: AttendanceReadDTO) {
        self.attendance = attendance
    }
}

public struct AttendanceResponseDTO: Codable, Equatable, Sendable {
    public let attendance: AttendanceRequestDTO
    public init(attendance: AttendanceRequestDTO) {
        self.attendance = attendance
    }
}

public protocol SnackdayCoordinationTransport: Sendable {
    func listEvents(teamID: String, seasonID: String) async throws -> SeasonEventsResponseDTO
    func createEvent(teamID: String, seasonID: String, input: CreateEventRequestDTO) async throws -> CreateEventResponseDTO
    func readAttendance(teamID: String, occurrenceID: String) async throws -> AttendanceReadResponseDTO
    func recordAttendance(teamID: String, occurrenceID: String, input: AttendanceRequestDTO) async throws -> AttendanceResponseDTO
    func listDutySlots(teamID: String, occurrenceID: String) async throws -> DutySlotsResponseDTO
    func claimDutySlot(teamID: String, occurrenceID: String, slotID: String) async throws -> DutySlotResponseDTO
}

/// This scopes native state only. It is never sent as authority.
public struct CoordinationContext: Equatable, Sendable {
    public let personID: String
    public let teamID: String
    public let seasonID: String
    public let timeZone: String
    public let canManage: Bool
    public init(personID: String, teamID: String, seasonID: String, timeZone: String, canManage: Bool) {
        self.personID = personID; self.teamID = teamID; self.seasonID = seasonID
        self.timeZone = timeZone; self.canManage = canManage
    }
}

public enum CoordinationFailure: Error, Equatable, Sendable {
    case offline, unauthorized, unavailable, invalidResponse, notFound, invalidInput
    case dutyTaken, occurrenceUnavailable, requestConflict
    case requestFailed(statusCode: Int)
}
public enum CoordinationLoad<Value: Equatable & Sendable>: Equatable, Sendable {
    case idle, loading
    case loaded(Value)
    case failed(CoordinationFailure)
}
public struct CoordinationDetail: Equatable, Sendable {
    public let occurrenceID: String
    public let attendance: AttendanceReadDTO
    public let dutySlots: [DutySlotDTO]
    public init(occurrenceID: String, attendance: AttendanceReadDTO, dutySlots: [DutySlotDTO]) {
        self.occurrenceID = occurrenceID; self.attendance = attendance; self.dutySlots = dutySlots
    }
}
public enum CoordinationMutation: Equatable, Sendable {
    case idle, saving
    case failed(CoordinationFailure)
}
public struct CoordinationState: Equatable, Sendable {
    public var context: CoordinationContext?
    public var schedule: CoordinationLoad<[ScheduleEventDTO]>
    public var selectedOccurrenceID: String?
    public var detail: CoordinationLoad<CoordinationDetail>
    public var mutation: CoordinationMutation
    public init(context: CoordinationContext? = nil, schedule: CoordinationLoad<[ScheduleEventDTO]> = .idle,
                selectedOccurrenceID: String? = nil, detail: CoordinationLoad<CoordinationDetail> = .idle,
                mutation: CoordinationMutation = .idle) {
        self.context = context; self.schedule = schedule; self.selectedOccurrenceID = selectedOccurrenceID
        self.detail = detail; self.mutation = mutation
    }
}

@MainActor public protocol SnackdayCoordinationControlling: AnyObject {
    var state: CoordinationState { get }
    func stateUpdates() -> AsyncStream<CoordinationState>
    func setContext(_ context: CoordinationContext?) async
    func reloadSchedule() async
    func openOccurrence(_ occurrenceID: String?) async
    /// True means the write committed; a later refresh may still fail visibly.
    func createEvent(_ input: CreateEventRequestDTO) async -> Bool
    func recordAttendance(participantID: String, status: AttendanceStatusDTO) async
    func claimDuty(slotID: String) async
}
