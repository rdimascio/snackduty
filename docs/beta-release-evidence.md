# Coach–parent beta release evidence

This record separates behavior implemented in source from evidence gathered in a local process, on the selected staging runtime, and in a distributed TestFlight build. A passing local test does not promote a row into either remote column.

## Evidence matrix

| Boundary                                                            | Source or command                                         | Implemented | Locally verified          | Staging verified | TestFlight released |
| ------------------------------------------------------------------- | --------------------------------------------------------- | ----------- | ------------------------- | ---------------- | ------------------- |
| Apple challenge and cryptographic identity-token verification       | `apps/web/test/beta-journey.test.ts`                      | Yes         | Pending integrated run    | No               | No                  |
| Stable provider-subject identity and verified-email claim           | `apps/web/test/beta-journey.test.ts`                      | Yes         | Pending integrated run    | No               | No                  |
| Session restore, server revocation, expiry, and logout              | `apps/web/test/beta-journey.test.ts`                      | Yes         | Pending integrated run    | No               | No                  |
| One adult coaches one team and parents on another                   | `apps/web/test/beta-journey.test.ts`                      | Yes         | Pending integrated run    | No               | No                  |
| Owner-only delegation and co-coach operational access               | `apps/web/test/beta-journey.test.ts`                      | Yes         | Pending integrated run    | No               | No                  |
| Recipient-bound invitation forwarding, rotation, replay, and expiry | `apps/web/test/beta-journey.test.ts`                      | Yes         | Pending integrated run    | No               | No                  |
| Cross-team, cross-season, and unrelated-child privacy boundaries    | `apps/web/test/beta-journey.test.ts`                      | Yes         | Pending integrated run    | No               | No                  |
| Durable runtime migrations and persistence                          | `bun run --filter web test apps/web/test/runtime.test.ts` | Yes         | See current check receipt | No               | No                  |
| Invitation intent persisted before idempotent delivery              | invitation outbox focused tests                           | Yes         | See current check receipt | No               | No                  |
| Native contract decoding and session/selection state                | SnackdayDomain tests                                      | Yes         | See current check receipt | No               | No                  |
| Native launch, Apple sheet, team switching, and failure recovery    | `bun run ios:test:ui`                                     | Yes         | See current check receipt | No               | No                  |

“Pending integrated run” must be replaced by the exact reviewed commit and a passing command before release approval. “See current check receipt” means the integration ledger or CI receipt for the reviewed commit is authoritative; this document does not copy a stale pass claim forward.

## Required release receipts

Record these against the same reviewed commit:

| Check                              | Receipt |
| ---------------------------------- | ------- |
| `bun run check:fast`               | Pending |
| `bun run check:scenario`           | Pending |
| `bun run ios:test:ui`              | Pending |
| `bun run accept`                   | Pending |
| `bun run gate`                     | Pending |
| Independent integrated-diff review | Pending |

For native checks, record the discovered simulator destination and the nonzero named-test counts. Keep failure logs redacted and attach screenshots to the release record rather than embedding child-sensitive data here.

## Account-dependent evidence

The following remain incomplete until they run with real external accounts and deployed configuration:

- Remote staging has a durable volume, backup destination, Apple audience, issuer/key retrieval, invitation provider credentials, and health endpoint configured.
- A live Apple identity token signs in an adult on staging, restores after process restart, and stops working after server-side revocation.
- A delivered invitation reaches the verified recipient, rejects a forwarded link, and retries idempotently through the deployed provider.
- The signed Release build uses the staging HTTPS origin, contains no development-auth route or automatic preview success state, and passes the native journey on TestFlight.
- The build is uploaded, external/internal beta access is configured as intended, and the released build number is recorded.

Never satisfy these rows with a development persona, a mocked identity verifier, an in-memory delivery recorder, or a preview fixture.
