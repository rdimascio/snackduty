# Agent-operated platform MVP — Fable window

Window: 2026-07-16 through 2026-07-18

This plan extends Studio's active `plans/SAFE_AUTONOMY_SPRINT.md`; it does not replace it. The live
Studio board is the execution source of truth. Lesto's `docs/NORTH-STAR.md` is the product source of
truth, and the ADRs in `docs/adr/` define the proof application's stable integration contract.

## Outcome

Demonstrate an attended Roof → Studio → Lesto/Snackday → Cloudflare loop with durable tasks,
repository-native verification, fresh review, a typed deploy outcome, and restart/reconnect
evidence.

## Operating rules

- Fable is architect and fresh-eyes reviewer; bounded worker runs implement.
- Begin with one implementation lane. Raise concurrency only after Studio's re-entry gate passes.
- No unattended operator loop until spend/concurrency defaults, repeat-failure breaking,
  repository-native gates, truthful lifecycle states, and the live breaker checklist are green.
- No Studio-authored merge until SHA-bound merge authorization (`L-957b8149`) records an allow for
  the exact head SHA from required CI and independent review evidence. Post-hoc merge observation
  is not authorization; direct pushes and external unauthorized merges are incidents.
- Keep merge, deployment, money, authentication, credential, tool-security, and destructive
  approvals human-gated.
- Preserve active worktrees and unrelated dirty changes. Every slice ends with focused checks, the
  repository gate, evidence capture, and review.

## Day 1 — make operation safe and freeze the contract

- Finish Studio `L-47eaf290` slice A and then its bounded repeat-failure breaker slice.
- Land the SHA-bound merge-authorization ledger and fail-closed boundary (`L-957b8149`) together
  with the five verified shutdown, evidence-integrity, target-branch, and redaction blockers.
- Fix the canonical operator digest lookup (`L-e62a5e6c`).
- Reconcile local Studio `main` with its task base before any new dispatch; do not strand new runs
  on stale `origin/main`.
- Adopt ADRs 0001–0004 and attach them as evidence to the combined-demo task `L-85abeda8`.
- Recover and verify Snackday Teams worktree `L-c2f23aff`; do not restart it blindly.

Exit: bounded spend/concurrency are effective, repeat failures produce one escalation, architecture
and acceptance are frozen, and the next Snackday slice has a current base and explicit gate.

## Day 2 — make verification and the product slice truthful

- Ship repository-native gate discovery/enforcement (`L-e107d8d5`) with Snackday `bun run gate` as
  the regression fixture.
- Ship truthful cost attribution (`L-5357f16a`) or explicitly render cost as unknown.
- After the safety lane is reviewed, run up to three isolated lanes in parallel:
  - Studio deploy contract, redaction, idempotency, and fixture tests (`L-b491692b`) after
    repository-native gate enforcement.
  - Snackday D1 adapter, schema, and repeatable migrations (`L-e0745bce`) without waiting for UI or
    live credentials.
  - Roof typed deploy outcome and recovery UI against fixtures (`L-575bbc3c`) without waiting for a
    live deployment.
- Complete Snackday persistent team/season creation (`L-c2f23aff`), then roster/guardian creation
  (`L-5eed2aa5`), with authorization and privacy-focused tests. Those contracts plus D1 unblock the
  authorized edge routes (`L-a8d22202`).
- Complete the cockpit project/task projection fixes (`L-c7ddec74`, `L-6170979e`) needed to see the
  proof workload.
- Run focused web/API and iOS reads against the same persisted team journey.

Exit: Studio cannot mark the slice complete without the exact Snackday gate, and the authenticated
web/API/native product journey works locally from persisted data.

## Day 3 — connect the attended golden path

- Ship truthful lifecycle states (`L-82c4a33e`) and run the operator re-entry checklist
  (`L-96310988`), including a deliberately repeated failure and hard-cap cancellation.
- Run the attended deployment burn (`L-309d7012`) only after the deploy contract, repository-native
  gates, re-entry gate, and Snackday edge routes are green. It invokes Snackday's repository-owned
  Lesto Cloudflare deploy command without exposing credentials.
- Run the live Roof recovery burn (`L-ecd0935c`) only after its fixture UI and both live integration
  lanes are green. Drive one bounded intent through Studio tasks and reviewed worktrees to a typed
  deploy outcome and healthy URL.
- Close and reopen Roof, restart Studio, and confirm the task, approval state, evidence, and deploy
  URL recover without a duplicate run or recommendation.
- Record the owner handoff: intent, commits, verification, review, deploy health, costs/unknowns,
  residual risks, and the next task.

Exit: ADR 0004's nine acceptance steps have captured evidence, or the run ends in one actionable
human blocker without claiming success.

## Board structure

Use existing projects and identifiers rather than creating a competing board:

- Lesto north-star epic: `L-b7ac4ea3`; combined demo: `L-85abeda8`.
- Studio Supervisor Pilot MVP project: `bffa7f36-d37e-434e-bbb8-ac5c2ce9dd1f`.
- Snackday MVP project: `40c7a86b-93e3-45f9-8417-6a6189c53285`.
- Snackday milestone goal: `L-e4e6affb`; Teams: `L-c2f23aff`; Roster: `L-5eed2aa5`.

Create new tasks only for a genuinely missing, independently verifiable slice. Link cross-repo work
with related edges; use blocking edges only for real execution prerequisites.
