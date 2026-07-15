#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/apps/ios/Snackday.xcodeproj"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$ROOT_DIR/DerivedData}"

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: Full Xcode is required. Install Xcode and select it with: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

xcodebuild build \
  -project "$PROJECT" \
  -scheme Snackday \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  CODE_SIGNING_ALLOWED=NO
