Probe complete. The full report (1,928 words) is saved at `/Users/ryan/.claude/plans/you-are-a-chief-buzzing-mango.md`; it is reproduced below.

**TLDR: ADR 0006's direction (one installer/support channel, separately versioned Roof + Studio, no embedding) is correct and is mostly already implemented in code — accept it with four amendments: launch-via-Studio-CLI-only, an explicit update-ordering rule plus a REST version endpoint, an uninstall spec (no uninstall code exists anywhere), and rollback restated as a documented procedure rather than an automatic property.** One direct contradiction needs an owner call: the ADR says Roof "discovers **or launches**" the daemon, while Roof's shipped transport layer declares Roof a pure client that never launches or manages it.

---

# Probe report — Roof + Studio packaging & runtime topology (ADR 0006)

Read-only architecture probe, 2026-07-16. Repos inspected: roof = `/Users/ryan/src`, studio = `/Users/ryan/every-io/studio`, platform ADRs = `/Users/ryan/snackday/docs/adr`. Nothing was mutated; Studio automation treated as release-blocked.

## 1. Observed facts

### Roof distribution — pipeline built, updater absent, zero releases

- A fail-closed release pipeline exists end-to-end but has never cut a release: `Scripts/release.sh` + `Scripts/appcast.sh` + `SIGNING.md` cover Developer ID signing, notarization, stapling, Gatekeeper validation, and a Sparkle-Ed25519-signed **append-only** appcast (`--maximum-versions 0`, `Scripts/appcast.sh:90`) served by a Cloudflare Worker + R2 (`updates/`). First release gated on `ROOF_FIRST_RELEASE=1`. `VERSION` = 0.1.0. Burned-version/half-published recovery is already specified (`SIGNING.md` recovery table).
- The app has **no updater runtime**: no Sparkle dependency in `Package.swift`, zero Sparkle/appcast references under `Sources/`. Board task L-e4fe5c6b (auto-update + channel) moved to In Progress today — packaging work must coordinate with it.
- `Scripts/bundle.sh` assembles a pure `roof.app` (`io.every.roof`); nothing embedded — no daemon, no helper, no LaunchAgent.

### Roof client lifecycle

- `Sources/StudioKit/Transport/StudioTransport.swift` is the single local/remote seam: local = pidfile `~/.studio/studio.pid` (`{pid, port, startedAt, token, bootId}`); remote = explicit URL + bearer. Its doc comment (lines 8–10): "The roof is a **pure client**: it never launches or manages the daemon." This **contradicts ADR 0006's "discovers or launches"**.
- No silent remote→local fallback on either side: `autodiscover` throws `missingRemoteToken` when `STUDIO_URL` is set without a token (`StudioTransport.swift:75-83`); studio's `resolveRemoteDaemonTarget` fails identically loud (`api/src/pidfile.ts:43-59`). ADR invariant 4 already holds in code.
- Remote profile: persisted in the macOS Keychain (`KeychainStore`, service `com.roof.operator`); resolution order settings → env → pidfile (`RoofSecrets.swift:43-54`). Remote 401 ⇒ `connectionExpired` banner, origin-gated, cleared on any healthy reload (`ChatModel.swift:382-391`; commits `f1f3abb`, `fed22e5`).
- Version skew: a major-only compat gate on the WS `hello.serverVersion` (`StudioClient.isCompatible`, `StudioClient.swift:35-59`); **no REST version route exists in `/v1`** — skew is only diagnosable after a WS connect.
- Divergence: roof resolves the pidfile via `homeDirectoryForCurrentUser` (getpwuid, ignores `$HOME`); studio uses node `homedir()` (`$HOME` first). Isolated-HOME rigs make the two see different `~/.studio` (verified in a prior session).

### Studio distribution — pipeline built, pre-first-tag

- Single self-contained bun-compiled binary × 4 targets; the durable-workflow bundle is **embedded in the binary** ("Option E", `bin/upgrade.ts:23-25`) — no side-by-side artifacts, no intra-studio skew.
- Release chain (`RELEASING.md`): verify → build → sign-macos (**ad-hoc**, not Developer ID) → release (cosign-keyless-signed `SHA256SUMS`) → bump-tap (Homebrew) → publish-version (`studio.every.io` `version.json` + `install.sh`, R2). Beta/stable channels from tag suffix. CI boot-smokes only 2 of 4 targets; `bump-tap` and `publish-version` have **never run e2e**.
- `studio upgrade` (`bin/upgrade.ts`) is install-method-aware (`~/.studio/install-method`): brew defers to `brew upgrade`; curl self-replaces atomically (EXDEV/ETXTBSY-safe temp+rename, re-exec); refuses from dev checkouts and unknown provenance; **downgrade requires `--yes`** with a DB-newer-than-binary warning. It verifies the asset hash against the cosign-signed `SHA256SUMS` but **warns-and-continues when cosign is absent** (`upgrade.ts:145-174`). It stops the daemon first. The daemon **never auto-updates** — the 24 h check is advisory only, because the daemon owns live SQLite + worktrees (`services/update-check.ts:1-12`).

### Studio daemon lifecycle & durability

- Hardened singleton pidfile: atomic `link(2)` create, stale-reap, `PidfileConflict`, successor-safe `removePidfileIfOwned` (`api/src/pidfile.ts:98-167`).
- Launcher (`ensureDaemon`, `bin/cli.ts` ~700–1150): attaches to a live daemon; reaps only heuristic-verified studio orphans (SIGTERM→SIGKILL); a **foreign process on :4983 is surfaced with pid + command and the CLI bails** — no silent port hopping; EADDRINUSE diagnosed structurally. Default port 4983 (`STUDIO_PORT`, `-p`). Restart reuses the stopped daemon's **own port** (`cli.ts:2575`) and a **persistent token that survives restarts** (L-89afc749) — a long-lived Roof stays authorized across `studio --stop && studio`.
- Durable ownership: per-boot `bootId` stamped onto runs; a successor daemon adopt-or-reaps prior-generation stranded runs (`api/src/bootid.ts`, `services/agent.ts:943-955`). Operator turns serialize server-side with durable digests at `~/.studio/operator/<taskId>/digest.json` (`api/src/paths.ts`); a restart-resume probe exists (`probes/operator-turn-restart-resume/`). Roof's brain is server-side since mig2 (`Package.swift` comment), so **closing Roof cannot kill durable work by construction** (ADR invariant 1).
- Rollback: forward-only, data-preserving migrations with pre-migration `.bak-v<n>` snapshots (`db/index.ts:2830`); an older binary against a newer-schema DB refuses to open with a named remedy (`SchemaDowngradeError`, `db/index.ts:~2938`).
- Uninstall: **no uninstall command exists anywhere** (grepped bin/, api/, scripts/). `~/.studio/` accumulates settings, `studio.db` + backups, operator digests, `bin/`, install-method, version-cache, `license.json` (`api/src/paths.ts:1-22`); worktrees and Roof's Keychain items are additional. `brew uninstall` removes only the binary.
- Topology: hosted/hybrid is designed-in — one client contract over localhost pidfile or tunnel (roof `FOUNDATION.md` §3 "software factory" remote box; hosted-SPA CORS via `STUDIO_WEB_ORIGIN`). Open-core: OSS binary fully offline; paid surface server-gated (`DISTRIBUTION_PLAN.md`).

## 2. Options

**A. Embed Studio inside Roof.app** (helper/LaunchAgent). One artifact, one updater — but it forks the daemon singleton (CLI/TUI users share `~/.studio/studio.pid`; an app-private copy fights the launcher's orphan-reaper), couples Sparkle app updates to a daemon that must _never_ be silently restarted mid-work, duplicates studio's finished self-updater, forces notarizing the studio binary, and abandons Linux/headless/remote parity. Contradicts studio's whole distribution design.

**B. Two fully separate installs** (status quo trajectory). Both pipelines already exist and are the most-built assets here — but the customer assembles the product themselves, support faces an unbounded version matrix, and nothing owns "first launch, no daemon."

**C. One installer + one support channel, separately versioned artifacts** (ADR 0006). Roof DMG/Sparkle for the app; Roof's first-run detects a missing/incompatible studio and drives studio's _own_ install/upgrade path; versions decoupled behind the major compat gate plus a release manifest (ADR 0007). Preserves both finished pipelines; adds only the join.

## 3. Recommendation

**Adopt Option C — ADR 0006's direction is correct and largely already implemented** (separate versioning, discovery, explicit remote profiles, fail-loud invariants all exist in code). Accept with four amendments:

1. **Launch semantics.** Replace "discovers or launches the local Studio daemon" with "discovers, or launches **via the Studio CLI's own launcher** — never by spawning the daemon process directly." All singleton/orphan-reap/port-pinning/token-persistence logic lives in studio's launcher (`bin/cli.ts`); a second spawner forks that brain. Whether Roof stays strictly pure-client instead is a human decision (below).
2. **Update ordering.** State it: the daemon never self-restarts; `studio upgrade` stops it explicitly and Roof must survive that (stale → recover, token persists — already true). Roof updates independently under the major gate. Add the missing primitive: an **unauthenticated REST version endpoint**, since skew is currently visible only after a WS connect.
3. **Uninstall is unimplemented.** The invariant "uninstall … explicitly handles the daemon, database, worktrees, and credentials" names code that does not exist on either side. Require an uninstall spec derived from a measured leftover inventory (probe step 8).
4. **Rollback is procedural, not automatic.** Roof's appcast is append-only forward; Sparkle won't downgrade; studio downgrade is confirm-gated with `.bak-v<n>` restore as the remedy. Say so: rollback = documented operator procedure (`studio upgrade --version --yes` + DB restore).

## 4. Risks

- **L-e4fe5c6b is In Progress** — Sparkle integration is being built now; don't race it.
- **cosign optional-verify**: without cosign installed, `studio upgrade` trusts `SHA256SUMS` fetched from the same origin as the binary — checksum without provenance.
- **Two never-e2e-exercised release jobs** (`bump-tap`, `publish-version`) fail half-open: binary shipped, tap/version.json stale.
- **Gatekeeper on the joined flow**: studio's mac binaries are ad-hoc signed; fine for brew, but a Roof-driven download inherits quarantine questions `install.sh` handles with `xattr`.
- **HOME divergence** (getpwuid vs `$HOME`) breaks isolated-HOME probes and users with remapped `$HOME`.
- **Fixed port 4983, foreign holder = hard stop** with instructions — correct per the ADR, but a guaranteed support topic.

## 5. Falsification / reversal triggers

- Clean-machine probe shows notarized Roof driving studio's installer trips Gatekeeper in ways only Developer-ID-signing studio fixes → revisit signing scope; if unfixable, Option A pressure returns.
- A minor studio release breaks Roof despite the major-only gate → gate too coarse; pull ADR 0007's release manifest forward and pair-pin versions.
- CLI-launched and Roof-launched daemons fight in the field (reaper kills the other's daemon, port pinning lost) → retreat to strict pure-client Roof.
- An emergency where append-only appcast history blocks remediation → amend feed policy (entry-pull), reversing "immutable feed".

## 6. Decisions still requiring a human

1. Pure-client Roof vs launch-via-studio-CLI (amendment 1) — overrides a standing FOUNDATION invariant; owner call.
2. Apple one-timers (`SIGNING.md`): Developer ID cert, notary key, Sparkle keys — and whether **studio** also gets Developer ID + notarization for the joined installer.
3. Supported version-matrix policy per channel (ties to board task L-5d3de617).
4. Make cosign verification mandatory (fail-closed) in `studio upgrade`?
5. Does the remote "software factory" profile UI ship to all customers at v1, or gate behind the paid tier (open-core boundary)?

## 7. Smallest disposable lifecycle probe

A throwaway macOS **user account** (not a VM — `~` isolation is the boundary that matters, and it keeps roof's getpwuid home consistent) plus one checklist script, `probes/lifecycle-clean-install/run.sh`, following studio's existing `probes/` convention:

1. Install studio via `install.sh` (beta channel) → `studio` boots; record `~/.studio` inventory against a pre-install marker.
2. Launch a `bundle.sh` Roof (DMG once L-e4fe5c6b lands) → pidfile discovery, WS hello version gate.
3. Start a durable operator turn → **quit Roof** → CLI shows the run still live → relaunch, state reappears (invariant 1).
4. Pre-bind :4983 with `nc -l` → launcher names the foreign pid + command and bails (invariant 3).
5. `studio --stop && studio` mid-session → same port, same token, Roof recovers without re-auth; then `studio upgrade` → same recovery across the binary swap.
6. Remote profile to a second daemon; kill it and rotate its token → expired/stale banner, never a silent local fallback (invariant 4).
7. Newer-schema `studio.db` under an older binary → `SchemaDowngradeError` names the `.bak` remedy; restore → boots (rollback).
8. Delete the account; the step-1/7 inventory diff **is** the uninstall spec input (invariant 2).
   Disposable: everything lives in the throwaway account; no infra, signing, or real release required.

## 8. Acceptance tests

- **AT1 durability**: turn running → Roof quit 60 s → CLI shows run still `running`, `bootId` unchanged; relaunch re-renders it.
- **AT2 ports**: foreign listener on 4983 → launcher exits non-zero; stderr names pid + command + kill instruction; no daemon spawned.
- **AT3 skew**: Roof vs major-bumped `serverVersion` refuses with an actionable message (unit exists; verify once live).
- **AT4 update ordering**: `studio upgrade` with Roof connected → Roof goes stale, recovers on the new daemon, no re-auth, no duplicated/lost runs.
- **AT5 rollback**: older binary + newer DB refuses to open, names `studio upgrade` and the `.bak-v<n>` path; restoring the backup boots clean.
- **AT6 remote**: `STUDIO_URL` without token fails loud in both Roof and CLI; token rotation shows `connectionExpired`, never local fallback.
- **AT7 uninstall**: every file/keychain item the install created is enumerated, and the to-be-written uninstall doc removes 100% of them.

---

One process note: per the global CLAUDE.md rule, two Studio-tooling friction items surfaced by this probe deserve board tasks once out of read-only mode — (a) no REST version endpoint on `/v1` for pre-connect skew diagnosis, and (b) no `studio uninstall`/leftover-inventory command. I could not file them under this probe's no-mutation constraint.
