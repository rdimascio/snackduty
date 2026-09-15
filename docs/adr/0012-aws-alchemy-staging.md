# 0012 — Declare AWS staging with Alchemy and keep RDS private

- Status: Accepted for implementation; deployment blocked on PostgreSQL runtime evidence
- Date: 2026-09-15
- Baseline: `699f6ce` (merged PRs #4–#5)

## Context

ADR 0010 selected one Bun process and durable SQLite for the first beta host.
The product owner has now selected AWS EC2 and RDS inside one VPC, managed with
Alchemy. This changes the storage substrate: the current runtime still calls
`openSqlite` and the SQLite backup tooling cannot verify RDS. Provisioning RDS
before that application migration would create a paid database the application
cannot use.

The sibling Lesto repository's accepted ADR 0044 and working examples pin
`alchemy@0.93.12`. Inspection of that installed package confirms typed AWS Cloud
Control resources for EC2 instances, RDS instances, load balancers, IAM and
Route 53, plus an S3 state store. Snackday has no Alchemy dependency yet, so its
package and lockfile registration stays with the central integration owner.

## Decision

Declare the staging graph in `infra/alchemy/alchemy.run.ts`, using the verified
Alchemy 0.93.12 API:

- one DNS-enabled VPC in an explicitly selected AWS region;
- two public subnets in distinct availability zones for an internet-facing
  application load balancer;
- one EC2 API host in the primary public subnet, with no SSH ingress and IMDSv2
  required;
- two private, unrouted database subnets for the RDS subnet group;
- one encrypted PostgreSQL RDS instance, pinned to the primary availability
  zone for low API-to-database latency, with seven-day backups and AWS-managed
  master credentials;
- TLS termination on the load balancer with an existing regional ACM
  certificate and a Route 53 alias for the selected hostname;
- security groups that permit public HTTPS to the load balancer, load balancer
  traffic to the API on port 3000, and PostgreSQL on port 5432 only from the API
  security group;
- an EC2 role limited to Systems Manager plus reading the RDS-generated secret
  and one explicitly named runtime secret.

The EC2 host has a public address only for outbound provider and AWS API access.
It accepts application traffic solely from the load balancer security group.
Database traffic resolves and travels privately inside the VPC. This avoids a
NAT gateway for the single-host staging topology while preserving a private RDS
endpoint. A later multi-instance production topology should move application
hosts to private subnets and assess per-AZ NAT or VPC endpoints separately.

Alchemy state lives in an existing encrypted and versioned S3 bucket, namespaced
by app and stage. Deploys must be serialized because the verified 0.93.12 S3
store does not supply a distributed lock. AWS credentials come only from the
standard SDK credential chain. No access key, database password, or application
secret is accepted in source configuration.

The stack refuses create and update phases unless
`SNACKDAY_POSTGRES_RUNTIME_VERIFIED=1`. This flag is evidence, not a development
override: it may be set only after the real application composition, canonical
migrations, authorization journeys, concurrent writes, backup/restore and
rollback have passed on the selected PostgreSQL version. Read-only state
inspection remains possible before that point. The pure `plan.ts` path performs
identifier validation and emits the intended topology without AWS calls.

RDS deletion protection is enabled. An operationally reviewed database
retirement procedure must first preserve a final snapshot and explicitly remove
protection; a routine Alchemy destroy is expected to fail while protection is
active.

## Application image contract

The EC2 AMI is an immutable, reviewed artifact identified by both AMI ID and
source artifact digest. Its root volume must be encrypted and it must include a
`snackday.service` unit that reads the
root-only `/etc/snackday/staging.env` file written at boot. That file contains
the public origin, Apple client ID, database endpoint, database secret ARN,
runtime secret ARN and artifact digest. It contains no secret value. The service
must retrieve secrets through its instance role and must fail closed if any
required value or PostgreSQL migration is unavailable.

## Evidence and remaining work

Locally verified in this slice:

- strict parsing rejects malformed regions, zones, hostnames, certificate ARNs,
  AMI IDs and artifact digests;
- the plan fixes the database to private subnets and makes the primary API and
  database availability zone identical;
- targeted tests prove the PostgreSQL deployment gate fails closed;
- the Alchemy program type-checks against the exact installed 0.93.12 package.

No AWS resource was created, adopted, changed or destroyed. Hosted staging is
still incomplete until the application PostgreSQL lane, package registration,
real account identifiers, read-only Alchemy preview, attended deployment,
remote probes, durable backup/restore and authenticated acceptance journeys all
pass on one reviewed commit.
