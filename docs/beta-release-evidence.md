# Coach–parent beta release evidence

This record separates behavior implemented in source from evidence gathered in a local process, on the selected staging runtime, and in a distributed TestFlight build. A passing local test does not promote a row into either remote column.

## Evidence matrix

| Boundary                                                            | Source or command                                         | Implemented | Locally verified          | Staging verified | TestFlight released |
| ------------------------------------------------------------------- | --------------------------------------------------------- | ----------- | ------------------------- | ---------------- | ------------------- |
| Apple challenge and cryptographic identity-token verification       | `apps/web/test/beta-journey.test.ts`                      | Yes         | Yes — focused journey     | No               | No                  |
| Stable provider-subject identity and verified-email claim           | `apps/web/test/beta-journey.test.ts`                      | Yes         | Yes — focused journey     | No               | No                  |
| Session restore, cookie-mode isolation, revocation, expiry, logout  | `apps/web/test/beta-journey.test.ts`                      | Yes         | Yes — focused journey     | No               | No                  |
| One adult coaches one team and parents on another                   | `apps/web/test/beta-journey.test.ts`                      | Yes         | Yes — focused journey     | No               | No                  |
| Owner-only delegation and co-coach operational access               | `apps/web/test/beta-journey.test.ts`                      | Yes         | Yes — focused journey     | No               | No                  |
| Recipient-bound invitation forwarding, rotation, replay, and expiry | `apps/web/test/beta-journey.test.ts`                      | Yes         | Yes — focused journey     | No               | No                  |
| Cross-team, cross-season, and unrelated-child privacy boundaries    | `apps/web/test/beta-journey.test.ts`                      | Yes         | Yes — focused journey     | No               | No                  |
| Durable runtime migrations and persistence                          | `bun run --filter web test apps/web/test/runtime.test.ts` | Yes         | See current check receipt | No               | No                  |
| Invitation intent persisted before idempotent delivery              | outbox tests and `apps/web/test/beta-journey.test.ts`     | Yes         | Yes — focused journey     | No               | No                  |
| Native contract decoding and session/selection state                | SnackdayDomain tests                                      | Yes         | See current check receipt | No               | No                  |
| Native launch, Apple sheet, team switching, and failure recovery    | `bun run ios:test:ui`                                     | Yes         | See current check receipt | No               | No                  |

“Focused journey” records `bun test apps/web/test/beta-journey.test.ts`: 2 tests, 91 assertions, and 0 failures against foundation integration `9439d7c` plus the owned acceptance follow-up. The final integration ledger or CI receipt remains authoritative after cherry-pick; this document does not copy a stale pass claim forward. “See current check receipt” has the same meaning for checks run outside this lane.

## Required release receipts

Record these against the same reviewed commit:

| Check                                         | Receipt                       |
| --------------------------------------------- | ----------------------------- |
| `bun test apps/web/test/beta-journey.test.ts` | Pass — 2 tests, 91 assertions |
| `bun run check:fast`                          | Pending                       |
| `bun run check:scenario`                      | Pending                       |
| `bun run ios:test:ui`                         | Pending                       |
| `bun run accept`                              | Pending                       |
| `bun run gate`                                | Pending                       |
| Independent integrated-diff review            | Pending                       |

For native checks, record the discovered simulator destination and the nonzero named-test counts. Keep failure logs redacted and attach screenshots to the release record rather than embedding child-sensitive data here.

## Account-dependent evidence

The following remain incomplete until they run with real external accounts and deployed configuration:

- Remote staging has a durable volume, backup destination, Apple audience, issuer/key retrieval, invitation provider credentials, and health endpoint configured.
- A live Apple identity token signs in an adult on staging, restores after process restart, and stops working after server-side revocation.
- A delivered invitation reaches the verified recipient, rejects a forwarded link, and retries idempotently through the deployed provider.
- The signed Release build uses the staging HTTPS origin, contains no development-auth route or automatic preview success state, and passes the native journey on TestFlight.
- The build is uploaded, external/internal beta access is configured as intended, and the released build number is recorded.

Never satisfy these rows with a development persona, a mocked identity verifier, an in-memory delivery recorder, or a preview fixture.

## Native real-controller preparation

Integration regressions found while replacing the fixture shell have source corrections with focused evidence; the final complete gate remains required:

- The Apple challenge preparation now leaves the sign-in form visible, so the view can present the system authorization sheet after receiving the server nonce. A late challenge failure is generation-guarded and cannot replace a session restored in the meantime.
- The native transport test server now reads `URLRequest.httpBodyStream`, matching the body representation used by `URLSession` on the simulator. This turns Apple sign-in, restored-session logout, and the live development round trip into exercised requests instead of false 400 responses from a test-only body reader.

These are implementation findings, not release evidence. Promote the native rows in the matrix only after the named domain, application, and UI tests pass through `bun run gate` on the reviewed commit with the Sign in with Apple entitlement configured.

## Review and real-storage findings

The independent Claude baseline review passed and a separate model reviewed the integrated diff. Confirmed findings now have regressions: redirected responses cannot persist cookies; local logout clears Keychain before waiting for network revocation; stale responses cannot replace a newer session; failed Apple completion is visible; archived-season attendance and roster reads deny access; native selection excludes inactive or mismatched seasons. A concurrent first-sign-in race was refuted using the real serialized SQLite adapter: both sign-ins resolve to one account/provider link. Expired Apple challenges are pruned using injected time.

Actual native HTTP acceptance initially failed with `errSecMissingEntitlement` (-34018), before its first HTTP request. `CODE_SIGNING_ALLOWED=NO` and a hostless domain test bundle could not exercise real Keychain. The simulator runners now use local ad-hoc signing and DomainTests run inside the app. A hosted Keychain save/restore/clear test passed, followed by real native/server sign-in, fresh-client restoration, recipient-bound invitation acceptance and logout replay rejection. Receipt `.artifacts/acceptance/run-IzKygO/receipt.json` records the passing integration run with dirty-source provenance; it does not establish staging or TestFlight. The final clean hosted commit checks remain required.
