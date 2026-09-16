# AWS staging evidence and handoff

## Baseline, September 15, 2026

PR #6 baseline `ff983842f90ab42d241e93631a843f2f08c29103` had successful
[product CI](https://github.com/rdimascio/snackduty/actions/runs/35015352050),
platform-manifest and GitGuardian checks. Downloaded product logs record 301 web
tests passing in both fast and full gates. This is baseline evidence, not a claim
about later commits.

The unchanged local HTTP test reproduced `EADDRINUSE` on ephemeral port **0**
inside the restricted agent sandbox. The exact same command outside the sandbox
passed all 14 runtime tests and 60 assertions. For future agents: reproduce this
environment boundary before changing test ports, retries, or assertions. A port-0
error here did not demonstrate a competing process or a product defect.

## Independent review

Astra and Sol independently reviewed the foundation and hardening changes.
Validated findings included CLI/SDK credential precedence disagreement, a
scope-level region option ignored by Cloud Control, a string-valued RDS port,
first-boot systemd restart exhaustion, and duplicate TLS URL parameters.
The fixes bind one account-verified credential snapshot and region, parse the
actual provider model, skip startup until configuration exists, and reject
duplicate `sslmode` parameters. Focused regressions cover these boundaries.

Real PostgreSQL testing additionally reproduced a duplicate acceptance returning
404 and an event retry raising a receipt uniqueness error. Transactions now lock
the team row before invitation state or event receipt decisions. Deterministic
two-pool tests also cover duplicate invitation creation and both orderings of
acceptance versus revocation/rotation. All 45 integration assertions passed on
PostgreSQL 14.20 with Bun 1.4.2. CI selects PostgreSQL 16 with Bun 1.3.5.

The integrated fast gate passed 306 web tests (the PostgreSQL test is separately
gated), 29 domain tests, 39 manifest tests and 61 script tests. Seven infrastructure
tests, four boot tests, infrastructure typecheck, shell syntax, the real Alchemy
provider import and the web build also passed. The provider import caught a
missing optional `@aws-sdk/client-s3` peer; it is now explicitly pinned and checked
in offline CI. Full product/hosted evidence must refer to the final pushed commit.

The DNS gate deliberately fails closed when independent origin/ALB DNS snapshots
disagree. ALB address rotation or DNS caching can cause a transient false failure;
wait for TTL expiry and rerun with fresh resolution rather than overriding the
gate. Listener, target and release checks are still required.

The release endpoint reports boot-verified archive identity. It is operational
evidence within the reviewed host trust boundary, not cryptographic remote
attestation. An administrator controlling the host can falsify its response.

## Gates that remain external

No AWS resource creation or deployment occurred. The Packer recipe has not built
an AMI; Linux image installation, EC2 boot, Secrets Manager permissions, RDS
reachability, log arrival, SNS delivery, and restore/rollback acceptance remain
unverified. Packer itself was unavailable in the local environment. Required
account, network, image, certificate, sender and release identifiers must be real
and reviewed before an attended provisioning run. Keep `stagingVerified: false`.

Use the [PostgreSQL harness](./postgres-integration.md),
[AMI recipe](../infra/ami/README.md), and [staging runbook](./aws-staging-runbook.md)
for reproducible checks and the evidence required to close these gates.
