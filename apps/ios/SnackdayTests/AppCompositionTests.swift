import SnackdayDesignSystem
import SnackdayDomain
import Testing

@Test func previewSnapshotComposesDomainAndDesignSystem() {
    #expect(HomeSnapshot.preview.team.name == "T-Ball Tigers")
    #expect(SnackdaySpacing.standard == 16)
}
