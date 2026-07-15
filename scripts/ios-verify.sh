#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PBXPROJ="$ROOT_DIR/apps/ios/Snackday.xcodeproj/project.pbxproj"
SCHEME="$ROOT_DIR/apps/ios/Snackday.xcodeproj/xcshareddata/xcschemes/Snackday.xcscheme"

required_targets=(Snackday SnackdayDomain SnackdayDesignSystem SnackdayTests SnackdayDomainTests SnackdayDesignSystemTests)
for target in "${required_targets[@]}"; do
  grep -q "name = $target;" "$PBXPROJ" || { echo "error: missing Xcode target $target" >&2; exit 1; }
  grep -q "BlueprintName=\"$target\"" "$SCHEME" || { echo "error: shared scheme is missing $target" >&2; exit 1; }
done

grep -q 'SWIFT_VERSION = 6.0;' "$PBXPROJ"
grep -q 'SWIFT_STRICT_CONCURRENCY = complete;' "$PBXPROJ"
grep -q 'IPHONEOS_DEPLOYMENT_TARGET = 18.0;' "$PBXPROJ"
echo "iOS project structure verified"
