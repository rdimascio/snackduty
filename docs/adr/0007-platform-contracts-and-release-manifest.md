# 0007 — Platform contracts and release manifest

- Status: Accepted (amended) — staged core adopted; signing, merge-authorization receipts, and
  application-template contract clauses severed and deferred to manifest v1
- Date: proposed 2026-07-16; adjudicated 2026-07-17
- Decider: Chief Architect (adjudication task `L-735d5b9e`, under platform decision `L-710ba74e`)

## Context

The products release independently, but users need a tested platform combination. Lockstep versions
would erase useful independence; best-effort latest-version compatibility would fail unpredictably.
Both are rejected (see Rejected alternatives). The 2026-07-16 red-team RCA additionally proved that
Studio-stamped review records were advisory, not authorizing — so nothing receipt-shaped may enter
a manifest until the fail-closed authorization ledger (D6) exists.

## Decision

Version each public seam independently; declare the tested combination in a staged release
manifest; fail loud on every unsupported pair. Concretely:

### 1. Independently versioned public seams

Each seam keeps its own version authority, single-sourced in the owning repository:

| Seam                        | Authority                                                                             | Today   |
| --------------------------- | ------------------------------------------------------------------------------------- | ------- |
| Studio `/v1` + WS contract  | `API_CONTRACT_VERSION` (`shared/src/contract-version.ts:6`) → OpenAPI `info.version` + WS `hello.serverVersion` | `1.0.0` |
| Studio product              | `STUDIO_VERSION` (`api/src/version.ts`) — deliberately a separate axis                 | `0.1.0` |
| Studio DB                   | `SCHEMA_VERSION` + forward-only `MIGRATIONS` chain                                     | v73     |
| Lesto packages              | lockstep changesets workspace version, exact internal pins; scaffold `LESTO_DEP_RANGE` | `0.2.0` |
| Lesto deploy verdict        | `DEPLOY_JSON_SCHEMA_VERSION` (producer, `packages/cli/src/run.ts`) vs Studio consumer `z.literal` pin | `1`/`1` |
| Roof client                 | Roof `VERSION` + `StudioClient.minServerVersion` (major-only connect gate)             | `1.0.0` |
| Application-template        | **does not exist** — severed; invented deliberately in v1 with a named owner           | —       |

The `/v1` contract policy stands: stable, additive-only, deprecate-before-remove
(`V1_CONTRACT_STATEMENT`); breaking seam changes require a new contract major plus migration
guidance.

### 2. Supported ranges

Until Studio cuts its first tagged release, the supported set is the current contract major
(`1.x`); Roof's major-only gate is the enforcement. A "previous supported" slot exists only once a
first tag defines it — the manifest never fabricates one. The support window (N−1 minor vs major)
and deprecation clock are a named human decision (below).

### 3. Capability negotiation

Additive `capabilities: string[]` on WS `hello`, plus a `contract` block
`{version, capabilities, openapiHash, wsUnionHash}` on `/v1/health` — derived from the route
registrar/generated spec, never hand-listed. The contract major remains the only hard connect
block; capabilities replace route-existence probing and tolerate absence. (Also closes the gap
that REST-only clients cannot see contract compatibility today.)

### 4. Schema hashes

Diagnostics only, never a compatibility gate — additive changes legitimately change hashes. The
single load-bearing hash is the manifest's own sidecar SHA-256. Hashes appear in connect
diagnostics and the incompatibility banner.

### 5. Migration rules

Forward-only migrations with fail-loud downgrade refusal on every store. Studio's
`SchemaDowngradeError` (names both versions and the db path; daemon refuses to open) is the
platform exemplar; `@lesto/migrate` must gain the same guard — today an older app boots a newer DB
silently (owner task below).

### 6. Release authority

Each repository owns its gate. Manifest v0 carries **no** authorization claims, and the schema
makes the severed claims unforgeable by construction: `signed` is `const false`,
`authorization.mergeReceipts` and `templateContractVersion` validate only as `null`. Signatures and
exact-SHA merge-authorization receipts enter only a later manifest v1, gated on (a) a signing
authority with custody and hosting, and (b) authenticated approval identity in the D6
authorization chain — the SHA-bound merge gate (`L-957b8149`) shipped 2026-07-17 and pins the
merged SHA, but receipts additionally require server-stamped approver identity + independence
(`L-090f5344`, open). A platform release is the manifest plus compatibility evidence; deployment remains separately
attended.

### 7. Rollback coordinates

The manifest records per-component rollback truthfully — closed enum `mechanism`
(`pointer-flip | none-roll-forward | undocumented-manual | appcast-repoint-unscripted | unknown`),
required `scripted` and `everExercised` booleans; guessing is unrepresentable. A
`--require-durable` consumer fails closed on any `durable: false`. "The manifest identifies a valid
compatible rollback set" is proven only by exercising it — a release gate, not assumed.

### 8. Manifest v0 — adopted, implemented, verified

An unsigned, deterministic local/CI artifact (`packages/platform-manifest/`): RFC 8785 canonical
JSON, sidecar SHA-256, deterministic timestamp (max committer date of the pinned HEADs), explicit
`unknowns[]` ledger (every `null` must be declared), facts read from pinned Git objects only —
never the working tree. Verification runs fixed phases with stable exit codes separating
environment (10), digest (4), canonicality (3), schema (2), internal inconsistency (7),
pinned-content tamper (6), and world drift (5) — forgery fails closed; staleness says regenerate.

### 9. Fail-loud behavior (best-effort skew rejected)

- **Compile time:** real-client contract tests over the byte-reproducible vendored spec slice;
  freshness checks that cannot go green silently — "couldn't verify" is a LOUD skip, never a false
  pass.
- **Connection time:** a readable contract-major mismatch blocks with the exact remediation banner
  (`ChatModel.swift:481`). An indeterminate probe currently fails open (shipped Roof behavior);
  whether a present manifest flips this to fail-closed is a named human decision — until decided,
  no component may silently tighten or loosen it.
- **Migration time:** downgrade refusal by error, on every store (rule 5).
- **Runtime:** forward-compatible decode on both WS sides (unknown type → typed `.unknown`,
  malformed known payload drops one message, stream survives); `compatStatus: "inconsistent"` in
  the manifest is loud, never papered over — consumers fail closed on it.

## Evidence reviewed (adjudication 2026-07-17)

All bounded probe results were consumed and the manifest evidence **re-verified live** during this
adjudication — not accepted from prose:

- Compatibility probe (`L-5d3de617`, `docs/platform/probes/compatibility.md`): seam inventory with
  file-level citations; spot-checks re-confirmed against source (`API_CONTRACT_VERSION`,
  `minServerVersion` + major-only compare, `SchemaDowngradeError`, producer/consumer `z.literal`
  pins).
- Manifest inventory + v0 spec (`release-manifest-inventory.md`, `release-manifest-v0.md`) and
  execution evidence (`release-manifest-v0-execution.md`, tasks `L-e62bf7c9`, `L-fed57518`,
  `L-2248304b`, closing the once-missing `L-40f386e3` stream).
- Live re-run (2026-07-17): preserved evidence bundle digest matches
  (`aa319413…5885`) and verifies with P1–P5 green, exiting 5 only on snackday's legitimate HEAD
  advance — staleness and forgery correctly discriminated; fresh two-run generation byte-identical
  (`cmp` silent) and verify exit 0; twelve-case tamper suite 12/12 exact expected failure classes;
  schema consts confirmed unforgeable.

## Evidence still owed — release gates, not acceptance blockers

These block the first supported platform release (D7), not this decision:

1. `previous/` + `incompatible/` fixture matrix with the negative control (the incompatible fixture
   must make the gate reject). `previous/` is definable only after Studio's first tagged release.
2. A Lesto application run against declared minimum and current framework versions — "minimum" is
   undefined under lockstep versioning until the support-window decision lands.
3. An exercised rollback proving the manifest identifies a valid compatible set.
4. First end-to-end runs of the never-exercised release jobs (`bump-tap`, `publish-version`).

## Rejected alternatives

- **Lockstep versions** — erases useful release independence across four repos with different
  cadences and toolchains.
- **Best-effort latest compatibility** — rejected outright: skew becomes an unpredictable runtime
  failure instead of a loud, attributable gate.
- **Status-quo edge fixes without a manifest** — leaves combination-testing unowned.
- **ADR as originally written (signed manifest + receipts now)** — a signature by an unaccountable
  key is theater; the RCA proved receipt-shaped records without a fail-closed ledger are post-hoc
  attribution. Blocked on 0006 packaging, 0008 identity, and D6.

## Consequences

- **Security:** severed claims are schema-unrepresentable, so a forged signature or receipt is
  schema-invalid, not merely suspicious; tamper vs staleness carry distinct exit codes so consumers
  can fail closed on forgery specifically. No credentials touch generation or verification.
- **Operability:** manifest generation tolerates degraded states truthfully (dirty trees, missing
  upstreams, zero releases) instead of refusing or lying — three of four current repos are
  non-durable and the manifest says so; it is architecture evidence, not a release candidate, until
  `durable: true` across the set.
- **Migration:** contract-major bumps carry migration guidance; DB downgrade refusal becomes a
  platform-wide invariant (Lesto guard pending); the additive-only `/v1` policy keeps old clients
  decoding new servers.

## Reversal triggers

- Two-plus Studio releases with no contract-major bump and no skew incidents → shrink to fixtures +
  health-contract block; shelve the manifest.
- ADR 0006 reverses to embedding Studio in Roof → negotiation collapses to build-time pinning.
- Spec-derived capabilities churn every release → revert to route-existence probing.
- A runtime decode failure against a manifest-declared-compatible set → the hashes-as-diagnostics
  stance is falsified; revisit gating.

## Recorded dissent (independent design review, 2026-07-17)

A post-acceptance review argued manifest v0 is over-built for a platform with zero releases
(canonicalization + seven failure classes + rollback taxonomy ahead of need) and that capability
negotiation should wait for its first concrete consumer (ship the `/v1/health` contract version
first, add `capabilities` with the first optional feature that needs one). The staged-core
acceptance stands — the tooling is built, verified, and contained in one package — but the
implementation tasks carry the staging note, and the reversal trigger ("two-plus releases, no
skew incidents → shrink to fixtures + health-contract") is the agreed off-ramp.

## Open named human decisions

1. Signing authority, key custody, and hosting (jointly with ADR 0008).
2. Fail-open vs fail-closed on an indeterminate version probe once a manifest consumer exists.
3. Support window (N−1 minor vs major) and deprecation clock.
4. Whether gate receipts live in this manifest or a separate release-evidence artifact.
5. Where the application-template contract version lives and who bumps it.
6. When Studio cuts its first tagged release (defines "previous").

## Implementation owners and blocking edges

Repository-owned tasks converted from this decision (tracked on the Studio board, parented to
`L-735d5b9e`):

- **studio** — `/v1/health` `contract` block + `hello.capabilities`, registrar-derived (subsumes
  the related CLI↔daemon handshake need in `L-5310972b`); fix the stale
  `V1_CONTRACT_STATEMENT` pointer (`apps/studio/ARCHITECTURE.md`).
- **crack** — `@lesto/migrate` downgrade/unknown-journal guard mirroring `SchemaDowngradeError`.
- **roof** — `previous/` + `incompatible/` fixture matrix with negative controls.
- **platform** — CI job producing the manifest artifact per release; manifest v1 schema gated on
  the D6 ledger and the signing decision.
