#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/apps/ios/Snackday.xcodeproj"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$ROOT_DIR/DerivedData}"
IOS_DESTINATION="${IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 16,OS=latest}"

if ! xcodebuild -version >/dev/null 2>&1 && [[ -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: Full Xcode is required. Install Xcode or set DEVELOPER_DIR to its Developer directory." >&2
  exit 1
fi

# xcodebuild prints "** TEST SUCCEEDED **" and exits 0 for a run that matched
# ZERO tests, so neither signal proves anything was verified. Capture the log,
# keep streaming it, and let the shared verdict guard decide — the same guard
# the acceptance journey uses, so the gated path can never be the weak one.
LOG_FILE="$(mktemp -t snackday-ios-test)"
trap 'rm -f "$LOG_FILE"' EXIT

set +e
xcodebuild test \
  -project "$PROJECT" \
  -scheme Snackday \
  -configuration Debug \
  -destination "$IOS_DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$LOG_FILE"
XCODEBUILD_STATUS="${PIPESTATUS[0]}"
set -e

bun "$ROOT_DIR/scripts/lib/xcodebuild-verdict.ts" "$LOG_FILE" "$XCODEBUILD_STATUS"
