# 0008 — Platform identity, entitlements, and credentials

- Status: Accepted (amended) — principal separation ratified as implemented, with a
  known-divergences appendix; the approval-identity clause is hardened by the red-team RCA and
  gates the D6 merge-authorization ledger
- Date: proposed 2026-07-16; adjudicated 2026-07-17
- Decider: Chief Architect (adjudication task `L-9f36cd26`, under platform decision `L-710ba74e`)

## Context

The platform crosses client licensing, orchestration authority, git hosting, deployment providers,
and deployed application identity. Treating one token or user string as all of these authorities
would make audit and revocation unreliable. The 2026-07-16 red-team RCA additionally proved that
records shaped like authorization without an authenticated authority behind them are post-hoc
attribution — which converts this ADR's identity clause from a pilot caveat into a gating
condition for release authority (D6).

## Decision

### 1. Separate principals by authority — ratified as implemented

No token is reused across authorities; each is stored, rotated, and revoked by its own system:

| Principal                    | Authorizes                                            | Storage / boundary (verified in source)                                                                 |
| ---------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Roof seat entitlement        | unlocks the client (Phase E — not yet shipped)        | Polar; Roof Keychain holds **only** `{studioURL, studioToken}` (`SecretKey`, CaseIterable-guarded)        |
| Studio principal             | orchestration, approvals, budgets, hosted access      | single bearer token, `~/.studio/token` (0600) + pidfile discovery; full-API scope                        |
| Studio entitlement           | license/pro features                                  | separate Polar license → `~/.studio/license.json` (0600) + db cache, 7-day offline grace                  |
| Git provider identity        | repository operations                                 | opt-in per-spawn `GH_TOKEN` (host-derived, HTTPS-only), the one named exception to the `*_TOKEN` scrub    |
| Cloudflare credentials       | deployment                                            | server-side only (`buildDeployEnv` allowlist; global `CLOUDFLARE_API_KEY` **refused**, ADR 0003)          |
| Application identity         | the deployed product (Snackday)                       | `@lesto/auth`, fully separate from deployment authority                                                   |

Machine principals are separated at the spawn boundary: `buildAgentEnv` is an explicit allowlist
that scrubs every `*_TOKEN`/`*_KEY`/`*_SECRET` and all `STUDIO_*`, forwarding only an injected
`STUDIO_RUN_ID` run identity (plus the named `GH_TOKEN` exception when requested).

### 2. Approval identity — amended wording, hardened by the RCA

The proposed text said "Studio stamps authoritative actors." **Present tense was wrong**: the
implementation stamps whatever the client asserts — `resolvedBy`/`approvedBy` are optional free
text defaulting to `'user'` (`workflows.ts:326,468,499`; `tasks.ts:995,2208`), and one shared
bearer token means any holder can assert any name. The accepted clause is:

- **Today:** actor fields are **advisory attribution, not authorization**. This is acceptable only
  while every consequential approval is human-gated (ADR 0003's standing rule) — that assumption
  is now stated explicitly rather than implied.
- **Hardened requirement:** authenticated, server-stamped approval identity with
  implementer-independence lineage is a **prerequisite of the D6 merge-authorization ledger**
  (`L-957b8149`, in flight), not merely of leaving pilot. A ledger fed by spoofable actor strings
  cannot satisfy its own verification requirement that the implementer's run cannot approve
  itself. No receipt derived from client-asserted identity may enter a release manifest (ADR 0007
  §6).
- Human and machine approvers get distinct, server-stamped identities when that system lands.

### 3. Credential containment and redaction — ratified, with one clause extended

Repository and deployment credentials remain server-side and never enter UI state, prompts, task
messages, logs, notification previews, or release manifests. Centralized `redactSecrets` covers
Sentry frames, failure evidence, and operator memory; the access log records path only, never
query strings. **Extended by this adjudication:** the "never enter" list explicitly includes
**Roof transcript and tool-result previews** — today the bounded 4000-char tool-result preview
(`Sources/OperatorKit/OperatorSession.swift:172-175`) bypasses redaction, a named divergence
below.

### 4. Rotation, revocation, offline, device loss

- Rotation is coarse by design in v0: one token = full API; `token rotate` restarts the shared
  daemon. The engine now **resumes in-flight operator turns across that restart** (`L-89afc749`,
  shipped) — rotation is a pause, not a kill. Per-session/per-principal revocation does not exist
  and is deliberately deferred until hosted mode needs it.
- Offline: Roof launches locally with pidfile discovery (no token needed on loopback); the Studio
  entitlement carries a 7-day offline grace. Seat-loss/device-loss policy is a named human
  decision below.
- Hosted/hybrid: the same principal-separation rule applies unchanged — a remote Studio is an
  authenticated remote principal; topology never merges authorities (ADR 0006 / D3). Hosted-mode
  token flows are design-stage; nothing here pre-authorizes them.

## Known divergences (appendix — tracked, owned, not hidden)

1. **Client-asserted approval identity** — `resolvedBy`/`approvedBy` free text defaulting
   `'user'`; also surfaces as `agent:unknown` on the CLI's primary write verb (`L-f164f81b`), and
   operator-memory approve is human-only by discipline, not capability (`L-3d6d030d`). Closed by
   the Option-C work gating D6 (§2).
2. **osxkeychain residue + silent SSH no-credential** (`L-bd770677`) — git's `credential approve`
   chain can persist a forwarded short-lived token into the dev's real keychain; SSH remotes get
   neither credential nor the loud explainer.
3. **Agent file-read of provider keys** (`L-3198d018`) — the env scrub cannot stop a file-tool
   read of `~/.studio/settings.local.json` until OS-level sandboxing lands.
4. **Roof preview redaction gap** — tool-result previews bypass `redactSecrets`
   (§3; task filed under roof).

## Evidence reviewed (adjudication 2026-07-17)

- Identity/credentials threat-model probe (`L-084f70a1`,
  `docs/platform/probes/identity-credentials.md`) — facts 1–5 with file-level citations.
- **Live re-verification during this adjudication:** `resolvedBy`/`approvedBy` client-asserted
  defaults confirmed at the cited lines; `buildAgentEnv` allowlist + `STUDIO_RUN_ID`-only
  injection + deliberate `GH_TOKEN` exception confirmed; `buildDeployEnv` refuses
  `CLOUDFLARE_API_KEY` (source comment + `deploy.test.ts:143,179`); Roof `SecretKey` is exactly
  `{studioURL, studioToken}` (CaseIterable); the unredacted 4000-char preview confirmed at
  `OperatorKit/OperatorSession.swift:172-175` (the probe's `RoofApp/` path had drifted — substance
  intact). One probe risk found **stale and corrected**: mid-turn restart no longer kills operator
  turns (`L-89afc749` completed).
- ADR 0003 (Accepted) verified implemented at the deploy boundary.
- Red-team gate-bypass RCA (2026-07-16) — the basis of the hardened clause in §2.

## Rejected alternatives

- **Ratify as-is (probe Option A)** — leaves the attribution gap unnamed while the RCA is open;
  "Studio stamps authoritative actors" would be false on its face.
- **Block everything on authenticated identity now (Option C everywhere)** — over-rotation:
  credential *containment* is sound and verified; the human-gate assumption holds while
  automation is paused. C gates D6 and any weakening of the human gate — not the pilot itself,
  unless the human decision below says otherwise.
- **One platform-wide SSO/token** — the failure mode this ADR exists to prevent: audit and
  revocation become unreliable the moment one credential spans authorities.

## Consequences

- **Security:** the trust boundary is honest — one shared token gates outsiders; past it,
  attribution is advisory and every consequential approval is human-gated until authenticated
  identity lands. Containment regressions are mechanically detectable (see reversal triggers).
- **Operability:** rotation restarts the daemon but resumes work; no per-session revocation until
  hosted mode; offline launch works locally without ceremony.
- **Migration:** when server-stamped identity lands, existing advisory fields remain as historical
  attribution — no rewrite of past records into claims of authorization.

## Reversal triggers

- Any caller trusts `resolvedBy`/`approvedBy` for a **non-human-gated** decision → Option C
  becomes blocking immediately, everywhere.
- Any provider key found in the db, a task message, a Sentry event, or a Roof preview →
  containment falsified; escalate as an incident.
- `SecretKey` grows beyond `{studioURL, studioToken}` → Roof storage clause falsified.
- A spawned agent env carries any `*_TOKEN`/`STUDIO_*` beyond the named `GH_TOKEN`/`STUDIO_RUN_ID`
  exceptions → `buildAgentEnv` regression; fail the gate.

## Open named human decisions

1. Is client-asserted approval identity acceptable for the **attended pilot**? (If no, Option C
   blocks launch, not just D6.)
2. Seat-loss / device-loss / deliberate-revocation policy — what a revoked principal kills vs
   resumes (restart-resume is solved; revocation semantics are not).
3. Reviewer-independence enforcement — approver ≠ author is enforced nowhere today; the D6 ledger
   design must say how it will be.
4. osxkeychain residue (`L-bd770677`) — accept for pilot, or fix first.
5. Real Polar org id — `PLACEHOLDER_ORG_ID` in `license.ts` is a human one-timer.

## Implementation owners and blocking edges

- **studio** — Option C: authenticated, server-stamped approval identity + implementer-independence
  lineage, designed with (and prerequisite to) the `L-957b8149` ledger; the probe's six read-only
  acceptance tests landed as documenting tests (actor-honesty, env-scrub, deploy-boundary,
  redaction, preview-leak, keychain-surface).
- **roof** — redact tool-result previews before render (route them through a redaction pass
  mirroring `redactSecrets`).
- Existing tracked items: `L-bd770677` (credential channel residues), `L-3198d018` (OS sandbox),
  `L-f164f81b` (CLI actor attribution), `L-3d6d030d` (operator-memory approve capability gap).
