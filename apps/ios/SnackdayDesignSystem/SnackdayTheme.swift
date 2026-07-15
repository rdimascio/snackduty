import SwiftUI

public enum SnackdaySpacing: Sendable {
    public static let compact: CGFloat = 8
    public static let standard: CGFloat = 16
    public static let spacious: CGFloat = 24
}

public extension Color {
    static let snackdayAccent = Color.accentColor
    static let snackdaySurface = Color(uiColor: .secondarySystemBackground)
    static let snackdayCanvas = Color(red: 0.965, green: 0.957, blue: 0.925)
    static let snackdayInk = Color(red: 0.075, green: 0.102, blue: 0.092)
    static let snackdayForest = Color(red: 0.075, green: 0.365, blue: 0.255)
    static let snackdayForestDeep = Color(red: 0.035, green: 0.235, blue: 0.180)
    static let snackdayCoral = Color(red: 0.925, green: 0.335, blue: 0.245)
    static let snackdayBlue = Color(red: 0.170, green: 0.455, blue: 0.790)
    static let snackdayViolet = Color(red: 0.455, green: 0.330, blue: 0.720)
}

public struct SnackdayCard<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(SnackdaySpacing.standard)
            .background(Color.snackdaySurface, in: RoundedRectangle(cornerRadius: 16))
    }
}

public struct SnackdayPrimaryButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, SnackdaySpacing.standard)
            .foregroundStyle(.white)
            .background(Color.snackdayAccent.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 12))
    }
}

#Preview("Card · Dark · Accessibility") {
    SnackdayCard {
        Text("Snack duty is covered")
            .font(.headline)
    }
    .padding()
    .preferredColorScheme(.dark)
    .environment(\.dynamicTypeSize, .accessibility2)
}
