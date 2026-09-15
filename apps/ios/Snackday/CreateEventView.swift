import Foundation
import Observation
import SnackdayDomain
import SwiftUI

@MainActor @Observable
final class CreateEventFormModel {
    var title = ""
    var kind: EventKindDTO = .practice
    var location = ""
    var notes = ""
    var eventDate: Date
    var durationMinutes = 60
    var includesSnackDuty = true
    var snackLabel = "Snacks"
    var snackInstructions = ""

    private(set) var failure: CoordinationFailure?
    private(set) var isSaving = false

    private let context: CoordinationContext
    private let controller: any SnackdayCoordinationControlling
    private let now: @Sendable () -> Date
    private let makeRequestID: @Sendable () -> UUID
    private var lastAttempt: (draft: EventDraft, requestID: UUID)?

    init(
        context: CoordinationContext,
        controller: any SnackdayCoordinationControlling,
        now: @escaping @Sendable () -> Date = { Date() },
        makeRequestID: @escaping @Sendable () -> UUID = { UUID() }
    ) {
        self.context = context
        self.controller = controller
        self.now = now
        self.makeRequestID = makeRequestID
        eventDate = now().addingTimeInterval(24 * 60 * 60)
    }

    var canSubmit: Bool {
        guard context.canManage, controller.state.context == context, eventDate > now() else {
            return false
        }
        guard (1...200).contains(trimmed(title).count), (5...1_440).contains(durationMinutes) else {
            return false
        }
        guard trimmed(location).count <= 200, trimmed(notes).count <= 2_000 else { return false }
        if includesSnackDuty {
            guard (1...120).contains(trimmed(snackLabel).count),
                  trimmed(snackInstructions).count <= 1_000
            else { return false }
        }
        return true
    }

    func submit() async -> Bool {
        guard canSubmit, !isSaving else { return false }
        let draft = makeDraft()
        let requestID: UUID
        if lastAttempt?.draft == draft, let retained = lastAttempt?.requestID {
            requestID = retained
        } else {
            requestID = makeRequestID()
            lastAttempt = (draft, requestID)
        }

        failure = nil
        isSaving = true
        defer { isSaving = false }
        let committed = await controller.createEvent(draft.request(requestID: requestID))
        guard !committed else { return true }
        if case .failed(let controllerFailure) = controller.state.mutation {
            failure = controllerFailure
        } else {
            failure = .unavailable
        }
        return false
    }

    private func makeDraft() -> EventDraft {
        EventDraft(
            title: trimmed(title),
            kind: kind,
            location: optional(location),
            notes: optional(notes),
            eventDate: eventDate,
            durationMinutes: durationMinutes,
            snackDuty: includesSnackDuty
                ? DutySlotInputDTO(label: trimmed(snackLabel), instructions: optional(snackInstructions))
                : nil,
            timeZoneID: context.timeZone
        )
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func optional(_ value: String) -> String? {
        let value = trimmed(value)
        return value.isEmpty ? nil : value
    }
}

struct EventDraft: Equatable {
    let title: String
    let kind: EventKindDTO
    let location: String?
    let notes: String?
    let eventDate: Date
    let durationMinutes: Int
    let snackDuty: DutySlotInputDTO?
    let timeZoneID: String

    func request(requestID: UUID) -> CreateEventRequestDTO {
        CreateEventRequestDTO(
            title: title,
            kind: kind,
            location: location,
            notes: notes,
            schedule: EventScheduleDTO(
                timeZone: timeZoneID,
                localTime: CoordinationFormatting.localTime(eventDate, timeZoneID: timeZoneID),
                durationMinutes: durationMinutes,
                frequency: .once,
                startDate: CoordinationFormatting.localDate(eventDate, timeZoneID: timeZoneID)
            ),
            requestId: requestID.uuidString.lowercased(),
            snackDuty: snackDuty
        )
    }
}

struct CreateEventView: View {
    let context: CoordinationContext
    let state: CoordinationState
    @Environment(\.dismiss) private var dismiss
    @State private var model: CreateEventFormModel

    @MainActor
    init(
        context: CoordinationContext,
        controller: any SnackdayCoordinationControlling,
        state: CoordinationState,
        now: @escaping @Sendable () -> Date = { Date() },
        makeRequestID: @escaping @Sendable () -> UUID = { UUID() }
    ) {
        self.context = context
        self.state = state
        _model = State(
            initialValue: CreateEventFormModel(
                context: context,
                controller: controller,
                now: now,
                makeRequestID: makeRequestID
            )
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Event") {
                    TextField("Title", text: $model.title)
                        .textInputAutocapitalization(.words)
                        .accessibilityIdentifier("create-event-title")
                    Picker("Type", selection: $model.kind) {
                        ForEach(EventKindDTO.allCases, id: \.self) { kind in
                            Text(kind.displayName).tag(kind)
                        }
                    }
                    TextField("Location (optional)", text: $model.location)
                    TextField("Notes (optional)", text: $model.notes, axis: .vertical)
                        .lineLimit(2...5)
                }

                Section("When") {
                    DatePicker("Date and time", selection: $model.eventDate, displayedComponents: [.date, .hourAndMinute])
                        .accessibilityIdentifier("create-event-date")
                    Stepper("Duration: \(model.durationMinutes) minutes", value: $model.durationMinutes, in: 5...1_440, step: 5)
                }

                Section("Snack Duty") {
                    Toggle("Add a snack slot", isOn: $model.includesSnackDuty)
                    if model.includesSnackDuty {
                        TextField("Slot label", text: $model.snackLabel)
                        TextField("Instructions (optional)", text: $model.snackInstructions, axis: .vertical)
                    }
                }

                if let failure = model.failure {
                    Section {
                        Label(
                            CoordinationCopy.message(for: failure),
                            systemImage: CoordinationCopy.image(for: failure)
                        )
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("create-event-error")
                    }
                }
            }
            .environment(\.timeZone, TimeZone(identifier: context.timeZone) ?? .gmt)
            .disabled(model.isSaving || state.context != context)
            .navigationTitle("Create Event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await model.submit() { dismiss() }
                        }
                    }
                    .disabled(!model.canSubmit || model.isSaving || state.context != context)
                    .accessibilityIdentifier("create-event-save")
                }
            }
            .overlay {
                if model.isSaving {
                    ProgressView("Creating event…")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("create-event-saving")
                }
            }
        }
        .interactiveDismissDisabled(model.isSaving)
    }
}

private extension EventKindDTO {
    var displayName: String {
        switch self {
        case .practice: return "Practice"
        case .game: return "Game"
        case .other: return "Other"
        }
    }
}
