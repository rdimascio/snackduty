import AuthenticationServices
import CryptoKit
import SnackdayDomain
import SwiftUI

func appleNonceDigest(_ nonce: String) -> String {
    SHA256.hash(data: Data(nonce.utf8))
        .map { String(format: "%02x", $0) }
        .joined()
}

struct AppleSignInView: View {
    let challenge: AppleChallengeDTO?
    let isPreparing: Bool
    let preparationFailed: Bool
    let prepare: () async -> Void
    let complete: (_ challengeID: String, _ token: String, _ displayName: String?, _ consent: Bool) async -> Void

    @State private var adultConsent = false
    @State private var authorizationFailed = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                Spacer()
                Image(systemName: "takeoutbag.and.cup.and.straw.fill")
                    .font(.system(size: 44, weight: .bold))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text("Welcome to Snackday")
                    .font(.largeTitle.weight(.bold))
                Text("Sign in to see the teams and children you are authorized to access.")
                    .font(.body)
                    .foregroundStyle(.secondary)

                Toggle(isOn: $adultConsent) {
                    Text("I confirm that I am an adult and agree to continue.")
                }
                .accessibilityIdentifier("adult-consent-toggle")

                signInControl

                if authorizationFailed {
                    Text("Apple sign-in did not complete. You can try again.")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("apple-sign-in-error")
                }
                Spacer()
            }
            .padding(24)
            .navigationTitle("Sign In")
        }
        .task {
            if challenge == nil, !isPreparing, !preparationFailed {
                await prepare()
            }
        }
    }

    @ViewBuilder private var signInControl: some View {
        if let challenge {
            SignInWithAppleButton(.continue) { request in
                request.requestedScopes = [.fullName, .email]
                request.nonce = appleNonceDigest(challenge.nonce)
            } onCompletion: { result in
                handle(result, challenge: challenge)
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 50)
            .disabled(!adultConsent)
            .accessibilityIdentifier("apple-sign-in-button")
        } else if isPreparing {
            ProgressView("Preparing secure sign-in…")
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("apple-sign-in-preparing")
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text("Apple sign-in is unavailable right now.")
                    .foregroundStyle(.secondary)
                Button("Try Again") {
                    Task { await prepare() }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("apple-sign-in-retry")
            }
        }
    }

    private func handle(
        _ result: Result<ASAuthorization, any Error>,
        challenge: AppleChallengeDTO
    ) {
        guard
            case .success(let authorization) = result,
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let token = String(data: tokenData, encoding: .utf8)
        else {
            authorizationFailed = true
            return
        }

        authorizationFailed = false
        let displayName = credential.fullName.flatMap { components in
            let formatted = PersonNameComponentsFormatter().string(from: components)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return formatted.isEmpty ? nil : formatted
        }
        Task {
            await complete(challenge.challengeId, token, displayName, adultConsent)
        }
    }
}
