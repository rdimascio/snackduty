# Platform manifest v0 — factual inventory (unsigned)

Captured 2026-07-16, local machine only. Nothing here was verified against remote services; remote-truth fields are flagged.

## 1. Repos: exact HEADs and working-tree state

| Repo                      | Path                        | HEAD                                       | Branch | Dirty                                                                                                                                                                                                                | Ahead/behind origin                                |
| ------------------------- | --------------------------- | ------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| roof (operator macOS app) | /Users/ryan/src             | `f1f3abbdede732dd647798fca8ddfd93ac098be3` | main   | clean (0 files)                                                                                                                                                                                                      | **12 ahead**, 0 behind `github.com/rdimascio/roof` |
| studio (daemon/board)     | /Users/ryan/every-io/studio | `46f7f7d4f2cf798dab9e5262855118abf6ad50f8` | main   | **dirty: 9 files** (4 modified: `web/src/components/board/project-selector.tsx`, `fleet/attention-panel.tsx`, `project-cockpit.tsx`, `web/src/lib/api.ts`; 5 untracked incl. `STRATEGY_V2.md`, `docs/rca/`, 3 plans) | 1 ahead, 0 behind `github.com/rdimascio/studio`    |
| lesto                     | /Users/ryan/crack           | `ecb0d42137d173ae65952d12cb66b39adc772de2` | main   | clean                                                                                                                                                                                                                | in sync with `github.com/lesto-run/lesto`          |
| snackday (demo app)       | /Users/ryan/snackday        | `54443aac30847ca0a02529de93823a54e48d713e` | main   | **dirty: 4 files** (`README.md` modified; untracked `docs/adr/`, `docs/platform-mvp-sprint.md`, `docs/platform/`)                                                                                                    | **no upstream configured**                         |

Note: studio is a shared worktree with concurrent agents — its dirty state may be a sibling's in-flight work, not attributable to one owner.

## 2. Version sources

- **lesto**: fixed changesets group `[["@lesto/*","create-lesto"]]` (`.changeset/config.json`, with `onlyUpdatePeerDependentsWhenOutOfRange:true`); all sampled packages at **0.2.0** (`packages/*/package.json`). Scaffold pin `LESTO_DEP_RANGE = "^0.2.0"` at `packages/create-lesto/src/scaffold.ts:52`. Root is private/unversioned.
- **studio**: root `package.json` `version: 0.1.0` is **not** the release version — release version derives from the `v*` git tag (`${GITHUB_REF_NAME#v}` in release.yml); local `build:binary` stamps `0.0.0-dev`. Self-update truth is `https://releases.example.com/version.json` (release.yml:216–250; `services/update-check.ts`, `bin/upgrade.ts`).
- **roof**: `/Users/ryan/src/VERSION` = `0.1.0`; release tag must exactly match `v<VERSION>`.
- **snackday**: all workspaces `0.0.0`, private; no versioning scheme.

## 3. Release/build workflows

- **crack** `.github/workflows/`: `release.yml` (workflow_dispatch only; npm Trusted Publishing/OIDC, no NPM_TOKEN; gated on admin repo var `RELEASE_ENABLED` + green-CI-for-exact-SHA precondition; driven by `bun run release:cut` = `scripts/dev/release.sh`; publisher `scripts/publish.mjs`), plus `ci.yml`, `deploy-examples.yml`, `benchmarks.yml`, `live-capstone-e2e.yml`, `live-capstone-failover.yml`, `scaffold-real-install.yml`, `scaffold-hoisted-preflight.yml`, `agent-activation.yml`.
- **studio**: `release.yml` (tag `v*` → verify(typecheck/lint/test/test:e2e) → 4× `bun build --compile` binaries via `scripts/build-binary.sh` → mac ad-hoc codesign → cosign-keyless-signed SHA256SUMS → GH Release → `bump-tap` (Homebrew) + `publish-version` (version.json to R2)); `ci.yml`; `deploy-oracle.yml` (weekly live wrangler prose-drift fence, `probes/deploy-credential-oracle/run.ts`). Runbook `RELEASING.md`.
- **roof**: `release.yml` (tag `v*.*.*` or dispatch; macos-15, `production` environment; builds DMG, refuses if GH Release exists — immutable). Sparkle-style signed appcast via `scripts/appcast.sh` (validates archives, reuses the live production feed); `scripts/release.sh`, `bundle.sh`.
- **snackday**: **no workflows directory** — no CI, no release pipeline.

## 4. Studio API contract sources

- Single contract-version constant: `shared/src/contract-version.ts` → `API_CONTRACT_VERSION = '1.0.0'`, emitted by both OpenAPI `info.version` and the WS `hello` event `serverVersion` (skew detection, L-2ae3cead).
- OpenAPI artifact: `api/openapi.json` (160 paths, `/v1/*` + WS union declared the stable additive-only surface). **sha256 `3fc48d942804421318fffc4359dd20b57b889e7899b34de3aa755b138c83b73b`** at studio HEAD+working tree.
- WS event union source: `shared/src/event.ts` (357 lines), **sha256 `0dcc8327d41d384858d131656ef58b77cbe930723f5b5dce7b1777ae5915d8d7`**.
- Drift gate: `bun run gen --check` (`scripts/gen.ts`, builds the spec from HEAD + explicitly named paths; CI runs `--check --head-only`).

## 5. Database migration versions

- **studio daemon SQLite**: `api/src/db/index.ts` → `SCHEMA_VERSION = 71` (line 197); forward-only `MIGRATIONS` array ends at `version: 71`; PRAGMA `user_version` is the on-disk marker; newer-db-than-binary is an explicit fatal (D-1).
- **lesto apps**: migrations are per-app via `@lesto/migrate` / `lesto migrate` (prints applied versions, DEPLOY.md). snackday's app declares migrations in `apps/web/lesto.app.ts`; no separate migrations dir found — actual version list not extracted here.

## 6. Lesto package/app compatibility facts

- Published surface: 49 packages (48 `@lesto/*` + `create-lesto`), fixed-group, **0.2.0 live on npm** (per memory/commit `ea143b0`, run 29428484765) — _not re-verified against npm in this pass_.
- `lesto deploy --json` verdict: `DEPLOY_JSON_SCHEMA_VERSION = 1` (`packages/cli/src/run.ts:2453`); Studio consumer pins `schemaVersion: z.literal(1)` (`api/src/services/lesto-deploy.ts:88`), unknown version → loud `unsupported`. **Coupling rule: bump = update Studio first.**
- snackday consumes published `^0.2.0` for 15 `@lesto/*` deps (`apps/web/package.json`) — the only real external consumer inventoried.
- Toolchain pins: bun `1.3.5` (crack + snackday `packageManager`), Node `>=22` (crack engines), npm ≥11.5.1 required in release workflow.
- Known compat gap (memory): npm `0.1.7` lacked `--json`; 0.2.0 closes it — Studio's prose fallback (`MISSING_CREDENTIAL_RE`) still covers pre-`--json` lesto, fenced by `deploy-oracle.yml`.

## 7. Gate commands

- **crack**: `bun run gate` (= ws:typecheck + ws:lint + ws:format:check + ws:test:cov serial coverage gate); `bun run gate:full` (adds type-tests, e2e typecheck, isolated-node-modules, `test:scripts-unit` incl. `assert-no-phantom-major`, content/integration/examples/site/bundle-size/pack-boot/pack-import, sh syntax).
- **studio**: `bun run typecheck && bun run lint && bun run test` + `bun run test:e2e` (durable-engine real-substrate tier); `bun run gen --check`.
- **roof**: `swift test` (CI pins `DEVELOPER_DIR` to Xcode 16); `scripts/check-fixture-freshness.sh`.
- **snackday**: `bun run gate` (format:check + lint + typecheck + test + build); `bun run ios:build|test|verify` (`scripts/ios-*.sh`).

## 8. Deploy config & rollback

- **Lesto-app deploys (snackday, examples, site, www)**: Wrangler on Cloudflare. Configs: `snackday/apps/web/wrangler.jsonc` (worker `web`, `nodejs_compat`, ASSETS→`./out`), `crack/site/wrangler.jsonc` (`lesto-docs` → docs.lesto.run), `crack/www/wrangler.jsonc` (`lesto-www` → lesto.run routes), `crack/examples/estate/wrangler.jsonc`, `crack/spikes/adr-0046-edge-kdf/wrangler.jsonc`.
- **Rollback mechanisms**: lesto self-host — immutable `releases/<version>/` trees + `lesto rollback --to <version>` live-pointer flip; deploy gate auto-rollback emits `retained | rolled-back | failed` verdict (worst-state error code `CLI_DEPLOY_ROLLBACK_FAILED`). npm — none (immutable; roll forward only). Studio binary — no explicit rollback path found; version.json is jq-merged forward (a manual re-render could point back, undocumented). roof — GH Releases immutable + appcast feed; rollback = re-point appcast (not scripted).

## 9. Missing / untrustworthy fields

1. **crack `RELEASING.md` status prose is stale** — says "0.1.5 live", actual is 0.2.0 (commit `ea143b0`). Prose ≠ source of truth.
2. **crack git tags stale** — newest per-package tags are `@0.1.0`; 0.1.x–0.2.0 npm releases have no corresponding tags. Tags cannot anchor a manifest here.
3. **studio & roof have zero git tags** — the tag-driven release pipelines have **never run**; no released-artifact version exists to record. `releases.example.com` origin in studio release.yml looks like a placeholder — live origin unverified.
4. **roof is 12 commits ahead of origin; snackday has no upstream** — neither local HEAD is durably published; snackday HEAD exists only on this machine.
5. **studio dirty tree** — `api/openapi.json`/`event.ts` hashes above are working-tree hashes at a dirty HEAD; only HEAD-committed hashes are manifest-grade (see verifier commands).
6. **npm-live state, deployed CF worker versions, and running daemon version** not verified (network/daemon calls out of scope). Daemon binary skew vs `SCHEMA_VERSION=71` unknown — `studio status` needed.
7. **snackday app migration version list** not extracted (embedded in `lesto.app.ts`); no CI means its gate has no enforcement record.
8. **studio root `version: 0.1.0` and `VERSION=0.1.0` (roof) are aspirational**, not released versions.
9. Studio release known gaps (self-documented): linux-arm64/darwin-x64 never boot-smoked in CI; bump-tap/publish-version infra never exercised end-to-end.

## 10. Manifest v0 field list (minimal JSON)

```json
{
  "manifestVersion": 0,
  "generatedAt": "",
  "signed": false,
  "repos": [
    {
      "name": "",
      "path": "",
      "remote": "",
      "head": "",
      "branch": "",
      "dirtyFileCount": 0,
      "aheadOfOrigin": 0,
      "hasUpstream": true,
      "latestTag": null,
      "releasePipeline": "",
      "gateCommand": ""
    }
  ],
  "lesto": {
    "npmSurfaceVersion": "0.2.0",
    "packageCount": 49,
    "scaffoldDepRange": "^0.2.0",
    "deployJsonSchemaVersion": 1,
    "npmVerified": false
  },
  "studio": {
    "apiContractVersion": "1.0.0",
    "openapiSha256": "",
    "wsEventSchemaSha256": "",
    "dbSchemaVersion": 71,
    "releasedBinaryVersion": null
  },
  "roof": { "versionFile": "0.1.0", "releasedVersion": null },
  "apps": [
    {
      "name": "snackday-web",
      "lestoDepRange": "^0.2.0",
      "wranglerConfig": "apps/web/wrangler.jsonc",
      "deployedVersion": null
    }
  ],
  "unknowns": [
    "npm-live",
    "cf-deployed-versions",
    "daemon-runtime-version",
    "snackday-migration-versions"
  ]
}
```

## 11. Verifier commands (local, read-only)

```sh
# HEAD / dirty / ahead per repo
for r in /Users/ryan/src /Users/ryan/every-io/studio /Users/ryan/crack /Users/ryan/snackday; do
  git -C "$r" rev-parse HEAD; git -C "$r" status --porcelain | wc -l
  git -C "$r" rev-list --left-right --count @{upstream}...HEAD 2>&1
  git -C "$r" tag --sort=-creatordate | head -3
done
# Committed (HEAD) contract hashes — not working-tree
git -C /Users/ryan/every-io/studio show HEAD:api/openapi.json | python3 -c "import sys,hashlib;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"
git -C /Users/ryan/every-io/studio show HEAD:shared/src/event.ts | python3 -c "import sys,hashlib;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"
grep -m1 "API_CONTRACT_VERSION" /Users/ryan/every-io/studio/shared/src/contract-version.ts
grep -m1 "SCHEMA_VERSION = " /Users/ryan/every-io/studio/api/src/db/index.ts
grep -m1 "DEPLOY_JSON_SCHEMA_VERSION" /Users/ryan/crack/packages/cli/src/run.ts
grep -m1 "schemaVersion: z.literal" /Users/ryan/every-io/studio/api/src/services/lesto-deploy.ts
grep -m1 "LESTO_DEP_RANGE" /Users/ryan/crack/packages/create-lesto/src/scaffold.ts
cat /Users/ryan/src/VERSION
python3 -c "import json;print(json.load(open('/Users/ryan/crack/packages/cli/package.json'))['version'])"
# Remote-truth checks (network; run only when authorized)
npm view @lesto/cli version            # npm-live surface version
studio status                          # daemon build/skew vs source
```
