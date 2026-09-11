# Team-first implementation status

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
