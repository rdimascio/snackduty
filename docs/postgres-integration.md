# PostgreSQL runtime integration

Run from the repository root after `bun install --frozen-lockfile`:

```sh
bash scripts/runtime/postgres-integration.sh
```

Prerequisites: Bun 1.3.5, OpenSSL, PostgreSQL server tools (`initdb`, `pg_ctl`,
`psql`, and `pg_config`), and permission to bind a local port. Run as a normal
user; PostgreSQL refuses root. To select an installed PostgreSQL version, set
`SNACKDAY_TEST_PG_BIN` to its `bin` directory. CI selects PostgreSQL 16.

The harness creates and removes its own temporary database cluster, certificate,
and random password. It ignores `DATABASE_URL`. TCP binds only to loopback,
requires TLS and SCRAM authentication, and rejects plaintext connections. The
application uses its real `@lesto/pg` opener and `sslmode=verify-full` with the
temporary certificate as its trusted CA. No AWS resources or existing database
are involved. The test asserts encryption through PostgreSQL's `pg_stat_ssl`.

Coverage includes every application migration and migration replay, durable
verified sessions after closing and reopening a pool, authorization, encrypted
outbox delivery, recipient binding, database-enforced acceptance rollback,
simultaneous invitation retries through independent application pools, duplicate
creation, both orderings of acceptance against revoke/resend, and concurrent
event/snack creation with one persisted idempotency receipt. Concurrency tests
hold a real team row lock, observe waiting requests in `pg_stat_activity`, and
release the lock only after both operations have reached PostgreSQL.

The ordinary product suite skips this integration test unless the harness sets
`SNACKDAY_TEST_POSTGRES_URL`. The dedicated **PostgreSQL runtime integration** CI
job always runs the harness and fails on setup or runtime errors. Add that check
to the repository's required checks before merging PostgreSQL changes.

This is local database/runtime evidence. It does not prove RDS reachability,
IAM permissions, AWS release identity, backup restoration, or ALB health.

The separate **Linux image build and boot** workflow adds PostgreSQL 16 TLS
readiness through the actual image installer, root launcher and systemd service.
It rotates a synthetic database password between starts, checks an application
row and migration ledger survive, and rejects invalid CA material. Its Secrets
Manager boundary is explicitly synthetic; see [AWS evidence](./aws-staging-evidence.md).
