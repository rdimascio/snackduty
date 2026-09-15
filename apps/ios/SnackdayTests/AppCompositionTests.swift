import SnackdayDesignSystem
import SnackdayDomain
import Foundation
import Testing
@testable import Snackday

@Test func realKeychainPersistsAndClearsAnOriginSession() throws {
    let service = "com.snackday.tests.\(UUID().uuidString)"
    let origin = try #require(URL(string: "https://api.snackday.test"))
    let first = KeychainSessionCookieStore(service: service)
    defer { try? first.clearSession(for: origin) }
    try first.saveSessionCookie("synthetic=session", for: origin)
    let restored = KeychainSessionCookieStore(service: service)
    #expect(try restored.sessionCookie(for: origin) == "synthetic=session")
    try restored.clearSession(for: origin)
    #expect(try first.sessionCookie(for: origin) == nil)
}

@Test func previewSnapshotComposesDomainAndDesignSystem() {
    #expect(HomeSnapshot.preview.team.name == "T-Ball Tigers")
    #expect(SnackdaySpacing.standard == 16)
}

@Test func appleNonceUsesLowercaseHexadecimalSHA256() {
    #expect(
        appleNonceDigest("abc")
            == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
}

@MainActor
@Test func launchModelDelegatesTheFrozenApplicationOperations() async {
    let controller = CompositionTestController()
    let model = NativeAppViewModel(controller: controller)

    #expect(model.state == .launching)
    await model.restoreOnce()
    #expect(model.state == .signedOut)
    #expect(controller.restoreCount == 1)
    await model.restoreOnce()
    #expect(controller.restoreCount == 1)

    await model.prepareSignIn()
    #expect(model.challenge == AppleChallengeDTO(challengeId: "challenge", nonce: "raw-nonce"))
    await model.completeSignIn(
        challengeID: "challenge",
        identityToken: "identity-token",
        displayName: "Taylor Adult",
        adultConsent: true
    )
    #expect(controller.completedConsent == true)

    await model.selectTeam("team-b")
    await model.selectSeason("season-b")
    await model.retry()
    await model.signOut()
    #expect(controller.selectedTeam == "team-b")
    #expect(controller.selectedSeason == "season-b")
    #expect(controller.retryCount == 1)
    #expect(controller.signOutCount == 1)
}

@MainActor
@Test func launchModelKeepsPreparedChallengeWhenControllerReturnsToSignedOut() async {
    let controller = CompositionTestController()
    let model = NativeAppViewModel(controller: controller)
    let observation = Task { await model.observeState() }
    defer { observation.cancel() }

    await model.prepareSignIn()
    controller.finishUpdates()
    await observation.value

    #expect(model.state == .signedOut)
    #expect(model.challenge == AppleChallengeDTO(challengeId: "challenge", nonce: "raw-nonce"))
}

@MainActor
private final class CompositionTestController: SnackdayApplicationControlling {
    var state = NativeAppState.launching
    var restoreCount = 0
    var completedConsent: Bool?
    var selectedTeam: String?
    var selectedSeason: String?
    var retryCount = 0
    var signOutCount = 0

    private let updates = AsyncStream<NativeAppState>.makeStream()

    func stateUpdates() -> AsyncStream<NativeAppState> {
        updates.stream
    }

    func finishUpdates() { updates.continuation.finish() }

    func restore() async {
        restoreCount += 1
        state = .signedOut
    }

    func beginAppleSignIn() async throws -> AppleChallengeDTO {
        state = .signedOut
        updates.continuation.yield(state)
        return AppleChallengeDTO(challengeId: "challenge", nonce: "raw-nonce")
    }

    func completeAppleSignIn(
        challengeID _: String,
        identityToken _: String,
        displayName _: String?,
        adultConsent: Bool
    ) async {
        completedConsent = adultConsent
    }

    func selectTeam(_ teamID: String) async { selectedTeam = teamID }
    func selectSeason(_ seasonID: String) async { selectedSeason = seasonID }
    func retry() async { retryCount += 1 }
    func signOut() async { signOutCount += 1 }
}
