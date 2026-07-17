The Write tool isn't enabled in this context, so I can't persist the plan file — but this task is a read-only report with no implementation phase, so the deliverable is the report itself. Here it is.

---

# Platform Identity & Credential Threat-Model Probe — ADR 0008

**Mode:** strictly read-only (no edits, mutations, agents, network, or secret-value reads). Studio automation treated as release-blocked.

## Context

ADR 0008 (`snackday/docs/adr/0008-platform-identity-entitlements-and-credentials.md`, **Proposed**, 2026-07-16) proposes separate principals for Roof seat entitlement, Studio human/machine orchestration, Git provider access, Cloudflare deployment, and deployed-app accounts; Studio stamps authoritative actors; Roof stores only its own entitlement/session + Studio connection material; repo/deploy credentials stay server-side and never enter UI, prompts, task messages, logs, notification previews, or release manifests. This probe tests whether the _implemented_ system satisfies that, and where it diverges.

## Observed facts (evidence)

**1. Roof entitlement / Keychain / sandbox.** Roof's Keychain holds exactly two items, both connection config, not authority: `SecretKey = {studioURL, studioToken}` (`roof/Sources/RoofApp/KeychainStore.swift:7-10`), generic-password items under `com.roof.operator` (`:25`). Resolution is Keychain → `STUDIO_URL/STUDIO_TOKEN` env fallback; blank URL ⇒ local pidfile discovery, **no token needed locally** (`RoofSecrets.swift:43-54`). Entitlements are empty; App Sandbox is intentionally OFF, Hardened Runtime ON with no exceptions (`roof/Scripts/entitlements.plist:3-8`). The `/ws` URL carries `?token=`; socket errors log domain+code only (`StudioClient.swift:299-302`). **Seat/Polar entitlement is Phase E, not yet in Roof** (`roof/FOUNDATION.md:290,434`) — today Roof gates on token connectivity, not a seat.

**2. Studio principals & bearer tokens.** One daemon bearer token, minted once, persisted `~/.studio/token` (0600) and mirrored into the pidfile for discovery (`ARCHITECTURE.md` runtime table; `api/src/pidfile.ts:19-24,138`). It **grants full API access**. Auth is a single shared secret, not a principal: `Authorization: Bearer` enforced on all non-public/non-webhook paths with constant-time compare (`api/src/server.ts:80-87,145-160`). **Actor stamping is client-asserted free text:** gate resolve `resolvedBy: z.string().optional()`, "audit only", **defaults to `'user'`** (`api/src/routes/v1/workflows.ts:326,499`); plan approve `approvedBy: z.string().optional()` (`tasks.ts:995`); `decidedBy` is a closed enum of _mechanisms_, not persons (`shared/src/approval.ts:6-16`). **Machine-principal separation for spawned agents is strong:** `buildAgentEnv` is an allowlist that scrubs every `*_TOKEN/*_KEY/*_SECRET` and all `STUDIO_*`, forwarding only PATH/HOME/locale/git-identity + an injected `STUDIO_RUN_ID` id (`api/src/services/agent-env.ts:263-309`); named residual — agents can still read provider keys from `~/.studio/settings.local.json` via file tools until OS sandbox (`:15-17`, L-3198d018). Entitlement is a **separate** local principal (Polar license → `~/.studio/license.json` 0600 + `license_cache` db v31, 7-day offline grace; portal endpoints are public/no-auth) — `api/src/services/license.ts`, `db/index.ts:127-131`.

**3. Git credentials.** Opt-in per-spawn (`github:true`), host-derived (`GH_TOKEN` github.com / `GH_ENTERPRISE_TOKEN` GHE), HTTPS-only, additive to git's helper chain; `GITHUB_TOKEN` deliberately stays scrubbed; token referenced by var-name so it never lands in a config value (`agent-env.ts:142-143,186-192,281-307`). **Two documented residual leaks (tracked L-bd770677):** SSH remotes get neither credential nor the loud explainer (`:107-113`); git's `credential approve` calls `store` on the whole chain, so macOS `osxkeychain` can **persist a forwarded short-lived token** into the dev's real keychain (`:114-120`).

**4. Cloudflare boundary (Lesto/Snackday).** Governed by ADR 0003 (**Accepted**): CF creds enter only the server-side run env, never board/messages/prompts/logs/diffs/previews/client storage; Roof never receives a CF token (`snackday/docs/adr/0003:19-24`). Implemented: `buildDeployEnv` = scrubbed allowlist + `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` + non-secret config, and **refuses `CLOUDFLARE_API_KEY`** (global key), verified by `deploy.test.ts:143,179` (`api/src/services/deploy.ts:33-73`). Snackday's `apps/web/wrangler.jsonc` is a minimal generated config with **no token in-repo**; deploy is `lesto deploy --cloudflare`. Deployed-app auth (`@lesto/auth`) is a separate concern from deployment authority (ADR 0003:24). Named residual: a proxy URL can embed `user:pass@host` visible to the build hook (`deploy.ts` comment).

**5. Leakage surfaces.** Centralized `redactSecrets` covers `Bearer/Basic/Token`, `password=/api_key=/token=…`, Linear `lin_api_…`; applied to Sentry frames, failure-evidence, operator-memory (`api/src/log.ts:214-238,410-415`). Access log records **path only**, never query string (`server.ts:134-146`). **Gap:** Roof tool-result previews are bounded 4000-char snapshots of tool stdout rendered into chat (`OperatorSession.swift:172-175`) with **no Studio-side redaction** — a tool that echoes a secret surfaces it in the Roof transcript.

## Options

- **A — Ratify ADR 0008 as-is.** Cheapest; leaves attribution + osxkeychain gaps unaddressed.
- **B — Ratify + a "known divergences" appendix** enumerating the four implemented gaps with owners/tracking IDs. Same cost, honest, no code change.
- **C — Ratify + close the approval-identity gap before leaving pilot** (bind `resolvedBy/approvedBy` to an authenticated principal, or document that pilot approvals are human-gated so the field is advisory).

## Recommendation

**Adopt B now; schedule C as a gate on leaving pilot.** The implemented system already realizes ADR 0008's _credential separation_ well (scrubbed agent env, server-side-only CF/GitHub creds, Roof holding only connection material, separate Polar entitlement). The genuine divergence is **identity/attribution**, not credential containment: one shared bearer token makes "who approved" client-asserted text. That is acceptable _only while every consequential approval is human-gated_ (ADR 0003:26) — the load-bearing assumption to make explicit. B ratifies the true state; C is the work that must precede any weakening of the human gate.

## Risks

- **Attribution spoofing** — any token holder can POST `resolvedBy:"alice"`; forgery surface the moment approval identity is trusted for audit or gates money/merge without a human (`workflows.ts:499`).
- **Coarse revocation** — one token = full API; `token rotate` restarts the shared daemon and drops all sessions (`bin/cli.ts:2536-2545`); no per-session revoke.
- **osxkeychain residue (L-bd770677)** — forwarded token replayable indefinitely from the dev's real keychain.
- **Agent reads `settings.local.json` provider keys** despite the env scrub — injection→key-read is one file-tool call until OS sandbox.
- **Roof transcript leakage** — previews bypass `redactSecrets`.

## Falsification / reversal triggers

- Any caller trusting `resolvedBy/approvedBy` for a **non-human-gated** decision → flip to C-blocking-now.
- A CF/provider key found in db, task message, Sentry event, or Roof preview → ADR 0003/0008 containment falsified; escalate.
- `SecretKey` growing beyond `{studioURL, studioToken}` → ADR 0008 "Roof stores only…" falsified.
- A spawned agent env containing any `*_TOKEN`/`STUDIO_*` outside the named `GH_TOKEN`/`STUDIO_RUN_ID` exceptions → `buildAgentEnv` regression.

## Decisions requiring a human

1. Is client-asserted approval identity acceptable for the pilot? (If no, C is a launch blocker.)
2. Seat-loss / device-loss / mid-turn rotation policy — today a rotated token 401s and the in-flight operator turn dies without resume (L-89afc749).
3. Reviewer-independence requirement — nothing enforces approver ≠ agent author today.
4. osxkeychain persistence (L-bd770677) — accept, or fix before pilot.
5. Real Polar org id — still `PLACEHOLDER_ORG_ID = 'org_PLACEHOLDER_studio_pro'` (`license.ts`), a human one-timer.

## Acceptance tests (read-only / non-secret-value)

1. **Actor honesty** — extend `workflows.route.test.ts` to assert a supplied `resolvedBy` is stored verbatim (proves it's unauthenticated; documents, doesn't fix).
2. **Agent-env scrub** — `buildAgentEnv` with synthetic `STUDIO_TOKEN/ANTHROPIC_API_KEY/GITHUB_TOKEN`; assert none survive, only allowlist + `STUDIO_RUN_ID` (`agent-env.test.ts`).
3. **Deploy boundary** — assert `buildDeployEnv` forwards `CLOUDFLARE_API_TOKEN`, not `CLOUDFLARE_API_KEY` (extends `deploy.test.ts:154,179`); add a `no STUDIO_*` case.
4. **Log redaction** — feed `redactSecrets` synthetic `Bearer …`, `lin_api_…`, `CLOUDFLARE_API_TOKEN=…`; assert masked; assert access log for a `?token=` request is path-only.
5. **Roof preview leak** — confirm no redactor wraps `OperatorSession.preview`; a synthetic secret-in-stdout should be reproduced in the transcript.
6. **Keychain surface guard** — assert `SecretKey.allCases == [studioURL, studioToken]` so any future secret trips review.

**Studio-tooling friction to file as board tasks** (per global CLAUDE.md; not filed here — read-only probe): unauthenticated `resolvedBy`/`approvedBy`; unredacted Roof tool previews; the two L-bd770677 credential residues.

---

_Report is ~1,450 words. I could not persist it to the plan file (Write tool is disabled in this context) and there is no implementation phase to approve, so I've delivered it inline. If you'd like, I can also draft the exact Studio board task bodies for the three friction items above, or run any of the six acceptance tests as read-only inspections._
