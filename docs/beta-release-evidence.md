# Coach–parent beta release evidence

This record separates behavior implemented in source from evidence gathered in a local process, on the selected staging runtime, and in a distributed TestFlight build. A passing local test does not promote a row into either remote column.

## Evidence matrix

| Boundary                                                              | Source or command                                     | Implemented | Locally verified                 | Staging verified | TestFlight released |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ----------- | -------------------------------- | ---------------- | ------------------- |
| Apple challenge and cryptographic identity-token verification         | `apps/web/test/beta-journey.test.ts`                  | Yes         | Yes — focused journey            | No               | No                  |
| Stable provider-subject identity and verified-email claim             | `apps/web/test/beta-journey.test.ts`                  | Yes         | Yes — focused journey            | No               | No                  |
| Session restore, cookie-mode isolation, revocation, expiry, logout    | `apps/web/test/beta-journey.test.ts`                  | Yes         | Yes — focused journey            | No               | No                  |
| One adult coaches one team and parents on another                     | `apps/web/test/beta-journey.test.ts`                  | Yes         | Yes — focused journey            | No               | No                  |
| Owner-only delegation and co-coach operational access                 | `apps/web/test/beta-journey.test.ts`                  | Yes         | Yes — focused journey            | No               | No                  |
| Recipient-bound invitation forwarding, rotation, replay, and expiry   | `apps/web/test/beta-journey.test.ts`                  | Yes         | Yes — focused journey            | No               | No                  |
| Cross-team, cross-season, and unrelated-child privacy boundaries      | `apps/web/test/beta-journey.test.ts`                  | Yes         | Yes — focused journey            | No               | No                  |
| Durable runtime migrations and persistence                            | `bun test apps/web/test/runtime.test.ts`              | Yes         | See current check receipt        | No               | No                  |
| Invitation intent persisted before idempotent delivery                | outbox tests and `apps/web/test/beta-journey.test.ts` | Yes         | Yes — focused journey            | No               | No                  |
| Native contract decoding and session/selection state                  | SnackdayDomain tests                                  | Yes         | See current check receipt        | No               | No                  |
| Native launch, Apple sheet, team switching, and failure recovery      | `bun run ios:test:ui`                                 | Yes         | See current check receipt        | No               | No                  |
| Atomic event/snack creation and idempotent replay                     | coordination operation and composed journey tests     | Yes         | Yes — real SQL/HTTP              | No               | No                  |
| Native coach creates event → parent RSVPs → parent claims snacks      | `bun run accept`                                      | Yes         | Yes — real controller/API and UI | No               | No                  |
| Native schedule cancellation, stale replies, typed failures and retry | Swift domain/app tests and `bun run ios:test:ui`      | Yes         | Yes — focused and full gate      | No               | No                  |

“Focused journey” now records `bun test apps/web/test/beta-journey.test.ts`: 2 tests, 128 assertions and 0 failures through the gate on `1f9e10a`. It extends the foundation's 91 assertions with the coordination operations. Generated RS256 keys exercise the real verifier, sessions, SQL and operations; they do not establish live Apple authentication. The final integration ledger and commit-bound CI receipts remain authoritative after merge.

## Foundation release receipts

Record these against the same reviewed commit:

| Check                                         | Receipt                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bun test apps/web/test/beta-journey.test.ts` | Pass — 2 tests, 91 assertions                                                            |
| `bun run check:fast`                          | Pass — `/tmp/snackday-foundation-fast-review.log`                                        |
| `bun run check:scenario`                      | Pass — `/tmp/snackday-foundation-scenario-final.log`                                     |
| `bun run ios:test:ui`                         | Pass — four tests, `/tmp/snackday-foundation-ui-final-2.log`                             |
| `bun run accept`                              | Pass — `.artifacts/acceptance/run-1FLROh/receipt.json` through gate                      |
| `bun run gate`                                | Pass on `afe87e8` — `/tmp/snackday-foundation-final-gate-3.log`                          |
| Independent integrated-diff review            | Claude baseline and final delta plus separate-model review passed after reproduced fixes |

For native checks, record the discovered simulator destination and the nonzero named-test counts. Keep failure logs redacted and attach screenshots to the release record rather than embedding child-sensitive data here.

## Coordination release receipts

| Check                         | Receipt                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check:fast`          | Pass — 295 web / 29 domain / 39 manifest / 12 harness; `/tmp/snackday-coordination-fast-final.log`                                              |
| `bun run check:scenario`      | Pass — `/tmp/snackday-coordination-scenario-final.log`                                                                                          |
| `bun run ios:test:ui`         | Pass — seven fixture tests; live-only test intentionally skipped without acceptance server; `/tmp/snackday-coordination-ui-fixed.log`           |
| `bun run accept`              | Pass on clean `0ab4097` — `.artifacts/acceptance/run-dYDR3Y/receipt.json`; both named native API and real UI tests required                     |
| `bun run gate`                | Pass on clean `1f9e10a` — `/tmp/snackday-coordination-gate-final.log`; acceptance `.artifacts/acceptance/run-1AgTjP/receipt.json`               |
| Durable runtime               | Pass — migration 013, restart, integrity-checked backup/restore; `/tmp/snackday-coordination-runtime-proof-final.log`; `stagingVerified: false` |
| Independent integrated review | gpt-5.5 full diff and final deltas through `1f9e10a` passed after reproduced fixes; additional Claude attempt hit account quota                 |
| Hosted PR checks              | [PR #5](https://github.com/rdimascio/snackduty/pull/5) records the reviewed head, required hosted checks and merge status                       |

The full gate includes 81 Swift tests, seven fixture UI tests, Debug/Release simulator builds and actual native/server acceptance. Local discovery selected iPhone 16 Pro on iOS 18.3; tools were Bun 1.4.2 and Xcode 16.2. The actual UI creates an event as coach, relaunches as parent, RSVPs for the authorized child, claims snacks, verifies saved server data, and switches to another team where the adult coaches. The screenshots were exported from the passing `.xcresult` into `/tmp/snackday-coordination-ui-success` and inspected.

Failed runs remain available: `/tmp/snackday-coordination-native-5.log` proves cancellation could strand session restoration; `.artifacts/acceptance/run-silejw/xcodebuild.log` proves the stale RSVP count and untappable RSVP row; `/tmp/snackday-coordination-ui-first.log` confirms the fixture reproduced the hit-target failure. The passing runs exercise the fixes, including canonical fractional timestamps. No failure was waived.

## Account-dependent evidence

The following remain incomplete until they run with real external accounts and deployed configuration:

- Remote staging has a durable volume, backup destination, Apple audience, issuer/key retrieval, invitation provider credentials, and health endpoint configured.
- A live Apple identity token signs in an adult on staging, restores after process restart, and stops working after server-side revocation.
- A delivered invitation reaches the verified recipient, rejects a forwarded link, and retries idempotently through the deployed provider.
- The signed Release build uses the staging HTTPS origin, contains no development-auth route or automatic preview success state, and passes the native journey on TestFlight.
- The build is uploaded, external/internal beta access is configured as intended, and the released build number is recorded.

Never satisfy these rows with a development persona, a mocked identity verifier, an in-memory delivery recorder, or a preview fixture.

## Native real-controller preparation

Integration regressions found while replacing the fixture shell have source corrections with focused evidence; the complete gate now passes:

- The Apple challenge preparation now leaves the sign-in form visible, so the view can present the system authorization sheet after receiving the server nonce. A late challenge failure is generation-guarded and cannot replace a session restored in the meantime.
- The native transport test server now reads `URLRequest.httpBodyStream`, matching the body representation used by `URLSession` on the simulator. This turns Apple sign-in, restored-session logout, and the live development round trip into exercised requests instead of false 400 responses from a test-only body reader.

The named native suites and real HTTP journey now pass locally through the gate. They establish local implementation evidence; live Apple authentication and TestFlight remain unverified.

## Review and real-storage findings

The independent Claude baseline review passed and a separate model reviewed the integrated diff. Confirmed findings now have regressions: redirected responses cannot persist cookies; local logout clears Keychain before waiting for network revocation; stale responses cannot replace a newer session; failed Apple completion is visible; archived-season attendance and roster reads deny access; native selection excludes inactive or mismatched seasons. A concurrent first-sign-in race was refuted using the real serialized SQLite adapter: both sign-ins resolve to one account/provider link. Expired Apple challenges are pruned using injected time.

Actual native HTTP acceptance initially failed with `errSecMissingEntitlement` (-34018), before its first HTTP request. `CODE_SIGNING_ALLOWED=NO` and a hostless domain test bundle could not exercise real Keychain. The simulator runners now use local ad-hoc signing and DomainTests run inside the app. A hosted Keychain save/restore/clear test passed, followed by real native/server sign-in, fresh-client restoration, recipient-bound invitation acceptance and logout replay rejection. Receipt `.artifacts/acceptance/run-IzKygO/receipt.json` records the passing integration run with dirty-source provenance; it does not establish staging or TestFlight. Foundation hosted checks subsequently passed on PR #4; current coordination hosted receipts are tracked on PR #5.
