# Beta integration ledger

Baseline `e0842fd` matches `origin/main`; clean worktree, PRs #1–#3 merged.
Foundation owner: root, branch `feat/beta-foundation`.

## Ownership and queue

All leaves start at the same foundation commit in isolated worktrees. No leaf
edits frozen contracts. Root owns `lesto.app.ts`, `composition.ts`,
`app-services.ts`, `application-contracts.ts`, `packages/domain/src/api-contracts.ts`,
`packages/domain/src/index.ts`, `contracts/**`, `TransportModels.swift`,
`ApplicationContracts.swift`, all manifests/lockfiles, migration registration,
Xcode project/schemes/configuration, CI and harness integration wiring.

| Ticket | Mission and exclusive files                                                                                                                                                                                                               | Dependency                                                | Observable done criteria                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A      | Canonical policy/runtime: `packages/domain/src/policies.ts`, `teams.ts`, `domain.test.ts`, new `policy*.test.ts`; web `teams.ts`, `team-reads.ts`, `roster.ts`, `attendance.ts`, `calendar-feeds.ts`; focused authorization/tenancy tests | Frozen contracts                                          | One policy; owner/coach/guardian/member, revoked/unknown, cross-team/season, own-child cases pass                                |
| B      | Adult identity: web `identity.ts`, `identity-providers.ts`, `people-identity.ts`, `authentication.ts`, new `apple-identity.ts`, `session-routes.ts`, `authentication*.test.ts`, `apple-identity*.test.ts`, `dev-sign-in.test.ts`          | Frozen contracts                                          | Real JWT cryptographic verification, subject linking, replay/expiry/revocation/logout tests; no name linking or release dev auth |
| C      | Invitations: web `invitations.ts`, `invite-delivery.ts`, new `invitation-outbox.ts`, invitation island/modules and invitation-specific tests                                                                                              | Frozen identity contract; B implementation at convergence | Recipient binding, explicit guardian targeting, forward/rotate/replay/duplicate tests, persisted retry intent                    |
| D      | Runtime: new `apps/web/runtime/**`, `apps/web/test/runtime*.test.ts`, `scripts/runtime/**`, `docs/staging-runtime.md`                                                                                                                     | Pure composition                                          | Same APIs/migrations; durable restart, backup/restore, health, fail-closed mode and redaction tests; honest remote evidence      |
| E      | Native transport: `SnackdayAPIClient.swift`, new domain `*Session*.swift`, `*Selection*.swift`, `SnackdayApplicationController.swift`; client/session/selection domain tests                                                              | Frozen Swift protocol/fixtures                            | Restore/logout/revoke, identity-scoped selection, cancellation/stale response, typed safe errors, canonical fixture decoding     |
| F      | Native shell: `Snackday/AppLaunchView.swift`, `AppRootView.swift`, new app views, `SnackdayTests/AppCompositionTests.swift`, `SnackdayUITests/**`                                                                                         | Frozen controller protocol; E at convergence              | Honest sign-in/empty/error/retry, switch team/season/logout, no live sample claims, named UI tests                               |
| G      | Acceptance: new `scripts/lib/beta-acceptance*.ts`, `apps/web/test/beta-journey*.test.ts`, `docs/beta-release-evidence.md`                                                                                                                 | Integrated implementations                                | Dual-role/two-team, recipient/session boundaries, failure recovery and exact evidence claims                                     |

Each kickoff narrows test ownership by exact filenames. Other files are forbidden
unless root reallocates them in this ledger. Migrations reserved centrally: 010
identity/session, 011 invitation recipient binding, 012 invitation delivery intent.
Root integrates leaf commits, registers migrations and new Swift files, and alone
runs simulator/DerivedData checks. Sol agents run focused non-simulator checks.

## Integration receipts

All initial leaves were cut from frozen foundation `66e03cb`; source commits were
cherry-picked in the root worktree. Follow-up E2/C2/A3 leaves share the newly frozen
`d3ab7a8` seam. Root alone owns simulator and DerivedData execution.

| Owner / ticket                | Integration commit(s)           | Scope / evidence                                                                                                                                                                        |
| ----------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root / foundation             | `66e03cb`, `85625e0`            | Contracts, canonical fixtures, factory/context composition, injected clocks and Release build check. Existing 232 web tests passed after composition split.                             |
| root / A                      | `13f1e13`                       | Domain policy wired into team/child authorization and privacy reads; focused policy/tenancy coverage.                                                                                   |
| Sol identity / B              | `c4b0d5c`                       | Cryptographic Apple verification, provider links and durable sessions.                                                                                                                  |
| Sol runtime / D               | `e56f6a9`                       | Bun/SQLite remote composition, health, backup/restore/probe tooling and focused persistence tests.                                                                                      |
| Sol transport / E             | `a99892b`                       | Native Keychain transport, session/selection controller and domain tests.                                                                                                               |
| root / integration            | `d91d9e4`, `9439d7c`            | Real runtime file/API routes, required Apple audience, session-mode enforcement, migrations and encrypted invitation outbox wiring.                                                     |
| Sol native shell / F          | `3a38619`, `16d948c`            | Honest SwiftUI shell and navigation tests.                                                                                                                                              |
| Sol invitations / C           | `4d83672`                       | Recipient binding, explicit child relationship targeting, delivery outbox and retry tests.                                                                                              |
| Sol acceptance / G            | `faf328c`, `f46c3a9`            | Real composed-runtime RS256 journey: 2 tests / 91 assertions. Synthetic keys and delivery explicitly labelled.                                                                          |
| Sol harness / G2              | `4a02172`                       | Recipient-bound existing scenario/acceptance fixtures; 50 focused API tests passed.                                                                                                     |
| root / native integration     | `eb687a4`, `d3ab7a8`            | Live app client composition, challenge race/body-stream regressions, entitlement/fixtures and native invitation contracts. 35 domain and four UI tests passed before follow-up changes. |
| Sol authorization / A2        | `4e81ed5`, `85fe1f5`            | Active-season event/duty scope; 30 API and 13 policy tests passed.                                                                                                                      |
| Sol clocks / A3               | `340bc38`                       | Roster/import/status clocks injected; composition also passes clock through page request services.                                                                                      |
| Sol attendance / A3           | `9910be1`                       | Reproduced archived aggregate leak; read/write now require canonical active occurrence scope.                                                                                           |
| Sol native join / C2          | `ee97c32`                       | Native invitation entry/preview/accept, cancellation and generic recipient failures.                                                                                                    |
| Sol session repair / E2       | `6e28a29`, `b678eba`, `7b00632` | Redirect rejection, immediate durable local logout, stale completion protection and visible rejected sign-in.                                                                           |
| Sol retention / B3            | `b38bf46`                       | Expired challenge cleanup and concurrent stable-subject sign-in regression; alleged unique race refuted on the real SQLite adapter.                                                     |
| Sol active selection / A4, E3 | `4c8cf8a`, `76e0828`            | Inactive season directories/rosters denied; native saved/default/explicit selections revalidated.                                                                                       |
| root / convergence            | `40fe367`                       | Join/picker wiring, mandatory outbox intent, app-hosted signed simulator tests with real Keychain, native live invitation acceptance and Xcode receipt discovery.                       |

## Follow-up ownership

- E2 (`fix/native-session-boundaries`, Sol runtime agent): only native API client,
  Keychain store, application controller and client/session/selection tests.
  Reject redirects and clear local identity on failed-network logout without
  overwriting a newer login. No contracts or UI edits.
- C2 (`feat/native-join-team`, Sol native agent): only new `JoinTeamView.swift` and
  `JoinTeamTests.swift`. Consume frozen invitation DTOs/protocol and exercise
  explicit preview/accept with cancellation and safe errors. Root wires it.
- A3 (`fix/injected-operation-clock`, Sol identity agent): roster, roster-import,
  team-reads and a dedicated operation-clock test. Expanded exclusively to
  attendance and its API test after reproducing archived-season aggregate leakage.
  Root handles composition and request service wiring.
- Root: shared files above, existing native picker/shell wiring and UI regression,
  old overview fixture migration, project registration, status/backlog and review.

## Current verification and blockers

Fast, scenario, native UI, acceptance and the Mac gate passed locally. The full
gate at `afe87e8` passed 288 web, 22 domain, 39 manifest, 12 harness, 59 Swift
and four UI tests. Claude reviewed the complete baseline and integrated delta;
a different-model integrated review also ran. Retained findings were reproduced
and corrected. Final fix `d54a2f4` makes an accepted invitation's refresh outlive
sheet cancellation: the regression failed before, passed after (12 app tests),
and independent review passed. `fc29d3d` replaces a flaky yield-count test wait
with request-registration barriers. The final gate passed; receipt
`.artifacts/acceptance/run-1FLROh/receipt.json` records native/API acceptance.
Hosted checks are required before merge. The alleged concurrent first Apple sign-in race was refuted with two
real simultaneous sign-ins producing exactly one account and provider link.

No remote staging, live Apple login, external delivery, signed archive or
TestFlight release is claimed. Hosting/volume/sender configuration and Apple
registration/distribution access remain unresolved. The user's account setup is
not yet decided; independent implementation continues without invented targets.

An unrelated untracked `test.jsonl` is preserved and excluded from commits. Local
receipts must retain truthful dirty-source provenance; hosted checks will provide
clean commit evidence.
