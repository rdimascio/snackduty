# AWS staging infrastructure

This directory contains Snackday's reviewed staging resource graph for
`alchemy@0.93.12`. It declares one VPC, two public subnets, two private database
subnets, an HTTPS application load balancer, one EC2 API host, and one private
RDS PostgreSQL instance. The API and primary database placement share an
availability zone; traffic between them stays on the VPC network.

No resource is ready to deploy yet. The checked-in application runtime still
opens SQLite, so `alchemy.run.ts` refuses create and update phases unless
`SNACKDAY_POSTGRES_RUNTIME_VERIFIED=1` is explicitly set. Set that flag only
after the application and its canonical migrations have passed against the
selected PostgreSQL version. `--read` remains available for state inspection.

The stack uses the AWS credential chain and an existing, encrypted, versioned
S3 bucket for shared Alchemy state. It never accepts AWS keys as application
configuration. Serialize deployments because Alchemy 0.93.12's S3 state store
does not provide a distributed deployment lock.

## Non-secret inputs

- `SNACKDAY_DEPLOY_STAGE` (use `staging`)
- `SNACKDAY_AWS_REGION`
- `SNACKDAY_AWS_PRIMARY_AZ` and `SNACKDAY_AWS_SECONDARY_AZ`
- `SNACKDAY_STAGING_HOSTNAME`
- `SNACKDAY_ROUTE53_HOSTED_ZONE_ID`
- `SNACKDAY_ACM_CERTIFICATE_ARN` in the selected region
- `SNACKDAY_API_AMI_ID` for the reviewed immutable application image
- `SNACKDAY_API_ARTIFACT_DIGEST` as `sha256:<64 lowercase hex characters>`
- `SNACKDAY_APPLE_CLIENT_ID`
- `SNACKDAY_RUNTIME_SECRET_ARN`
- `SNACKDAY_POSTGRES_ENGINE_VERSION`
- `ALCHEMY_STATE_BUCKET`
- optional `SNACKDAY_API_INSTANCE_TYPE` (default `t3.small`)
- optional `SNACKDAY_RDS_INSTANCE_CLASS` (default `db.t4g.micro`)

The AMI must use an encrypted root volume and provide a `snackday.service` unit that reads
`/etc/snackday/staging.env`. The stack writes only non-secret endpoints and
secret ARNs to that root-readable file. The instance role can read exactly the
RDS-managed master secret and the configured runtime secret. There is no SSH
ingress; operators use AWS Systems Manager.

## Safe local inspection

`plan.ts` validates all identifiers and prints a credential-free topology plan
without importing Alchemy or contacting AWS:

```sh
bun infra/alchemy/plan.ts
bun test infra/alchemy/config.test.ts
```

After the PostgreSQL runtime gate is satisfied, preview Alchemy's resource
changes with its read-only mode before any deployment:

```sh
bun infra/alchemy/alchemy.run.ts --read
```

The root package owner must register the repository-pinned Alchemy dependency
before this is runnable from a clean Snackday checkout. Until then, the stack is
type-checked against the sibling Lesto repository's installed
`alchemy@0.93.12`, the same version its accepted deployment convention uses.
