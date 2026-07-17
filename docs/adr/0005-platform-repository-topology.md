# 0005 — Platform repository topology

- Status: Proposed
- Date: 2026-07-16
- Decider: Chief Architect

## Context

Roof, Studio, Lesto, and Snackday have different implementation languages, security boundaries,
release cadences, and ownership. Cross-product architecture material currently lives in Lesto,
Roof, Studio, and Snackday documents without a neutral compatibility source.

## Proposed decision

Keep product code in independently versioned repositories. Create a small neutral platform
coordination repository for accepted cross-product ADRs, compatibility manifests, schemas,
runbooks, demo definitions, and evidence indexes. It must not become a shared implementation
package or a second task board; Studio remains the execution source of truth.

## Alternatives

- Product monorepo: simpler atomic edits, but couples unrelated toolchains, release authority, and
  open-source/product boundaries.
- Put all platform material in Lesto: gives the framework authority over client and engine policy.
- Put it in Studio: gives the orchestrator authority over product and application contracts.

## Evidence required

- Inventory cross-repository artifacts, release owners, licenses, and dependency directions.
- Prototype a manifest referencing exact current commits and contract hashes.
- Demonstrate that no product build imports the coordination repository at runtime.

## Reversal trigger

Reconsider a monorepo only if coordinated changes routinely require atomic cross-repository commits
and compatibility/release automation cannot keep the suite safe at acceptable cost.
