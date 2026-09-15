import Foundation
import Observation
import SnackdayDesignSystem
import SnackdayDomain
import SwiftUI

@MainActor @Observable
final class CoordinationViewModel {
    private(set) var state: CoordinationState

    private let controller: any SnackdayCoordinationControlling
    private var handlingUnauthorized = false

    init(controller: any SnackdayCoordinationControlling) {
        self.controller = controller
        state = controller.state
    }

    func observe(sessionExpired: @escaping @MainActor () async -> Void) async {
        await receive(controller.state, sessionExpired: sessionExpired)
        for await update in controller.stateUpdates() {
            guard !Task.isCancelled else { return }
            await receive(update, sessionExpired: sessionExpired)
        }
    }

    func reloadIfNeeded(for context: CoordinationContext) async {
        guard controller.state.context == context else { return }
        if case .idle = controller.state.schedule {
            await controller.reloadSchedule()
        }
    }

    func reloadSchedule(for context: CoordinationContext) async {
        guard controller.state.context == context else { return }
        await controller.reloadSchedule()
    }

    func openOccurrence(_ occurrenceID: String, in context: CoordinationContext) async {
        guard controller.state.context == context else { return }
        await controller.openOccurrence(occurrenceID)
    }

    private func receive(
        _ update: CoordinationState,
        sessionExpired: @escaping @MainActor () async -> Void
    ) async {
        let unauthorized = Self.containsUnauthorized(update)
        if unauthorized {
            guard !handlingUnauthorized else { return }
            handlingUnauthorized = true
            state = CoordinationState()
            await sessionExpired()
            return
        }
        handlingUnauthorized = false
        state = update
    }

    static func containsUnauthorized(_ state: CoordinationState) -> Bool {
        if case .failed(.unauthorized) = state.schedule { return true }
        if case .failed(.unauthorized) = state.detail { return true }
        if case .failed(.unauthorized) = state.mutation { return true }
        return false
    }
}

struct ScheduleView: View {
    let context: CoordinationContext
    private let controller: any SnackdayCoordinationControlling
    private let sessionExpired: @MainActor () async -> Void

    @State private var model: CoordinationViewModel
    @State private var navigationPath: [String] = []
    @State private var showingCreateEvent = false

    @MainActor
    init(
        context: CoordinationContext,
        controller: any SnackdayCoordinationControlling,
        sessionExpired: @escaping @MainActor () async -> Void = {}
    ) {
        self.context = context
        self.controller = controller
        self.sessionExpired = sessionExpired
        _model = State(initialValue: CoordinationViewModel(controller: controller))
    }

    var body: some View {
        navigation
            .sheet(isPresented: $showingCreateEvent) {
                CreateEventView(context: context, controller: controller, state: model.state)
            }
            .task { await model.observe(sessionExpired: sessionExpired) }
            .task(id: context) { await model.reloadIfNeeded(for: context) }
            .onChange(of: context) {
                navigationPath.removeAll()
                showingCreateEvent = false
            }
    }

    private var navigation: some View {
        NavigationStack(path: $navigationPath) {
            content
                .navigationTitle("Schedule")
                .toolbar {
                    if context.canManage, matchingState != nil {
                        ToolbarItem(placement: .primaryAction) {
                            Button {
                                showingCreateEvent = true
                            } label: {
                                Label("Create Event", systemImage: "plus")
                            }
                            .accessibilityIdentifier("schedule-create-event")
                        }
                    }
                }
                .navigationDestination(for: String.self) { occurrenceID in
                    EventDetailView(
                        context: context,
                        controller: controller,
                        state: model.state,
                        occurrenceID: occurrenceID
                    )
                }
        }
    }

    @ViewBuilder private var content: some View {
        if let state = matchingState {
            switch state.schedule {
            case .idle, .loading:
                ProgressView("Loading schedule…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("schedule-loading")
            case .failed(let failure):
                ScheduleFailureView(failure: failure) {
                    await model.reloadSchedule(for: context)
                }
            case .loaded(let events):
                ScheduleLoadedView(events: events, context: context) {
                    await model.reloadSchedule(for: context)
                }
            }
        } else {
            ProgressView("Loading selected season…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("schedule-context-loading")
        }
    }

    private var matchingState: CoordinationState? {
        model.state.context == context ? model.state : nil
    }

}

private struct ScheduleFailureView: View {
    let failure: CoordinationFailure
    let retry: @MainActor () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label(CoordinationCopy.title(for: failure), systemImage: CoordinationCopy.image(for: failure))
        } description: {
            Text(CoordinationCopy.message(for: failure))
        } actions: {
            if failure != .unauthorized {
                Button("Try Again") {
                    Task { await retry() }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("schedule-retry")
            }
        }
        .accessibilityIdentifier("schedule-error")
    }
}

private struct ScheduleLoadedView: View {
    let events: [ScheduleEventDTO]
    let context: CoordinationContext
    let reload: @MainActor () async -> Void

    var body: some View {
        let rows = scheduleRows(events)
        if rows.isEmpty {
            ContentUnavailableView {
                Label("No events yet", systemImage: "calendar")
            } description: {
                Text(
                    context.canManage
                        ? "Create the first event for this season."
                        : "Events will appear here after a coach adds them."
                )
            } actions: {
                Button("Refresh Schedule") {
                    Task { await reload() }
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("schedule-refresh")
            }
            .accessibilityIdentifier("schedule-empty")
        } else {
            List(rows) { row in
                NavigationLink(value: row.occurrence.id) {
                    ScheduleEventRow(row: row, timeZoneID: context.timeZone)
                }
                .accessibilityIdentifier("schedule-event-\(row.occurrence.id)")
            }
            .refreshable { await reload() }
            .accessibilityIdentifier("schedule-list")
        }
    }
}

struct ScheduleRow: Identifiable, Equatable {
    let series: EventSeriesDTO
    let occurrence: EventOccurrenceDTO
    var id: String { occurrence.id }
}

func scheduleRows(_ events: [ScheduleEventDTO]) -> [ScheduleRow] {
    events
        .flatMap { event in
            event.occurrences.map { ScheduleRow(series: event.series, occurrence: $0) }
        }
        .sorted {
            $0.occurrence.startsAt == $1.occurrence.startsAt
                ? $0.occurrence.id < $1.occurrence.id
                : $0.occurrence.startsAt < $1.occurrence.startsAt
        }
}

private struct ScheduleEventRow: View {
    let row: ScheduleRow
    let timeZoneID: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(row.series.title)
                    .font(.headline)
                Spacer()
                if row.occurrence.status == .cancelled {
                    Text("Cancelled")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.red)
                }
            }
            Text(CoordinationFormatting.eventDate(row.occurrence.startsAt, timeZoneID: timeZoneID))
                .foregroundStyle(.secondary)
            if let attendance = row.occurrence.attendance {
                Text("\(attendance.yes) going · \(attendance.maybe) maybe")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

enum CoordinationFormatting {
    static func eventDate(_ value: String, timeZoneID: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return "Date unavailable" }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.timeZone = TimeZone(identifier: timeZoneID) ?? TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    static func localDate(_ date: Date, timeZoneID: String) -> String {
        components(date, timeZoneID: timeZoneID, format: "%04d-%02d-%02d") { value in
            [value.year ?? 0, value.month ?? 0, value.day ?? 0]
        }
    }

    static func localTime(_ date: Date, timeZoneID: String) -> String {
        components(date, timeZoneID: timeZoneID, format: "%02d:%02d") { value in
            [value.hour ?? 0, value.minute ?? 0]
        }
    }

    private static func components(
        _ date: Date,
        timeZoneID: String,
        format: String,
        values: (DateComponents) -> [Int]
    ) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeZoneID) ?? .gmt
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(format: format, arguments: values(components).map { $0 as CVarArg })
    }
}

enum CoordinationCopy {
    static func title(for failure: CoordinationFailure) -> String {
        switch failure {
        case .unauthorized: return "Sign in again"
        case .offline: return "You’re offline"
        case .dutyTaken: return "Snack duty was claimed"
        case .occurrenceUnavailable: return "Event unavailable"
        case .requestConflict: return "Request changed"
        case .invalidInput: return "Check the details"
        case .notFound: return "Event unavailable"
        case .invalidResponse: return "Unexpected response"
        case .unavailable, .requestFailed: return "Couldn’t reach Snackday"
        }
    }

    static func message(for failure: CoordinationFailure) -> String {
        switch failure {
        case .unauthorized: return "Your session expired."
        case .offline: return "Connect to the internet, then try again."
        case .dutyTaken: return "Another adult claimed this duty. Refresh to see the assignment."
        case .occurrenceUnavailable: return "This event can no longer accept changes."
        case .requestConflict: return "Change the form and submit it as a new request."
        case .invalidInput: return "Review the event information and try again."
        case .notFound: return "This event is no longer available to this account."
        case .invalidResponse: return "Snackday received an unexpected response."
        case .unavailable, .requestFailed: return "The service is unavailable right now. Try again shortly."
        }
    }

    static func image(for failure: CoordinationFailure) -> String {
        switch failure {
        case .offline: return "wifi.slash"
        case .unauthorized: return "person.crop.circle.badge.exclamationmark"
        case .dutyTaken: return "takeoutbag.and.cup.and.straw.fill"
        case .occurrenceUnavailable, .notFound: return "calendar.badge.exclamationmark"
        default: return "exclamationmark.arrow.triangle.2.circlepath"
        }
    }
}
