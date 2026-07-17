# Chief Architect decision packet — platform assembly

- Decision window: 2026-07-16 through 2026-07-18
- Status: Ready for architecture review
- Product source: Lesto `docs/NORTH-STAR.md`
- Execution source: Studio live board
- Current proof application: Snackday

## Decision requested

Approve, amend, or reject the proposed platform assembly model:

> Keep Roof, Studio, Lesto, and applications in independently versioned repositories. Present one
> product through Roof, run one orchestration engine in Studio, build applications on published
> Lesto contracts, and ship a release manifest that declares a tested compatibility set. Begin
> with an unsigned local/CI v0; add signing only when its release authority exists.

The decision is not whether these products should integrate; the ratified north star already says
they should. The decision is how repository ownership, runtime assembly, distribution, identity,
version compatibility, and release authority compose into one supportable platform.

## Fable evidence and adjudication

- [Final Chief Architect adjudication](chief-architect-adjudication.md)
- [Consolidated human-decision sheet](human-decision-sheet.md) — one-sitting owner sign-off
  (ADRs 0005/0007/0008 adjudicated 2026-07-17; 0006 pre-staged)
- [Repository-topology probe](probes/repository-topology.md)
- [Packaging/runtime probe](probes/packaging-runtime.md)
- [Compatibility probe](probes/compatibility.md)
- [Identity/credentials probe](probes/identity-credentials.md)
- [Release-manifest inventory](probes/release-manifest-inventory.md)
- [Unsigned release-manifest v0 specification](probes/release-manifest-v0.md)
- [Release-manifest v0 execution evidence](probes/release-manifest-v0-execution.md)
- [Installer/lifecycle preflight](probes/lifecycle-preflight.md)

The release-manifest v0 implementation evidence is complete: generation is byte-reproducible, the
preserved unsigned artifact verifies cleanly, and all twelve negative controls return their exact
expected failure classes. Three of four pinned repositories are non-durable, so the manifest is
architecture evidence rather than a release candidate. Signing and authorization receipts remain
intentionally deferred until their authorities exist.
The lifecycle task `L-786014f7` also remains open: Roof builds with the full Xcode toolchain, but its
vendored Studio contract has drifted, and Studio's current worktree fails typechecking and one CLI
unit test. Those are explicit stop conditions, not waived evidence.

## Current facts

| Layer    | Repository          | Shipped or established responsibility                                                                                                |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Roof     | `~/src`             | Signed native macOS client; conversation, approvals, evidence, operated-app and deploy views over Studio `/v1` + WebSocket contracts |
| Studio   | `~/every-io/studio` | Local-first durable engine; tasks, workflows, worktrees, budgets, review evidence, approvals, typed outcomes, public API             |
| Lesto    | `~/crack`           | Published application framework; governed app MCP surfaces; Cloudflare adapters and deployment command                               |
| Snackday | `~/snackday`        | Real Lesto application and the first cross-product acceptance workload                                                               |

Roof's current direction is “one engine, one app”: Studio is the engine and hosted revenue
surface; Roof is the application and seat surface. The same Roof binary selects local, hosted, or
hybrid operation through its Studio base URL. Studio and Roof already have a versioned wire seam,
but compatibility and coordinated release policy are not formalized. Lesto packages are published,
but the supported application/platform version set is not declared in one place.

## Proposed assembly

```text
Customer
   │
   ▼
Roof.app ── Studio /v1 + WebSocket ──► Studio engine
                                            │
                                   Git/worktree/workflow contracts
                                            │
                                            ▼
                              Lesto application repository
                                            │
                               published @lesto/* + governed MCP
                                            │
                                            ▼
                                      Cloudflare
```

The customer experiences one platform, not one source tree. A release manifest binds the tested
versions and contract hashes of the participating artifacts.

## Decisions and recommendations

### D1 — Repository topology

Options:

1. Merge all products into a monorepo.
2. Keep independent product repositories with an optional coordination repository.
3. Keep the current repositories and store cross-product material in one product repository.

Recommendation: option 2. Repository boundaries match product authority and release cadence.
Cross-product contracts, compatibility manifests, demo definitions, and incident runbooks need a
small neutral coordination repository; it contains no product implementation. Before accepting the
ADR, name the owner of that repository, define which artifacts are canonical there, and document
how the current Snackday-hosted planning material migrates without becoming another source of
truth.

Evidence required: dependency/release inventory and one compatibility-manifest prototype.

### D2 — Customer-visible packaging

Options:

1. One macOS application containing an embedded Studio engine.
2. Roof and Studio installed separately and connected over localhost or a remote URL.
3. One installer that installs separately versioned Roof and Studio artifacts.

Recommendation: option 3 for the first supported distribution. Preserve Studio as an independently
operable engine while giving customers one installation and support flow. Treat embedding as a
future optimization only if lifecycle, licensing, and update evidence justify it. The installer may
assemble the products, but Roof and Studio remain separately versioned artifacts. Whether Roof may
launch Studio through a documented CLI is still a named lifecycle decision.

Evidence required: installer/lifecycle probe covering first launch, engine discovery, occupied
ports, update ordering, rollback, uninstall, and remote-profile selection.

### D3 — Local, hosted, and hybrid runtime

Recommendation: one Roof binary and one Studio API contract. Local points Roof at a loopback Studio
daemon; hosted points it at an authenticated remote Studio; hybrid uses the same contract with
local source/worktree execution and hosted coordination where explicitly supported. Do not fork
clients or orchestration semantics by topology.

Evidence required: connection-profile and token-rotation probe across local and remote fixtures.

### D4 — Contract and version compatibility

Options:

1. Lockstep versions across every repository.
2. Independent semantic versions with declared compatibility ranges.
3. Best-effort latest-version compatibility.

Recommendation: option 2. Version the Studio API and WebSocket event contract, Lesto packages and
app template contract independently. Stage the implementation: v0 is an unsigned, deterministic
local/CI artifact containing exact commits, contract facts, known unknowns, and rollback evidence.
Signing, template-contract claims, and SHA-bound merge-authorization receipts enter a later schema
only after their authoritative systems exist. Contract hashes are diagnostic seam evidence; they
do not substitute for compatibility tests. Fail loud when an unsupported pair connects, subject to
an explicit Chief Architect decision on the connection-time policy.

Evidence required: generated compatibility matrix and CI probe using current, previous, and
intentionally incompatible fixtures.

### D5 — Identity, credentials, and entitlements

Recommendation: keep identities separate by authority:

- Roof seat entitlement identifies the user and unlocks the client.
- Studio principal authorizes orchestration, approvals, budgets, and hosted access.
- Git provider identity authorizes repository operations.
- Cloudflare credentials authorize deployment and remain server-side.
- Application identity authorizes Snackday or another deployed product independently.

No token is silently reused across authorities. Roof stores only client/session material in the
Keychain and never receives repository or Cloudflare deployment credentials. Human and machine
approvers have distinct, server-stamped identities.

Evidence required: threat model and token-flow probe covering local, hosted, hybrid, rotation,
revocation, offline launch, and account/seat changes.

### D6 — Release and merge authority

Recommendation: product repositories release independently, while a platform release is the signed
manifest plus compatibility evidence. Each repository owns its gate. Studio may coordinate a
release but cannot authorize its own merge: exact-SHA merge authorization and independent GitHub
branch protection are mandatory. Deployment remains separately attended.

Evidence required: SHA-bound authorization (`L-957b8149`), branch protection, a coordinated release
dry run, and rollback of one component without corrupting the others.

### D7 — Platform definition of done

Recommendation: the first supported platform release must pass the golden path in ADR 0004, plus:

- install or connect Roof and Studio from clean state;
- reject an incompatible contract pair;
- complete exact-SHA independent review authorization;
- deploy the pinned application commit without exposing credentials;
- restore the task, decision, evidence, and deploy URL across restart;
- rollback one component using the release manifest.

## Three-day evidence plan

### Day 1 — freeze decisions and safety boundaries

- Chief Architect reviews ADRs 0001–0008 and records accept/amend/reject per decision.
- Complete the repository/artifact inventory and coordination-repository spike.
- Freeze the release-manifest and compatibility-matrix schemas before implementation.
- Keep fleet dispatch and merges paused until the current Studio release blockers are green.

### Day 2 — run independent probes

- Installer/lifecycle probe: Roof + Studio clean install, discovery, update, rollback, uninstall.
- Contract probe: current/previous/incompatible Studio API and Roof client combinations.
- Identity probe: local/hosted/hybrid token and entitlement flows.
- Release probe: produce a manifest for the current four-repository set and verify hashes/gates.

These probes may run in parallel because they produce evidence rather than shared runtime code.

### Day 3 — decide and convert

- Chief Architect adjudicates probe results and marks proposed ADRs accepted, amended, or rejected.
- Convert accepted decisions into repository-owned implementation tasks with explicit dependencies.
- Run a paper/dry-run assembly from clean install through rollback.
- Preserve unknowns as named blockers; do not turn missing evidence into approval.

## Studio board

- Chief Architect decision: `L-710ba74e`
- Repository topology ADR: `L-76601e17`; inventory spike: `L-9d682737`
- Packaging/runtime ADR: `L-723fe37e`; installer/lifecycle probe: `L-786014f7`
- Contracts/release ADR: `L-735d5b9e`; compatibility probe: `L-5d3de617`; manifest probe:
  `L-40f386e3`
- Identity/credentials ADR: `L-9f36cd26`; threat-model probe: `L-084f70a1`

The four ADR tasks block the final Chief Architect decision. Each ADR is blocked only by the probe
that supplies its missing evidence, allowing all five probes to run in parallel.

## Decision record template

For each ADR, record:

- decision and status;
- deciding actor and timestamp;
- evidence reviewed;
- alternatives rejected and why;
- security, operability, and migration consequences;
- reversal trigger;
- implementation owners and blocking edges.

## Known blockers

- Studio's five verified shutdown/evidence/redaction defects.
- Missing SHA-bound merge authorization (`L-957b8149`) and GitHub branch protection.
- Repository identity drift affecting review ingestion.
- No neutral coordination repository. (Manifest v0 is now implemented, exercised, and
  re-verified — see ADR 0007, Accepted 2026-07-17.)
- Compatibility policy across Roof, Studio, Lesto, and application templates is now decided in
  ADR 0007; its staged-core implementation tasks remain open.
- Cloudflare credentials and live deployment remain attended human prerequisites.
- Roof's vendored Studio OpenAPI contract is stale against Studio HEAD.
- Studio's current shared worktree fails typechecking and one CLI unit test, preventing the
  lifecycle restart/rotation/rollback drill.
