# 0002 — Integrate through durable contracts

- Status: Accepted
- Date: 2026-07-16

## Context

The combined product must survive model sessions, daemon restarts, and partial failures. Direct
model-to-model coordination or private imports would make progress and authority ephemeral. Lesto
and Studio already expose the necessary governed seams.

## Decision

The integration contract is:

1. A Roof conversation is anchored to a durable Studio task or goal.
2. Studio decomposes work into repository-scoped tasks, creates isolated worktrees, records
   dependencies, and dispatches bounded implementation runs.
3. Agents change applications through normal source control and may inspect a running Lesto app
   through its loopback development MCP control plane. `describe_app` is the first inspection
   call; mutation requires an explicit operator scope or app-defined domain tool.
4. Every repository supplies its own required verification command. Snackday's completion gate is
   `bun run gate`; a lint- or typecheck-only result is not equivalent.
5. Studio records plans, exact commands, check results, review findings, commits, approvals, costs,
   and typed run outcomes. Roof renders those server-owned projections.
6. Integration between Roof and Studio uses Studio's versioned `/v1` and WebSocket schemas.
   Integration between an application and Lesto uses published `@lesto/*` packages and governed
   MCP contracts, never private framework source.

Fable acts as architect and advisory reviewer during the pilot. It may recommend approval,
rejection, or escalation but does not impersonate a human approver. Implementation is delegated to
bounded worker runs only after the current Studio safe-autonomy release gate permits dispatch.

## Consequences

- Durable tasks and evidence, not chat transcripts, carry intent between agents.
- Server-side authorization applies to every application mutation; client visibility grants
  nothing.
- Missing, stale, or unpriced evidence is reported as unknown, never silently green or zero.
- Mid-run steering is not promised; new constraints apply at the next safe run boundary.
