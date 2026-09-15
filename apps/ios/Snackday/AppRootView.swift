import SnackdayDesignSystem
import SnackdayDomain
import SwiftUI

struct AppRootView: View {
    let identity: AdultIdentityDTO?
    let directory: TeamDirectory?
    let snapshot: HomeSnapshot
    let selectTeam: (String) -> Void
    let selectSeason: (String) -> Void
    let signOut: () -> Void
    let joinTeam: (() -> Void)?

    init(
        identity: AdultIdentityDTO? = nil,
        directory: TeamDirectory? = nil,
        snapshot: HomeSnapshot,
        selectTeam: @escaping (String) -> Void = { _ in },
        selectSeason: @escaping (String) -> Void = { _ in },
        signOut: @escaping () -> Void = {},
        joinTeam: (() -> Void)? = nil
    ) {
        self.identity = identity
        self.directory = directory
        self.snapshot = snapshot
        self.selectTeam = selectTeam
        self.selectSeason = selectSeason
        self.signOut = signOut
        self.joinTeam = joinTeam
    }

    var body: some View {
        TabView {
            HomeView(
                identity: identity,
                directory: directory,
                snapshot: snapshot,
                selectTeam: selectTeam,
                selectSeason: selectSeason,
                signOut: signOut,
                joinTeam: joinTeam
            )
            .tabItem { Label("Home", systemImage: "house.fill") }

            UnavailableFeatureView(
                title: "Schedule",
                systemImage: "calendar",
                description: "Schedule details are not available in this beta yet."
            )
            .tabItem { Label("Schedule", systemImage: "calendar") }

            RosterView(roster: snapshot.roster)
                .tabItem { Label("Team", systemImage: "person.3.fill") }

            UnavailableFeatureView(
                title: "Inbox",
                systemImage: "bubble.left.and.bubble.right.fill",
                description: "Team messaging is not available in this beta yet."
            )
            .tabItem { Label("Inbox", systemImage: "bubble.left.and.bubble.right.fill") }
        }
        .tint(.snackdayForest)
    }
}

private struct HomeView: View {
    let identity: AdultIdentityDTO?
    let directory: TeamDirectory?
    let snapshot: HomeSnapshot
    let selectTeam: (String) -> Void
    let selectSeason: (String) -> Void
    let signOut: () -> Void
    let joinTeam: (() -> Void)?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: SnackdaySpacing.spacious) {
                    if let directory {
                        TeamSeasonPickerView(
                            directory: directory,
                            selectTeam: selectTeam,
                            selectSeason: selectSeason
                        )
                    }
                    teamHeader
                    scheduleStatus
                    rosterSummary
                }
                .padding(.horizontal, SnackdaySpacing.standard)
                .padding(.bottom, SnackdaySpacing.spacious)
            }
            .background(Color.snackdayCanvas)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Text("snackday")
                        .font(.title2.weight(.black))
                        .foregroundStyle(Color.snackdayForest)
                        .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let identity {
                            Text(identity.person.displayName)
                        }
                        if let joinTeam { Button("Join Team", action: joinTeam) }
                        Button("Sign Out", role: .destructive, action: signOut)
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .accessibilityLabel("Account")
                    .accessibilityIdentifier("account-menu")
                }
            }
            .toolbarBackground(Color.snackdayCanvas, for: .navigationBar)
        }
    }

    private var teamHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(snapshot.greeting)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            Text(snapshot.team.name)
                .font(.largeTitle.weight(.heavy))
                .foregroundStyle(Color.snackdayInk)
            Text(snapshot.team.season)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("selected-team-season")
    }

    private var scheduleStatus: some View {
        VStack(alignment: .leading, spacing: SnackdaySpacing.standard) {
            Label("SCHEDULE", systemImage: "calendar.badge.clock")
                .font(.caption.weight(.bold))
                .tracking(1.2)
            Text(snapshot.nextEvent)
                .font(.title2.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .foregroundStyle(.white)
        .background(
            LinearGradient(
                colors: [.snackdayForest, .snackdayForestDeep],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .shadow(color: Color.snackdayForest.opacity(0.18), radius: 18, y: 9)
    }

    private var rosterSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Roster")
                .font(.title3.weight(.bold))
            Text(snapshot.roster.isEmpty ? "No players are listed for this season." : "\(snapshot.roster.count) players")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SnackdaySpacing.standard)
        .background(Color.snackdaySurface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct RosterView: View {
    let roster: [RosterMember]

    var body: some View {
        NavigationStack {
            Group {
                if roster.isEmpty {
                    ContentUnavailableView(
                        "No players yet",
                        systemImage: "person.3",
                        description: Text("Players will appear after they are added to this season.")
                    )
                } else {
                    List(roster) { member in
                        RosterMemberRow(member: member)
                    }
                }
            }
            .navigationTitle("Team")
        }
    }
}

private struct RosterMemberRow: View {
    let member: RosterMember

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(member.displayName)
                .font(.headline)
            Text(guardiansLine)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(guardiansAccessibilityIdentifier)
    }

    private var guardiansLine: String {
        if !member.guardianDetailsVisible {
            return "Guardian details are private"
        }
        return member.guardians.isEmpty
            ? "No guardians on file"
            : member.guardians
                .map { "\($0.displayName) · \($0.relationship)" }
                .joined(separator: ", ")
    }

    private var guardiansAccessibilityIdentifier: String {
        if !member.guardianDetailsVisible {
            return "roster-guardians-private"
        }
        return member.guardians.isEmpty ? "roster-guardians-empty" : "roster-guardians-visible"
    }
}

private struct UnavailableFeatureView: View {
    let title: String
    let systemImage: String
    let description: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView(title, systemImage: systemImage, description: Text(description))
                .navigationTitle(title)
        }
    }
}

#Preview("Home") {
    AppRootView(snapshot: .preview)
}
