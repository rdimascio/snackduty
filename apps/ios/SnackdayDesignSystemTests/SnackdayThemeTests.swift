import SnackdayDesignSystem
import Testing

@Test func spacingScaleHasIncreasingSemanticSteps() {
    #expect(SnackdaySpacing.compact < SnackdaySpacing.standard)
    #expect(SnackdaySpacing.standard < SnackdaySpacing.spacious)
    #expect(SnackdaySpacing.standard == 16)
}
