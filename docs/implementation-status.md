# Team-first implementation status

## Published foundation

[PR #1](https://github.com/rdimascio/snackduty/pull/1) merged as `5146232ade232558e222badbde8a8d19a21f69ee` on September 14 after the [hosted macOS full product gate](https://github.com/rdimascio/snackduty/actions/runs/34897170161) and GitGuardian checks passed. This publishes the restored roadmap, roster privacy, duty API, native privacy correction, and product CI. Local and hosted gates both executed 226 web tests, 19 Swift tests, the domain/platform suites, builds and native live acceptance.

## Co-coach capability slice

The next isolated Sol implementation adds owner-controlled coaching grants to existing adult team memberships. Stored role precedence is owner → coach → adult. Coaches use the existing authorized roster, season, event, attendance and duty services; owners alone manage invitations and coaching grants. API `access: "manage"` describes operational access and is not permission to manage membership. Server guards remain authoritative.

Integrated as `9de1226` on `feat/co-coach-beta` from Sol commit `a469f34`, based on merged main `5146232`. Independent review prompted explicit delegated-owner coverage, same-team guardian preservation, and accurate accepted-invitation role typing/display. The complete local Mac gate passed with 232 web tests, 10 domain tests, 39 platform-manifest tests, 19 Swift tests, builds, and live native/API acceptance. Hosted CI must pass before this branch is merged.

`POST /api/teams/:teamId/adult-members/:personId/co-coach/grant` requires an active adult account and team membership. The matching `/revoke` endpoint downgrades all active coach rows to ordinary adult access, including when the target account is deactivated. Neither endpoint changes a creator/owner role or guardian edges; unknown roles remain inert. A parent retains own-child reads on the coached team and other teams after coaching is revoked. Accepted invitation pages report the current coach role accurately without adding a coach invitation type.

This is a partial SD-027/SD-003 backend slice. Verified recipient-bound co-coach invitations, role-change audit/outbox, native role-management UI and real authentication remain open. The existing membership table stores the role; no new schema migration is required. League and branded-app work remain deferred.

## Mac restoration verification — September 14, 2026

Restored on `review/team-first`. Fetching with local GitHub CLI authentication confirmed that `origin/main` still points to `38dab8b227e8da51b123f45382b82ebb1dd6aeec`; there were no newer main changes to integrate. The earlier integration-token 403 does not apply to the local authenticated CLI. No branch protection or repository rulesets were configured at inspection; passing product checks remain our merge requirement.

`bun install --frozen-lockfile` and the complete `bun run gate` passed on this Mac using Bun 1.4.2, Xcode 16.2 (16C5032a), and the iPhone 16 / iOS 18.3 simulator. After review corrections, the gate exercised formatting, lint (existing warnings), workspace typechecks, 226 web tests, 10 domain tests, 39 platform-manifest tests, 19 Swift tests, web/native builds, and the real HTTP acceptance journey including the explicitly executed native live round trip. Additional Swift regressions prove full own-child and redacted teammate roster responses decode and map successfully, including honest empty versus private guardian state. The standalone Swift run excludes the environment-gated live case; the acceptance step runs and verifies it separately.

These are local synthetic-data checks, not production or distribution evidence. The installed Xcode is below the launch plan's Xcode 26+ upload requirement. Production runtime/authentication, secure recipient binding, delivery, native coordination screens, app registration/signing, a signed archive and physical-device/TestFlight verification remain outstanding. League operations remain R4; branded apps remain last at R5.

Independent review found that hidden guardian arrays were described as missing by native UI, and that release/unassignment could irreversibly erase past or cancelled duty assignments. Both were corrected and passed the full gate. Native UI now distinguishes private guardian details from a full empty response; duty changes preserve assignments once the event is past or cancelled, while same-state retries remain successful. Duty concurrency tests issue competing requests against the serialized SQLite connection; they establish one winner for the current local adapter, not overlapping transactions across independent database connections. Conditional-update guards remain defense in depth and need additional driver-specific verification if the runtime changes.

The new `Product / Full product gate` workflow runs the unchanged complete gate for PRs and main on macOS 15 with Bun 1.3.5, Xcode 16.4 and an available iPhone simulator. It preserves the gate exit code and uploads failure logs/test results. This is a simulator CI lane, not signing or release certification.

The sections below preserve the September 11 handoff. Their GitHub and native-environment blockers describe that earlier environment; the verification and publishing evidence above supersede them for this Mac.

## Original restored handoff

September 11, 2026. Base: `38dab8b227e8da51b123f45382b82ebb1dd6aeec` in `rdimascio/snackduty`.

The owner authorized implementation, Sol delegation, PR creation and merging. Two Sol implementation agents completed bounded changes in separate worktrees. The orchestrator reviewed their diffs, requested compatibility and dual-role corrections, and combined the changes on local branch `codex/team-first-integration`.

GitHub branch creation returned HTTP 403, “Resource not accessible by integration,” including a retry after the owner's authorization. Repository metadata reports push/admin permissions, but that does not establish the integration's effective write grant. No remote branch, PR, merge, deployment or TestFlight upload was performed. Publishing requires fixing the GitHub connection's repository write access. This environment has no Xcode or Apple account connection.

## Reviewed commits

| Integration commit | Change                                                                                    | Source branch/commit               |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| `83f4701`          | Coach-parent-player roadmap, 30 dependency-linked tasks, league and branded apps deferred | `codex/team-first-roadmap`         |
| `594aa29`          | Field-level roster privacy in API and rendered page                                       | `codex/roster-privacy`, `40ddb487` |
| `41def6a`          | Persisted event duty slots and claim/release/assignment API                               | `codex/snack-duty-api`, `43fedeae` |
| `2d0ed0b`          | Regression for manager on one team and guardian on another                                | `codex/roster-privacy`, `7f72703d` |

## Behavior delivered

Roster managers retain full roster access. Ordinary team adults receive minimal teammate entries; an active authorized guardian receives private details for their own linked child. Unrelated, revoked and cross-team access is tested. The `guardians` array remains present when redacted, preserving the existing Swift DTO shape by source inspection. No native compilation is claimed.

Migration `009_create_duty_slots` adds single-adult slots to existing event occurrences. Authenticated team adults can list and claim slots and release their own assignment. Existing owner/creator managers can create slots and assign or unassign active team adults. Each operation checks team and occurrence scope; conditional transactional writes reject competing claims. New assignments require future scheduled events. Same-state retries are no-ops; this is not durable request-key idempotency across arbitrary later edits. Creation retry keys remain future work before automatic client retries.

API base: `/api/teams/:teamId/occurrences/:occurrenceId/duty-slots`. GET lists; POST creates. POST `/:slotId/claim` and `/:slotId/release` act for the caller. POST `/:slotId/assignment` accepts `assigneePersonId` as a person ID or null.

This is a backend foundation. It does not implement native duty screens, co-coach manager grants, swaps, rotations, reminders, production identity or the assistant. Existing authorization semantics remain the baseline for manager operations. SD-003 and SD-011 remain incomplete because their full acceptance criteria are broader than these slices.

## Verification

Validation used Bun 1.3.5 on Linux, with frozen dependencies installed using `--ignore-scripts`. This exercises Bun SQLite, not a successfully built Node native SQLite module.

| Check                                                                      | Result                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------ |
| Combined web suite                                                         | 224 passed, 0 failed, 2,498 assertions across 20 files |
| Workspace typecheck                                                        | Passed; iOS command checks structure only              |
| Web production build                                                       | Passed                                                 |
| Lint                                                                       | Exit 0 with warnings; not warning-free                 |
| Formatting and patch whitespace                                            | Checked before packaging; see package README           |
| Native build, simulator/device tests, signing, APNs, production smoke test | Not performed; Xcode/Apple access unavailable          |

The original full gate stopped at iOS tests because Xcode was unavailable. A green full gate or release-ready build is not claimed. The added API tests cover invalid scope, revoked access, assignment rules, competing claims, release ownership and persistence. Full native and production gates remain required before merging under repository policy and before beta distribution.

## Prepared PR sequence

1. **docs: prioritize coach-parent-player workflows and defer branded apps.** Make the owner's independent team the first pilot; preserve tenant isolation now and defer league hierarchy and branded distribution. Validate backlog dependency integrity.
2. **fix(web): scope roster details to authorized adults.** Prevent unrelated parents from reading private roster fields while preserving own-child and manager access. Include the dual-role regression in this PR. Validate API and HTML privacy paths and native decoding on macOS.
3. **feat(web): add event duty slot API.** Provide the persistence and authorized mutations needed for native snack-duty screens. Validate migration and claim concurrency; complete required CI before merging.

These are prepared descriptions and local commits, not GitHub PRs. The bundle and ordered patches offer two alternative ways to restore the reviewed work. Use one method; applying both would duplicate the changes.

Next work: explicit co-coach capabilities; production API/runtime proof and verified adult sign-in; secure invitation binding; native launch/session/team selection. Infrastructure edits must first follow the required sibling Lesto guides. Complete the whole coach/co-coach/parent loop, then archive and test that exact commit for TestFlight.
