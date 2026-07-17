All source material is read: the decision packet, ADRs 0005–0008 (plus 0004 and the index for cross-reference), the four completed probe reports (repository-topology, packaging-runtime, compatibility, identity-credentials — the release-manifest probe report is absent, consistent with the ECONNRESET failure), the north star, and the red-team gate-bypass RCA. The Write tool is not available in this session, so the memo is delivered inline below.

---

# Chief Architect decision memo — platform assembly adjudication

**Decision:** `L-710ba74e` · **Date:** 2026-07-16 · **Deciding actor:** Chief Architect (final adjudicator) · **Mode:** read-only; Studio automation and merges treated as fail-closed throughout.

## Evidence base and one governing correction

Four of five probes completed and are admitted as evidence: repository topology (`L-9d682737`), packaging/runtime (`L-786014f7`), compatibility (`L-5d3de617`), identity/credentials (`L-084f70a1`). The **release-manifest probe (`L-40f386e3`) produced no result** — one ECONNRESET failure, bounded retry empty. Per ADR 0004's failure rule ("missing evidence cannot satisfy acceptance") and the packet's Day-3 instruction ("do not turn missing evidence into approval"), that evidence is **missing, not green**. Every conclusion below that depends on manifest generation, hash verification, or rollback-set identification is marked unproven.

The governing correction: the red-team RCA (`studio/docs/rca/2026-07-16-red-team-gate-bypass.md`, P0, confirmed) establishes that Studio's review subsystem was advisory, not authorizing — PR #7 merged with zero reviews and failing `build`/`game-smoke` checks; three fixes landed on `main` with no review lineage at all. This is not merely a D6 blocker. It falsifies any reading of ADRs 0007/0008 in which Studio-stamped receipts or actor fields are treated as authorization evidence today. The RCA's fail-closed merge-authorization ledger is therefore elevated from "evidence required" to a **hard prerequisite** threaded through 0007 and 0008 below.

---

## ADR 0005 — Platform repository topology: **AMEND, then accept**

**Decision.** Independent product repositories plus a small neutral coordination repository (packet D1, option 2) is confirmed. Accept with three exact amendments from the topology probe:

1. **Ownership clause.** The coordination repo is created under a clean, non-employer, non-personal org (human choice below), private initially, plain-docs license. Its merge authority is the Chief Architect decision process, not any product team. It must not live under `every-io` and must not be blocked on Studio's provenance/title gate — the manifest must be able to name (or exclude) the Studio artifact without inheriting Studio's provenance risk.
2. **Canonicality clause.** The repo stores accepted cross-product ADRs, the release manifest (versions + content hashes + supported ranges + migration/rollback coordinates), runbooks, demo definitions, and evidence indexes — **never canonical schemas or code**. Product repos remain canonical for their seams (Studio: `api/openapi.json` + WS union; Lesto: deploy-verdict schema + package semver). Consumers keep the proven vendored-slice + freshness-gate pattern (`Fixtures/regen.py`, `Scripts/check-fixture-freshness.sh`). "No product build imports the coordination repository at runtime" becomes true by construction.
3. **Migration clause.** Commit Snackday's untracked `docs/adr/` and `docs/platform/` **immediately** and give Snackday a private remote; relocate ADRs 0005–0008 and the packet to the coordination repo at creation, leaving 0001–0004 in Snackday with pointers.

**Evidence.** Probe §1: complete four-repo inventory; strictly one-way dependency graph (Roof→Studio vendored OpenAPI slice; Studio→Lesto external-binary zod-parsed verdict; Snackday→Lesto genuine from-npm `^0.2.0`); zero observed changes that required atomic cross-repo landing — the versioned seams already absorb coupling.

**Contradiction on record.** The platform's constitutional documents (ADRs 0005–0008, the packet) are untracked files in a repo with no remote — the weakest durability in the estate, while the packet itself lists "no neutral coordination repository" as a blocker. Also: Roof `main` is 12 commits ahead unpushed, Studio 2 ahead; the manifest's "current commits" are one disk failure from unreproducible.

**Rejected alternatives.** Monorepo — four toolchains, four release mechanisms, and four license postures (MIT public / Apache pending provenance / proprietary-unlicensed / UNLICENSED) would entangle; Studio's provenance gate would then block everything, and the "Snackday consumes Lesto from real npm" dogfood proof would be erased. Status quo — currently failing (see contradiction). Anointing Lesto or Studio as host — grants one product improper authority over the others' contracts.

**Human decisions.** (a) Org, name, visibility, and license of the coordination repo (interacts with `L-7455a0fb` — "Studio" is a provisional name; don't bake it into a public repo). (b) Roof licensing posture and third-party notices — a distribution pipeline exists with no EULA/LICENSE. (c) Studio provenance Gate-1 sign-off.

**Reversal triggers.** Monorepo: ≥3 same-day paired landings across ≥2 repos in any rolling month despite the seams. Fold-back: the coordination repo acquires runtime-imported code, a package with dependents, or a second task board. Contract-drift: a runtime decode failure against a manifest-declared-compatible set falsifies "hashes/pointers only."

**Prerequisites.** Commit/push the untracked docs and unpushed branches (hour-0 items below); coordination repo creation waits only on the org/name decision; the manifest content it will host remains **unproven** until `L-40f386e3` re-runs.

---

## ADR 0006 — Packaging and runtime topology: **AMEND, then accept**

**Decision.** One installer and support channel with separately versioned Roof and Studio artifacts, no embedding (packet D2 option 3, D3 one-binary/one-contract) is confirmed — the probe found the invariants largely already implemented. Accept with four exact amendments:

1. **Launch semantics.** Replace "discovers or launches the local Studio daemon" with "discovers, or launches **via the Studio CLI's own launcher — never by spawning the daemon process directly**." All singleton/orphan-reap/port-pinning/token-persistence logic lives in `bin/cli.ts`; a second spawner forks that brain. This resolves the ADR's direct contradiction with Roof's shipped invariant ("the roof is a pure client: it never launches or manages the daemon," `StudioTransport.swift:8-10`) — but which side wins is a named human decision, since either way a standing FOUNDATION invariant or the ADR text changes.
2. **Update-ordering rule + version endpoint.** State explicitly: the daemon never self-restarts; `studio upgrade` stops it and Roof must survive (already true — persistent token, port reuse). Add an **unauthenticated REST version/contract endpoint** — today skew is diagnosable only after a WS connect.
3. **Uninstall clause.** The invariant "uninstall … explicitly handles the daemon, database, worktrees, and credentials" names code that does not exist on either side. Require an uninstall spec derived from the lifecycle probe's measured leftover inventory before the first supported release.
4. **Rollback restated as procedure.** Roof's appcast is append-only and Sparkle won't downgrade; Studio downgrade is confirm-gated with `.bak-v<n>` restore. The ADR must say rollback is a documented operator procedure, not an automatic property.

**Evidence.** Probe: fail-loud invariants verified in code — no silent remote→local fallback on either side (`StudioTransport.swift:75-83`, `pidfile.ts:43-59`); durable work survives Roof quit by construction (server-side brain, `bootId` adopt-or-reap); `SchemaDowngradeError` refuses older-binary/newer-DB; foreign port holder surfaced, never hopped.

**Contradictions.** "Discovers or launches" vs. pure-client (above). HOME divergence: Roof resolves `~` via getpwuid, Studio via `$HOME` — isolated-HOME rigs see different `~/.studio`. Both release pipelines are complete but **zero releases have ever been cut**, and `bump-tap`/`publish-version` have never run end-to-end (half-open failure mode).

**Rejected alternatives.** Embedding Studio in Roof.app — forks the daemon singleton against CLI users, couples Sparkle updates to a daemon that must never silently restart, duplicates a finished self-updater, abandons Linux/headless/remote parity. Two fully separate installs — customer assembles the platform themselves; nothing owns "first launch, no daemon."

**Human decisions.** Pure-client vs. launch-via-CLI (amendment 1); Apple one-timers (Developer ID, notary, Sparkle keys) and whether Studio also gets Developer ID for the joined flow; make cosign verification in `studio upgrade` mandatory (currently warns-and-continues — checksum without provenance); per-channel version-matrix policy; whether the remote "software factory" profile ships to all at v1.

**Reversal triggers.** Gatekeeper breaks the Roof-driven Studio install in ways only Developer-ID-signing Studio fixes → revisit signing scope; if unfixable, embedding pressure returns. A minor Studio release breaks Roof despite the major-only gate → pull the manifest forward and pair-pin. CLI-launched and Roof-launched daemons fight in the field → retreat to strict pure-client.

**Prerequisites.** The **clean-machine lifecycle probe has not been run** — the report designed it (throwaway macOS user account, 8 steps) but executed nothing; the ADR's evidence-required item is unproven and is scheduled in the 72-hour plan. Coordinate with in-flight Sparkle work (`L-e4fe5c6b`, In Progress) — do not race it.

---

## ADR 0007 — Contracts and release manifest: **AMEND: accept the core, sever and defer the release-authority clauses**

**Decision.** Independent seam versioning with a declared, tested compatibility set (packet D4 option 2) is confirmed — the compatibility probe shows nearly every manifest field maps to an existing mechanism (`API_CONTRACT_VERSION`, generated committed spec, `SCHEMA_VERSION`, lockstep Lesto versions). But the ADR as written is over-scoped for a platform with zero released artifacts, and the RCA plus the missing manifest probe force a split. Exact amendments:

1. **Adopt the staged core now:** (a) fixture matrix — keep the current vendored slice, add `previous/` (regen at last released Studio tag; until one exists, the last manifest stands in) and `incompatible/` (synthetic `info.version: 2.0.0` + one renamed required field), with the negative control that the incompatible fixture must make the gate _reject_; (b) capability negotiation — additive `capabilities: string[]` on WS `hello` plus a `contract` block `{version, capabilities, openapiHash, wsUnionHash}` on `/v1/health`, derived from the route registrar, never hand-listed; (c) schema hashes as **diagnostics only, never a gate** (additive changes legitimately change hashes); (d) fail-loud parity — mirror `SchemaDowngradeError` in `@lesto/migrate` (currently no downgrade guard: an older app boots a newer DB silently); (e) **manifest v0 as an unsigned CI artifact**.
2. **Sever and defer:** "signed" (no signing authority, custody, or hosting exists; a signature by an unaccountable key is theater — sequence after D6/D8); "per-repository gate and exact-SHA merge authorization receipts" (the RCA proves the receipts this clause would embed do not exist and that receipt-shaped records — `winning_attempt` — were post-hoc attribution, not authorization; receipts may only enter the manifest once emitted by the fail-closed authorization ledger); "application-template contract version" (exists nowhere — `create-lesto` carries no marker; invent it deliberately, with an owner, later).
3. **Resolve the fail-open gap:** the ADR must state whether an indeterminate version probe fails open (today's Roof behavior) or closed once a manifest exists, and name the manifest's runtime enforcer. Human decision below.

**Evidence.** Compatibility probe: the Roof↔Studio seam is the strongest-instrumented in the platform (real-client contract tests over a byte-reproducible slice, major-only connect gate, forward-compatible WS decode on both sides, fail-loud DB downgrade). **Contradiction/missing:** the release-manifest probe evidence is absent — manifest generation, byte-reproducibility, hash verification, and "rollback identifies a valid compatible set" (ADR evidence items 1 and 4) are all **unproven**. Minor: `V1_CONTRACT_STATEMENT` points at a stale path (`apps/studio/ARCHITECTURE.md`).

**Rejected alternatives.** Lockstep versions — erases useful independence (packet D4 option 1). Best-effort latest — fails unpredictably (option 3). Status-quo edge fixes without a manifest — leaves combination-testing unowned. ADR as written now — blocked on 0006 packaging, 0008 signing identity, and nonexistent receipts.

**Human decisions.** Signing authority/custody/hosting (with 0008); fail-open vs. fail-closed on indeterminate probe; support window (N−1 minor vs. major) and deprecation clock; whether gate receipts live in this manifest or a separate release-evidence artifact; where the template contract version lives; when Studio cuts its first tagged release.

**Reversal triggers.** Two-plus Studio releases with no contract-major bump and no skew incidents → shrink to fixtures + health-contract, shelve the manifest. 0006 reverses to embedding → negotiation collapses to build-time pinning. Spec-derived capabilities churn every release → revert to route-existence probing.

**Prerequisites.** **Re-run `L-40f386e3`** — nothing manifest-shaped is accepted until it produces a reproducible generator run and hash verification. First Studio tagged release (defines "previous"). D6 ledger before any receipt or signature enters the manifest.

---

## ADR 0008 — Identity, entitlements, credentials: **AMEND, then accept — with one clause hardened by the RCA**

**Decision.** Separate principals per authority (packet D5) is confirmed; the probe found **credential separation already well realized** (scrubbed agent env allowlist, server-side-only Cloudflare/GitHub credentials with `CLOUDFLARE_API_KEY` refused, Roof Keychain holding exactly `{studioURL, studioToken}`, separate Polar entitlement). The genuine divergence is **identity/attribution**, and the RCA converts it from a pilot caveat into a gating condition. Exact amendments:

1. **Known-divergences appendix** (probe Option B), enumerating with owners/IDs: `resolvedBy`/`approvedBy` are client-asserted free text defaulting to `'user'` (`workflows.ts:326,499`; `tasks.ts:995`); osxkeychain can persist a forwarded short-lived GitHub token into the dev's real keychain, and SSH remotes silently get no credential (`L-bd770677`); agents can file-read provider keys from `~/.studio/settings.local.json` until OS sandboxing (`L-3198d018`); Roof tool-result previews (4000-char stdout snapshots) bypass `redactSecrets`.
2. **Hardened clause (RCA-driven):** authenticated, server-stamped approval identity with implementer-independence lineage (probe Option C) is a **prerequisite of the D6 merge-authorization ledger**, not merely of "leaving pilot." The RCA's corrective ledger must persist reviewer identity and independence; a ledger fed by spoofable actor strings cannot satisfy its own verification requirement that "the implementer's own run cannot satisfy the independent-review requirement." Until then, ADR text must state the load-bearing assumption explicitly: actor fields are advisory, and every consequential approval is human-gated (ADR 0003's standing rule).
3. **Redaction clause:** extend "never enter … notification previews" to explicitly cover Roof transcript/tool-result previews, closing the named gap.

**Evidence.** Identity probe facts 1–5 with file-level citations; ADR 0003 (Accepted) verified implemented in `buildDeployEnv` + `deploy.test.ts`. **Contradiction:** the ADR says "Studio stamps authoritative actors" — present tense; the implementation stamps whatever the client asserts. The RCA shows why that distinction is not academic.

**Rejected alternatives.** Ratify as-is (Option A) — leaves the attribution gap unnamed while the RCA is open; unacceptable. Block everything on Option C now — over-rotation: credential containment is sound, and the human-gate assumption holds while automation is paused.

**Human decisions.** Is client-asserted approval identity acceptable for the attended pilot (if no, C blocks launch, not just merges)? Seat-loss/device-loss/mid-turn rotation policy (rotated token 401s kill in-flight turns without resume). Reviewer-independence enforcement (approver ≠ author is enforced nowhere). Accept or fix osxkeychain residue pre-pilot. Real Polar org id (placeholder in `license.ts`).

**Reversal triggers.** Any caller trusting `resolvedBy`/`approvedBy` for a non-human-gated decision → C becomes blocking immediately. Any provider key found in db, task message, Sentry, or a Roof preview → containment falsified; escalate as incident. `SecretKey` growing beyond two fields, or agent env leaking any `*_TOKEN`/`STUDIO_*` beyond the named exceptions → regression, fail the gate.

**Prerequisites.** Threat-model evidence is in hand (this probe). Option-C implementation and preview redaction are implementation tasks sequenced with the D6 ledger.

---

## 72-hour plan (fail-closed throughout)

**Standing rule for all 72 hours:** Studio-driven merges, fleet dispatch, and automated review authorization stay **paused**. Anything that must land does so via attended PR with independent _human_ review, green GitHub checks, and exact-SHA confirmation — Studio's own gate is not trusted until the RCA verification requirements pass. All probes below are read-only or isolated (throwaway accounts, scratch branches, CI-only), so they parallelize safely.

**Hours 0–8 — durability and adjudication record (serial, cheap, urgent).**

1. Commit and push Snackday `docs/adr/` + `docs/platform/`; create Snackday's private remote. Push Roof (ahead 12) and Studio (ahead 2). (Removes the single-disk-failure risk under every decision above.)
2. Record this adjudication on `L-710ba74e` and the four ADR tasks (attended board edits only); reconcile the packet's ten listed task IDs against the live board so "each ADR blocked only by its probe" is actually wired.
3. Enable GitHub branch protection on `rdimascio/studio` and `rdimascio/roof` (required checks, required review, no direct pushes) — the RCA's independent second layer; this is fail-closed by construction.
4. Re-dispatch the **release-manifest probe (`L-40f386e3`)** attended. It is the only missing evidence stream and the long pole for 0007.

**Hours 8–48 — four parallel lanes (independent evidence, no shared runtime code).**

- **Lane A (lifecycle):** run the clean-machine lifecycle probe in a throwaway macOS user account per the packaging report's 8-step script — install, discovery, durable-turn-survives-Roof-quit, occupied port, stop/upgrade recovery, remote rotation, downgrade refusal, leftover inventory (which _is_ the uninstall spec input). Coordinate with, don't race, `L-e4fe5c6b`.
- **Lane B (contracts):** on scratch branches, build the `previous/` and `incompatible/` fixtures with negative controls; prototype the `/v1/health` contract block and `hello.capabilities`; draft the `@lesto/migrate` downgrade guard. CI-only; nothing merges without attended review.
- **Lane C (identity/authority):** write the merge-authorization ledger **design spec** (`L-957b8149`) satisfying every RCA verification requirement, including authenticated reviewer identity and independence lineage (the 0008 hardened clause); land the probe's six read-only acceptance tests (actor-honesty, env-scrub, deploy-boundary, redaction, preview-leak, keychain-surface) as documenting tests. Fix repository-identity drift (`local/studio`) via attended PR — it is an RCA contributing factor and blocks review ingestion.
- **Lane D (coordination):** draft the coordination-repo charter embodying the 0005 amendments; assemble the consolidated human-decision sheet (org/name; Roof license; pure-client vs. CLI-launch; cosign mandatory; signing authority; fail-open/closed; support window; Polar org id) for owner sign-off in one sitting. When the Lane-0 manifest probe returns, verify the v0 generator is byte-reproducible and its hashes recompute from pinned commits.

**Hours 48–72 — converge.**

- Adjudicate Lane A and the manifest-probe results; flip ADRs 0005/0006/0008 from Proposed to Accepted-as-amended; 0007's core likewise **only if** the manifest probe is green — otherwise its manifest clause stays open as a named blocker, per the failure rule.
- Paper dry-run assembly (packet Day 3): clean install → incompatible-pair rejection → exact-SHA authorization walkthrough → pinned deploy → restart legibility → manifest-guided rollback, against ADR 0004's golden path and D7's definition of done.
- Convert accepted decisions into repository-owned implementation tasks with explicit dependency edges (attended).
- **Explicit non-goal:** do not unpause Studio automation or Studio-driven merges inside this window. Unpausing requires, later: the five verified defects fixed with independent review, the authorization ledger live and passing the RCA's seven verification requirements, branch protection confirmed, and repo-identity resolution fail-closed.

## Decided vs. unproven

**Decided (evidence in hand):** independent repos + neutral coordination repo with ownership/canonicality/migration amendments; one installer with separately versioned artifacts, no embedding, launch-via-CLI-only pending one human call; independent seam versioning, fixture matrix, capability negotiation, hashes-as-diagnostics; principal separation as implemented; merges and automation remain fail-closed pending the RCA corrective ledger.

**Unproven (named blockers, not approvals):** everything manifest-shaped — generation, reproducibility, hash verification, rollback-set identification (`L-40f386e3` missing); the clean-machine lifecycle path end-to-end (probe designed, not executed); uninstall (no code exists); manifest signing (no authority exists); template contract version (doesn't exist); authenticated approval identity and reviewer independence (client-asserted today); both never-exercised release jobs (`bump-tap`, `publish-version`); Studio's first tagged release, which alone defines "previous" for compatibility testing.

_(≈2,750 words.)_
