# Team-first implementation status

## Current beta foundation — September 14, 2026

Source baseline is merged PR #3, `e0842fd`; `origin/main` was fetched again and has no newer changes. The integration branch is `feat/beta-foundation`. This branch is not yet published or merged. The [integration ledger](./beta-integration-ledger.md) records isolated Sol ownership and commit receipts; [release evidence](./beta-release-evidence.md) separates local and external verification.

Implemented and integrated locally:

- One domain authorization evaluator controls runtime owner, co-coach, member and additive guardian access. Current membership, active team/season and exact child scope are checked server-side. A selected team or cached capability grants nothing.
- A pure application factory injects database, mode-bound Lesto sessions, time and provider adapters. Development and the selected Bun/SQLite staging runtime share composition and migrations. There are no required authentication stubs or import-time database instances.
- Apple signature/issuer/audience/expiry/nonce validation, single-use persisted challenges, stable provider-subject linking, explicit adult consent, session restore/revocation/logout, and isolated development authentication exist. Children remain participants without accounts.
- Invitations bind to provider-verified email or an owner-confirmed active adult. Forwarded links cannot grant membership; child authority requires explicit targeting. Encrypted delivery intent is persisted with the invitation before Lesto queue delivery; retries use an idempotency key.
- Swift decodes canonical server contract fixtures. The native shell uses real transport/session/selection interfaces, explicit sign-in, honest loading/empty/error states and team/season switching. Release contains no development sign-in or automatic successful preview. Misleading sample status tiles are removed.
- The durable runtime serves actual authorized APIs and file routes, applies canonical migrations and supports health, integrity checks, backup/restore and rollback drills. Missing remote authentication/delivery configuration fails closed.

### Local verification

The composed runtime journey passes 2 tests and 91 assertions using real generated RS256 tokens and durable database/session/outbox implementations. This establishes local cryptographic integration, dual coach–parent identity, two-team privacy, recipient/replay boundaries and session expiry/revocation. Its keys and delivery recorder are synthetic; it is not a live Apple or mail-provider test.

The complete Mac gate passed on `afe87e8`: 288 web tests, 22 domain tests, 39 manifest tests, 12 harness tests, 59 Swift tests, four UI tests, Debug/Release simulator builds and real native/API acceptance. Xcode 16.2 discovered iPhone 16 Pro on iOS 18.3. The acceptance receipt is `.artifacts/acceptance/run-1FLROh/receipt.json`; its dirty flag reflects the preserved unrelated untracked file.

Two independent integrated reviews completed. Reproduced findings have regressions for redirect credentials, local logout, rejected sign-in, archived-season privacy and selection. The final review found cancellation of the invitation sheet could strand the application refresh. `d54a2f4` fixes the refresh lifetime; its regression failed before the fix and passed after it. A repeated gate exposed a scheduler-dependent test wait; `fc29d3d` uses deterministic request-registration barriers. Both deltas passed independent review and the complete gate. Hosted checks on the published commit remain required before merge.

### External requirements still incomplete

No staging hosting account, hostname, persistent volume or verified invitation sender has been selected. No live Apple sign-in, external delivery, remote restart/restore/rollback journey, signed archive, physical-device journey or TestFlight release has been verified. Local Xcode account metadata lists a Personal Team; that is not distribution evidence. The source bundle identifier is `com.snackday.app`; app registration, paid-team/capability configuration and an upload-capable Xcode remain prerequisites.

The foundation is therefore implemented in substantial local slices, not a completed staging/TestFlight beta. Verified-email authentication onboarding, native coordination screens, broader role audit/jobs, delivery and onboarding work remain open. League operations stay R4; branded apps stay last at R5.

## Published baseline receipts

| PR                                                  | Merged commit | Scope and evidence                                                                                                                                                       |
| --------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#1](https://github.com/rdimascio/snackduty/pull/1) | `5146232`     | Roadmap, private roster reads, duty API, native privacy display and Mac product CI; local and hosted gates passed.                                                       |
| [#2](https://github.com/rdimascio/snackduty/pull/2) | `5611809`     | Owner-controlled co-coach grants and additive guardian rights; local and hosted gates passed.                                                                            |
| [#3](https://github.com/rdimascio/snackduty/pull/3) | `e0842fd`     | Reproducible synthetic scenarios, fast feedback, native UI guards/screenshots, redacted failure receipts and live native/API acceptance; local and hosted checks passed. |

The [development loop](./development-loop.md) remains the entry point. `bun run check:fast` checks TypeScript and tests; `bun run check:scenario` exercises synthetic real-API scenarios; native runners discover installed simulators. `bun run accept` requires its named native live test and preserves redacted failure artifacts. `bun run gate` runs the complete Mac product checks. CI evidence must refer to the exact reviewed commit before merge.
