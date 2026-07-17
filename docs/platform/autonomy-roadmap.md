# Autonomy roadmap — building Snackday with Studio

- Date: 2026-07-17 · Status: active · Owner: Ryan
- Goal: **Studio builds Snackday autonomously.** This memo says how close that is, what
  blocks it, and in what order the rest lands.
- Sources: the four accepted platform ADRs (0005–0008), `UPGRADE_SAFETY_PLAN.revised.md`
  (upgrade-correctness contract), epic `L-6e485bca` (daemon lifecycle, post-review), the
  [human-decision sheet](human-decision-sheet.md).

## Verdict

**The first autonomous Snackday burn can start this week — in attended mode.** Attended is
not a compromise: ADR 0008's accepted operating rule is "every consequential approval is
human-gated," so agents plan, implement, and open gated merges; the human approves. The
blocking set for that pilot is three human actions and one ~20-line guard — not the daemon
epic, not the platform backlog. Unattended autonomy is a later tier with a named gate.

## Why the safety bar is met

The RCA that paused autonomy demanded a fail-closed merge authority. That now exists and is
**live-verified**: SHA-bound merge authorization shipped (PR #9), the review gate fails
closed on verdicts (#11), CI is trustworthy again (#15), and the live canary (`L-eccc38cf`,
2026-07-17) passed — merge refusal and bypass detection proven on real substrate. One layer
remains, and it is a human's ten minutes: GitHub branch protection.

## Tier 1 — the pilot (this week)

| # | Item | Owner | Ref |
|---|------|-------|-----|
| 1 | GitHub branch protection on the product repos | **Ryan (~10 min)** | `L-a4d52b09` |
| 2 | Give snackday a **remote** + push the estate (roof is ahead-14/behind-1) | **Ryan** | `L-4655733f` |
| 3 | Sign decision-sheet **C1** (advisory identity OK for attended pilot — rec: yes); A1 while there | **Ryan** | `L-58698e19` sheet |
| 4 | Tmp-tree fork-refusal guard (~20 LOC) so a verify tree can't re-anchor the fleet daemon mid-burn | agent, same-day | `L-9c151fac` |
| 5 | **Dispatch the burn:** 3–5 real Snackday tasks through the dev-loop fleet (Kimi K3 live for cheap capacity), approvals attended from Roof/TUI | operator | — |

Dogfooding is the probe: every friction the burn surfaces becomes a board task. That is the
fastest path to finding what actually blocks autonomy, and it is this platform's founding
method.

## Tier 2 — make autonomy survivable (1–2 weeks, parallel with burns)

The daemon epic (`L-6e485bca`) in its post-review order — the substrate must stop being a
hazard during long burns:

1. **Park** (`L-485369f1`) — restarts stop cancelling in-flight runs. *Build first: every
   later task ends in "restart the daemon."*
2. **Fail-closed lifecycle/DB-writer lock + preflight boot** (`L-7a411fa1`) — the pidfile
   singleton does not guard migration today; this closes the v71/v73 stranding class.
3. **Canonical daemon artifact + `studio daemon install`** (`L-b92dc619`, staged flip).
4. **`studio dev` isolation** via `STUDIO_HOME` (`L-acbcce45`).
5. **Skew write-refusal** deltas on the existing banner (`L-2f45fa91`).
6. **Supervision** (`L-a0ef1dd0`) — launchd/systemd owns the process, last.

Plus `UPGRADE_SAFETY_PLAN.revised.md` Phase 0 (fail-loud batch) in parallel, and its
upgrade-handoff work (`L-289b413f`, blocked on park).

## Tier 3 — shrink the human in the loop (weeks out)

- **Server-stamped approval identity + independence lineage** (`L-090f5344`) — the named
  gate for widening autonomy: approvals become capability-gated, so low-risk classes can be
  auto-approved without violating ADR 0008. No receipt enters a release manifest before it.
- Upgrade handoff + cross-version resume e2e; **first tagged release** (sheet B6) — the
  remedy channel that makes skew warnings actionable for a non-dev install.
- Roof preview redaction (`L-d8072bc0`) and the ADR 0007 implementation set as they matter.

## Explicitly not blocking — do not wait on

Coordination repo creation (A1 gates it, not the pilot) · manifest CI wiring · Roof
licensing (blocks external distribution only) · unix-socket spike · the `previous/` fixture
matrix (blocked on B6 anyway).

## Standing constraints during the pilot

- **Deploys stay attended** — Cloudflare credentials are human-held by design (ADR 0003).
- **Leave the daemon alone during burns** until park lands: a restart today cancels
  in-flight runs (`SIGTERM` world-cancel; `SIGKILL` ironically resumes).
- All burns run under the review gate + SHA-bound merge authorization; actor fields remain
  advisory until Tier 3 identity lands.
- **Token safety is per-run-strong, fleet-lagging** (assessed 2026-07-17): the per-run runaway
  trip works (it caught the 274k burst, `L-349c1d38`), but fleet-day \$ caps enforce at run
  completion (`L-06acddff`) and the meter is fail-open (`L-a45dd717`) — both filed as
  launch-gate blockers on `L-5540b242`. Pilot posture: keep the \$25/\$50 daily clamps, prefer
  few concurrent lanes over many, and treat "failed to record spend" log lines as a
  stop-the-burn signal.

## Pilot definition of done

A Snackday task goes ticket → plan → implement → review → gated merge with **zero human
keystrokes except approvals**, three tasks in a row, no daemon intervention — and the
friction list it produces is filed, triaged, and smaller on the third run than the first.
