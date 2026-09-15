# Staging runtime runbook

Status: locally implemented and locally verified. No hosted staging environment,
provider account, hostname, or durable volume has been configured or verified.

## Runtime shape

The beta runtime is one Bun process serving the canonical Lesto application over
HTTP behind a provider-managed HTTPS proxy. SQLite lives on one attached persistent
volume. The process uses the same `createApplication` factory and ordered application
migrations as development; the runtime adds lifecycle, readiness, redaction, and
storage operations around that composition.

Do not run more than one application instance against this SQLite file. Moving to
multiple writers requires the separately planned Postgres/Hyperdrive migration and
transaction verification work.

The runtime fails closed:

- `SNACKDAY_RUNTIME_MODE` accepts only `staging` or `production`.
- `LESTO_DB` must be an absolute path and cannot be `:memory:`.
- `SNACKDAY_PUBLIC_BASE_URL` must be a credential-free HTTPS origin.
- Development sign-in is disabled in composition and `/api/dev/*` is withheld at
  the serving boundary.
- Invitation create/resend returns 503 until a real persisted delivery adapter is
  injected. It never reports a memory-only delivery as success.
- Calendar bearer-token routes remain withheld until every upstream proxy log is
  configured and verified to avoid request paths. Set
  `SNACKDAY_UPSTREAM_CREDENTIAL_PATH_LOGGING_SAFE=true` only after that verification.
- Application access logs and request traces redact calendar feed tokens.

## Required configuration

| Variable                                         | Example                        | Requirement                                                                                 |
| ------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `SNACKDAY_RUNTIME_MODE`                          | `staging`                      | Explicitly `staging` or `production`                                                        |
| `LESTO_DB`                                       | `/data/snackduty/snackduty.db` | Absolute path on the mounted persistent volume                                              |
| `SNACKDAY_PUBLIC_BASE_URL`                       | `https://staging.example.com`  | Public HTTPS origin, without credentials/query/fragment                                     |
| `SNACKDAY_APPLE_CLIENT_ID`                       | `com.snackday.app`             | Required exact registered Apple token audience; example is not account verification         |
| `SNACKDAY_INVITATION_OUTBOX_KEY`                 | Secret store only              | Canonical base64 32-byte encryption key, required when real invitation delivery is injected |
| `HOST`                                           | `0.0.0.0`                      | Optional; defaults to `0.0.0.0`                                                             |
| `PORT`                                           | `3000`                         | Optional; defaults to `3000`                                                                |
| `SNACKDAY_UPSTREAM_CREDENTIAL_PATH_LOGGING_SAFE` | `false`                        | Optional explicit Boolean; defaults to false                                                |

`bun run runtime:serve` starts this runtime; runtime sources are included in the
web TypeScript project. The configured Apple audience creates the real Apple JWKS
verifier. A real invitation adapter must still be injected through
`runRuntimeFromEnvironment` together with its encrypted outbox key. The default
unavailable adapter fails closed; it does not send mail. Never substitute the
development persona or recorder for a remote provider.

## Local durability proof

Use a new absolute scratch directory. The command creates the directory, runs the
real application migrations, persists and restores a Lesto session across process
reopen, takes an online SQLite backup, restores it to a new database, checks SQLite
integrity/foreign keys, prints a JSON receipt, and removes the scratch directory.

```sh
bun scripts/runtime/verify-local.ts /tmp/snackduty-runtime-proof
```

The focused tests additionally exercise the real team create/list APIs, verify the
same session after database restart, and prove that data written after a backup is
absent from the restored copy:

```sh
bun test apps/web/test/runtime.test.ts apps/web/test/runtime-probe.test.ts
```

These commands are local evidence. Their receipts deliberately set
`stagingVerified` to false.

## Health and deployment order

Configure the platform's liveness check as `GET /health` and readiness check as
`GET /readyz`. Liveness proves the Bun server is responding; readiness executes
`SELECT 1` against the configured database.

For each staging release:

1. Record the application commit, image digest, target hostname, volume identifier,
   current database path, and intended release identifier.
2. Create and retain an integrity-checked backup on a different durable storage
   location. The command refuses relative paths and existing destinations.
3. Deploy exactly one instance from the reviewed immutable artifact with the volume
   mounted at the configured absolute path. Startup applies the canonical pending
   migrations before the server becomes ready.
4. Wait for readiness, then run the bounded remote probe.
5. Exercise authenticated identity, session restoration, two-team tenancy, and
   invitation delivery against real configured accounts. Store redacted receipts.
   Health alone is not staging verification.

```sh
bun scripts/runtime/storage.ts backup \
  /data/snackduty/snackduty.db \
  /backups/snackduty/pre-release-<release>.db

bun scripts/runtime/probe-remote.ts https://<staging-host>
```

The probe checks health, readiness, and absence of development sign-in. Even a
passing probe reports only `preliminarySurfaceVerified`; it cannot prove durable
persistence or authenticated product journeys.

## Restore and rollback drill

Restore never overwrites a live file. Stop the application, restore to a new path,
verify the copy, then point `LESTO_DB` at the restored path and start the prior
immutable application artifact. This makes the database selected for rollback
explicit and retains the failed database for diagnosis.

```sh
bun scripts/runtime/storage.ts restore \
  /backups/snackduty/pre-release-<release>.db \
  /data/snackduty/rollback-<release>.db

bun scripts/runtime/storage.ts verify \
  /data/snackduty/rollback-<release>.db
```

A database restore discards writes made after its source backup. Record that data
loss window and obtain operational approval before a hosted rollback. If the prior
artifact is compatible with the migrated schema, prefer rolling back only the
application artifact and retaining the current database.

The rollback receipt is complete only after the prior artifact reaches readiness
and the real authenticated acceptance journeys pass against the selected database.

## Hosted evidence still required

The following non-secret identifiers are needed before staging can be selected and
verified:

- hosting provider/project and region;
- staging hostname;
- persistent volume identifier, mount path, size, and backup retention target;
- immutable application artifact/image identifier;
- upstream proxy/load-balancer request logging policy and its verification receipt;
- Apple team ID, registered iOS bundle ID (the native token audience), and real
  adult test account identifiers;
- verified invitation sender/domain and safe recipient test addresses.

Keep `staging verified` and `TestFlight released` incomplete until those real-host,
real-account journeys and rollback receipts exist.
