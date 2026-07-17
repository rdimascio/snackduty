# Platform manifest v0 execution evidence

Executed locally on 2026-07-16 without network access, credentials, daemon access, or writes to sibling repositories.

## Result

- Two independent collections of the four repositories produced byte-identical canonical manifests (`cmp` exit 0).
- The unmodified manifest passed all verifier phases (exit 0).
- The preserved manifest SHA-256 is `aa319413d71ea7058157013632361022bee1efe53cef85f44a3b3c92d6745885`.
- The twelve-case tamper suite returned every documented failure class at its exact expected code.
- The tamper command verifies the source artifact first and aborts unless it exits cleanly.

The preserved artifacts are:

- `evidence/platform-manifest-v0.json`
- `evidence/platform-manifest-v0.json.sha256`

## Pinned repository state

| Component | Pinned HEAD                                | Durable | Reason when not durable                                           |
| --------- | ------------------------------------------ | ------- | ----------------------------------------------------------------- |
| Lesto     | `ecb0d42137d173ae65952d12cb66b39adc772de2` | yes     | —                                                                 |
| Roof      | `f1f3abbdede732dd647798fca8ddfd93ac098be3` | no      | local branch 12 ahead and 1 behind its local upstream ref         |
| Snackday  | `54443aac30847ca0a02529de93823a54e48d713e` | no      | dirty working tree and no upstream                                |
| Studio    | `46f7f7d4f2cf798dab9e5262855118abf6ad50f8` | no      | dirty working tree and one commit ahead of its local upstream ref |

Dirty state is recorded as non-authoritative operational evidence. All content facts and hashes were collected from pinned Git objects, never from sibling working-tree files.

## Negative controls

| Mutation                                             | Expected | Actual |
| ---------------------------------------------------- | -------: | -----: |
| Pinned OpenAPI hash changed                          |        6 |      6 |
| Canonical content re-indented                        |        3 |      3 |
| Signature claim set to true                          |        2 |      2 |
| Fabricated authorization receipt                     |        2 |      2 |
| Pinned HEAD truncated                                |        2 |      2 |
| Valid 40-character but unavailable HEAD              |       10 |     10 |
| Alternate existing commit with different pinned data |        6 |      6 |
| Null-ledger entry removed                            |        7 |      7 |
| Compatibility status left inconsistent with versions |        7 |      7 |
| Pinned deploy schema version changed consistently    |        6 |      6 |
| Throwaway shared clone advanced by an empty commit   |        5 |      5 |
| Sidecar digest changed                               |        4 |      4 |

The world-drift control creates and advances a shared clone under the operating system temporary directory. It does not modify a source repository. The alternate-existing-commit control recomputes the deterministic timestamp so the manifest stays internally consistent and reaches pinned-content verification.

## Truthfulness boundary

The artifact is explicitly unsigned. Merge authorization receipts and the template contract do not exist and remain `null`. NPM state, deployed Snackday version, and app migration versions were not remotely or operationally verified and remain declared unknowns. Rollback facts and operational repository facts are non-authoritative evidence, not release authorization.

The canonical evidence JSON is excluded from repository formatting by `.oxfmtrc.json`. The final evidence check runs `bun run format:check` between hashing and verification, then checks the digest again, so formatting cannot silently invalidate the sidecar.

This proves deterministic local generation and tamper classification. It does not make the pinned set a release candidate: three of four repository states are non-durable.
