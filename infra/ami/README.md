# Immutable staging AMI

This is a reproducible recipe, **not a built or boot-verified AMI**. Do not run
Packer builds or Alchemy until account, base AMI, network IDs, release checksums and
PostgreSQL evidence are reviewed. Packer creates billable builder resources.

## Build contract

1. Select an exact Ubuntu 24.04 x86_64 base AMI in the expected account/region
   context. Record publisher, base AMI ID, Python/systemd versions and installed
   OS package list. Never use a `most_recent` image query. This recipe assumes
   Python 3, unzip, logrotate, and the SSM agent are installed on that reviewed base.
2. On the same Linux architecture, run `bash infra/ami/build-release.sh <full-commit> <new-absolute-output>`
   with Bun 1.3.5. It archives committed source, installs frozen dependencies with
   install scripts disabled, builds the app, and emits `release.tar` with an
   included `release-commit.txt`. The artifact digest is SHA256 of this archive;
   archive hashes may vary across native toolchains, so retain the actual archive.
3. Assemble a reviewed input directory containing `release.tar`, the exact Bun
   binary, `awscliv2.zip`, `cloudwatch.deb`, `rds-ca.pem`, and the four repository
   files `boot.py`, `snackday.service`, `cloudwatch-agent.json`, `install-image.sh`.
   Pin **every** file with a reviewed `SHA256SUMS`; record exact AWS CLI and agent
   versions and download origins in the build receipt. No download occurs during
   install. RDS CA source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem.
   Verify vendor signatures when acquiring AWS CLI and CloudWatch agent inputs.
4. With Packer and amazon plugin 1.3.9, `packer init infra/ami/snackday.pkr.hcl`,
   then `packer validate` with a private vars file containing all required inputs.
   `packer build` requires separately approved real identifiers. Supply an existing
   disposable builder subnet/security group allowing SSH only from the builder
   controller; no application role or runtime credentials belong on this machine.
   The expected account is enforced by `allowed_account_ids`.
5. Retain `ami-receipt.json`, package/tool receipt, exact archive, checksums, and
   encrypted AMI ID together. Set Alchemy `SNACKDAY_API_AMI_ID`,
   `SNACKDAY_API_RELEASE_COMMIT`, and `SNACKDAY_API_ARTIFACT_DIGEST` from that receipt.
   Tags are labels; they do not constitute boot evidence.

## Boot and logs

The image installs root-owned source/dependencies, a root-owned launcher and
systemd unit. The service verifies the archive SHA, its included commit, and
every installed file/link against the archive on **each start**, rejecting extra
files and links outside the release. It retrieves AWSCURRENT for the two precise
Secrets Manager ARNs into captured pipes and memory. The database secret requires
`username` and `password`; runtime secret requires only
`SNACKDAY_INVITATION_OUTBOX_KEY` (base64, 32 bytes). Additional secret fields never
become environment variables. Custom KMS keys are not supported by this IAM
policy; use the AWS-managed Secrets Manager key until a scoped decrypt policy is reviewed.

DATABASE_URL percent-encodes credentials and requires `sslmode=verify-full` with
the baked RDS CA. The launcher clears inherited environment and supplementary
groups, drops to the `snackday` UID/GID, then execs the runtime. Secrets never enter
user data, disk, argv or error text. Root and the process can still inspect its
environment. No development auth or SQLite fallback is configured.

systemd writes application JSON events to `/var/log/snackday/runtime.jsonl`;
CloudWatch agent ships them to `/snackday/staging/application` with 14-day
retention. Local logs rotate at 20MB/daily with seven retained copies. The graph
alarms on missing/zero healthy ALB targets and EC2 status failure; the supplied SNS
topic must already have a confirmed, tested operator subscription. Database SQL
logs are not exported because statement/error text can contain sensitive data.

Before calling this deployable, boot an instance and prove service restart, secret
refresh, rejected bad digest/commit/CA/secret, non-root runtime, read-only release,
real PostgreSQL readiness, release endpoint identity, CloudWatch log arrival and
alarm delivery. A local test cannot establish any of those AWS runtime facts.

## Offline verification

The **Linux image build and boot** workflow validates Packer formatting, schema
and the pinned amazon plugin without creating AWS resources. It runs the real
release builder twice and requires identical archives, then installs and boots
the result using the actual scripts and systemd unit on a disposable Ubuntu VM.
`ci-boot.py` is deliberately restricted to disposable GitHub-hosted Linux VMs;
it replaces system packages and `/usr/local/bin/aws`. Never run it on a shared
machine or deployment host. See [evidence scope](../../docs/aws-staging-evidence.md)
for the synthetic Secrets Manager boundary, TLS PostgreSQL and retained receipts.

```sh
python3 -m unittest discover -s infra/ami -p '*_test.py'
bun test infra/alchemy
bun run infra:typecheck
bash -n infra/ami/build-release.sh infra/ami/install-image.sh
```

API references: [STS identity](https://docs.aws.amazon.com/cli/latest/reference/sts/get-caller-identity.html),
[Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html),
[ALB metrics](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html).
