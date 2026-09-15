import Foundation
import SnackdayDomain
import Testing
@testable import Snackday

private let tokenA = String(repeating: "a", count: 64)
private let tokenB = String(repeating: "B", count: 64)

@Test func invitationParserAcceptsOnlyRawHexOrHTTPSFragmentLinks() {
    #expect(InvitationTokenParser.parse("  \(tokenB)\n") == tokenB.lowercased())
    #expect(
        InvitationTokenParser.parse("https://join.snackduty.test/invite#\(tokenA)") == tokenA
    )

    for rejected in [
        "https://join.snackduty.test/invite?token=\(tokenA)",
        "https://join.snackduty.test/other#\(tokenA)",
        "http://join.snackduty.test/invite#\(tokenA)",
        "https://user@join.snackduty.test/invite#\(tokenA)",
        "https://join.snackduty.test/invite#short",
        String(repeating: "g", count: 64),
    ] {
        #expect(InvitationTokenParser.parse(rejected) == nil)
    }
}

@MainActor
@Test func previewAndAcceptUseTheParsedTokenAndReachRealSuccessState() async throws {
    let transport = ImmediateInvitationTransport()
    let model = JoinTeamModel(transport: transport)
    model.input = "https://join.snackduty.test/invite#\(tokenB)"

    await model.previewInvitation()
    #expect(model.input.isEmpty)
    #expect(
        model.phase
            == .preview(
                InvitationPreviewDTO(
                    state: .preview,
                    teamName: "Fixture Falcons",
                    inviterDisplayName: "Fixture Coach",
                    invitedRole: .adult
                )
            )
    )
    #expect(await transport.previewTokens() == [tokenB.lowercased()])

    #expect(await model.acceptInvitation())
    guard case .joined(let accepted) = model.phase else {
        Issue.record("Expected a joined state")
        return
    }
    #expect(accepted.membership.role == .adult)
    #expect(accepted.team.name == "Fixture Falcons")
    #expect(await transport.acceptTokens() == [tokenB.lowercased()])
}

@MainActor
@Test func aLatePreviewCannotReplaceANewerPreview() async {
    let transport = ControlledPreviewTransport()
    let model = JoinTeamModel(transport: transport)

    model.input = tokenA
    let first = Task { await model.previewInvitation() }
    await expectPendingPreview(tokenA, transport: transport)

    model.input = tokenB
    let second = Task { await model.previewInvitation() }
    await expectPendingPreview(tokenB.lowercased(), transport: transport)
    await transport.resume(
        token: tokenB.lowercased(),
        with: InvitationPreviewDTO(state: .preview, teamName: "New Team", invitedRole: .adult)
    )
    await second.value
    await transport.resume(
        token: tokenA,
        with: InvitationPreviewDTO(state: .preview, teamName: "Stale Team", invitedRole: .owner)
    )
    await first.value

    #expect(
        model.phase
            == .preview(
                InvitationPreviewDTO(state: .preview, teamName: "New Team", invitedRole: .adult)
            )
    )
}

@MainActor
@Test func cancellingAnAcceptDropsItsLateSuccess() async {
    let transport = ControlledAcceptTransport()
    let model = JoinTeamModel(transport: transport)
    model.input = tokenA
    await model.previewInvitation()

    let acceptance = Task { await model.acceptInvitation() }
    await expectPendingAccept(transport)
    model.cancel()
    await transport.resumeAccept(with: acceptedFixture())

    #expect(await acceptance.value == false)
    #expect(model.phase == .entry)
}

@MainActor
@Test func anAlreadyAcceptedInvitationRefreshesWithoutAcceptingAgain() async {
    let model = JoinTeamModel(transport: AcceptedInvitationTransport())
    model.input = tokenA

    await model.previewInvitation()
    #expect(model.beginRefreshingExistingMembership())
    #expect(model.phase == .refreshing)
    #expect(!model.beginRefreshingExistingMembership())
}

@MainActor
@Test func retryKeepsOnlyATransientInMemoryCredential() async {
    let transport = RetryingInvitationTransport()
    let model = JoinTeamModel(transport: transport)
    model.input = tokenA

    await model.previewInvitation()
    #expect(model.phase == .failed(.offline, retry: .preview))
    #expect(await model.retry() == false)
    #expect(
        model.phase
            == .preview(
                InvitationPreviewDTO(state: .preview, teamName: "Recovered Team", invitedRole: .adult)
            )
    )

    let terminal = TerminalInvitationTransport(error: .requestFailed(statusCode: 404))
    let terminalModel = JoinTeamModel(transport: terminal)
    terminalModel.input = tokenB
    await terminalModel.previewInvitation()
    #expect(terminalModel.phase == .failed(.invalidOrExpired, retry: nil))
    #expect(await terminalModel.retry() == false)

    let unauthorized = TerminalInvitationTransport(error: .unauthorized)
    let unauthorizedModel = JoinTeamModel(transport: unauthorized)
    unauthorizedModel.input = tokenB
    await unauthorizedModel.previewInvitation()
    #expect(unauthorizedModel.phase == .failed(.unauthorized, retry: nil))
}

private actor ImmediateInvitationTransport: SnackdayInvitationTransport {
    private var previews: [String] = []
    private var accepts: [String] = []

    func previewInvitation(token: String) -> InvitationPreviewDTO {
        previews.append(token)
        return InvitationPreviewDTO(
            state: .preview,
            teamName: "Fixture Falcons",
            inviterDisplayName: "Fixture Coach",
            invitedRole: .adult
        )
    }

    func acceptInvitation(token: String) -> InvitationAcceptanceDTO {
        accepts.append(token)
        return acceptedFixture()
    }

    func previewTokens() -> [String] { previews }
    func acceptTokens() -> [String] { accepts }
}

private actor ControlledPreviewTransport: SnackdayInvitationTransport {
    private var pending: [String: CheckedContinuation<InvitationPreviewDTO, any Error>] = [:]
    private var pendingWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    func previewInvitation(token: String) async throws -> InvitationPreviewDTO {
        try await withCheckedThrowingContinuation { continuation in
            pending[token] = continuation
            pendingWaiters.removeValue(forKey: token)?.forEach { $0.resume() }
        }
    }

    func acceptInvitation(token _: String) -> InvitationAcceptanceDTO { acceptedFixture() }

    func waitUntilPending(_ token: String) async {
        if pending[token] != nil { return }
        await withCheckedContinuation { continuation in
            if pending[token] != nil {
                continuation.resume()
            } else {
                pendingWaiters[token, default: []].append(continuation)
            }
        }
    }

    func resume(token: String, with preview: InvitationPreviewDTO) {
        pending.removeValue(forKey: token)?.resume(returning: preview)
    }
}

private actor ControlledAcceptTransport: SnackdayInvitationTransport {
    private var pendingAccept: CheckedContinuation<InvitationAcceptanceDTO, any Error>?
    private var pendingWaiters: [CheckedContinuation<Void, Never>] = []

    func previewInvitation(token _: String) -> InvitationPreviewDTO {
        InvitationPreviewDTO(state: .preview, teamName: "Fixture Falcons", invitedRole: .adult)
    }

    func acceptInvitation(token _: String) async throws -> InvitationAcceptanceDTO {
        try await withCheckedThrowingContinuation { continuation in
            pendingAccept = continuation
            let waiters = pendingWaiters
            pendingWaiters.removeAll()
            waiters.forEach { $0.resume() }
        }
    }

    func waitUntilAcceptPending() async {
        if pendingAccept != nil { return }
        await withCheckedContinuation { continuation in
            if pendingAccept != nil {
                continuation.resume()
            } else {
                pendingWaiters.append(continuation)
            }
        }
    }

    func resumeAccept(with acceptance: InvitationAcceptanceDTO) {
        pendingAccept?.resume(returning: acceptance)
        pendingAccept = nil
    }
}

private actor RetryingInvitationTransport: SnackdayInvitationTransport {
    private var attempt = 0

    func previewInvitation(token _: String) throws -> InvitationPreviewDTO {
        attempt += 1
        if attempt == 1 { throw SnackdayAPIError.offline }
        return InvitationPreviewDTO(state: .preview, teamName: "Recovered Team", invitedRole: .adult)
    }

    func acceptInvitation(token _: String) -> InvitationAcceptanceDTO { acceptedFixture() }
}

private struct TerminalInvitationTransport: SnackdayInvitationTransport {
    let error: SnackdayAPIError
    func previewInvitation(token _: String) throws -> InvitationPreviewDTO { throw error }
    func acceptInvitation(token _: String) throws -> InvitationAcceptanceDTO { throw error }
}

private struct AcceptedInvitationTransport: SnackdayInvitationTransport {
    func previewInvitation(token _: String) -> InvitationPreviewDTO {
        InvitationPreviewDTO(
            state: .accepted,
            teamName: "Fixture Falcons",
            grantedRole: .adult
        )
    }

    func acceptInvitation(token _: String) throws -> InvitationAcceptanceDTO {
        Issue.record("An accepted preview must not be accepted again")
        return acceptedFixture()
    }
}

private func expectPendingPreview(
    _ token: String,
    transport: ControlledPreviewTransport
) async {
    await transport.waitUntilPending(token)
}

private func expectPendingAccept(_ transport: ControlledAcceptTransport) async {
    await transport.waitUntilAcceptPending()
}

private func acceptedFixture() -> InvitationAcceptanceDTO {
    let data = Data(
        """
        {
          "invitation": { "id": "invitation_fixture", "status": "accepted" },
          "membership": { "role": "adult" },
          "team": {
            "id": "team_fixture",
            "name": "Fixture Falcons",
            "status": "active",
            "createdAt": "2026-09-14T00:00:00.000Z",
            "updatedAt": "2026-09-14T00:00:00.000Z"
          }
        }
        """.utf8
    )
    return try! JSONDecoder().decode(InvitationAcceptanceDTO.self, from: data)
}
