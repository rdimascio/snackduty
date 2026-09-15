import SnackdayDomain
import SwiftUI

struct EventDetailView: View {
    let context: CoordinationContext
    let controller: any SnackdayCoordinationControlling
    let state: CoordinationState
    let occurrenceID: String
    @State private var respondingParticipantID: String?

    var body: some View {
        Group {
            if state.context != context || state.selectedOccurrenceID != occurrenceID {
                ProgressView("Loading selected event…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("event-context-loading")
            } else {
                detailContent
            }
        }
        .navigationTitle(event?.series.title ?? "Event")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: occurrenceID) {
            guard state.context == context else { return }
            await controller.openOccurrence(occurrenceID)
        }
        .confirmationDialog(
            rsvpDialogTitle,
            isPresented: rsvpDialogIsPresented,
            titleVisibility: .visible
        ) {
            if let option = respondingOption {
                Button("Going") { record(option, status: .yes) }
                    .accessibilityIdentifier("rsvp-yes-\(option.participantId)")
                Button("Maybe") { record(option, status: .maybe) }
                    .accessibilityIdentifier("rsvp-maybe-\(option.participantId)")
                Button("Not Going") { record(option, status: .no) }
                    .accessibilityIdentifier("rsvp-no-\(option.participantId)")
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder private var detailContent: some View {
        switch state.detail {
        case .idle, .loading:
            ProgressView("Loading event…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("event-detail-loading")
        case .failed(let failure):
            ContentUnavailableView {
                Label(
                    CoordinationCopy.title(for: failure),
                    systemImage: CoordinationCopy.image(for: failure)
                )
            } description: {
                Text(CoordinationCopy.message(for: failure))
            } actions: {
                if failure != .unauthorized {
                    Button("Try Again") {
                        Task { await controller.openOccurrence(occurrenceID) }
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("event-detail-retry")
                }
            }
            .accessibilityIdentifier("event-detail-error")
        case .loaded(let detail):
            if detail.occurrenceID == occurrenceID, let event {
                List {
                    eventSection(event)
                    attendanceSection(detail.attendance, cancelled: event.occurrence.status == .cancelled)
                    dutySection(detail.dutySlots, cancelled: event.occurrence.status == .cancelled)
                    mutationSection
                }
                .refreshable { await controller.openOccurrence(occurrenceID) }
                .accessibilityIdentifier("event-detail")
            } else {
                ProgressView("Loading selected event…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("event-context-loading")
            }
        }
    }

    private var event: ScheduleRow? {
        guard case .loaded(let events) = state.schedule else { return nil }
        return scheduleRows(events).first(where: { $0.occurrence.id == occurrenceID })
    }

    private func eventSection(_ event: ScheduleRow) -> some View {
        Section("Event") {
            LabeledContent(
                "When",
                value: CoordinationFormatting.eventDate(
                    event.occurrence.startsAt,
                    timeZoneID: context.timeZone
                )
            )
            if let location = event.series.location {
                LabeledContent("Location", value: location)
            }
            if let notes = event.series.notes {
                Text(notes)
            }
            if event.occurrence.status == .cancelled {
                Label("Cancelled", systemImage: "calendar.badge.exclamationmark")
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("event-cancelled")
                if let reason = event.occurrence.cancelledReason {
                    Text(reason)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func attendanceSection(
        _ attendance: AttendanceReadDTO,
        cancelled: Bool
    ) -> some View {
        Section("RSVP") {
            Text(
                "\(attendance.counts.yes) going · \(attendance.counts.maybe) maybe · \(attendance.counts.no) not going"
            )
            .foregroundStyle(.secondary)

            if attendance.responseOptions.isEmpty {
                Text("No RSVP choices are available for this account.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("rsvp-empty")
            } else {
                ForEach(attendance.responseOptions, id: \.participantId) { option in
                    Button {
                        respondingParticipantID = option.participantId
                    } label: {
                        HStack {
                            Text(option.displayName)
                            Spacer()
                            Text(RSVPStatusCopy.label(option.status))
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(cancelled || isSaving)
                    .accessibilityLabel(
                        "RSVP for \(option.displayName), \(RSVPStatusCopy.label(option.status))"
                    )
                    .accessibilityIdentifier("rsvp-option-\(option.participantId)")
                }
            }
            if cancelled {
                Text("Cancelled events cannot accept RSVP changes.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func dutySection(_ slots: [DutySlotDTO], cancelled: Bool) -> some View {
        Section("Snack Duty") {
            if slots.isEmpty {
                Text("No snack duty is listed for this event.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("duty-empty")
            } else {
                ForEach(slots, id: \.id) { slot in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(slot.label)
                            .font(.headline)
                        if let instructions = slot.instructions {
                            Text(instructions)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        dutyAssignment(slot, cancelled: cancelled)
                    }
                    .padding(.vertical, 3)
                }
            }
        }
    }

    @ViewBuilder
    private func dutyAssignment(_ slot: DutySlotDTO, cancelled: Bool) -> some View {
        if let assignee = slot.assignee {
            if assignee.personId == context.personID {
                Label("Claimed by you", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .accessibilityIdentifier("duty-claimed-self")
            } else {
                Text("Claimed by \(assignee.displayName)")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("duty-claimed-other")
            }
        } else {
            Button("Claim \(slot.label)") {
                Task { await controller.claimDuty(slotID: slot.id) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(cancelled || isSaving)
            .accessibilityIdentifier("duty-claim-\(slot.id)")
        }
    }

    @ViewBuilder private var mutationSection: some View {
        switch state.mutation {
        case .idle:
            EmptyView()
        case .saving:
            Section {
                ProgressView("Saving changes…")
                    .accessibilityIdentifier("coordination-saving")
            }
        case .failed(let failure):
            Section {
                Label(
                    CoordinationCopy.message(for: failure),
                    systemImage: CoordinationCopy.image(for: failure)
                )
                .foregroundStyle(.red)
                .accessibilityIdentifier("coordination-mutation-error")
                if failure != .unauthorized {
                    Button("Refresh Event") {
                        Task { await controller.openOccurrence(occurrenceID) }
                    }
                    .accessibilityIdentifier("coordination-mutation-retry")
                }
            }
        }
    }

    private var isSaving: Bool {
        if case .saving = state.mutation { return true }
        return false
    }

    private var respondingOption: AttendanceOptionDTO? {
        guard let respondingParticipantID,
              case .loaded(let detail) = state.detail
        else { return nil }
        return detail.attendance.responseOptions.first {
            $0.participantId == respondingParticipantID
        }
    }

    private var rsvpDialogTitle: String {
        respondingOption.map { "RSVP for \($0.displayName)" } ?? "RSVP"
    }

    private var rsvpDialogIsPresented: Binding<Bool> {
        Binding(
            get: { respondingParticipantID != nil },
            set: { isPresented in
                if !isPresented { respondingParticipantID = nil }
            }
        )
    }

    private func record(_ option: AttendanceOptionDTO, status: AttendanceStatusDTO) {
        Task {
            guard controller.state.context == context,
                  controller.state.selectedOccurrenceID == occurrenceID
            else { return }
            await controller.recordAttendance(participantID: option.participantId, status: status)
        }
    }
}

enum RSVPStatusCopy {
    static func label(_ status: AttendanceStatusDTO?) -> String {
        switch status {
        case .yes: return "Going"
        case .maybe: return "Maybe"
        case .no: return "Not going"
        case nil: return "No response"
        }
    }
}
