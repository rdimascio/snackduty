# 0006 — Platform packaging and runtime topology

- Status: Accepted (amended) — one installer/support channel with separately versioned Roof and
  Studio artifacts, no embedding; four amendments; launch semantics pending one named human
  decision
- Date: proposed 2026-07-16; adjudicated 2026-07-17
- Decider: Chief Architect (adjudication task `L-723fe37e`, under platform decision `L-710ba74e`)

## Context

Roof is the customer-visible macOS client and Studio is an independently useful local or hosted
engine. Roof already selects a Studio endpoint through its transport base URL. Customers still
need one coherent installation, update, rollback, and support experience. The packaging probe
found the proposal's invariants largely already implemented in code; the open questions are the
join, not the parts.

## Decision

Ship **one installer and support channel containing separately versioned Roof and Studio
artifacts**. The same Roof binary supports local, hosted, and hybrid topology through the
versioned Studio contract (ADR 0007). Do not embed or fork Studio inside Roof for the first
supported release. Four amendments bind the proposal:

### 1. Launch semantics (wording corrected; direction pending human decision D1)

The proposed "Roof discovers or launches the local Studio daemon" contradicted Roof's shipped
invariant ("the roof is a pure client: it never launches or manages the daemon,"
`StudioTransport.swift:8-10`). The accepted wording: Roof **discovers, or launches via the Studio
CLI's own launcher — never by spawning the daemon process directly**. All
singleton/orphan-reap/port-pinning/token-persistence logic lives in `bin/cli.ts`; a second spawner
would fork that brain. Whether Roof instead stays strictly pure-client (installer owns first
launch) is decision-sheet item **D1** — until signed, Roof's shipped pure-client behavior stands.

### 2. Update ordering + version endpoint

The daemon never self-restarts; the 24h update check is advisory only. `studio upgrade` stops the
daemon explicitly, and Roof must survive that — **proven live**: restart reuses the port, the
token persists byte-identical, and the client re-reads state (Lane A step 10). Roof updates
independently behind the contract-major gate. The missing primitive — pre-connect skew is
diagnosable only after a WS connect — is owned by the ADR 0007 `/v1/health` contract block
(`L-4c64c89d`), which subsumes the unauthenticated REST version endpoint this amendment requires.

### 3. Uninstall must exist before the first supported release

The proposed invariant "uninstall … explicitly handles the daemon, database, worktrees, and
credentials" names code that exists on neither side (verified: no uninstall verb anywhere; the
leftover inventory spans `~/.studio/*`, worktrees, installed git hooks, Roof Keychain items).
Owned by `L-bff067c3`; the Lane B throwaway-account teardown diff is the spec input (AT7).

### 4. Rollback is a documented operator procedure, not an automatic property

Roof's appcast is append-only and Sparkle won't downgrade; Studio downgrade is confirm-gated
(`--yes`) with `.bak-v<n>` restore as the remedy. The drill is **proven live**: an older-schema
binary refused a `user_version=9999` DB (daemon never became healthy), and restoring the snapshot
booted clean (Lane A step 12). The ADR states rollback as that procedure.

## Evidence reviewed (adjudication 2026-07-17)

- Packaging/runtime probe (`docs/platform/probes/packaging-runtime.md`): fail-loud invariants
  verified in code — no silent remote→local fallback on either side; durable work survives Roof
  quit by construction (server-side brain, `bootId` adopt-or-reap); `SchemaDowngradeError`;
  foreign port holder surfaced, never hopped.
- Lifecycle preflight **executed** (`probes/lifecycle-preflight-execution.md`, `L-786014f7`):
  Lane A green across all 12 steps on live substrate — occupied-port bail naming the foreign pid,
  pidfile contract, wire proof, restart persistence, rotation refusal, downgrade/rollback drill.
  The three stop conditions the packet named (Studio typecheck, the failing CLI unit test, Roof's
  vendored-contract drift) were re-verified **cleared** at origin/main `a443abef` — the drift was
  real and the freshness gate caught it live (re-vendored at roof `c8c7126`, 26/26 contract
  tests).
- Delta since the probe: the Sparkle auto-update task (`L-e4fe5c6b`) was **canceled** — the
  missing updater runtime is an open gap needing resequencing, not in-flight work. Roof cannot
  push update #2 until an updater ships; the appcast pipeline exists unattached.

## Rejected alternatives

- **Embed Studio inside Roof.app** — forks the daemon singleton against CLI/TUI users, couples
  Sparkle updates to a daemon that must never silently restart mid-work, duplicates a finished
  self-updater, forces notarizing the studio binary, abandons Linux/headless/remote parity.
- **Two fully separate installs** — the customer assembles the platform themselves; support faces
  an unbounded version matrix; nothing owns "first launch, no daemon."

## Consequences

- **Operability:** both release pipelines are preserved as-built; the installer adds only the
  join. Costs named: the joined flow inherits Gatekeeper questions (studio binaries are ad-hoc
  signed); `bump-tap`/`publish-version` have never run end-to-end (half-open failure mode);
  port 4983 with a foreign holder is a hard stop by design — a guaranteed support topic.
- **Security:** the shipped binary embeds its workflow bundle, so customers never pay the
  ~23s cold-bundle boot cost (a dev-checkout-only characteristic; Lane A finding 1) — keep this
  property through any packaging change. Cosign verification in `studio upgrade` currently
  warns-and-continues; making it mandatory is decision-sheet item D2.
- **Migration:** none for existing installs; the installer is additive.

## Reversal triggers

- Gatekeeper breaks the Roof-driven Studio install in ways only Developer-ID-signing Studio fixes
  → revisit signing scope; if unfixable, embedding pressure returns.
- A minor Studio release breaks Roof despite the major-only gate → pull the ADR 0007 manifest
  forward and pair-pin versions.
- CLI-launched and Roof-launched daemons fight in the field → retreat to strict pure-client Roof.
- An emergency where the append-only appcast blocks remediation → amend the immutable-feed policy.

## Open named human decisions (decision-sheet cluster D)

1. **D1** — pure-client Roof vs launch-via-Studio-CLI (amendment 1).
2. **D2** — cosign verification mandatory in `studio upgrade`.
3. **D3** — Apple one-timers (Developer ID, notary, Sparkle keys; whether Studio also gets
   Developer ID for the joined flow).
4. **D4** — per-channel version-matrix policy; remote "software factory" profile at v1 or later.

## Release gates (not acceptance blockers)

Lane B of the lifecycle probe, human-gated: real-account pidfile discovery + quit/relaunch (AT1),
an updater runtime (Sparkle work canceled — needs a new owner/sequence), `release.sh` beyond
`--check` (Apple credentials), live `studio upgrade` + uninstall inventory (AT7 → `L-bff067c3`),
Gatekeeper on the joined flow, and the two never-exercised release jobs.
