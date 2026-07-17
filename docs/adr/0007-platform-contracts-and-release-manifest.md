# 0007 — Platform contracts and release manifest

- Status: Proposed
- Date: 2026-07-16
- Decider: Chief Architect

## Context

The products release independently, but users need a tested platform combination. Lockstep versions
would erase useful independence; best-effort latest-version compatibility would fail unpredictably.

## Proposed decision

Version each public seam independently. Introduce the release manifest in stages.

Manifest v0 is an unsigned, deterministic CI/local artifact. It contains:

- Roof, Studio, Lesto, and proof-application commit identities and durability state;
- Studio OpenAPI and WebSocket schema hashes;
- pinned producer/consumer contract facts and their computed consistency state;
- database schema and application dependency facts that exist in committed source;
- declared unknowns for missing releases, deployment state, and rollback evidence;
- repository gate facts and rollback coordinates that can be derived without credentials.

It uses canonical RFC 8785 JSON, a sidecar SHA-256 digest, and a deterministic timestamp derived
from the pinned commits. Verification distinguishes artifact corruption, non-canonical encoding,
schema failure, pinned-content mismatch, internal inconsistency, environmental failure, and normal
world drift. A negative test suite must prove that forged claims fail closed.

Manifest v0 cannot claim a signature, application-template contract version, or merge-authorization
receipt. Those fields are absent or schema-constrained to null until their authoritative systems
exist. A later manifest schema may add:

- signed artifact and platform-release identities;
- supported version ranges and required feature capabilities;
- application-template contract versions and migration requirements;
- exact-SHA merge-authorization receipts from the fail-closed authorization ledger;
- verified deployment targets and exercised rollback coordinates.

Connections and releases fail loud on an unsupported combination. Additive compatibility is tested
against current and previous supported versions; breaking changes require a new contract version
and migration guidance.

## Evidence required

- Implement the v0 generator, verifier, and tamper suite from
  `docs/platform/probes/release-manifest-v0.md`.
- Generate the manifest twice for the current repositories and prove byte-for-byte reproducibility.
- Run Roof contract tests against current, previous, and incompatible Studio fixtures.
- Run a Lesto application against the declared minimum and current supported framework versions.
- Roll back one component and prove the manifest identifies a valid compatible set.

## Current evidence

- Repository and artifact inventory: complete.
- Manifest v0 schema and verification design: complete.
- Generator/verifier/tamper execution: not started.
- Signing and merge-authorization receipts: intentionally deferred; their authorities do not yet
  exist.
