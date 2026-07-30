import SnackdayDesignSystem
import SnackdayDomain
import SwiftUI

struct AppRootView: View {
    let snapshot: HomeSnapshot

    var body: some View {
        TabView {
            HomeView(snapshot: snapshot)
                .tabItem { Label("Home", systemImage: "house.fill") }

            PlaceholderView(title: "Schedule", systemImage: "calendar")
                .tabItem { Label("Schedule", systemImage: "calendar") }

            PlaceholderView(title: "Team", systemImage: "person.3.fill")
                .tabItem { Label("Team", systemImage: "person.3.fill") }

            PlaceholderView(title: "Inbox", systemImage: "bubble.left.and.bubble.right.fill")
                .tabItem { Label("Inbox", systemImage: "bubble.left.and.bubble.right.fill") }
        }
        .tint(.snackdayForest)
    }
}

private struct HomeView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let snapshot: HomeSnapshot

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: SnackdaySpacing.spacious) {
                    teamHeader
                    nextEventCard
                    quickActions
                    if !snapshot.roster.isEmpty {
                        rosterSection
                    }
                    teamUpdate
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
    }

    private var nextEventCard: some View {
        VStack(alignment: .leading, spacing: SnackdaySpacing.standard) {
            Label("UP NEXT", systemImage: "calendar.badge.clock")
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

    private var quickActions: some View {
        VStack(alignment: .leading, spacing: SnackdaySpacing.standard) {
            Text("Team essentials")
                .font(.title3.weight(.bold))
                .foregroundStyle(Color.snackdayInk)

            LazyVGrid(
                columns: Array(repeating: .init(.flexible()), count: dynamicTypeSize.isAccessibilitySize ? 1 : 2),
                spacing: 12
            ) {
                ActionTile(title: "Assignments", detail: "2 open", icon: "person.badge.clock", tint: .snackdayBlue)
                ActionTile(title: "Snack duty", detail: "You’re up May 9", icon: "takeoutbag.and.cup.and.straw.fill", tint: .snackdayCoral)
                ActionTile(title: "Photos", detail: "18 new", icon: "photo.on.rectangle.angled", tint: .snackdayViolet)
                ActionTile(title: "Forms", detail: "All signed", icon: "checkmark.seal.fill", tint: .snackdayForest)
            }
        }
    }

    private var rosterSection: some View {
        VStack(alignment: .leading, spacing: SnackdaySpacing.standard) {
            Text("Roster")
                .font(.title3.weight(.bold))
                .foregroundStyle(Color.snackdayInk)

            VStack(spacing: 10) {
                ForEach(snapshot.roster) { member in
                    RosterMemberRow(member: member)
                }
            }
        }
    }

    private var teamUpdate: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Latest from the team")
                .font(.title3.weight(.bold))

            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "megaphone.fill")
                    .foregroundStyle(Color.snackdayCoral)
                    .frame(width: 38, height: 38)
                    .background(Color.snackdayCoral.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text("Coach Mia")
                        .font(.headline)
                    Text("Remember water bottles and team hats for Saturday’s practice.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(SnackdaySpacing.standard)
            .background(Color.snackdaySurface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }
}

private struct ActionTile: View {
    let title: String
    let detail: String
    let icon: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: icon)
                .font(.title3.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 40, height: 40)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Color.snackdayInk)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SnackdaySpacing.standard)
        .background(Color.snackdaySurface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct RosterMemberRow: View {
    let member: RosterMember

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(String(member.displayName.prefix(1)))
                .font(.headline)
                .foregroundStyle(Color.snackdayForest)
                .frame(width: 38, height: 38)
                .background(Color.snackdayForest.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(member.displayName)
                    .font(.headline)
                    .foregroundStyle(Color.snackdayInk)
                Text(guardiansLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(SnackdaySpacing.standard)
        .background(Color.snackdaySurface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var guardiansLine: String {
        member.guardians.isEmpty
            ? "No guardians on file"
            : member.guardians
                .map { "\($0.displayName) · \($0.relationship)" }
                .joined(separator: ", ")
    }
}

private struct PlaceholderView: View {
    let title: String
    let systemImage: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView(title, systemImage: systemImage, description: Text("Coming next."))
                .navigationTitle(title)
        }
    }
}

#Preview("Home · Light") {
    AppRootView(snapshot: .preview)
}

#Preview("Home · Roster") {
    AppRootView(
        snapshot: HomeSnapshot(
            greeting: "Welcome back",
            team: TeamSummary(name: "T-Ball Tigers", season: "Spring 2026"),
            nextEvent: "No events scheduled yet",
            roster: [
                RosterMember(
                    id: "participant_1",
                    displayName: "Avery Preview",
                    guardians: [
                        RosterGuardian(id: "guardian_1", displayName: "Jordan Preview", relationship: "parent"),
                        RosterGuardian(id: "guardian_2", displayName: "Sam Preview", relationship: "caregiver"),
                    ]
                ),
                RosterMember(id: "participant_2", displayName: "Riley Preview", guardians: []),
            ]
        )
    )
}

#Preview("Home · Dark · Accessibility") {
    AppRootView(snapshot: .preview)
        .preferredColorScheme(.dark)
        .environment(\.dynamicTypeSize, .accessibility3)
}
