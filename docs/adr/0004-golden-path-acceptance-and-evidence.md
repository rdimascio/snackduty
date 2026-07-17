# 0004 — Require an evidence-backed golden path

- Status: Accepted
- Date: 2026-07-16

## Context

The three-day model window is too short for the full hosted platform. A tangible MVP must prove the
cross-repository loop with honest evidence while remaining small enough to repeat.

## Decision

The MVP is complete when one attended run demonstrates this path:

1. In Roof, an operator asks for a bounded Snackday product change.
2. The conversation resolves to a durable Studio goal with repository-scoped tasks and dependency
   edges.
3. Studio dispatches implementation into isolated worktrees under explicit concurrency, token,
   spend, retry, and approval limits.
4. The worker implements the change using Lesto's public substrate and no human-authored commits
   after the initial intent.
5. Snackday passes `bun run gate` plus focused API and native checks relevant to the slice.
6. A fresh Fable review evaluates the actual diff and verification evidence. A human resolves any
   consequential approval.
7. Studio invokes the repository-owned Cloudflare deployment path and records a typed deploy
   outcome containing the commit, deployed URL, health result, verification commands, review,
   residual risks, elapsed time, model usage, and known cost or an explicit unknown.
8. Roof displays the running app, status, deployed URL, and attended approval/evidence without
   exposing secrets.
9. The same outcome remains legible after a Studio daemon restart and Roof reconnect.

The initial product slice is the existing Snackday Milestone 1 journey: a safely signed-in adult
creates a persistent team and season, adds a child with multiple guardians without a child account
or email, and reads the authorized team from web and native clients.

## Non-goals

- Hosted multi-tenant Studio, billing, and untrusted-user code execution.
- Fully autonomous consequential approvals.
- A generic plugin system or new orchestration engine.
- Completing all Snackday product milestones.
- Claiming production readiness from a single demonstration.

## Failure rule

Repeated identical failures stop after the configured bound, preserve the worktree, and create one
durable escalation with the failing command, normalized evidence, attempted remedies, accumulated
cost, and recommended next action. Missing evidence cannot satisfy acceptance.
