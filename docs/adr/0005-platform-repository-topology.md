# 0005 — Platform repository topology

- Status: Accepted (amended) — independent product repositories plus a small neutral coordination
  repository, with ownership, canonicality, and migration clauses added
- Date: proposed 2026-07-16; adjudicated 2026-07-17
- Decider: Chief Architect (adjudication task `L-76601e17`, under platform decision `L-710ba74e`)

## Context

Roof, Studio, Lesto, and Snackday have different implementation languages, security boundaries,
release cadences, ownership, and — decisively — different license postures (proprietary-unlicensed,
Apache-pending-provenance, MIT, UNLICENSED). Cross-product architecture material lived scattered
across all four repos, and its newest layer (the platform ADRs and decision packet) sat untracked
in a repo with no remote — the weakest durability in the estate.

## Decision

Keep product code in independently versioned repositories. Create a small neutral platform
coordination repository. It must not become a shared implementation package or a second task
board; Studio remains the execution source of truth. Three clauses bind the proposal:

### 1. Ownership clause

The coordination repository is created under a clean, non-employer, non-personal org (which org is
a named human decision below), private initially, plain-docs license. Its merge authority is the
Chief Architect decision process, not any product team. (Honesty note from design review: until
multiple governors exist this is owner-controlled in practice — the charter must name
administrators, succession, and recovery rather than implying org-name neutrality equals
governance neutrality.) It must **not** live under `every-io` and
must **not** be blocked on Studio's provenance/title gate — the manifest must be able to name (or
exclude) the Studio artifact without inheriting Studio's provenance risk.

### 2. Canonicality clause

The coordination repository stores **accepted cross-product ADRs, the release manifest (versions +
content hashes + supported ranges + migration/rollback coordinates), runbooks, demo definitions,
and evidence indexes — never canonical schemas or code**. Product repositories remain canonical
for their seams (Studio: `api/openapi.json` + the WS union; Lesto: deploy-verdict schema + package
semver; template contract: the Lesto scaffold, when it exists per ADR 0007). Consumers keep the
proven vendored-slice + freshness-gate pattern (`Fixtures/regen.py`,
`Scripts/check-fixture-freshness.sh`). "No product build imports the coordination repository at
runtime" is thereby true by construction, and enforced by CI grep in both directions once the repo
exists.

### 3. Migration clause

Snackday's `docs/adr/` and `docs/platform/` are committed (done, 2026-07-16/17); Snackday gets a
private remote (task filed — it is still remote-less at adjudication). At coordination-repo
creation, ADRs 0005–0008 and the decision packet **move** there with back-pointers; ADRs 0001–0004
stay in Snackday (they are Snackday's own integration contract). After the move, no platform-ADR
edits land in Snackday.

## Evidence reviewed (adjudication 2026-07-17)

- Repository-topology probe (`L-9d682737`, `docs/platform/probes/repository-topology.md`):
  complete four-repo inventory (artifact, build system, version, license, release mechanism);
  strictly one-way dependency graph; zero observed changes requiring atomic cross-repo landing —
  the versioned seams absorb the coupling that exists.
- **Live re-verification during this adjudication:** dependency directions confirmed in source —
  Roof→Studio via the vendored OpenAPI slice + freshness gate (files present), Studio→Lesto via
  the external-binary zod-parsed verdict (`z.literal` pins verified under ADR 0007), and
  Snackday→Lesto genuinely from npm (`@lesto/*@^0.2.0` in `apps/web/package.json`, no workspace
  links). Roof has no LICENSE/EULA file (confirmed). Durability deltas since the probe: the
  constitutional docs are now committed; **Snackday still has no remote**; Roof drifted further
  (ahead 13, behind 1, unpushed); Studio is ahead 1.
- The manifest-prototype evidence item is satisfied: ADR 0007's adjudication live-verified
  byte-reproducible generation, clean verification, and the 12/12 tamper suite.

## Rejected alternatives

- **Product monorepo** — four toolchains (SwiftPM/Xcode, Bun/TS ×2, Xcode iOS), four release
  mechanisms (notarized .app + appcast; GH Release + tap + R2; npm changesets; wrangler deploys),
  and four license postures would entangle. Studio's provenance gate would then block everything,
  and the "Snackday consumes Lesto from real npm" dogfood proof would be erased. No observed
  atomic-change need pays for this.
- **Anoint Lesto or Studio as platform host** — grants one product improper authority over the
  others' contracts; each candidate fails the same way.
- **Status quo (distributed docs)** — was actively failing at proposal time: constitutional
  documents untracked in a remote-less repo while the packet itself listed "no neutral
  coordination repository" as a blocker.

## Consequences

- **Security/provenance:** license and provenance boundaries stay per-repo; the coordination repo
  carries plain docs and hashes, so it never inherits any product's IP risk.
- **Operability:** one more repository to keep honest. The named cost: it rots into a stale mirror
  if the manifest is hand-written — mitigated because the manifest is generated and verified
  mechanically (proven under ADR 0007), with verify checks in product CI.
- **Migration:** one deliberate document move at creation time, with back-pointers; no product
  build changes at all.

## Reversal triggers

- **Monorepo (measurable):** over any rolling month after the manifest exists, ≥3 changes require
  same-day paired landings across ≥2 product repos despite the versioned seams → re-open D1
  toward a monorepo or a merge of the tightly coupled pair.
- **Fold-back:** the coordination repo acquires runtime-imported code, a package with dependents,
  or a second task board → stop; fold its contents back into product repos.
- **Contract drift:** a runtime decode failure against a manifest-declared-compatible set
  falsifies "hashes/pointers only" → canonical schemas may then need to move, with generated
  clients.
- **Ownership:** if Studio's provenance review finds transplanted employer code and the manifest
  cannot exclude/replace the Studio artifact without restructuring, the coordination design failed
  its purpose.

## Open named human decisions

1. **Org, name, visibility, and license** of the coordination repo — interacts with `L-7455a0fb`
   ("Studio" is a provisional name; do not bake it into a public platform repo).
2. **Roof licensing posture** (proprietary EULA vs source-available vs open) and third-party
   notices — a distribution pipeline exists with no license text at all; blocking for any external
   distribution.
3. **Studio provenance Gate-1 sign-off** — already human-gated in `docs/license-decision.md`.
4. Manifest signing authority is deliberately **not** decided here — it belongs to ADR 0007/0008
   and sequences after the D6 ledger.

## Implementation owners and blocking edges

- **Durability (immediate, owner: Ryan):** create Snackday's private remote and push; reconcile
  and push Roof (ahead 13, behind 1); push Studio. The manifest's pinned commits stay
  one-disk-failure from unreproducible until this lands.
- **Coordination repo (blocked only on human decision 1):** draft charter embodying the three
  clauses; first commit carries the topology inventory; CI greps for the no-runtime-import
  invariant both directions; execute the migration clause.
- **Roof licensing (human decision 2):** license/EULA + third-party notices before any external
  distribution.
- Acceptance tests for the seams are owned by the ADR 0007 implementation tasks (fixture matrix,
  verdict-version coverage, from-registry gate run) — no duplication here.
