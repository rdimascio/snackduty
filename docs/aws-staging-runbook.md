# AWS staging deployment runbook

Status: deployment verification is implemented locally. No AWS resources, credentials, hosted
database, DNS name, or staging release have been created or verified.

This runbook targets one Snackday Bun/Lesto API on EC2 and PostgreSQL on RDS in the same VPC. It
uses [Alchemy](https://alchemy.run/) for the resource graph and the AWS CLI only for read-only
post-deploy verification. The verifier always reports `stagingVerified: false`; real adult
authentication, invitation delivery, restart persistence, and rollback acceptance are separate
release gates.

## Current integration gate

Do not deploy the graph until the application artifact can boot with the following runtime seam:

```text
SNACKDAY_DATABASE_DIALECT=postgres
DATABASE_URL=<injected from the AWS secret at process start>
SNACKDAY_DATABASE_POOL_MAX=10
```

As of the baseline for this runbook, `runtime:serve` deliberately refuses the PostgreSQL selection
until the root application composition supplies the Lesto PostgreSQL driver to the application,
sessions, queue, and invitation outbox. The Alchemy stack must retain its explicit PostgreSQL
readiness guard until the integrated PostgreSQL tests and the complete product gate pass. A
locally validated infrastructure plan is not permission to bypass that guard.

## Target topology

- Alchemy owns one named `staging` stack and stores shared deployment state with `AWS.state()` in
  the target AWS account and Region. Do not use local `.alchemy` state for staging or CI.
- An internet-facing Application Load Balancer terminates HTTPS. The API EC2 instance runs in an
  application subnet and accepts application traffic only from the load balancer security group.
- RDS PostgreSQL is not publicly accessible. Its security group accepts TCP 5432 only from the API
  security group. The application receives the connection URL from a secret at runtime; it never
  appears in Alchemy outputs, target files, logs, or receipts.
- EC2 and RDS share one VPC and Region. Prefer placing the current EC2 instance in the RDS writer's
  Availability Zone to avoid cross-AZ latency. RDS still needs a multi-subnet group for recovery;
  an RDS failover can move the writer and temporarily make the path cross-AZ.
- RDS storage is encrypted and automated backup retention is at least seven days. Every release
  also has an available encrypted manual pre-deploy snapshot.
- Keep one API instance for the beta until queue-worker and migration concurrency have explicit
  PostgreSQL evidence. The database is durable independently of the EC2 host.

Alchemy's current AWS provider includes EC2, VPC/networking, and RDS resources. Its v2 API is beta,
so the repository must pin an exact reviewed version in `bun.lock` rather than resolving `latest`
during a deployment. Relevant upstream references are the [AWS setup and shared state
guide](https://alchemy.run/aws/setup/), [VPC helper](https://alchemy.run/aws/networking/), [runtime
selection](https://alchemy.run/aws/compute/choosing-a-runtime/), and [RDS
guide](https://alchemy.run/aws/data/rds/).

## Plan without creating resources

1. Confirm the intended AWS account and Region using a narrowly scoped AWS SSO profile. Do not
   paste credentials into a shell history, repository file, task, or log.
2. Run the locked checks and build the immutable application artifact. Record its SHA-256 digest
   and the exact 40-character Git commit.
3. Preview the graph. Alchemy's `plan` and `deploy --dry-run` are read-only; `deploy`, `destroy`,
   and `unsafe nuke` are not.

```sh
aws sts get-caller-identity --profile <staging-profile>
bun alchemy plan --stage staging --profile <staging-profile> --detailed
```

Review the plan for one VPC, the intended public/private subnets, narrowly scoped security groups,
one load balancer, one EC2 instance, one private encrypted PostgreSQL RDS instance, and the required
secret/IAM resources. Reject replacements of the VPC, database, database subnet group, or database
secret unless the release explicitly calls for them. Alchemy shows and confirms a plan before
applying it; do not use `--yes` for an attended staging deployment.

## Non-secret verification target

After Alchemy resolves resource identifiers, create an untracked target JSON file. It contains
identifiers and artifact coordinates only. Do not include `DATABASE_URL`, a database endpoint,
secret ARN, session token, invitation token, Apple token, or AWS credential.

```json
{
  "schema": "snackday/aws-staging-target/v1",
  "stage": "staging",
  "awsAccountId": "123456789012",
  "region": "us-west-2",
  "hostname": "staging.example.com",
  "publicBaseUrl": "https://staging.example.com",
  "vpcId": "vpc-0123456789abcdef0",
  "apiInstanceId": "i-0123456789abcdef0",
  "apiSubnetId": "subnet-0123456789abcdef0",
  "apiSecurityGroupId": "sg-0123456789abcdef0",
  "apiPort": 3000,
  "loadBalancerArn": "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/snackday/0123456789abcdef",
  "loadBalancerDnsName": "snackday-0123456789.us-west-2.elb.amazonaws.com",
  "loadBalancerSecurityGroupId": "sg-00112233445566778",
  "databaseInstanceId": "snackday-staging",
  "databaseSubnetGroupName": "snackday-staging-private",
  "databaseSecurityGroupId": "sg-0fedcba9876543210",
  "databasePort": 5432,
  "minimumBackupRetentionDays": 7,
  "preDeploySnapshotId": "snackday-staging-pre-release-20260915",
  "releaseCommit": "0123456789abcdef0123456789abcdef01234567",
  "artifactDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "previousArtifactDigest": null
}
```

Use `null` for `previousArtifactDigest` only on the first staging release, when no application
artifact exists to roll back to. Later releases must record the real prior digest. Unknown fields
are rejected so a connection string or other secret cannot be silently carried into the target
file.

Validate the file without AWS credentials, commands, or network calls:

```sh
bun scripts/runtime/aws-staging-preflight.ts /absolute/path/to/target.json
```

The dry-run receipt marks every cloud check as `planned` and keeps all verification fields false.

## Backup, migration, and readiness order

Perform these steps sequentially for an attended release:

1. Confirm `bun run gate` passed on `releaseCommit` and the artifact digest matches that reviewed
   source.
2. Confirm RDS automated backup retention is at least seven days and point-in-time recovery has a
   current restorable window.
3. Create a manual pre-deploy snapshot and wait until it is `available`. Record its identifier in
   the target file. RDS manual snapshots persist until explicitly deleted.
4. Apply the reviewed Alchemy plan with one API instance. Startup must run the canonical
   application migration list before `/readyz` returns 200. Capture the redacted `runtime.ready`
   receipt, including `migrations_applied`; absence of that receipt is a failed release.
5. Run the live preflight below. Then exercise live Apple identity, session restoration, two-team
   tenancy, recipient-bound invitation delivery, event creation, own-child RSVP, and snack claim.
6. Restart or replace the EC2 process and repeat session restoration plus the saved coordination
   read. This is the durable RDS evidence that health checks alone cannot provide.

Example snapshot commands, run only during the attended release:

```sh
aws rds create-db-snapshot \
  --db-instance-identifier <database-instance-id> \
  --db-snapshot-identifier <pre-release-snapshot-id> \
  --region <region> \
  --profile <staging-profile>

aws rds wait db-snapshot-available \
  --db-snapshot-identifier <pre-release-snapshot-id> \
  --region <region> \
  --profile <staging-profile>
```

RDS automated backups support point-in-time recovery within their retention window, while a manual
snapshot is retained independently. See AWS's [backup and restore
guide](https://docs.aws.amazon.com/AmazonRDS/latest/gettingstartedguide/managing-backup-restore.html).

## Read-only live preflight

The live mode runs only these bounded operations:

- `ec2 describe-instances` for the named API instance;
- `sts get-caller-identity` for exact account binding;
- `elbv2 describe-load-balancers` for the named public entry point;
- `rds describe-db-instances` for the named database;
- `ec2 describe-security-groups` for the API and database security groups;
- `rds describe-db-snapshots` for the named pre-deploy snapshot;
- HTTPS `GET /health`, `GET /readyz`, and `POST /api/dev/sign-in`.

It verifies a running EC2 instance, an available private encrypted PostgreSQL database in the same
VPC, at least the configured backup retention, database ingress only from the API security group,
API ingress only from the load balancer security group, an available encrypted manual snapshot no
more than 24 hours old, matching DNS answers for the public origin and verified load balancer, and
the existing preliminary runtime surface. It never reads or prints a database endpoint or secret.

```sh
AWS_PROFILE=<staging-profile> \
  bun scripts/runtime/aws-staging-preflight.ts /absolute/path/to/target.json --live \
  > /absolute/path/to/redacted-preflight-receipt.json
```

A nonzero exit means at least one AWS account, topology, snapshot, origin binding, health,
readiness, or development-auth check failed. A zero exit still reports `stagingVerified: false`
until the authenticated and durability journeys above have their own receipts.

## Rollback drill

Prefer rolling back only the EC2 application artifact when the previous artifact is compatible
with the migrated schema. Repoint to the exact `previousArtifactDigest`, wait for `/readyz`, then
repeat the authenticated journeys. Never silently run down-migrations.

The first staging release has no previous application artifact. Its rollback options are restoring
the database into a new instance and deploying a newly reviewed corrective artifact, or removing
the unreleased environment before any real user data exists.

When data restoration is required:

1. Stop application writes and record the recovery point and expected data-loss window.
2. Restore the pre-deploy snapshot or a chosen point in time to a **new** RDS identifier. RDS does
   not restore a snapshot over the existing instance.
3. Attach the same private subnet group and database security group, verify encryption and backup
   retention, then create a new secret value for the restored endpoint. Do not overwrite or print
   the old secret.
4. Point the previous immutable artifact at the new secret, start one API instance, and require
   the migration compatibility check plus `/readyz` before reopening traffic.
5. Repeat live identity, tenancy, invitation, persistence, and coordination acceptance. Retain the
   failed database for diagnosis until the rollback is accepted.
6. Record the restored database identifier, source snapshot or point in time, previous artifact
   digest, start/end timestamps, and acceptance receipts. Cleanup is a later explicit operation.

AWS restores create a new DB instance and leave the source intact; see [Restoring to a DB
instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RestoreFromSnapshot.html).

## Evidence required before calling staging verified

- exact AWS account alias/ID, Region, Alchemy stage and reviewed plan receipt;
- immutable source commit and artifact digest;
- VPC, subnet, security-group, load-balancer, EC2 and RDS identifiers;
- redacted migration/readiness receipt and successful live preflight receipt;
- live Apple identity, session restore/revoke/logout and recipient-bound invitation evidence;
- two-team isolation and event → RSVP → snack-claim evidence using non-production test people;
- EC2 restart persistence evidence;
- backup identifier, retention/PITR evidence, and a successful restore/rollback drill;
- independently reviewed diff and passing checks on the deployed commit.

Keep TestFlight release status separate. A healthy AWS runtime and a signed simulator build do not
prove an App Store Connect upload or physical-device Apple sign-in.
