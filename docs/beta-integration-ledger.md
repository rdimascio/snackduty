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

## Evidence

- Wave 0: prior 232 web tests still pass after removing import-time application
  database creation and global page services; web typecheck passes.
- Runtime staging hostname/provider, Apple audience/team/bundle and verified
  sender are requested. No remote staging, real Apple login, email delivery,
  signing or TestFlight release is claimed.

## Integration receipts

Pending foundation commit and leaf implementation. All required stubs must be
removed before claiming integrated completion. The final reviewed commit must
pass local fast/scenario/UI/accept/full Mac gate and hosted checks before merge.
