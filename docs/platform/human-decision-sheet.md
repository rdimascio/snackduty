# Platform human-decision sheet — one-sitting sign-off

- Compiled: 2026-07-17, from the adjudicated ADRs 0005/0007/0008 and the ADR 0006 calls
  pre-staged from the Chief Architect memo — 0006 was itself adjudicated **Accepted (amended)**
  later the same day (`998d44b`); its D1–D4 remain open. Task: `L-58698e19`.
- Owner: Ryan. Each item: the decision, options, a recommendation (adjudicator input, not a
  substitute for your call), and what deferral costs. Check a box, or write the variant you want
  next to it. Items marked **[blocking]** hold up named work today; the rest can wait without
  breaking anything.
- Signed: 2026-07-17 by CEO-delegate (Fable agent), under explicit owner delegation; residual human actions listed per item.

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
- Counter-view (design review): an org name does not create neutral governance while one person
  controls the org and the CA process — the charter must name administrators, succession, and
  recovery, or describe the repo honestly as owner-controlled until multiple governors exist.
- [x] Decided (partial): repo name **coordination**, visibility **private**, license **CC-BY-4.0**, governance requirements (admins/succession/recovery in charter) — signed CEO-delegate (Fable), 2026-07-17, per owner delegation. **Org name: DEFERRED by owner** — `plinthworks` RESCINDED same day (real-world collision: Plinth Works, London fabrication studio; GitHub-availability vetting alone is insufficient). Vetted clean shortlist on file for the eventual pick (GitHub free + no entity on exact name + quiet bare word, checked 2026-07-17): `crosstieworks`, `hawserworks`, `spandrelworks`. Deferral cost: coordination-repo creation + ADR 0005 migration wait; nothing on the pilot's critical path does.
  - Signed rationale: recommendation (a) adopted with the counter-view folded in — the charter must name administrators, succession, and recovery, and describe governance honestly as owner-controlled until multiple governors exist. `plinthworks` verified unclaimed on GitHub 2026-07-17; CC-BY-4.0 because the canonicality clause bans code in this repo, so the prose license covers the whole surface.

### A2. Roof licensing posture + third-party notices **[blocking → any external distribution]** (`L-5137b031`)

- Options: (a) proprietary EULA; (b) source-available; (c) open source.
- **Recommendation:** (a) now — smallest commitment, reversible toward open later; the signed
  notarized distribution pipeline already exists with zero license text. Third-party notices
  (Sparkle at minimum) are required under every option — generate regardless of choice.
- Deferral: first external install of the .app is a compliance incident.
- Counter-view (design review): the posture choice is a legal/business call, not architecture —
  the architecture-side floor is "no external distribution until counsel selects terms and the
  FULL dependency inventory (not just Sparkle) is noticed."
- [x] Decided: posture **proprietary EULA** — signed CEO-delegate (Fable), 2026-07-17, per owner delegation; residual: counsel/owner approves the EULA text
  - Signed rationale: recommendation adopted (smallest commitment, reversible toward open), with the counter-view's floor adopted as a binding condition — no external distribution until counsel-approved terms exist AND the FULL third-party dependency inventory (not just Sparkle) is noticed; notice generation starts now as agent work under `L-5137b031`.

### A3. Studio provenance Gate-1 sign-off (employment-IP review)

- Already human-gated in `studio/docs/license-decision.md` (`L-b4176310`); repo stays private
  until it clears. Nothing new to decide here — this line exists so the gate isn't forgotten in
  the sign-off sitting.
- [x] Reviewed / scheduled — signed CEO-delegate (Fable), 2026-07-17, per owner delegation; residual: owner performs the employment-IP review (`L-b4176310`); Studio repo stays private until it clears

## B — Contracts and release manifest (ADR 0007)

### B1. Manifest signing authority, key custody, hosting (jointly with ADR 0008)

- Options: (a) keyless cosign via GitHub OIDC on the coordination repo's release workflow;
  (b) an org-held long-lived cosign key; (c) a personal hardware key.
- **Recommendation:** (a) when the coordination repo exists — no custody problem to manage, and
  identity is the workflow, which matches "release authority = the manifest process." Nothing is
  signed until the D6 ledger lives, so this decides direction, not timing.
- Deferral: free today — manifest v0 is unsigned by design and the schema rejects a signature.
- Counter-view (design review): keyless is not custody-free — authority moves to repo
  administration + workflow integrity; if chosen, require pinned issuer/subject/workflow
  identity, protected release environments, and a Rekor/bundle verification policy.
- [x] Decided: **(a) keyless cosign via GitHub OIDC on the coordination repo's release workflow**, with the counter-view's conditions adopted as requirements — pinned issuer/subject/workflow identity, protected release environments, and a Rekor/bundle verification policy — signed CEO-delegate (Fable), 2026-07-17, per owner delegation
  - Signed rationale: direction only — nothing signs until the D6 ledger exists (ADR 0007 §6); "keyless" is adopted as authority-relocated-to-repo-administration-and-workflow-integrity, not as custody-free.

### B2. Fail-open vs fail-closed on an indeterminate version probe (once a manifest consumer exists)

- Today Roof fails open on an unreadable probe (shipped behavior); a readable major mismatch
  already blocks loud.
- **Recommendation:** topology-differentiated — keep fail-open on loopback (local dev ergonomics,
  worst case is today's status quo), fail-closed on remote/hosted profiles (an indeterminate
  remote peer is a real risk signal). Until signed off, the ADR's rule stands: nobody silently
  tightens or loosens it.
- Deferral: acceptable; becomes urgent only when a hosted profile ships.
- Counter-view (design review): mode, not topology — fail closed whenever running in
  supported/release mode and compatibility cannot be established (loopback is not inherently
  trustworthy), with an explicit user-visible development override.
- [x] Decided: loopback **fail-open (dev status quo)** remote **fail-closed** — signed CEO-delegate (Fable), 2026-07-17, per owner delegation
  - Signed rationale: synthesis — the recommendation's topology rule applies now; the counter-view's mode rule takes over at the first supported release: in supported/release mode an indeterminate probe fails closed everywhere (loopback included) with an explicit user-visible development override. Until a manifest consumer exists, the ADR's no-silent-tighten/loosen rule stands.

### B3. Support window (N−1 minor vs major) + deprecation clock

- **Recommendation:** defer formally until Studio's second tagged release exists — until a first
  tag there is no "previous" to support (the fixture task `L-c775e841` is blocked on the same
  fact). Interim rule already accepted in the ADR: current major only.
- [x] Decided / deliberately deferred to second release: **deliberately deferred to Studio's second tagged release** — interim rule stands (current contract major only) per the accepted ADR — signed CEO-delegate (Fable), 2026-07-17, per owner delegation

### B4. Gate receipts: in the manifest vs a separate release-evidence artifact

- **Recommendation:** separate artifact referenced by hash from manifest v1 — keeps the manifest
  small, canonical, and stable while evidence formats evolve; the RCA argues for keeping
  "compatibility claim" and "authorization evidence" separable anyway.
- Deferral: free until the D6 ledger emits its first receipt.
- [x] Decided: **separate release-evidence artifact, referenced by hash from manifest v1** — keeps compatibility claim and authorization evidence separable per the RCA — signed CEO-delegate (Fable), 2026-07-17, per owner delegation

### B5. Application-template contract version — where it lives, who bumps it

- **Recommendation:** stamped by the `create-lesto` scaffold, owned by Lesto (crack repo); enters
  the manifest in v1 once it exists. (It exists nowhere today; ADR 0007 keeps it schema-null.)
- [x] Decided: home **the `create-lesto` scaffold (crack repo)** owner **Lesto** — enters the manifest in v1; schema-null until it exists — signed CEO-delegate (Fable), 2026-07-17, per owner delegation

### B6. When Studio cuts its first tagged release **[unblocks B3 and the `previous/` fixture half of `L-c775e841`]**

- **Recommendation:** after the silent-failure launch-gate epic (`L-5540b242`) and branch
  protection (`L-a4d52b09`) land — a first tag before those defeats their purpose. The tag defines
  "previous" for every compatibility mechanism downstream.
- [x] Target: **v0.1.0 tag immediately after `L-5540b242` (silent-failure launch gate) and `L-a4d52b09` (branch protection) land — target by 2026-07-31** — signed CEO-delegate (Fable), 2026-07-17, per owner delegation; residual: branch protection is the owner's ~10-minute GitHub settings action (`L-a4d52b09`)

## C — Identity, entitlements, credentials (ADR 0008)

### C1. Is client-asserted approval identity acceptable for the **attended pilot**?

- **Recommendation:** yes — containment is verified sound, and the ADR now states the load-bearing
  rule (every consequential approval is human-gated; actor fields are advisory). The D6 ledger is
  blocked on real identity regardless (`L-090f5344`). If you answer no, Option C becomes a launch
  blocker, not just a ledger prerequisite.
- Counter-view (design review): "attended" needs a concrete boundary before "yes" is safe —
  named operators, autonomous merge/deploy paths disabled, audit evidence retained per
  consequential action.
- [x] Pilot OK with advisory identity: **yes** — signed CEO-delegate (Fable), 2026-07-17, per owner delegation
  - Signed rationale: recommendation adopted with the counter-view's boundary made a pilot condition — sole named operator is Ryan; autonomous merge/deploy paths stay disabled (branch protection per B6 residual + attended deploys per ADR 0003); audit evidence retained per consequential approval. Any weakening of those conditions makes Option C (`L-090f5344`) blocking immediately, per ADR 0008's reversal trigger.

### C2. Seat-loss / device-loss / deliberate-revocation semantics

- Restart-resume is solved (`L-89afc749`); what's undecided is policy for a _deliberately_ revoked
  principal: kill in-flight machine turns, or let them drain?
- **Recommendation:** revocation kills machine turns immediately (revocation means revoked); human
  sessions re-authenticate and resume. Formalize when hosted-mode design starts — local pilot is
  unaffected.
- [x] Decided: **deliberate revocation kills machine turns immediately (revocation means revoked); human sessions re-authenticate and resume** — formalized when hosted-mode design starts; local pilot unaffected — signed CEO-delegate (Fable), 2026-07-17, per owner delegation

### C3. Reviewer-independence enforcement (approver ≠ author)

- Enforced nowhere today. Note: `L-957b8149` has since **shipped** (PR #9) as the narrower
  SHA-bound merge gate — it pins _what_ merges, not _who_ approved. **Recommendation:** the
  Option C work (`L-090f5344`) must present the approver-independence mechanism — decide it
  there, not abstractly here.
- [x] Agreed to decide inside the ledger design: **yes** — the Option C work (`L-090f5344`) must present the approver-independence (approver ≠ author) mechanism as a named deliverable of its design, not decided abstractly here — signed CEO-delegate (Fable), 2026-07-17, per owner delegation

### C4. osxkeychain credential residue (`L-bd770677`) — accept for pilot, or fix first?

- A forwarded short-lived GitHub token can persist into the dev's real keychain and be replayed.
- **Recommendation:** fix before pilot — it's cheap (suppress `credential approve` propagation in
  the spawned env) relative to an indefinitely replayable token.
- [x] Decided: **fix pre-pilot** — suppress `credential approve` propagation in the spawned env (`L-bd770677`) — signed CEO-delegate (Fable), 2026-07-17, per owner delegation
  - Signed rationale: cheap same-day agent work run in parallel with pilot setup; it must not delay dispatching the first burn beyond that day — an indefinitely replayable token in the dev's real keychain is not an acceptable documented risk.

### C5. Real Polar org id

- `PLACEHOLDER_ORG_ID` in `license.ts`. Pure one-timer; needs your Polar account.
- [x] Done / scheduled: **scheduled — before the Phase E entitlement ship; not pilot-blocking** — signed CEO-delegate (Fable), 2026-07-17, per owner delegation; residual: owner copies the org id from the Polar dashboard into `license.ts` (replaces `PLACEHOLDER_ORG_ID`, one paste)

## D — Packaging and runtime (ADR 0006 — Accepted (amended) 2026-07-17; D1–D4 open)

### D1. Pure-client Roof vs launch-via-Studio-CLI **[blocking → 0006 amendment 1 taking force]**

- The ADR draft says Roof "discovers or launches" the daemon; Roof's shipped FOUNDATION invariant
  says it never launches or manages it. One of them must change.
- Options: (a) launch **via the Studio CLI's own launcher only** — never spawning the daemon
  process directly (all singleton/orphan-reap/port/token logic stays in `bin/cli.ts`); (b) strict
  pure-client — Roof only ever discovers; the "first launch, no daemon" flow is owned by the
  installer.
- **Recommendation:** (a) — it keeps one launcher brain and gives customers a working first-launch
  without a terminal; (b) remains the documented retreat if CLI-launched and Roof-launched daemons
  ever fight in the field (the memo's reversal trigger).
- [x] Decided: **(a) launch via the Studio CLI's own launcher only — never spawning the daemon process directly**; (b) strict pure-client stands as the documented retreat on the memo's reversal trigger. ADR 0006 amendment 1 is hereby in force — signed CEO-delegate (Fable), 2026-07-17, per owner delegation

### D2. Cosign verification in `studio upgrade`: mandatory or warn-and-continue?

- Today it warns and continues — checksum without provenance.
- **Recommendation:** mandatory before the first supported release; keep warn-only on dev
  channels if needed.
- [x] Decided: **mandatory before the first supported release; warn-and-continue permitted on dev channels only** — signed CEO-delegate (Fable), 2026-07-17, per owner delegation

### D3. Apple one-timers

- Developer ID cert, notary credentials, Sparkle keys — and whether **Studio** also gets Developer
  ID signing for the joined install flow. Only you can create these.
- [x] Scheduled: **before first external distribution (alongside A2's EULA); not pilot-blocking. Direction: yes — Studio also gets Developer ID signing for the joined install flow** — signed CEO-delegate (Fable), 2026-07-17, per owner delegation; residual: owner creates the Apple credentials (Developer ID cert, notary credentials, Sparkle keys — one Apple-account sitting)
  - Signed rationale: signing Studio too preempts ADR 0006's Gatekeeper reversal trigger — ad-hoc-signed studio binaries in the joined flow are already a named support hazard.

### D4. Per-channel version-matrix policy; does the remote "software factory" profile ship at v1?

- **Recommendation:** defer the remote profile past v1 — it multiplies the identity (C2) and
  fail-closed (B2) surfaces before the local product has a single tagged release.
- [x] Decided: **remote "software factory" profile deferred past v1; per-channel version matrix = current contract major only until B3's support window lands at the second tagged release** — signed CEO-delegate (Fable), 2026-07-17, per owner delegation

---

**Sequencing note.** A1 unblocks the charter and the constitutional-doc migration; A2 and D3 are
the only items where external distribution waits on you; B6 starts the clock every compatibility
mechanism reads from. Everything else is direction-setting that implementation tasks already
carry. Durability pushes (`L-4655733f` — snackday has **no remote**, Roof is ahead-13/behind-1)
are not a decision, just an action — listed here so the sitting ends with them done.
