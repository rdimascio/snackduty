import SwiftUI

public enum SnackdaySpacing: Sendable {
    public static let compact: CGFloat = 8
    public static let standard: CGFloat = 16
    public static let spacious: CGFloat = 24
}

public extension Color {
    static let snackdayAccent = Color.accentColor
    static let snackdaySurface = Color(uiColor: .secondarySystemBackground)
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
