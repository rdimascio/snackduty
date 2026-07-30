# Lifecycle preflight — Lane A execution evidence

Executed 2026-07-17 (task `L-786014f7`), credential-free, per the Lane A checklist in
[`lifecycle-preflight.md`](lifecycle-preflight.md) §3. Pinned substrate: Studio source suites ran
at **origin/main `a443abef`** (the post-merge state of PRs #8–#15) in an isolated worktree; the
live daemon drills (steps 7–12) exercised the **installed `studio` binary 0.1.0** under an
isolated `$HOME` on port 8973 — the real shared daemon and `~/.studio` were never touched. Roof at
**`c8c7126`** (which re-vendored the operator fixture against the merged spec — a real
studio-side drift caught and cleared by the freshness gate during this execution).

## Result — Lane A GREEN, all 12 steps

| Step | Concern                                   | Result                                                                                                     |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1    | Roof clean build + full offline suite     | pass (546-test CLI suite green upstream; roof `swift test` green, live smokes self-skipped)                |
| 2    | Contract freshness vs merged spec         | pass — after re-vendoring: the merged wave HAD drifted the spec; the gate caught it (see below)            |
| 3    | Credential-free `roof.app` bundle         | pass (ad-hoc signed)                                                                                       |
| 4    | Studio typecheck + unit + lifecycle tests | pass (typecheck exit 0; unit suite green incl. pidfile/version/migrate/upgrade/update-check)               |
| 5    | Server e2e, warm bundle                   | pass — after prebuilding the flow bundle (see cold-bundle finding)                                         |
| 6    | Shipped-artifact build + boot smoke       | pass — smoke logs `workflow: using embedded bundle … no resolve/build/guard`                               |
| 7    | Occupied port fails loud                  | pass — launcher bailed: `daemon failed to start — port :8973 is still in use (EADDRINUSE, pid 6303)` (AT2) |
| 8    | Pidfile contract                          | pass — `{pid, port, token, bootId}` all present                                                            |
| 9    | Roof wire proof (remote seam)             | pass — `roof-probe` phase-0 REST + WS hello/snapshot, read-only                                            |
| 10   | Close/reopen projection                   | pass — restart reused the port, **token byte-identical** (L-89afc749), probe re-read seeded state          |
| 11   | Token rotation                            | pass — post-rotate, the stale token was refused (AT6, rotation half)                                       |
| 12   | Downgrade refusal + rollback drill        | pass — `user_version=9999` DB refused (daemon never healthy); snapshot restore booted clean (AT5)          |

## Findings beyond pass/fail

1. **Cold-bundle boot cost is real and only affects dev checkouts.** The first e2e attempt failed
   exactly as L-94df194e documented: a cold `api/src/.well-known` flow bundle adds ~23s per daemon
   boot, and the crash-recovery e2e's SIGKILL→reboot cycle blew its budget. CI's prebuild
   (`bunx workflow build`, ci.yml) is load-bearing. The **shipped binary is immune** — step 6's
   smoke confirms the bundle is embedded ("Option E"), so customers never pay this cost. The
   packaging story should keep that property.
2. **Harness note for future runs:** macOS `nc -l` is single-accept — the launcher's occupancy
   probe consumes the connection, the port frees, and the daemon binds, making the occupied-port
   test pass vacuously wrong. Use a persistent listener (`python3 -m http.server`) as the foreign
   holder.
3. **The freshness gate earned its keep live:** the merged wave changed the operator spec (a
   workflow-step description), the vendored slice went stale, the gate went red, and the
   re-vendor + 26/26 contract tests + green re-check closed the loop — the exact studio-side-drift
   scenario it was built for.

## Lane B — remains human-gated (not waived)

Per `lifecycle-preflight.md` §2: roof.app pidfile discovery + quit/relaunch in a real account
(AT1), anything Sparkle (no updater runtime shipped; its task was **canceled**, so this is an open
gap, not in-flight work), `release.sh --check` and beyond (Apple credentials), live
`studio upgrade` + uninstall leftover inventory (AT7 — spec input for the uninstall task), and
Gatekeeper behavior of the joined flow. These are release gates for the first supported
distribution, owned via the ADR 0006 adjudication.
