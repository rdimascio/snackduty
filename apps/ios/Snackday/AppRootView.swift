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
    let snapshot: HomeSnapshot

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: SnackdaySpacing.spacious) {
                    teamHeader
                    nextEventCard
                    quickActions
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
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: {}) {
                        Image(systemName: "person.crop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(Color.snackdayInk)
                    }
                    .accessibilityLabel("Profile")
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

            Button(action: {}) {
                HStack(spacing: 8) {
                    Text(snapshot.team.name)
                        .font(.largeTitle.weight(.heavy))
                        .foregroundStyle(Color.snackdayInk)
                    Image(systemName: "chevron.down.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Color.snackdayCoral)
                }
            }
            .buttonStyle(.plain)

            Text(snapshot.team.season)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var nextEventCard: some View {
        VStack(alignment: .leading, spacing: SnackdaySpacing.standard) {
            HStack {
                Label("UP NEXT", systemImage: "calendar.badge.clock")
                    .font(.caption.weight(.bold))
                    .tracking(1.2)
                Spacer()
                Text("IN 3 DAYS")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.white.opacity(0.14), in: Capsule())
            }

            VStack(alignment: .leading, spacing: 5) {
                Text("Practice")
                    .font(.title.weight(.bold))
                Text("Saturday · 9:00–10:00 AM")
                    .font(.headline)
                    .foregroundStyle(.white.opacity(0.82))
                Label("Lakeside Field 2", systemImage: "mappin.and.ellipse")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white.opacity(0.72))
                    .padding(.top, 3)
            }

            Divider().overlay(.white.opacity(0.2))

            Button(action: {}) {
                HStack {
                    Text("View event")
                    Spacer()
                    Image(systemName: "arrow.right")
                }
                .font(.headline)
                .foregroundStyle(.white)
            }
            .accessibilityHint(snapshot.nextEvent)
            .accessibilityIdentifier("home.schedule")
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

            LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 12) {
                ActionTile(title: "Assignments", detail: "2 open", icon: "person.badge.clock", tint: .snackdayBlue)
                ActionTile(title: "Snack duty", detail: "You’re up May 9", icon: "takeoutbag.and.cup.and.straw.fill", tint: .snackdayCoral)
                ActionTile(title: "Photos", detail: "18 new", icon: "photo.on.rectangle.angled", tint: .snackdayViolet)
                ActionTile(title: "Forms", detail: "All signed", icon: "checkmark.seal.fill", tint: .snackdayForest)
            }
        }
    }

    private var teamUpdate: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Latest from the team")
                    .font(.title3.weight(.bold))
                Spacer()
                Button("See all") {}
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.snackdayForest)
            }

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
            .background(.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }
}

private struct ActionTile: View {
    let title: String
    let detail: String
    let icon: String
    let tint: Color

    var body: some View {
        Button(action: {}) {
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
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(SnackdaySpacing.standard)
            .background(.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
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

#Preview("Home · Dark · Accessibility") {
    AppRootView(snapshot: .preview)
        .preferredColorScheme(.dark)
        .environment(\.dynamicTypeSize, .accessibility3)
}
