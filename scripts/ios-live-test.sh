#!/usr/bin/env bash
set -euo pipefail

# Focused LIVE run of the SnackdayDomainTests round trip against a real,
# already-running dev server. `SNACKDAY_LIVE_API=<base URL>` is REQUIRED here —
# unlike scripts/ios-test.sh, this wrapper exists only to make the env-gated
# live test actually run, so a missing base URL is an error, never a skip.
#
# xcodebuild does not hand its plain environment to the test runner; variables
# prefixed with TEST_RUNNER_ are forwarded with the prefix stripped. Exporting
# TEST_RUNNER_SNACKDAY_LIVE_API is what delivers SNACKDAY_LIVE_API to the test
# process (kept out of the xcodebuild argument list so build settings — and the
# incremental build cache — are untouched).
#
# Selection is at SUITE granularity: Swift Testing function identifiers
# (with or without trailing parentheses) match ZERO tests under this Xcode's
# -only-testing, silently "succeeding" while running nothing. The whole
# SnackdayAPIClientTests suite runs in well under a second, and the caller
# (scripts/acceptance.ts) verifies the live test's own pass verdict.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/apps/ios/Snackday.xcodeproj"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$ROOT_DIR/DerivedData}"
IOS_DESTINATION="${IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 16,OS=latest}"

if [[ -z "${SNACKDAY_LIVE_API:-}" ]]; then
  echo "error: SNACKDAY_LIVE_API=<base URL> is required, e.g. SNACKDAY_LIVE_API=http://localhost:3000." >&2
  exit 1
fi

if ! xcodebuild -version >/dev/null 2>&1 && [[ -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: Full Xcode is required. Install Xcode or set DEVELOPER_DIR to its Developer directory." >&2
  exit 1
fi

export TEST_RUNNER_SNACKDAY_LIVE_API="$SNACKDAY_LIVE_API"

xcodebuild test \
  -project "$PROJECT" \
  -scheme Snackday \
  -configuration Debug \
  -destination "$IOS_DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -only-testing:SnackdayDomainTests/SnackdayAPIClientTests \
  CODE_SIGNING_ALLOWED=NO
