import SnackdayDesignSystem
import SnackdayDomain
import SwiftUI

struct TeamSeasonPickerView: View {
    let directory: TeamDirectory
    let selectTeam: (String) -> Void
    let selectSeason: (String) -> Void

    private var selectedTeam: TeamWithSeasonsDTO? {
        guard let selectedTeamID = directory.selection?.teamID else {
            return directory.teams.first
        }
        return directory.teams.first { $0.team.id == selectedTeamID }
    }

    private var selectedSeason: SeasonDTO? {
        guard let selectedSeasonID = directory.selection?.seasonID else {
            return nil
        }
        return selectedTeam?.seasons.first { $0.id == selectedSeasonID }
    }

    var body: some View {
        HStack(spacing: 12) {
            Menu {
                ForEach(directory.teams, id: \.team.id) { entry in
                    Button(entry.team.name) {
                        selectTeam(entry.team.id)
                    }
                    .disabled(entry.team.id == selectedTeam?.team.id)
                }
            } label: {
                pickerLabel(
                    title: "Team",
                    value: selectedTeam?.team.name ?? "Choose a team",
                    systemImage: "person.3.fill"
                )
            }
            .accessibilityIdentifier("team-picker")

            Menu {
                ForEach(selectedTeam?.seasons ?? [], id: \.id) { season in
                    Button(season.label) {
                        selectSeason(season.id)
                    }
                    .disabled(season.id == selectedSeason?.id)
                }
            } label: {
                pickerLabel(
                    title: "Season",
                    value: selectedSeason?.label ?? "Choose a season",
                    systemImage: "calendar"
                )
            }
            .disabled(selectedTeam?.seasons.isEmpty != false)
            .accessibilityIdentifier("season-picker")
        }
    }

    private func pickerLabel(title: String, value: String, systemImage: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(title.uppercased(), systemImage: systemImage)
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
            HStack {
                Text(value)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
            }
            .foregroundStyle(Color.snackdayInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.snackdaySurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
