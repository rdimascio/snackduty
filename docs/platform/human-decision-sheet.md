# Platform human-decision sheet — one-sitting sign-off

- Compiled: 2026-07-17, from the adjudicated ADRs 0005/0007/0008 (all Accepted-amended) and the
  pending ADR 0006 calls named by the Chief Architect memo. Task: `L-58698e19`.
- Owner: Ryan. Each item: the decision, options, a recommendation (adjudicator input, not a
  substitute for your call), and what deferral costs. Check a box, or write the variant you want
  next to it. Items marked **[blocking]** hold up named work today; the rest can wait without
  breaking anything.

## A — Coordination repository (ADR 0005)

### A1. Org, name, visibility, license of the coordination repo **[blocking → charter `L-68325e9d`, repo creation, ADR migration]**

- Options: (a) a new neutral platform org; (b) `lesto-run`; (c) personal `rdimascio`.
- Constraints already decided: not under `every-io`; not blocked on Studio's provenance gate; do
  not bake the provisional "Studio" name into it (`L-7455a0fb`); private initially; plain-docs
  license.
- **Recommendation:** (a) a new neutral org with a product-agnostic name; Apache-2.0 (docs) or
  CC-BY-4.0. `lesto-run` is a workable second choice but quietly grants the framework's org the
  platform's constitution.
- Deferral: the charter, repo creation, and the ADR-migration clause all wait; constitutional docs
  stay in the proof-app repo.
- [ ] Decided: org ____________ name ____________ visibility ______ license ______

### A2. Roof licensing posture + third-party notices **[blocking → any external distribution]** (`L-5137b031`)

- Options: (a) proprietary EULA; (b) source-available; (c) open source.
- **Recommendation:** (a) now — smallest commitment, reversible toward open later; the signed
  notarized distribution pipeline already exists with zero license text. Third-party notices
  (Sparkle at minimum) are required under every option — generate regardless of choice.
- Deferral: first external install of the .app is a compliance incident.
- [ ] Decided: posture ______

### A3. Studio provenance Gate-1 sign-off (employment-IP review)

- Already human-gated in `studio/docs/license-decision.md` (`L-b4176310`); repo stays private
  until it clears. Nothing new to decide here — this line exists so the gate isn't forgotten in
  the sign-off sitting.
- [ ] Reviewed / scheduled

## B — Contracts and release manifest (ADR 0007)

### B1. Manifest signing authority, key custody, hosting (jointly with ADR 0008)

- Options: (a) keyless cosign via GitHub OIDC on the coordination repo's release workflow;
  (b) an org-held long-lived cosign key; (c) a personal hardware key.
- **Recommendation:** (a) when the coordination repo exists — no custody problem to manage, and
  identity is the workflow, which matches "release authority = the manifest process." Nothing is
  signed until the D6 ledger lives, so this decides direction, not timing.
- Deferral: free today — manifest v0 is unsigned by design and the schema rejects a signature.
- [ ] Decided: ______

### B2. Fail-open vs fail-closed on an indeterminate version probe (once a manifest consumer exists)

- Today Roof fails open on an unreadable probe (shipped behavior); a readable major mismatch
  already blocks loud.
- **Recommendation:** topology-differentiated — keep fail-open on loopback (local dev ergonomics,
  worst case is today's status quo), fail-closed on remote/hosted profiles (an indeterminate
  remote peer is a real risk signal). Until signed off, the ADR's rule stands: nobody silently
  tightens or loosens it.
- Deferral: acceptable; becomes urgent only when a hosted profile ships.
- [ ] Decided: loopback ______ remote ______

### B3. Support window (N−1 minor vs major) + deprecation clock

- **Recommendation:** defer formally until Studio's second tagged release exists — until a first
  tag there is no "previous" to support (the fixture task `L-c775e841` is blocked on the same
  fact). Interim rule already accepted in the ADR: current major only.
- [ ] Decided / deliberately deferred to second release: ______

### B4. Gate receipts: in the manifest vs a separate release-evidence artifact

- **Recommendation:** separate artifact referenced by hash from manifest v1 — keeps the manifest
  small, canonical, and stable while evidence formats evolve; the RCA argues for keeping
  "compatibility claim" and "authorization evidence" separable anyway.
- Deferral: free until the D6 ledger emits its first receipt.
- [ ] Decided: ______

### B5. Application-template contract version — where it lives, who bumps it

- **Recommendation:** stamped by the `create-lesto` scaffold, owned by Lesto (crack repo); enters
  the manifest in v1 once it exists. (It exists nowhere today; ADR 0007 keeps it schema-null.)
- [ ] Decided: home ______ owner ______

### B6. When Studio cuts its first tagged release **[unblocks B3 and the `previous/` fixture half of `L-c775e841`]**

- **Recommendation:** after the silent-failure launch-gate epic (`L-5540b242`) and branch
  protection (`L-a4d52b09`) land — a first tag before those defeats their purpose. The tag defines
  "previous" for every compatibility mechanism downstream.
- [ ] Target: ______

## C — Identity, entitlements, credentials (ADR 0008)

### C1. Is client-asserted approval identity acceptable for the **attended pilot**?

- **Recommendation:** yes — containment is verified sound, and the ADR now states the load-bearing
  rule (every consequential approval is human-gated; actor fields are advisory). The D6 ledger is
  blocked on real identity regardless (`L-090f5344`). If you answer no, Option C becomes a launch
  blocker, not just a ledger prerequisite.
- [ ] Pilot OK with advisory identity: yes / no

### C2. Seat-loss / device-loss / deliberate-revocation semantics

- Restart-resume is solved (`L-89afc749`); what's undecided is policy for a *deliberately* revoked
  principal: kill in-flight machine turns, or let them drain?
- **Recommendation:** revocation kills machine turns immediately (revocation means revoked); human
  sessions re-authenticate and resume. Formalize when hosted-mode design starts — local pilot is
  unaffected.
- [ ] Decided: ______

### C3. Reviewer-independence enforcement (approver ≠ author)

- Enforced nowhere today. **Recommendation:** the `L-957b8149` ledger design must present its
  enforcement mechanism as part of Option C (`L-090f5344`, related-edged) — decide the mechanism
  there, not abstractly here.
- [ ] Agreed to decide inside the ledger design: yes / no

### C4. osxkeychain credential residue (`L-bd770677`) — accept for pilot, or fix first?

- A forwarded short-lived GitHub token can persist into the dev's real keychain and be replayed.
- **Recommendation:** fix before pilot — it's cheap (suppress `credential approve` propagation in
  the spawned env) relative to an indefinitely replayable token.
- [ ] Decided: fix pre-pilot / accept documented risk

### C5. Real Polar org id

- `PLACEHOLDER_ORG_ID` in `license.ts`. Pure one-timer; needs your Polar account.
- [ ] Done / scheduled: ______

## D — Packaging and runtime (ADR 0006 — pending adjudication; decisions pre-staged)

### D1. Pure-client Roof vs launch-via-Studio-CLI **[blocking → 0006 adjudication text]**

- The ADR draft says Roof "discovers or launches" the daemon; Roof's shipped FOUNDATION invariant
  says it never launches or manages it. One of them must change.
- Options: (a) launch **via the Studio CLI's own launcher only** — never spawning the daemon
  process directly (all singleton/orphan-reap/port/token logic stays in `bin/cli.ts`); (b) strict
  pure-client — Roof only ever discovers; the "first launch, no daemon" flow is owned by the
  installer.
- **Recommendation:** (a) — it keeps one launcher brain and gives customers a working first-launch
  without a terminal; (b) remains the documented retreat if CLI-launched and Roof-launched daemons
  ever fight in the field (the memo's reversal trigger).
- [ ] Decided: ______

### D2. Cosign verification in `studio upgrade`: mandatory or warn-and-continue?

- Today it warns and continues — checksum without provenance.
- **Recommendation:** mandatory before the first supported release; keep warn-only on dev
  channels if needed.
- [ ] Decided: ______

### D3. Apple one-timers

- Developer ID cert, notary credentials, Sparkle keys — and whether **Studio** also gets Developer
  ID signing for the joined install flow. Only you can create these.
- [ ] Scheduled: ______

### D4. Per-channel version-matrix policy; does the remote "software factory" profile ship at v1?

- **Recommendation:** defer the remote profile past v1 — it multiplies the identity (C2) and
  fail-closed (B2) surfaces before the local product has a single tagged release.
- [ ] Decided: ______

---

**Sequencing note.** A1 unblocks the charter and the constitutional-doc migration; A2 and D3 are
the only items where external distribution waits on you; B6 starts the clock every compatibility
mechanism reads from. Everything else is direction-setting that implementation tasks already
carry. Durability pushes (`L-4655733f` — snackday has **no remote**, Roof is ahead-13/behind-1)
are not a decision, just an action — listed here so the sitting ends with them done.
