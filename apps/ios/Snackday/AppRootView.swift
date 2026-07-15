import SnackdayDesignSystem
import SnackdayDomain
import SwiftUI

struct AppRootView: View {
    let snapshot: HomeSnapshot

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SnackdaySpacing.spacious) {
                    VStack(alignment: .leading, spacing: SnackdaySpacing.compact) {
                        Text(snapshot.greeting)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(snapshot.team.name)
                            .font(.largeTitle.bold())
                        Text(snapshot.team.season)
                            .font(.headline)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)

                    SnackdayCard {
                        Label("Up next", systemImage: "calendar")
                            .font(.headline)
                        Text(snapshot.nextEvent)
                            .font(.body)
                            .padding(.top, SnackdaySpacing.compact)
                    }

                    Button("View team schedule") {}
                        .buttonStyle(SnackdayPrimaryButtonStyle())
                        .accessibilityHint("Shows practices, games, and volunteer assignments")
                        .accessibilityIdentifier("home.schedule")
                }
                .padding(SnackdaySpacing.standard)
            }
            .navigationTitle("Snackday")
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
