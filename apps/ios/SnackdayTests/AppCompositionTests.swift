import SnackdayDesignSystem
import SnackdayDomain
import Testing
@testable import Snackday

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
private final class CompositionTestController: SnackdayApplicationControlling {
    var state = NativeAppState.launching
    var restoreCount = 0
    var completedConsent: Bool?
    var selectedTeam: String?
    var selectedSeason: String?
    var retryCount = 0
    var signOutCount = 0

    func stateUpdates() -> AsyncStream<NativeAppState> {
        AsyncStream { $0.finish() }
    }

    func restore() async {
        restoreCount += 1
        state = .signedOut
    }

    func beginAppleSignIn() async throws -> AppleChallengeDTO {
        AppleChallengeDTO(challengeId: "challenge", nonce: "raw-nonce")
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
