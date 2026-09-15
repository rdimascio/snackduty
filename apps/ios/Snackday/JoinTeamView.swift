import Foundation
import Observation
import SnackdayDomain
import SwiftUI

enum InvitationTokenParser {
    static func parse(_ value: String) -> String? {
        let candidate = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let token = token(candidate) { return token }

        guard
            let components = URLComponents(string: candidate),
            components.scheme?.lowercased() == "https",
            components.host?.isEmpty == false,
            components.user == nil,
            components.password == nil,
            components.path == "/invite",
            components.query == nil,
            let fragment = components.percentEncodedFragment
        else { return nil }
        return token(fragment)
    }

    private static func token(_ value: String) -> String? {
        guard value.utf8.count == 64, value.utf8.allSatisfy(isHexDigit) else { return nil }
        return value.lowercased()
    }

    private static func isHexDigit(_ byte: UInt8) -> Bool {
        (48 ... 57).contains(byte) || (65 ... 70).contains(byte) || (97 ... 102).contains(byte)
    }
}

enum JoinTeamFailure: Equatable {
    case invalidEntry
    case invalidOrExpired
    case unauthorized
    case offline
    case unavailable
    case invalidResponse
}

enum JoinTeamRetry: Equatable {
    case preview
    case accept
}

enum JoinTeamPhase: Equatable {
    case entry
    case previewing
    case preview(InvitationPreviewDTO)
    case accepting(InvitationPreviewDTO)
    case joined(InvitationAcceptanceDTO)
    case refreshing
    case failed(JoinTeamFailure, retry: JoinTeamRetry?)
}

@MainActor @Observable
final class JoinTeamModel {
    var input = ""
    private(set) var phase: JoinTeamPhase = .entry

    private let transport: any SnackdayInvitationTransport
    private var token: String?
    private var preview: InvitationPreviewDTO?
    private var generation: UInt64 = 0

    init(transport: any SnackdayInvitationTransport) {
        self.transport = transport
    }

    func previewInvitation() async {
        guard let parsed = InvitationTokenParser.parse(input) else {
            clearCredential()
            phase = .failed(.invalidEntry, retry: nil)
            return
        }
        input = ""
        token = parsed
        await requestPreview(token: parsed)
    }

    func acceptInvitation() async -> Bool {
        guard let token, let preview else { return false }
        let requestGeneration = nextGeneration()
        phase = .accepting(preview)
        do {
            let acceptance = try await transport.acceptInvitation(token: token)
            guard requestGeneration == generation, !Task.isCancelled else { return false }
            clearCredential()
            phase = .joined(acceptance)
            return true
        } catch is CancellationError {
            guard requestGeneration == generation else { return false }
            clearCredential()
            phase = .entry
            return false
        } catch {
            guard requestGeneration == generation else { return false }
            handle(error, retry: .accept)
            return false
        }
    }

    func retry() async -> Bool {
        guard case .failed(_, let retry) = phase, let retry, let token else { return false }
        switch retry {
        case .preview:
            await requestPreview(token: token)
            return false
        case .accept:
            return await acceptInvitation()
        }
    }

    func beginRefreshingExistingMembership() -> Bool {
        guard case .preview(let preview) = phase, preview.state == .accepted else { return false }
        _ = nextGeneration()
        clearCredential()
        phase = .refreshing
        return true
    }

    func cancel() {
        _ = nextGeneration()
        clearCredential()
        input = ""
        phase = .entry
    }

    private func requestPreview(token: String) async {
        let requestGeneration = nextGeneration()
        phase = .previewing
        do {
            let result = try await transport.previewInvitation(token: token)
            guard requestGeneration == generation, !Task.isCancelled else { return }
            preview = result
            phase = .preview(result)
        } catch is CancellationError {
            guard requestGeneration == generation else { return }
            clearCredential()
            phase = .entry
        } catch {
            guard requestGeneration == generation else { return }
            handle(error, retry: .preview)
        }
    }

    private func handle(_ error: Error, retry: JoinTeamRetry) {
        let failure: JoinTeamFailure
        let retryAction: JoinTeamRetry?
        switch error {
        case SnackdayAPIError.unauthorized:
            failure = .unauthorized
            retryAction = nil
        case SnackdayAPIError.offline:
            failure = .offline
            retryAction = retry
        case SnackdayAPIError.unavailable:
            failure = .unavailable
            retryAction = retry
        case SnackdayAPIError.invalidResponse:
            failure = .invalidResponse
            retryAction = nil
        case SnackdayAPIError.requestFailed(let statusCode) where statusCode >= 500:
            failure = .unavailable
            retryAction = retry
        case SnackdayAPIError.requestFailed:
            failure = .invalidOrExpired
            retryAction = nil
        default:
            failure = .unavailable
            retryAction = retry
        }
        if retryAction == nil { clearCredential() }
        phase = .failed(failure, retry: retryAction)
    }

    private func nextGeneration() -> UInt64 {
        generation &+= 1
        return generation
    }

    private func clearCredential() {
        token = nil
        preview = nil
    }
}

struct JoinTeamView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: JoinTeamModel
    @State private var operation: Task<Void, Never>?
    private let didJoin: @MainActor () async -> Void

    @MainActor
    init(
        transport: any SnackdayInvitationTransport,
        didJoin: @escaping @MainActor () async -> Void
    ) {
        _model = State(initialValue: JoinTeamModel(transport: transport))
        self.didJoin = didJoin
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .entry:
                    entry
                case .previewing:
                    loading("Checking invitation…", identifier: "invite-preview-loading")
                case .preview(let preview):
                    invitation(preview)
                case .accepting:
                    loading("Joining team…", identifier: "invite-accept-loading")
                case .joined, .refreshing:
                    loading("Refreshing your teams…", identifier: "invite-refresh-loading")
                case .failed(let failure, let retry):
                    failureView(failure, canRetry: retry != nil)
                }
            }
            .navigationTitle("Join a Team")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                        .accessibilityIdentifier("invite-cancel")
                }
            }
        }
        .onDisappear {
            operation?.cancel()
            model.cancel()
        }
    }

    private var entry: some View {
        Form {
            Section {
                TextField("Invitation link or token", text: $model.input, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .privacySensitive()
                    .accessibilityIdentifier("invite-entry")
            } header: {
                Text("Invitation")
            } footer: {
                Text("Paste the link from your invitation. Snackday checks it with the server before showing team details.")
            }
            Button("Check Invitation", action: startPreview)
                .buttonStyle(.borderedProminent)
                .disabled(model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("invite-preview")
        }
    }

    private func invitation(_ preview: InvitationPreviewDTO) -> some View {
        VStack(spacing: 20) {
            Image(systemName: preview.state == .accepted ? "checkmark.circle.fill" : "person.3.fill")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
            Text(preview.teamName)
                .font(.title2.bold())
                .multilineTextAlignment(.center)
            if let inviter = preview.inviterDisplayName {
                Text("Invited by \(inviter)")
                    .foregroundStyle(.secondary)
            }
            Text(roleDescription(preview))
                .multilineTextAlignment(.center)
            Button(preview.state == .accepted ? "Continue" : "Accept Invitation") {
                if preview.state == .accepted {
                    finishExistingMembership()
                } else {
                    startAccept()
                }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("invite-accept")
            Button("Use a Different Invitation", action: reset)
                .accessibilityIdentifier("invite-replace")
        }
        .padding()
    }

    private func loading(_ message: String, identifier: String) -> some View {
        ProgressView(message)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier(identifier)
    }

    private func failureView(_ failure: JoinTeamFailure, canRetry: Bool) -> some View {
        VStack(spacing: 20) {
            ContentUnavailableView {
                Label(failureContent(failure).title, systemImage: failureContent(failure).image)
            } description: {
                Text(failureContent(failure).message)
            }
            if canRetry {
                Button("Try Again", action: startRetry)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("invite-retry")
            }
            Button("Enter Another Invitation", action: reset)
                .accessibilityIdentifier("invite-reset")
        }
        .padding()
        .accessibilityIdentifier("invite-error")
    }

    private func roleDescription(_ preview: InvitationPreviewDTO) -> String {
        let role = preview.invitedRole ?? preview.grantedRole
        switch role {
        case .owner:
            return "You’ll join as a team owner."
        case .coach:
            return "You’ll join as a coach."
        case .adult:
            return "You’ll join as a team member."
        case nil:
            return preview.state == .accepted
                ? "You already joined this team."
                : "Review this invitation before joining."
        }
    }

    private func failureContent(_ failure: JoinTeamFailure) -> (title: String, message: String, image: String) {
        switch failure {
        case .invalidEntry:
            return (
                "Check the invitation",
                "Enter the full invitation link or its 64-character token.",
                "link.badge.plus"
            )
        case .invalidOrExpired:
            return (
                "Invitation unavailable",
                "This invitation is invalid, expired, or not for this account.",
                "link.badge.plus"
            )
        case .unauthorized:
            return (
                "Sign in again",
                "Your session expired before Snackday could verify this invitation.",
                "person.crop.circle.badge.exclamationmark"
            )
        case .offline:
            return ("You’re offline", "Connect to the internet, then try again.", "wifi.slash")
        case .unavailable:
            return (
                "Couldn’t reach Snackday",
                "The service is unavailable right now. Try again shortly.",
                "exclamationmark.arrow.triangle.2.circlepath"
            )
        case .invalidResponse:
            return (
                "Couldn’t verify invitation",
                "Snackday received an unexpected response.",
                "doc.badge.ellipsis"
            )
        }
    }

    private func startPreview() {
        replaceOperation { await model.previewInvitation() }
    }

    private func startRetry() {
        replaceOperation {
            if await model.retry() { await refreshAndDismiss() }
        }
    }

    private func startAccept() {
        replaceOperation {
            if await model.acceptInvitation() { await refreshAndDismiss() }
        }
    }

    private func finishExistingMembership() {
        guard model.beginRefreshingExistingMembership() else { return }
        replaceOperation { await refreshAndDismiss() }
    }

    private func replaceOperation(_ action: @escaping @MainActor () async -> Void) {
        operation?.cancel()
        operation = Task { await action() }
    }

    private func refreshAndDismiss() async {
        await didJoin()
        guard !Task.isCancelled else { return }
        dismiss()
    }

    private func cancel() {
        reset()
        dismiss()
    }

    private func reset() {
        operation?.cancel()
        operation = nil
        model.cancel()
    }
}
