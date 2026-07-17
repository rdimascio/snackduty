I've read the probe inventory, ADR 0007, and the adjudication. Note on mechanics: this session has no Write tool (nor ExitPlanMode/AskUserQuestion), so — like the Chief Architect memo — the deliverable is inline below. Everything is derived from the probe's local facts; nothing below claims signing or merge authorization exists.

---

# platform-manifest-v0 — unsigned specification

Scope per adjudication L-710ba74e: manifest v0 is an **unsigned CI/local artifact**; signing and merge-authorization receipts are severed; hashes are diagnostics for seams but load-bearing for the manifest's own integrity. v0 is machine-scoped (absolute paths permitted) because two of four HEADs exist only on this machine.

## 1. Schema shape

Draft 2020-12, `additionalProperties: false` everywhere. `?` = nullable (must be present, may be `null`; every `null` requires a matching `unknowns[]` entry).

```jsonc
{
  "schema": "platform-manifest/v0", // const, required
  "signed": false, // const false — schema rejects true
  "generatedAt": "…Z", // required, deterministic (see §2)
  "generator": { "tool": "", "version": "" }, // required
  "authorization": {
    // required, all-const
    "mergeReceipts": null, // const null in v0
    "reason": "NO_AUTHORIZATION_LEDGER", // const — RCA: receipts do not exist
  },
  "repos": [
    {
      // required, sorted by name, all 4 present
      "name": "",
      "path": "", // required
      "head": "40-lower-hex", // required, ^[0-9a-f]{40}$
      "branch": "", // required
      "remote": "url?", // null ⇒ snackday case
      "upstream": { "configured": true, "ahead": 0, "behind": 0 } /*?*/,
      "dirty": { "clean": true, "fileCount": 0 }, // required
      "durable": false, // required: upstream configured ∧ ahead==0 ∧ clean
      "latestTag": "string?", // null ⇒ studio, roof
      "tagsAuthoritative": false, // required (crack tags stale ⇒ false)
      "releasePipeline": "enum", // tag-push | dispatch-only | none
      "gateCommand": "", // required
      "gateEnforcedInCI": false, // required (snackday ⇒ false)
    },
  ],
  "contracts": {
    // required — every value HEAD-committed
    "studio": {
      "apiContractVersion": "1.0.0", // required
      "openapiSha256": "hex64", // required — sha256 of `git show <head>:api/openapi.json`
      "wsEventSchemaSha256": "hex64", // required — shared/src/event.ts at <head>
      "dbSchemaVersion": 71, // required int
      "hashRole": "diagnostic", // const — never a compatibility gate
    },
    "lesto": {
      "deployJsonSchemaVersion": 1, // required — producer, run.ts
      "studioConsumerPinnedVersion": 1, // required — consumer, lesto-deploy.ts z.literal
      "compatStatus": "consistent", // required enum: consistent | inconsistent
      "npmSurfaceVersion": "0.2.0?", // nullable — remote truth, unverified locally
      "scaffoldDepRange": "^0.2.0", // required — scaffold.ts:52
      "packageCount": 49 /*?*/,
    },
    "templateContractVersion": null, // const null — does not exist (severed)
  },
  "releases": {
    // required; each component nullable
    "studio": null,
    "roof": null,
    "lesto": { "channel": "npm", "version": "0.2.0", "locallyVerified": false },
    "reasonForNulls": "NO_TAGGED_RELEASE_EVER_CUT",
  },
  "rollback": [
    {
      // required, one per component
      "component": "",
      "mechanism": "pointer-flip | none-roll-forward | undocumented-manual | appcast-repoint-unscripted | unknown",
      "scripted": false,
      "everExercised": false,
    },
  ],
  "apps": [
    {
      "name": "snackday-web",
      "lestoDepRange": "^0.2.0",
      "wranglerConfig": "apps/web/wrangler.jsonc",
      "deployedVersion": null,
      "migrationVersions": null,
    },
  ],
  "unknowns": [{ "field": "json-pointer", "reason": "CODE" }], // required, sorted by field
}
```

Required means locally derivable read-only from a pinned SHA. Nullable is reserved for remote/runtime truth (npm-live, deployed worker versions, daemon version) and nonexistent facts (tags, releases, receipts, template contract, snackday migrations). The schema makes the three severed clauses **unforgeable by construction**: `signed`, `authorization.*`, and `templateContractVersion` are `const`, so a manifest claiming a signature or a receipt is schema-invalid, not merely suspicious.

## 2. Canonical serialization and digest

- **Canonical form: RFC 8785 (JCS)** — UTF-8, lexicographically sorted keys at every level, no insignificant whitespace, shortest-form numbers (all numerics here are non-negative integers; floats are forbidden by schema), no trailing newline. The file on disk **is** the canonical bytes.
- Hashes: lowercase hex only. Timestamps: `YYYY-MM-DDTHH:MM:SSZ`, UTC, second precision. Arrays: `repos` and `rollback` sorted by `name`/`component`, `unknowns` by `field` — enforced by schema-adjacent lint, so canonicalization never reorders arrays (JCS doesn't).
- **Determinism rule:** identical repo states ⇒ identical bytes. Therefore `generatedAt` is **not** wall clock; it is the max committer timestamp across the four pinned HEADs. Wall-clock, hostname, and tool invocation details go in an un-digested sidecar run log, never in the manifest.
- **Digest:** `sha256(canonical bytes)` written to sidecar `platform-manifest-v0.json.sha256` (format: `<hex64>  platform-manifest-v0.json`). The digest lives outside the document — no self-referential hash field, no "compute with field zeroed" ambiguity. This digest is the _only_ load-bearing hash; the embedded contract hashes remain diagnostics per adjudication amendment 1(c).
- Two-run reproducibility is a **release requirement**: generator runs twice; byte-identical output or the artifact is rejected (this is the check Lane D was told to perform when L-40f386e3 returns).

## 3. Deterministic local verification (`verify-manifest`, read-only)

Phases run in fixed order; within a phase all findings are collected; process exits with the code of the **first failing phase** and prints every finding as `FAIL <phase>.<n> <json-pointer>: expected … actual …`.

- **P0 Environment.** Manifest + sidecar readable; each `repos[].path` is a git worktree containing object `head`. Failure ⇒ exit **10** (environment, not tamper).
- **P1 Digest.** sha256(file bytes) == sidecar ⇒ else exit **4**.
- **P2 Canonicality.** Parse, re-serialize per JCS, byte-compare to file ⇒ else exit **3**.
- **P3 Schema.** Validate against platform-manifest-v0 schema (consts included) ⇒ else exit **2**.
- **P4 Internal consistency.** Every `null` has an `unknowns` entry and vice-versa; `durable` recomputed from `upstream`+`dirty`; `compatStatus` recomputed from the two pinned schema versions; `generatedAt` == max committer date of the four `head`s ⇒ else exit **7**.
- **P5 Pinned-content facts** (world-independent — must hold forever): for each repo at the pinned `head` object, recompute via `git -C <path> show <head>:<file>`: openapi and event.ts sha256; grep constants at that blob (`API_CONTRACT_VERSION`, `SCHEMA_VERSION`, `DEPLOY_JSON_SCHEMA_VERSION`, `z.literal`, `LESTO_DEP_RANGE`, roof `VERSION`, snackday dep ranges). Any mismatch ⇒ exit **6** — the manifest lies about committed content: tamper-grade.
- **P6 World drift** (time-dependent): current `HEAD` == pinned `head`; branch name; upstream ahead/behind (against local remote-tracking refs — no fetch); `latestTag`. Mismatch ⇒ exit **5** ("stale, not forged"). Dirty-file-count drift alone is a **warning, not a failure** — studio is a shared worktree; dirt is not attributable and HEAD is the anchor.
- Exit **0**: all pass. Declared unknowns do not degrade the exit code — they are the manifest telling the truth.

Codes: `0` pass · `2` schema-invalid · `3` non-canonical · `4` digest mismatch · `5` world drifted · `6` pinned-content mismatch (tamper) · `7` internally inconsistent · `10` environment/usage. Ordering rationale: 4→3→2 establishes "this is the artifact" before trusting any field; 6 vs 5 separates _forgery_ from _staleness_ so consumers can react differently (fail closed on 6; regenerate on 5). Note the runtime fail-open/fail-closed question for version probes remains a named human decision per the adjudication — this verifier only defines manifest verification, not connection-time enforcement.

## 4. Explicit degraded-state handling

- **Dirty repos** (studio: 9 files; snackday: 4). Generation does not refuse; it records `dirty.fileCount` and sets `durable:false`. All contract hashes and constants are taken from **HEAD blobs, never the working tree** (`git show HEAD:…`), so the probe's working-tree hashes are explicitly non-manifest-grade — the generator must reproduce them from HEAD or record HEAD's values instead.
- **Unpushed / no upstream** (roof 12 ahead; snackday no remote). Recorded as `upstream` facts + `durable:false`. Verification does not fail on it, but the spec states the consequence plainly: a manifest naming non-durable HEADs describes a platform that exists on one disk and **cannot be a release candidate**; a future `--require-durable` consumer flag fails closed on any `durable:false`.
- **Missing SHA-bound merge authorization.** `authorization.mergeReceipts` is `const null` with `const` reason. Nothing receipt-shaped can enter v0 — the RCA showed receipt-shaped records were post-hoc attribution, so v0 makes the claim unrepresentable rather than optional. Receipts arrive only in a manifest v1 gated on the fail-closed ledger (D6).
- **Absent releases** (studio and roof have zero tags; pipelines never run). `releases.studio/roof: null` + `NO_TAGGED_RELEASE_EVER_CUT`; `latestTag: null`; lesto's stale `@0.1.0` tags are recorded with `tagsAuthoritative:false` so no consumer anchors on them. The fixture-matrix "previous" slot is out of manifest scope until a first tag exists — v0 never fabricates a "previous."
- **Incompatible contract versions.** The manifest records both sides of each pinned pair (lesto producer `DEPLOY_JSON_SCHEMA_VERSION` vs studio consumer `z.literal`) and a computed `compatStatus`. If sources genuinely diverge, generation still succeeds with `compatStatus:"inconsistent"` — the manifest's job is to make the incompatibility loud, not to hide it; verification confirms the recomputation (P4) and consumers fail closed on `inconsistent`.
- **Unknown rollback.** `mechanism` is a closed enum including `unknown` and `none-roll-forward`; `scripted` and `everExercised` are required booleans. Current truthful values: lesto self-host `pointer-flip` (scripted, exercised), npm `none-roll-forward`, studio binary `undocumented-manual`, roof `appcast-repoint-unscripted`. Guessing is unrepresentable: an omitted component is schema-invalid.

## 5. Tamper and negative tests

Each test mutates a **copy**; each MUST fail with the exact code, and a test that passes is itself a suite failure (negative control, per adjudication fixture rule).

1. Flip one hex char in `openapiSha256` → **6**.
2. Re-indent / reorder keys, content identical → **3**.
3. Edit the sidecar digest → **4**.
4. Set `signed:true` → **2** (const).
5. Replace `authorization.mergeReceipts` with a plausible receipt object → **2**.
6. Truncate a `head` to 12 chars → **2**; substitute a different valid 40-hex SHA not in the repo → **10**; substitute another _existing_ commit → **6** (pinned blobs differ).
7. Delete the `unknowns` entry for a still-null field → **7**.
8. Set `deployJsonSchemaVersion: 2` (synthetic incompatible, mirroring the `incompatible/` fixture discipline) → **6**, and recomputed `compatStatus` check → **7**.
9. World-drift control: in a throwaway `git clone --shared` of snackday under `$TMPDIR`, add an empty commit, point the manifest copy's `path` there → **5** (originals untouched).
10. Reproducibility control: run the generator twice against unchanged repos; any byte diff → suite failure.

## 6. Smallest credential-free dry run

No network, no daemon, no secrets, no writes outside `$TMPDIR` — runnable today under the standing read-only rule:

```sh
OUT=$(mktemp -d)
gen-manifest --out "$OUT/platform-manifest-v0.json"        # read-only git show/rev-parse/status/tag
gen-manifest --out "$OUT/second.json"
cmp "$OUT/platform-manifest-v0.json" "$OUT/second.json"    # byte-reproducibility
verify-manifest "$OUT/platform-manifest-v0.json"; echo "exit=$?"   # expect 0
tamper-suite "$OUT/platform-manifest-v0.json"              # tests 1–9 on copies; expect 9/9 correct failures
```

Success criterion: `cmp` silent, verify exits 0 with the probe's known truths visible in output (2 dirty repos, 2 non-durable, 3 nulled releases, `mergeReceipts:null`), tamper suite 9/9. This is exactly the evidence packet the missing L-40f386e3 re-run owes ADR 0007's "generate a manifest for the current repositories" — while making no claim about signing, authorization, npm-live, or deployed state.

---

_≈1,690 words. Sources: `docs/platform/probes/release-manifest-inventory.md` (all repo/contract facts and §11 verifier commands, reused as P5/P6 primitives), `docs/adr/0007-platform-contracts-and-release-manifest.md`, and the Chief Architect adjudication's 0007 amendments (unsigned v0, severed receipt/signing/template clauses, hashes-as-diagnostics, negative-control fixture rule)._
