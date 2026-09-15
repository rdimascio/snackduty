#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/apps/ios/Snackday.xcodeproj"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$ROOT_DIR/DerivedData}"
TEST_NAME="testHomeRosterPrivacyAndTabNavigation"

if ! xcodebuild -version >/dev/null 2>&1 && [[ -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: Full Xcode is required. Install Xcode or set DEVELOPER_DIR to its Developer directory." >&2
  exit 1
fi

IOS_DESTINATION="${IOS_DESTINATION:-$(bun "$ROOT_DIR/scripts/ios-destination.ts")}"

LOG_FILE="$(mktemp -t snackday-ios-ui-test)"
trap 'rm -f "$LOG_FILE"' EXIT

set +e
xcodebuild test \
  -project "$PROJECT" \
  -scheme Snackday \
  -configuration Debug \
  -destination "$IOS_DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -only-testing:SnackdayUITests \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= 2>&1 | tee "$LOG_FILE"
XCODEBUILD_STATUS="${PIPESTATUS[0]}"
set -e

bun "$ROOT_DIR/scripts/lib/xcodebuild-verdict.ts" \
  "$LOG_FILE" \
  "$XCODEBUILD_STATUS" \
  --named-only \
  "the native UI smoke test" \
  "SnackdayUISmokeTests[./ ]$TEST_NAME"
