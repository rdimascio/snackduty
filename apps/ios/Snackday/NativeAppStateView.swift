import SnackdayDomain
import SwiftUI

struct NativeAppStateView: View {
    let state: NativeAppState
    let challenge: AppleChallengeDTO?
    let isPreparingSignIn: Bool
    let signInPreparationFailed: Bool
    let prepareSignIn: () async -> Void
    let completeSignIn: (String, String, String?, Bool) async -> Void
    let selectTeam: (String) -> Void
    let selectSeason: (String) -> Void
    let retry: () -> Void
    let signOut: () -> Void

    @ViewBuilder var body: some View {
        switch state {
        case .launching:
            LoadingStateView(message: "Starting Snackday…", identifier: "launch-loading")
        case .signedOut:
            AppleSignInView(
                challenge: challenge,
                isPreparing: isPreparingSignIn,
                preparationFailed: signInPreparationFailed,
                prepare: prepareSignIn,
                complete: completeSignIn
            )
        case .authenticating:
            LoadingStateView(message: "Signing you in…", identifier: "authentication-loading")
        case .loading(_, let directory):
            LoadingStateView(
                message: directory == nil ? "Loading your teams…" : "Loading your team…",
                identifier: "team-loading"
            )
        case .ready(let identity, let directory, let snapshot):
            AppRootView(
                identity: identity,
                directory: directory,
                snapshot: snapshot,
                selectTeam: selectTeam,
                selectSeason: selectSeason,
                signOut: signOut
            )
        case .emptyTeams(let identity):
            SignedInEmptyView(
                identity: identity,
                directory: nil,
                title: "No teams yet",
                systemImage: "person.3",
                description: "Create a team on the web or ask a team owner for an invitation.",
                identifier: "empty-teams",
                selectTeam: selectTeam,
                selectSeason: selectSeason,
                signOut: signOut
            )
        case .emptySeasons(let identity, let directory, _):
            SignedInEmptyView(
                identity: identity,
                directory: directory,
                title: "No seasons yet",
                systemImage: "calendar.badge.plus",
                description: "This team does not have a season to show yet.",
                identifier: "empty-seasons",
                selectTeam: selectTeam,
                selectSeason: selectSeason,
                signOut: signOut
            )
        case .failed(let identity, let directory, let failure):
            FailureStateView(
                identity: identity,
                directory: directory,
                failure: failure,
                selectTeam: selectTeam,
                selectSeason: selectSeason,
                retry: retry,
                signOut: signOut
            )
        }
    }
}

private struct LoadingStateView: View {
    let message: String
    let identifier: String

    var body: some View {
        ProgressView(message)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier(identifier)
    }
}

private struct SignedInEmptyView: View {
    let identity: AdultIdentityDTO
    let directory: TeamDirectory?
    let title: String
    let systemImage: String
    let description: String
    let identifier: String
    let selectTeam: (String) -> Void
    let selectSeason: (String) -> Void
    let signOut: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let directory {
                    TeamSeasonPickerView(
                        directory: directory,
                        selectTeam: selectTeam,
                        selectSeason: selectSeason
                    )
                }
                ContentUnavailableView(title, systemImage: systemImage, description: Text(description))
                    .accessibilityIdentifier(identifier)
            }
            .padding()
            .navigationTitle("Snackday")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Text(identity.person.displayName)
                        Button("Sign Out", role: .destructive, action: signOut)
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .accessibilityLabel("Account")
                    .accessibilityIdentifier("account-menu")
                }
            }
        }
    }
}

private struct FailureStateView: View {
    let identity: AdultIdentityDTO?
    let directory: TeamDirectory?
    let failure: NativeAppFailure
    let selectTeam: (String) -> Void
    let selectSeason: (String) -> Void
    let retry: () -> Void
    let signOut: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let directory {
                    TeamSeasonPickerView(
                        directory: directory,
                        selectTeam: selectTeam,
                        selectSeason: selectSeason
                    )
                }
                ContentUnavailableView {
                    Label(content.title, systemImage: content.systemImage)
                } description: {
                    Text(content.message)
                }
                .accessibilityIdentifier("app-error")
                Button("Try Again", action: retry)
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("state-retry")
            }
            .padding()
            .navigationTitle("Snackday")
            .toolbar {
                if identity != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Sign Out", action: signOut)
                    }
                }
            }
        }
    }

    private var content: (title: String, message: String, systemImage: String) {
        switch failure {
        case .offline:
            ("You’re offline", "Connect to the internet, then try again.", "wifi.slash")
        case .unauthorized:
            ("Session expired", "Sign in again to continue.", "person.crop.circle.badge.exclamationmark")
        case .unavailable:
            ("Snackday is not configured yet", "Check the app configuration and try again.", "exclamationmark.triangle")
        case .invalidResponse:
            ("Couldn’t read the response", "Snackday received an unexpected server response.", "doc.badge.ellipsis")
        case .requestFailed(let statusCode):
            ("Request failed", "The server returned status \(statusCode).", "exclamationmark.arrow.triangle.2.circlepath")
        }
    }
}
