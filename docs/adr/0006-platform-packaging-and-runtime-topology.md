# 0006 — Platform packaging and runtime topology

- Status: Proposed
- Date: 2026-07-16
- Decider: Chief Architect

## Context

Roof is the customer-visible macOS client and Studio is an independently useful local or hosted
engine. Roof already selects a Studio endpoint through its transport base URL. Customers still need
one coherent installation, update, rollback, and support experience.

## Proposed decision

Ship one installer and support channel containing separately versioned Roof and Studio artifacts.
Roof discovers or launches the local Studio daemon, or connects to an explicitly configured remote
profile. The same Roof binary supports local, hosted, and hybrid topology through the versioned
Studio contract. Do not embed or fork Studio inside Roof for the first supported release.

## Required invariants

- Closing Roof does not corrupt or implicitly kill durable Studio work.
- Uninstall and update behavior explicitly handles the daemon, database, worktrees, and credentials.
- Occupied ports, daemon version skew, token rotation, and rollback fail visibly and recoverably.
- Remote profiles never fall back silently to a local daemon.

## Evidence required

Run a clean-machine lifecycle probe covering install, first launch, discovery, local/remote switch,
update ordering, rollback, uninstall, and recovery after interruption.
