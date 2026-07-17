# Probe report — Cross-version compatibility: Roof ↔ Studio ↔ Lesto ↔ Lesto apps (Snackday)

Read-only probe complete (board L-5d3de617); nothing was mutated. Full report saved to `/Users/ryan/.claude/plans/you-are-a-chief-prancy-phoenix.md` (1,688 words). **TLDR: the Roof↔Studio seam is already the strongest-instrumented seam in the platform — a pinned OpenAPI slice with real-client contract tests, a major-version connect gate, forward-compat WS decode, and a fail-loud DB downgrade error. ADR 0007 is directionally right but over-scoped for a platform with zero released Studio artifacts; land its testable core now (fixture matrix, contract surface on `/v1/health`, spec-derived capabilities, an unsigned manifest generator) and defer signing, gate receipts, and the template contract version.**

## 1. Observed facts

**Version axes.** Studio deliberately has two: a product version (`0.1.0`; `--define STUDIO_VERSION` in the compiled binary, single-sourced in `api/src/version.ts`, which fixed the CLI-vs-daemon "two version schemes" bug L-c7086bbc) and a `/v1` contract version (`API_CONTRACT_VERSION = '1.0.0'`, `shared/src/contract-version.ts:6`) single-sourced into both OpenAPI `info.version` (`api/src/server.ts:254`) and the WS `hello.serverVersion` (`api/src/ws/index.ts:233`). The contract policy is codified: `V1_CONTRACT_STATEMENT` (`server.ts:37`) — `/v1` + the WS union are stable, additive-only, deprecate-before-remove; non-`/v1` is internal (expanded in studio `ARCHITECTURE.md` §5, though the statement's pointer `apps/studio/ARCHITECTURE.md` is a stale path). Roof pins `StudioClient.minServerVersion = "1.0.0"` with major-only comparison (`StudioClient.swift:36-49`). Lesto lockstep-publishes 49 packages via changesets with exact internal pins (workspace at 0.2.0; 0.1.5 was live on npm 2026-07-09); Snackday pins `^0.2.0` and its bun.lock resolves 0.2.0 exactly.

**Compile-time.** Roof's `OperatorServerContractTests` drives the _real_ `StudioClient` literals through a capturing URLProtocol and validates path/method/every body field against a byte-reproducible vendored slice of Studio's spec (15 routes, 37 schemas; `Tests/StudioKitTests/Fixtures/regen.py`). Roof-side drift fails CI immediately (`/Users/ryan/src/.github/workflows/ci.yml:52`); Studio-side drift is caught by `Scripts/check-fixture-freshness.sh`, which re-vendors from Studio's committed spec and, when Studio is unreachable, exits 0 with a LOUD "freshness UNVERIFIED" rather than a false green (ci.yml:62, best-effort). Fixture and spec are in sync today (both 1.0.0). Studio-internally, the spec is generated from the same route registrar the daemon serves (`gen-spec.ts` → `registerAllV1Routes`), CI gates spec/client drift (`bun run gen --check`, studio ci.yml:42), and `surface-parity.parity.test.ts` asserts CLI/MCP/API parity from the generated spec cross-checked against live zod. Lesto↔apps compatibility is types-at-install plus a type-regression suite (crack ADR 0026), `test:pack-boot` (packs all 49, boots a scaffold, catches lockfile mispins), and `assert-no-phantom-major`.

**Connection-time.** Roof probes `hello.serverVersion` (5s timeout): a readable major mismatch **blocks** with "incompatible studio daemon — server X, roof needs Y. Update studio (or roof)." (`ChatModel.swift:476-483`, FOUNDATION invariant 5); an indeterminate probe **fails open**. Informal capability probing already exists: `/v1/operator-readiness` is the operability gate (unknown keys deliberately ignored), with the `/v1/workflows` list as the documented "pack-only fallback for older daemons" (`regen.py:38`). `hello.bootId/seq` are optional for wire back-compat with pre-M1 daemons. Gap: `/v1/health` exposes only the _product_ version (`shared/src/health.ts:20`) — REST-only clients can't see contract compat.

**Migration-time.** Studio's SQLite store has a `MIGRATIONS` chain + `SCHEMA_VERSION` with invariant tests (`migrate.test.ts:148-165`); an older binary opening a newer DB throws `SchemaDowngradeError` naming both versions and the db path, and the daemon won't open (`db/index.ts:2938,2976`; tested at `migrate.test.ts:1466`) — the platform's fail-loud exemplar. Build skew (daemon lags source) is detected by `sourceFingerprint` (SHA-256 over path/size/mtime of loaded source roots, `build-fingerprint.ts`). By contrast, `@lesto/migrate` is forward-only with an applied-versions journal and **no downgrade guard** — an older app booting a newer DB proceeds silently. Roof has no on-disk store to migrate, and its Sparkle update pipeline is merged with zero releases cut.

**Runtime.** WS decode is forward-compatible on both sides: unknown type → `.unknown` (never a crash or stream teardown), known-but-unmodeled → `.other(raw)`, malformed known payload drops one message (`WSEvent.swift`, tested; mirrors studio `parseWsEvent` warn-not-drop, `event.ts:324-345`). REST reads are deliberate subset-decodes that ignore unknown keys (pinned by `StudioClientCompatTests`); a field _rename_ is a runtime decode failure — exactly the gap the read-route vendoring (L-da24cec9) closed at CI time, backstopped by the `roof-probe` live smokes. Studio→Lesto is an external-binary seam: `lesto deploy --json` folded into typed never-throw results, with a prose-parser fallback "for a lesto that predates the flag" (`lesto-deploy.ts:1-30`) but no version check of the binary (machinery mothballed per board). There are no direct Roof↔Lesto or app↔Studio seams (snackday ADR 0002, Accepted).

## 2. ADR 0007 evaluation

(`~/snackday/docs/adr/0007-platform-contracts-and-release-manifest.md`, Proposed today.) **Sound**: it names the two real axes — independent seam versioning plus a tested combination — and nearly every manifest field maps to a mechanism that already exists (contract constant, hashable committed spec, `SCHEMA_VERSION`, lockstep Lesto versions, typed outcomes); its fail-loud posture matches shipped precedent. **Gaps**: "signed" has no signing authority/custody/hosting defined; the "application-template contract version" exists nowhere today (create-lesto carries no marker) — a new invention; Studio has no released artifact or digest to pin (sequence behind ADR 0006); per-repo gate/merge receipts couple a compat manifest to release evidence and are separable; it's silent on whether a manifest flips Roof's fail-open indeterminate probe to fail-closed; and no component is named as the manifest's runtime enforcer.

## 3. Options

- **A — status quo + edge fixes** (no manifest): lesto downgrade guard, contract block on `/v1/health`, previous/incompatible fixtures. Cheapest; leaves combination-testing unowned.
- **B — ADR 0007 as written**: signed manifest including receipts, now. Blocked on packaging (0006), identity/signing (0008), and human decisions; heavy while Studio automation is release-blocked.
- **C — staged core-now**: land 0007's testable core, defer signing + receipts + template-contract-version.

## 4. Recommendation — Option C

1. **Fixtures** (roof `Tests/StudioKitTests/Fixtures/`): keep the current slice; add `previous/` (regen at the last released Studio tag — until a first release exists, the last manifest stands in) and `incompatible/` (synthetic `info.version: 2.0.0` + one renamed required field). Contract tests run current strictly, previous with a documented allowlist of capability-gated routes; the incompatible fixture must make the version gate _reject_ — a fixture set that can only pass proves nothing.
2. **Capability negotiation**: additive `capabilities: string[]` on `hello`, plus a `contract` block `{version, capabilities, openapiHash, wsUnionHash}` on `/v1/health` — derived from the route registrar/spec, never hand-listed. Roof keeps the major gate as the only hard block; capabilities replace route-existence probing, tolerating absence.
3. **Schema hashing**: canonical sorted-key SHA-256 of the committed `openapi.json` and of a generated JSON-schema dump of the `event.ts` union — for manifest pinning and connect diagnostics **only**, never a gate (additive changes legitimately change hashes).
4. **Fail-loud diagnostics**: mirror `SchemaDowngradeError`'s shape (both versions + path) in `@lesto/migrate` for unknown journal rows; Roof logs both contract hashes on connect and shows them in the incompatibility banner; every "couldn't verify" path adopts the freshness script's LOUD-skip-never-false-green posture.
5. **Manifest v0** (unsigned CI artifact): roof `VERSION` + `minServerVersion`; Studio contract + product versions, openapi sha256, `SCHEMA_VERSION`; Lesto workspace version + npm dist-tags; Snackday lock digest + gate command.

## 5. Risks

"Previous" is ill-defined until Studio cuts a first tagged release. Hash-as-gate temptation would brick older clients on every additive change. A hand-maintained capability list becomes a second drifting contract. The freshness check is best-effort, so Studio-side drift can persist on runners without a Studio checkout. Lockstep Lesto versioning makes "minimum supported framework version" a whole wave — the ADR's evidence item needs that defined. Flipping fail-open→fail-closed changes first-connect UX on slow daemons.

## 6. Falsification / reversal triggers

Two+ Studio releases with no contract-major bump and no skew incidents beyond build-skew ⇒ shrink to fixtures + health-contract, shelve the manifest. ADR 0006 reverses to embedding Studio in Roof ⇒ negotiation collapses to build-time pinning. The operator surface moves off `/v1` ⇒ re-anchor the vendored-slice mechanism first. Spec-derived capabilities churn every release ⇒ revert to route-existence probing (proven today).

## 7. Decisions requiring a human

Signing authority/custody/hosting (with ADR 0008); fail-open vs fail-closed on an indeterminate probe once a manifest exists; the support window (N−1 minor vs major) and deprecation clock; whether gate receipts live in this manifest or a separate release-evidence artifact; where the template contract version lives and who bumps it; when Studio cuts its first versioned artifact.

## 8. Acceptance tests

1. `swift test --filter OperatorServerContractTests` green; rename a fixture field in a scratch copy → red (negative control).
2. `ROOF_STUDIO_OPENAPI=… bash Scripts/check-fixture-freshness.sh` green today; doctored spec → non-zero.
3. Incompatible fixture → `testFixtureVersionIsCompatibleWithPinnedMinimum` red; a daemon with `API_CONTRACT_VERSION=2.0.0` → Roof blocks with the exact ChatModel status line.
4. Previous fixture regen'd at the prior Studio tag → green with documented allowlist.
5. Studio `bun run gen --check` clean; `migrate.test.ts` green including the SchemaDowngradeError case.
6. Crack `test:pack-boot` + `test:types`; Snackday `bun run gate` at locked 0.2.0, then re-gate in a scratch tree bumped to the latest wave (ADR's minimum+current evidence).
7. WS corpus replay {current, unknown-type, malformed-known} → typed / `.unknown` / single-drop, stream survives.
8. Manifest v0 generator runs on current checkouts; a validator against a tree with Lesto rolled back one wave flags the mismatch.

**Board tasks to file once mutations are permitted** (out of scope for this probe): studio — `/v1/health` lacks contract version + schema hash; studio — `V1_CONTRACT_STATEMENT` points at the stale path `apps/studio/ARCHITECTURE.md`; crack — `@lesto/migrate` has no downgrade/unknown-journal guard.
