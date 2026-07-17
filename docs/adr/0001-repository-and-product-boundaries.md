# 0001 — Keep product and control-plane repositories separate

- Status: Accepted
- Date: 2026-07-16

## Context

Lesto's ratified north star is “conversation in, deployed production app out.” The participating
repositories already have distinct responsibilities and independent release concerns. Combining
them into a monorepo would couple the native client, orchestration engine, framework, and proof
application without improving the product loop.

## Decision

Keep the repositories separate and assign one owner to each responsibility:

- Roof (`~/src`) is the thin native conversation and approval client. It consumes Studio's public
  `/v1` and WebSocket contracts and contains no orchestration or deployment logic.
- Studio (`~/every-io/studio`) is the durable system of record for goals, tasks, dependencies,
  runs, worktrees, approvals, evidence, budgets, and typed outcomes.
- Lesto (`~/crack`) is the agent-native application substrate and owns framework packages,
  governed application MCP surfaces, and Cloudflare deployment adapters.
- Snackday (`~/snackday`) is the real product and integration proof. Its domain, application,
  deployment configuration, and gates remain local to this repository.

Studio's live board is the execution source of truth. Repository documentation records stable
decisions and acceptance contracts, not a duplicate task ledger.

## Consequences

- Cross-repository changes are coordinated as linked Studio tasks with explicit dependencies.
- Shared behavior must cross a versioned public contract; no repository imports another
  repository's private source.
- A single demonstration may span several repositories while each change remains independently
  testable and revertible.
- Hosted multi-tenancy, billing, and a physical repo consolidation are outside the MVP.
