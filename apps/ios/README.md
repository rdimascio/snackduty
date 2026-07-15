# Snackday for iOS

Snackday is a native SwiftUI application targeting iOS 18 with Swift 6 and Xcode 16 or newer.

Open `Snackday.xcodeproj`, select the shared **Snackday** scheme, then choose an iOS 18 simulator. The scheme builds the application and its two framework modules and runs all three Swift Testing suites.

## Module boundaries

- `Snackday` is the composition root and owns navigation and application UI.
- `SnackdayDomain` contains framework-independent, `Sendable` client models and contracts. It must not import SwiftUI.
- `SnackdayDesignSystem` contains semantic SwiftUI tokens and accessible components.

The native domain module is a client boundary, not a hand-maintained copy of the TypeScript domain package. Transport models should eventually be generated from an explicit API contract.

## Commands

From the repository root:

```sh
bun run ios:build
bun run ios:test
```

Builds use a generic simulator. Tests default to an iPhone 16 on the latest installed runtime; override that with `IOS_DESTINATION`. Both commands place build products in the ignored root `DerivedData` directory and disable code signing.
