The preflight is written to the plan file (1,385 words, under the 1,600 cap). Sources located: ADR 0006 at `/Users/ryan/snackday/docs/adr/0006-platform-packaging-and-runtime-topology.md` and the packaging/runtime report at `/Users/ryan/snackday/docs/platform/probes/packaging-runtime.md`. Every command below was verified against current source, not the report's prose. Full document:

---

# Roof + Studio lifecycle preflight (credential-free) — executable form of ADR 0006

## Context

ADR 0006 requires a clean-machine lifecycle probe; the packaging/runtime report sketched it as prose (§7/§8). This converts both into commands that run today, credential-free, without touching the real Studio daemon. Repos: roof `/Users/ryan/src`, studio `/Users/ryan/every-io/studio`.

Three constraints are load-bearing:

1. **Roof resolves `~/.studio/studio.pid` via getpwuid and ignores `$HOME`** — a temp-HOME daemon is invisible to roof's local discovery. All temp-lane roof↔daemon contact goes through the remote seam: `STUDIO_URL` + `STUDIO_TOKEN` (`Sources/StudioKit/Transport/StudioTransport.swift:75`, `Sources/RoofProbe/RoofProbe.swift:642`).
2. **The studio launcher's first isolated call must pin a non-4983 port**, or it reaps the real shared daemon (`probes/operator-turn-restart-resume/run.sh:40`). Every `studio` invocation below carries `HOME="$ISO"` **and** `-p "$PORT"`.
3. **Run `swift package clean` before any roof verify you intend to trust** (stale-SwiftPM-binary hazard after sandboxed agent runs).

## 1. Exact existing commands/tests per concern

| Concern                 | Credential-free command(s)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build (roof)            | `swift package clean && swift build`; app bundle: `bash Scripts/bundle.sh release` → ad-hoc-signed `build/roof.app` (the designed credential-free path, `SIGNING.md`)                                                                                                                                                                                                                                                                      |
| Build (studio)          | `bun run typecheck`; shipped artifact: `bash scripts/build-binary.sh bun-darwin-arm64 0.0.0-dev studio-darwin-arm64` → `dist/studio-darwin-arm64`; boot smoke `bash scripts/smoke-binary.sh dist/studio-darwin-arm64` (self-isolates HOME via `mktemp -d`, random port, tokenless `/health`)                                                                                                                                               |
| Contract tests          | roof `swift test --filter OperatorServerContractTests` (vendored openapi slice); studio-side drift `ROOF_STUDIO_OPENAPI="$STUDIO/api/openapi.json" bash Scripts/check-fixture-freshness.sh` — the env pin is **required**: the script's fallback shells out to `studio repos`, which contacts the real daemon; studio `bun run test:unit` and `bun run test:e2e` (e2e boots isolated embedded engines with fake agents; no external creds) |
| Daemon discovery        | units `bun test api/src/pidfile.test.ts api/src/index.boot.test.ts api/src/index.first-boot.test.ts`; live: boot temp daemon, assert pidfile `{pid,port,startedAt,token,bootId}`, then bare `swift run roof-probe` (Phase-0 read-only: transport → `/v1` REST → `/ws` hello/snapshot; no LLM)                                                                                                                                              |
| Occupied port           | live only: pre-bind the port, launcher must bail naming pid + command (`bin/cli.ts:1045–1158`); arg-parsing units in `bin/cli.test.ts` (`extractPort`, `daemonSpawnConfig`)                                                                                                                                                                                                                                                                |
| Close/reopen projection | roof offline: `swift test --filter FleetStoreTests`, `--filter FleetConnectionTests`, `--filter ServerOperatorConversationTests`, `--filter ChatModelTests`; studio `bun test api/test/e2e/daemon-stop.e2e.test.ts` (+ crash-recovery e2es); live no-LLM: seed a board task → restart temp daemon → same port, persisted token (L-89afc749), probe re-reads state                                                                          |
| Token rotation          | roof units: `swift test --filter StudioReadingTests` (port-level `unauthorized`) and `--filter ChatModelTests` (`connectionExpired` origin-gating/clearing); studio live: `probes/operator-turn-restart-resume/verify-token-persist.sh` pattern — persistence across restart, `studio token rotate --yes`, old token must 401                                                                                                              |
| Version skew            | roof `swift test --filter StudioClientCompatTests` (d7 major-only gate on WS `hello.serverVersion`); studio `bun test api/src/version.test.ts`. No REST version endpoint exists — pre-connect skew is undiagnosable (known gap, flagged by the probe report)                                                                                                                                                                               |
| Downgrade refusal       | `bun test api/src/db/migrate.test.ts` — "downgrade guard (D-1)" (SchemaDowngradeError **before** backupDb) and the `.bak-v21` snapshot test; live temp variant: `PRAGMA user_version=9999` on the temp `studio.db`, reboot must refuse and name the remedy                                                                                                                                                                                 |
| Update logic            | `bun test bin/upgrade.test.ts` (upgradeMode SE-2/SE-4: brew-defers, refuse-dev, refuse-unknown, downgrade needs `--yes`; SHA256SUMS parsing SE-1); `bun test api/src/services/update-check.test.ts` (24 h advisory only — daemon never auto-updates). Live `studio upgrade` = network + self-replaces the installed binary → excluded from this lane                                                                                       |
| Rollback                | procedural by design (probe amendment 4): restore `studio.db.bak-v<n>` + pinned `studio upgrade --version X --yes`; roof feed is append-only (`Scripts/appcast.sh`, `--maximum-versions 0`) and Sparkle won't downgrade. Credential-free drill: snapshot the temp DB pre-corruption, restore, daemon boots clean                                                                                                                           |
| UI paint                | `swift run roof --render <hero\|chat\|review\|deploy\|gate\|notice> out.png` — offscreen render of shipped views on canned fakes; no creds, no daemon; needs a logged-in WindowServer session (not plain SSH)                                                                                                                                                                                                                              |

## 2. Lane split

**Lane A — temp HOME under `/private/tmp` (checklist below):** everything in the table.

**Lane B — throwaway macOS user, GUI, credentials, or human observation:**

- **roof.app local pidfile discovery + quit/relaunch state reappearing (AT1)** — getpwuid means the daemon must live in the account's real `~`; use a throwaway _user account_, not a VM (probe §7); needs GUI + human eyeball.
- **Anything Sparkle** — DMG install, auto-update, feed-level downgrade refusal: no updater runtime is shipped (`Package.swift` has no Sparkle dep; L-e4fe5c6b in progress). Requires Sparkle keys + a cut release.
- **`./Scripts/release.sh --check` and beyond** — Developer ID `.p12`, notary `.p8`, Sparkle Ed25519, Cloudflare token (`SIGNING.md`); `--check` is read-only but _by design_ exits nonzero until creds exist.
- **Live operator-turn restart-resume** (`probes/operator-turn-restart-resume/run.sh`) — needs an Anthropic key; its credential-free sibling `verify-token-persist.sh` is folded into Lane A.
- **`studio upgrade` live + uninstall inventory diff (AT7)** — network, mutates the installed binary; the leftover inventory needs the throwaway account's teardown.
- **Gatekeeper behavior of the joined install flow** — needs notarized artifacts + GUI.

## 3. Ordered checklist (Lane A)

```bash
#!/bin/bash
# Roof+Studio lifecycle preflight — credential-free lane.
# Never stops or contacts the daemon on :4983 / real ~/.studio.
set -euo pipefail
ROOF=/Users/ryan/src STUDIO=/Users/ryan/every-io/studio PORT=8973
ISO="$(mktemp -d /private/tmp/lifecycle-preflight.XXXXXX)"
API="http://127.0.0.1:$PORT" PID="$ISO/.studio/studio.pid"
s() { HOME="$ISO" studio "$@"; }              # ALWAYS isolated HOME
tok() { python3 -c "import json;print(json.load(open('$PID'))['token'])"; }
up() { for _ in $(seq 60); do curl -fsS "$API/health" >/dev/null 2>&1 && return; sleep 1; done
       echo "FATAL: daemon never became healthy" >&2; exit 1; }
down() { for _ in $(seq 30); do curl -fsS "$API/health" >/dev/null 2>&1 || return; sleep 0.5; done; }
cleanup() { s --stop -p "$PORT" >/dev/null 2>&1 || true; rm -rf "$ISO"; }
trap cleanup EXIT
mkdir -p "$ISO/.studio"

# 1. Roof: clean build + full offline suite (live smokes self-skip without ROOF_LIVE_*).
( cd "$ROOF" && swift package clean && swift build && swift test )

# 2. Contract freshness vs studio's committed spec (env pin avoids the daemon fallback).
( cd "$ROOF" && ROOF_STUDIO_OPENAPI="$STUDIO/api/openapi.json" bash Scripts/check-fixture-freshness.sh )

# 3. Credential-free app bundle.
( cd "$ROOF" && bash Scripts/bundle.sh release )

# 4. Studio: typecheck + unit suite, then the load-bearing lifecycle tests explicitly.
( cd "$STUDIO" && bun run typecheck && bun run test:unit )
( cd "$STUDIO" && bun test api/src/pidfile.test.ts api/src/version.test.ts \
    api/src/db/migrate.test.ts bin/upgrade.test.ts api/src/services/update-check.test.ts )

# 5. Server e2e (isolated embedded engines; includes daemon-stop + crash recovery).
( cd "$STUDIO" && bun run test:e2e )

# 6. Shipped-artifact boot smoke (script self-isolates HOME, random port).
( cd "$STUDIO" && bash scripts/build-binary.sh bun-darwin-arm64 0.0.0-dev studio-darwin-arm64 \
    && bash scripts/smoke-binary.sh dist/studio-darwin-arm64 )

# 7. Occupied port fails loud (run BEFORE booting our daemon).
nc -l 127.0.0.1 "$PORT" >/dev/null 2>&1 & NC=$!
if s --headless -p "$PORT" >"$ISO/port.log" 2>&1; then
  echo "FAIL: launcher did not bail on an occupied port" >&2; exit 1; fi
kill "$NC" 2>/dev/null || true
grep -qi "in use" "$ISO/port.log"             # must name the foreign holder

# 8. Discovery: boot isolated daemon; pidfile carries pid/port/token/bootId.
s --headless -p "$PORT" & up
T1="$(tok)"
python3 -c "import json;d=json.load(open('$PID'));assert all(k in d for k in('pid','port','token','bootId')),d"

# 9. Roof wire proof over the remote seam (read-only REST + WS hello/snapshot).
( cd "$ROOF" && STUDIO_URL="$API" STUDIO_TOKEN="$T1" swift run roof-probe )

# 10. Close/reopen projection, no LLM: seed state, restart, token+port persist, state re-reads.
s tasks create "preflight marker" --repo none -p "$PORT"
s --stop -p "$PORT"; down
s --headless -p "$PORT" & up
[ "$(tok)" = "$T1" ]                          # persisted token (L-89afc749)
( cd "$ROOF" && STUDIO_URL="$API" STUDIO_TOKEN="$T1" swift run roof-probe )

# 11. Token rotation fails loud: rotate (daemon restarts), old token must be refused.
s token rotate --yes -p "$PORT"; up
if ( cd "$ROOF" && STUDIO_URL="$API" STUDIO_TOKEN="$T1" swift run roof-probe ) \
  >"$ISO/rot.log" 2>&1; then echo "FAIL: stale token accepted" >&2; exit 1; fi

# 12. Downgrade refusal + rollback drill on the TEMP db only.
s --stop -p "$PORT"; down
cp "$ISO/.studio/studio.db" "$ISO/studio.db.snapshot"        # our .bak stand-in
sqlite3 "$ISO/.studio/studio.db" 'PRAGMA user_version=9999;'
if s --headless -p "$PORT" >"$ISO/downgrade.log" 2>&1 & then :; fi
sleep 5
if curl -fsS "$API/health" >/dev/null 2>&1; then
  echo "FAIL: daemon opened a newer-schema db" >&2; exit 1; fi
cp "$ISO/studio.db.snapshot" "$ISO/.studio/studio.db"        # rollback = restore snapshot
s --headless -p "$PORT" & up                                  # boots clean again
s --stop -p "$PORT"; down
echo "PREFLIGHT GREEN — Lane A complete. Lane B items remain human-gated."
```

## Deferred friction (file once out of read-only mode)

Already flagged by the probe report: (a) no unauthenticated REST version endpoint for pre-connect skew; (b) no `studio uninstall`/leftover-inventory verb. New micro-nit from this session: `studio token --help` prints usage but exits nonzero (per your global rule these belong on the board, but filing is a mutation this session forbids).
