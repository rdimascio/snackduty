# Attended AWS staging readiness — 2026-09-17

**Verdict: preparation complete enough for review; build/deployment approval is blocked.**
No Packer build, Alchemy apply/destroy, AWS resource mutation, secret retrieval,
DNS change, snapshot, restore, rotation or traffic switch was performed.
`stagingVerified` remains **false**. This document is an execution proposal,
not permission to run its billable steps.

Source baseline: PR #6 `7733962868da6cf2464bb4463a09085b59f166dc` and PR #7
`9f548e7c2a8e5552a54894ea18cb95138fb15da2`. A clean worktree and
`docs/aws-staging-readiness` branch were created from freshly fetched
`origin/main` at the latter commit. Existing worktrees and the original
untracked `.playwright-mcp/` and `test.jsonl` were preserved.

## What is ready, and what is not

| Boundary                    | Evidence and remaining gate                                                                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux fixture               | Prior hosted reproducible release builds, Packer validation and 21 real installer/launcher/systemd boot checks pass. TLS PostgreSQL is real; Secrets Manager is synthetic. See [baseline evidence](./aws-staging-evidence.md).                                                               |
| Local AWS configuration     | `~/.aws/config` has profile `staging`, region `us-east-1`, and a login-session ARN naming account `545738964453`. These are candidate coordinates, not STS-verified ownership or deployment permission. No repository env/state configuration was found.                                     |
| Read-only AWS observations  | Explicit-profile, explicit-region STS failed with an expired login after a sandbox network retry. **No successful account, image, network, IAM, S3, secret-metadata, ACM, DNS or SNS observation.** Do not infer these prerequisites exist. No credential values were printed.               |
| Production input provenance | Public input verification is recorded in [vendor evidence](./evidence/aws-readiness-2026-09-17/production-inputs.md). Fixture CA/checksums must never substitute for these inputs. Base AMI and OS inventory remain unselected.                                                              |
| Actual release and AMI      | No approved deployment commit/archive digest or resulting AMI exists. A CI merge-test digest is not the digest of main or the next release. Linux x86_64 production build controller remains to be selected; local host is macOS arm64, Bun 1.4.2, AWS CLI 2.33.1, with no installed Packer. |
| Infrastructure              | Locked Alchemy graph and offline tests exist. No live provider create/update, EC2 startup, IMDS identity, Secrets Manager access or RDS connection has been proved.                                                                                                                          |
| Usable beta                 | Apple registration/client audience and native release configuration are unverified. Production invitation adapter is **unimplemented in this entry point**, not merely missing a credential. Verified-email onboarding remains incomplete.                                                   |
| Recovery/operations         | Log arrival, alarm delivery, restart/replacement persistence, rollback and restore have no live receipts. Restore endpoint wiring requires additional reviewed implementation; see recovery section.                                                                                         |

## Input ledger: ask only for existing prerequisites

Every unknown below remains unknown; example IDs in tests/runbooks are not inputs.
The operator supplies identifiers, never secret values. If a prerequisite does not
exist, record that fact and prepare a separately approved bootstrap change.

| Required input / source seam                                                             | Status and exact prerequisite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_PROFILE`, `SNACKDAY_AWS_ACCOUNT_ID`, `SNACKDAY_AWS_REGION`, `SNACKDAY_DEPLOY_STAGE` | Candidate `staging` / `545738964453` / `us-east-1`; session expired. Stage must be `staging`. Reauthenticate outside this pass, verify STS exact account before any metadata call.                                                                                                                                                                                                                                                                                                                                                                            |
| `SNACKDAY_AWS_PRIMARY_AZ`, `SNACKDAY_AWS_SECONDARY_AZ`                                   | Two distinct available AZs in the region, unselected. Confirm t3.small and selected RDS engine/class availability. CIDRs `10.42.0.0/16`, public `10.42.1.0/24`, `10.42.2.0/24`, DB `10.42.11.0/24`, `10.42.12.0/24` must not conflict with intended connected networks.                                                                                                                                                                                                                                                                                       |
| Packer `base_ami`                                                                        | Exact regional Ubuntu 24.04 amd64 EBS/HVM AMI ID, date/name, owner, root mapping, snapshot IDs, encryption/key, architecture and launch permissions. Canonical standard AMI owner is `099720109477`; no `most_recent` query or invented AMI. A custom prepared base also needs its ancestry and package provenance.                                                                                                                                                                                                                                           |
| Base contents                                                                            | Evidence for Python 3, systemd, unzip, logrotate, SSM agent enabled, and absence of preinstalled conflicting AWS CLI/CloudWatch packages. Record full `dpkg-query` inventory. Installer downloads/installs no missing OS prerequisites. Stock image sufficiency is unproved; missing packages require a reviewed base-preparation change.                                                                                                                                                                                                                     |
| Packer builder identity                                                                  | Existing `arn:aws:iam::<account>:role/<builder_role_name>`; default name `snackday-image-builder` is only a default, existence unknown. Inspect trust, operator `sts:AssumeRole`, inline/attached policies, permission boundary and applicable SCP/session restrictions. Allow only reviewed EC2 image/build lifecycle and required encryption operations; no runtime secret access or runtime instance profile.                                                                                                                                              |
| Packer `subnet_id`, `security_group_id`                                                  | **Existing builder network**, distinct from the VPC Alchemy will create. Same region/VPC, controller SSH route on TCP 22 only, NACL return traffic, DNS and required egress. Existing template does not set `associate_public_ip_address` or `ssh_interface`; verify subnet auto-public-IP/default communicator behavior and controller reachability, or stop for a reviewed change. No SSM communicator/profile is configured.                                                                                                                               |
| Deployment principal                                                                     | Existing CLI-resolvable session with S3 state and Cloud Control/underlying EC2, ELB, RDS, IAM/PassRole, Logs, CloudWatch and Route53 permissions. Check service-linked-role prerequisites/creation permissions, quotas and restrictions. Do not use the builder role as application identity.                                                                                                                                                                                                                                                                 |
| `ALCHEMY_STATE_BUCKET`                                                                   | Existing bucket in selected account/region, encryption, versioning, public-access block, ownership/bucket policy, approved retention for noncurrent versions, recoverable state and one deployment operator. No distributed lock in this provider. S3 init performs bucket-level ListObjectsV2 without Prefix: a prefix-only ListBucket condition will fail. Scope object access to actual `snackday/` state paths. No `alchemy.secret()` here, so an Alchemy password is not currently required. SSE-KMS state would additionally require scoped key access. |
| `SNACKDAY_STAGING_HOSTNAME`, `SNACKDAY_ROUTE53_HOSTED_ZONE_ID`                           | Existing public authoritative zone, delegation and unoccupied/owned staging name. Alchemy creates the A alias; it does not register a domain/create a zone. Existing conflicting records are an abort gate, not authority to overwrite.                                                                                                                                                                                                                                                                                                                       |
| `SNACKDAY_ACM_CERTIFICATE_ARN`                                                           | Existing issued regional certificate covering hostname, same account/region, valid chain/expiry and renewal validation. ACM validation records/certificate issuance are prerequisites, not graph outputs.                                                                                                                                                                                                                                                                                                                                                     |
| `SNACKDAY_RUNTIME_SECRET_ARN`                                                            | Existing same-account/region secret using AWS-managed Secrets Manager key. Metadata must show AWSCURRENT and no pending deletion. Its owner must attest to the canonical base64 32-byte `SNACKDAY_INVITATION_OUTBOX_KEY` schema; metadata cannot prove contents. Do not read values to check this. Preserve this key across restores or persisted outbox ciphertext is unreadable. Custom secret KMS keys are unsupported by the graph's runtime policy.                                                                                                      |
| `SNACKDAY_APPLE_CLIENT_ID`                                                               | Actual registered audience for intended native/web journey; source bundle ID `com.snackday.app` is not registration evidence. Confirm developer team/capability, native entitlement, HTTPS API configuration and any web Services ID/return URLs needed for the chosen flow.                                                                                                                                                                                                                                                                                  |
| `SNACKDAY_ALERT_TOPIC_ARN`                                                               | Existing SNS topic in account/region, confirmed operator subscription, publish policy allowing the alarms; inspect topic KMS policy if encrypted. A confirmed subscription alone is not delivery proof.                                                                                                                                                                                                                                                                                                                                                       |
| `SNACKDAY_POSTGRES_ENGINE_VERSION`                                                       | Exact supported RDS PostgreSQL version, unselected; CI exercised PostgreSQL 16.15. Verify regional orderability, CA compatibility, maintenance behavior and ordinary support dates. A test fixture's 17.6 is not a selected version.                                                                                                                                                                                                                                                                                                                          |
| Instance sizes                                                                           | Default `SNACKDAY_API_INSTANCE_TYPE=t3.small`, `SNACKDAY_RDS_INSTANCE_CLASS=db.t4g.micro`. Review capacity; one API and Single-AZ DB are not HA. DB gp3 starts at 20 GiB and can grow to 100 GiB.                                                                                                                                                                                                                                                                                                                                                             |
| Release coordinates                                                                      | Reviewed full source SHA, actual reproducible Linux archive, `sha256:<digest>`, tool/package receipt; resulting encrypted AMI receipt becomes `SNACKDAY_API_AMI_ID`. Set `SNACKDAY_API_RELEASE_COMMIT` and `SNACKDAY_API_ARTIFACT_DIGEST` from that same receipt. No AMI ID is requested before building it.                                                                                                                                                                                                                                                  |
| Product acceptance prerequisites                                                         | Real invitation transport implementation through `RuntimeApplicationAdapters.inviteDelivery`, verified sender/provider setup, test adults/devices and a reviewed team/guardian onboarding path. `runRuntimeFromEnvironment(process.env)` supplies no delivery adapter; invitation create/resend deliberately return 503. Adding secret fields cannot enable it: launcher exports only the outbox key.                                                                                                                                                         |

**Alchemy-created outputs, not questions for the operator:** VPC, IGW and attachment,
four subnets, two route tables/four associations/default public route, three
security groups, private RDS subnet group and database, its RDS-managed master
secret, API role/two inline policies/instance profile, application log group,
EC2 instance, ALB/target group/HTTPS listener, two alarms and Route53 A alias.
The API receives a public IPv4 for egress, with inbound application access only
from ALB. There is no NAT gateway, VPC endpoint, bastion, ASG or second API.
RDS upgrades also create/use the exported `upgrade` log stream/group; account
service-linked roles can be created on first service use. Include those in review.

## Contracts checked and read-only inspection procedure

Use frozen `alchemy@0.93.12` and `@aws-sdk/client-s3@3.1133.0`, Bun 1.3.5,
Packer 1.14.3 and amazon plugin 1.3.9. Reviewed installed provider source agrees
with `bun.lock`: `src/aws/s3-state-store.ts`, `src/aws/control/resource.ts`,
`src/alchemy.ts` and `src/scope.ts`. The graph uses **S3StateStore**, not the
newer `AWS.state()` API. Do not migrate this deployment by copying current v2 docs.
`plan.ts` is offline validation plus a topology summary, **not a cloud diff**;
`--read` returns saved state, not refreshed resource drift or a dry-run deployment.
Default invocation mutates immediately; `--destroy` deletes. No interactive
approval is supplied by the library. Immutable changes trigger replacement;
resource application is not a transaction and a failure can leave partial state.
CLI state/stage/adoption overrides are not part of this procedure.

Packer's [versioned 1.3.9 contract](https://developer.hashicorp.com/packer/integrations/hashicorp/amazon/v1.3.9/components/builder/ebs)
matches the pinned recipe: account binding uses assume-role, an existing subnet
and SG are supplied, and `encrypt_boot` can make an additional encrypted copy.
Packer does not own ongoing image retention. `packer validate` proves neither
permissions nor successful provisioning.

After the user renews the session, a fresh read-only pass must run first. For each
call use `--profile staging --region us-east-1 --no-cli-pager` and bounded
connect/read timeouts, with endpoint overrides disabled and no credential debug
logging. First compare `sts get-caller-identity --query Account --output text`
to `545738964453`; abort on mismatch. Do not silently fall back to default.
Rebind if the user selects different coordinates. Inspect only named resources:

1. `ec2 describe-images --image-ids <base>` and its named snapshots; verify owner,
   root mappings, architecture, state, backing encryption and provenance.
2. `iam get-role`, named attached/inline role policies and policy versions;
   inspect trust/principal boundary. Inspect the named builder subnet, SG,
   route table and NACL; selected AZ offerings and RDS orderable engine/class.
3. `s3api head-bucket` with expected owner, bucket location, encryption,
   versioning, public-access block and bucket policy. List at most the named
   state prefix first; treat preexisting state as an upgrade/recovery, not bootstrap.
4. Named Route53 zone/delegation and hostname records, `acm describe-certificate`,
   `sns get-topic-attributes` and bounded subscriptions for that topic.
5. `secretsmanager describe-secret` and `get-resource-policy` for the supplied
   runtime ARN only; inspect referenced KMS policy metadata if relevant. Do not
   invoke `get-secret-value`, batch retrieval, or put credentials into evidence.

Record queried identifiers/time, redacted results and denied/unavailable checks.
No account-wide secret/image inventory is required. Policy inspection can detect
a missing allow/explicit deny; it **cannot prove the future EC2 role can fetch
AWSCURRENT**. That proof needs the attended boot with the real vendor CLI and
IMDS role, corroborated by redacted service readiness and permitted audit events.

## Ordered execution proposal — not executed

### A. Freeze inputs and approval scope

1. Close the input ledger and read-only checks. Select the approved release SHA
   after its review and all applicable CI passes; record the built SHA separately
   from GitHub's PR head/merge-test SHA. Retain original archive bytes. Choose an
   attended Linux x86_64 controller with sufficient disk and SSH connectivity.
2. Decide whether the objective is an **infrastructure-only synthetic rehearsal**
   or a usable beta. The current code permits the former proposal; the latter is
   blocked on delivery implementation/identity/onboarding. Do not invite users.
3. Review the cost sheet, state ownership, maintenance window, failure budget,
   retention deadline and operator. Obtain separate explicit authorization for
   prerequisites that need creation, then image build, then the exact graph.
   Snapshot/restore, alert fault injection, replacement and cleanup must be named
   in their own attended approval scope; none is authorized by this report.

### B. Acquire production image inputs and build

4. Download the exact public vendor versions from `ci-prepare.sh`, checking its
   pinned SHA256 values; verify AWS CLI and CloudWatch detached signatures using
   official vendor keys/fingerprints before installation. Verify Packer signed
   SHA256SUMS, and retain plugin version/checksum provenance from `packer init`.
   Use the official [AWS CLI verification instructions](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
   and [CloudWatch signature instructions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/verify-CloudWatch-Agent-Package-Signature.html).
   Record URLs, retrieval time, signer fingerprints, signatures, hashes and exact
   versions. An unverified signature or digest mismatch aborts the build.
5. Acquire `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`
   as `rds-ca.pem`, hash the downloaded bytes, inspect included CA validity and
   selected region's RDS CA chain against [RDS TLS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).
   This HTTPS truststore is the provenance; do not claim it has a detached vendor
   signature. Never use `ci-boot.py`'s generated CA or Secrets Manager fixture.
6. On Linux x86_64 with Bun **1.3.5**, from the exact reviewed checkout, run:

   ```sh
   bash infra/ami/build-release.sh "$RELEASE_COMMIT" "$INPUTS"
   bash infra/ami/build-release.sh "$RELEASE_COMMIT" "$SECOND_BUILD"
   cmp "$INPUTS/release.tar" "$SECOND_BUILD/release.tar"
   sha256sum "$INPUTS/release.tar"
   ```

   Both output paths must be new absolute directories. `$RELEASE_COMMIT` is the
   selected 40-character SHA, not a sample. Retain commit, archive, frozen lockfile
   hash, build receipts, full OS/package inventory and independent build equality.
   Copy verified `bun`, `awscliv2.zip`, `cloudwatch.deb`, `rds-ca.pem` and **the
   same commit's** `boot.py`, `snackday.service`, `cloudwatch-agent.json`,
   `install-image.sh` into `$INPUTS`. Produce the reviewed `SHA256SUMS` covering
   exactly these ten installer-required files including `release.tar`. Signature
   verification precedes checksum approval; do not bless arbitrary downloads by
   hashing them. Do not run `ci-boot.py` on a controller or real EC2 host.

7. Prepare a private Packer vars file with `account_id`, `region`,
   `builder_role_name`, exact `base_ami`, existing `subnet_id`, existing
   `security_group_id`, absolute `inputs`, full `release_commit` and
   `artifact_digest` (use the same `sha256:<hex>` receipt convention). In a new
   build working directory, validate the checked-out absolute template:

   ```sh
   packer fmt -check "$CHECKOUT/infra/ami/snackday.pkr.hcl"
   packer init "$CHECKOUT/infra/ami/snackday.pkr.hcl"
   packer validate -var-file="$PACKER_VARS" "$CHECKOUT/infra/ami/snackday.pkr.hcl"
   # ONLY AFTER IMAGE-BUILD APPROVAL; never executed in this readiness pass:
   # Run from the reviewed checkout; export CHECKOUT, PACKER_VARS and BUILD_WORKDIR.
   # BUILD_WORKDIR must be a new, existing, empty directory for the manifest.
   AWS_PROFILE=staging bun -e '
     import { verifyAwsAccount } from "./infra/alchemy/account";
     verifyAwsAccount(process.env.SNACKDAY_AWS_ACCOUNT_ID!, process.env.SNACKDAY_AWS_REGION!);
     const child = Bun.spawn([
       "packer", "build", "-var-file=" + process.env.PACKER_VARS,
       process.env.CHECKOUT + "/infra/ami/snackday.pkr.hcl"
     ], { cwd: process.env.BUILD_WORKDIR, env: process.env, stdout: "inherit", stderr: "inherit" });
     process.exit(await child.exited);
   '
   ```

   The local profile uses `login_session`; the pinned Packer plugin's older AWS
   SDK cannot be assumed to resolve that login. The existing `verifyAwsAccount`
   seam bridges AWS CLI `export-credentials` to one account-verified in-memory
   environment for Packer without printing credentials. No direct profile-only
   build or global AWS config edits are needed. The builder still assumes its
   reviewed target-account role. Ensure both session lifetimes cover the build;
   expiry aborts rather than silently switching identities. The controller needs
   AWS CLI >=2.32 for `login_session` (local 2.33.1 qualifies); the AMI's pinned
   CLI 2.27.49 uses EC2 IMDS and is a separate tool contract. See the
   [pinned plugin dependencies](https://github.com/hashicorp/packer-plugin-amazon/blob/v1.3.9/go.mod),
   [SDK resolver](https://github.com/aws/aws-sdk-go-v2/blob/config/v1.29.14/config/resolve_credentials.go)
   and [AWS login compatibility guidance](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html).

   Capture the manifest `ami-receipt.json` from that new directory, Packer/plugin
   versions, base image receipt and restricted build log. Inspect resulting
   account/region/AMI availability, snapshots, encryption/root mapping and tags
   read-only. Join that manifest to the reviewed source/archive/input receipt;
   the manifest alone does not contain all provenance. Verify no temporary
   builder/volume/keypair or intermediate copy remains. An AMI receipt is not a
   boot receipt. No application secret belongs on the builder.

### C. Review and apply infrastructure

8. Populate every non-secret environment input from the ledger and AMI receipt.
   Run `bun infra/alchemy/plan.ts` offline; compare its summary **and the complete
   graph source** with existing saved state/actual resources. The summary omits
   some IAM/log/DNS/alarm details and cannot detect replacements. Inspect saved
   state using `bun infra/alchemy/alchemy.run.ts --read` only once inputs and
   account are validated. Keep raw output restricted: it includes DB endpoint
   and secret ARN, which must not be copied to the public verification target.
   Review any DB/VPC/subnet/secret replacement as a stop, not routine convergence.
9. After the actual AMI exists, complete the separate graph approval. Include
   DNS A-alias creation: this graph has no separate promotion switch; applying it
   creates a public HTTPS origin. Use only a new, reserved staging hostname and
   synthetic data. Serialized operator invokes, from the reviewed checkout:

   ```sh
   # ONLY AFTER GRAPH APPROVAL and passing selected-version PostgreSQL evidence:
   AWS_PROFILE=staging SNACKDAY_POSTGRES_RUNTIME_VERIFIED=1 \
     bun infra/alchemy/alchemy.run.ts
   ```

   All other validated env inputs must already be set. The guard acknowledges
   PostgreSQL test evidence; it is neither approval nor a claim of live readiness.
   No `--force`, `--adopt`, `--destroy`, stage override or local-state fallback.
   Do not retry a partial failure until state/resource receipts are reconciled.

10. **First release:** the DB does not exist before apply. The monolithic graph
    creates RDS, then boots/migrates the first API and publishes DNS. There is no
    pre-migration snapshot possible with this graph. Restrict to synthetic data;
    after RDS is available and initial migration completes, take an explicitly
    approved encrypted baseline snapshot and wait for availability before user
    acceptance. Put its real ID in `preDeploySnapshotId`, recording that it is a
    **post-bootstrap baseline**, not a pre-bootstrap recovery point. A requirement
    for a snapshot before initial migration would need a reviewed staged-apply
    seam; do not pretend one exists. **Upgrades:** freeze writes as needed and
    create/wait for an encrypted pre-upgrade snapshot before apply. Verify PITR
    window and seven-day retention. No snapshot commands run in this pass.

### D. Live proof, then acceptance

11. Through approved SSM access, inspect cloud-init and both services; redact
    errors before retention. Require root-owned immutable release, non-root
    runtime, matching boot-verified commit/digest and `runtime.ready` migrations.
    No manual `get-secret-value`, env/process dump or raw credential logs. Prove
    real launcher fetches both AWSCURRENT secrets under EC2 identity (metadata,
    policy and safe CloudTrail event fields where available), then successful
    CA/hostname-verified PostgreSQL connection. `/readyz` plus the known launcher
    contract supports TLS evidence; additionally capture a boolean `pg_stat_ssl`
    assertion for the application connection through a reviewed secret-safe
    diagnostic if needed, never a URL/password. Rotation remains separate work.
12. Create the strict target JSON from **actual outputs**, approved release
    coordinates and available snapshot; `previousArtifactDigest=null` only for
    the first release. Exclude endpoint, secret ARN and all credentials. Run:

    ```sh
    bun scripts/runtime/aws-staging-preflight.ts "$TARGET"
    AWS_PROFILE=staging bun scripts/runtime/aws-staging-preflight.ts "$TARGET" --live
    ```

    Require account/VPC/SG/RDS/snapshot checks, real DNS/TLS binding, the exact
    single HTTPS listener/default forwarding rule/healthy target and matching
    `/__snackday/release`. The live probe includes a rejected dev-sign-in POST.
    No health shim or tag-only identity is acceptable; receipt still says false.

13. Require the following separately timestamped gates before acceptance. Record
    only synthetic marker IDs and boolean outcomes, never child-sensitive payloads.

| Gate                     | Required proof / stop condition                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and tenancy     | Live Apple sign-in on correctly configured native build; nonce/replay/audience rejection; session restore/revoke/logout; coach + guardian in two teams, own-child access only, revoked/cross-team denial. Test people/onboarding must exist through an approved product path.                  |
| Delivery                 | Implemented provider, verified sender and intended-recipient inbox receipt; persisted outbox retry/idempotency, forwarded/replayed/expired invitation rejection. Current artifact cannot pass; do not replace this with a fixture.                                                             |
| Coordination persistence | Create event, RSVP for own child, claim snack; verify saved session and rows after service restart and, separately, immutable EC2 replacement. Re-run live preflight against new instance ID. Record interruption; no ASG or zero-downtime claim.                                              |
| Logs                     | Actual redacted ready/access events arrive in `/snackday/staging/application` under actual instance stream, retention 14 days; no token/path/child-sensitive leaks. Merely having an agent or log group is insufficient. Review RDS upgrade-log retention separately.                          |
| Alarms                   | Correct dimensions/actions and confirmed subscription; separately approved controlled fault/metric test shows alarm and recovery messages reaching the operator. A direct SNS test alone does not prove metric-to-alarm wiring.                                                                |
| Recovery                 | Reviewed implementation for restored endpoint/secret selection, available encrypted snapshot/PITR, synthetic before/after markers, measured RTO/lost-write interval, tenant/session persistence after restore and corrective/previous image. No completed claim without actual drill receipts. |

## Abort, rollback and cleanup gates

Abort before mutation for identity/region mismatch, unknown inputs, failed vendor
verification, unavailable controller path, inadequate policy/state protection,
conflicting DNS, CI failure or unapproved replacement. Abort promotion for failed
boot, secret/TLS/readiness, release identity, logs, alarms or acceptance. A failed
apply is **not an automatic rollback**. Preserve restricted state versions and
sanitized event IDs; enumerate only that run's resource IDs before retry/cleanup.

For application rollback, choose the retained previous **AMI + commit + archive
digest**, not just a digest/tag. Confirm schema compatibility and review the
Alchemy update/replacement (including target registration and alarms), approve
the change, then rerun startup, preflight and authenticated persistence gates.
The single host can cause downtime; there is no implemented blue/green switch.
Never run down-migrations or edit the installed immutable tree.

On the first release there is no previous artifact. Stop writes/service under
separate operational approval, keep DNS closed to onboarding, retain data/state
for diagnosis, then build a reviewed corrective AMI or explicitly approve cleanup
of the unused synthetic environment. The baseline snapshot cannot recover any
state preceding its creation. Do not set a fictional previous digest.

RDS restore creates a **new DB instance**, preserving the old one. The present
graph always derives endpoint/managed secret from its own `Database` resource;
there is **no environment override to attach a restored DB**. Before any restore
drill, implement/review an explicit external-restored-DB or reconciliation seam,
with safe state ownership, private subnet/SG/encryption/backup configuration and
secret reference, including an explicit decision about restored PostgreSQL
credentials, managed-password enrollment/rotation and instance-role access.
Do not assume restoring a snapshot automatically supplies a new RDS-managed
secret. Merely editing a runtime secret does not redirect this graph.
Record recovery point/write freeze, restore markers, RTO and actual lost writes;
retain original DB, compatible image and outbox key until recovery is accepted.
The existing live verifier requires an encrypted available manual snapshot
belonging to the **target DB**, created within 24 hours. The source recovery
snapshot belongs to the old DB, so it cannot fill that gate for the restored DB.
After validating restore markers, obtain explicit approval for a fresh snapshot
of the restored DB, wait until available and put that ID in the restored target's
`preDeploySnapshotId`; run preflight within 24 hours. Keep source snapshot/PITR
and marker assertions separately as recovery proof. The same freshness gate
requires a newly approved snapshot if any later preflight occurs after 24 hours.
This implementation is a recovery acceptance blocker, not an action performed here.

Cleanup needs an approved per-resource disposition, with data owner/retention
deadline. Do not run blanket `--destroy`: RDS has deletion protection, and the
pinned Cloud Control delete handler does not request a final snapshot. A final
snapshot/retention decision, disabling deletion protection and state reconciliation
are separate mutations. Delete dependent target/listener/ALB and instance/profile,
then DB only after its retention gate, then policies/SG/subnets/routes/IGW/VPC/DNS
as appropriate to actual state. Verify asynchronous deletion completion before
removing state. Never erase state to make a failed destroy look successful.

**Bills can survive failure:** running builder/API/restored DB, attached/orphaned
EBS, ALB and public IPv4, RDS storage/backups, manual snapshots, AMI snapshots
(including encryption-copy intermediates), logs/alarms, Secrets Manager secrets,
S3 state versions and release archives. Stopping EC2 leaves EBS charges; stopping
RDS is not permanent cleanup and does not remove storage charges. Deregistering
an AMI does not by itself prove backing snapshots are deleted. Existing zone,
certificate, topic, state bucket, runtime secret and builder network are shared
prerequisites: do not delete them as stack cleanup. RDS-managed secret lifecycle
must be checked after database deletion. Inspect final named resources and costs;
retain a redacted cleanup receipt and explicitly list all retained billable items.

## Handoff and approval boundary

Next input request, after this preparation: renew the `staging` login and provide
or confirm the **existing** prerequisite ledger (or identify which are absent),
choose exact base/DB version and Linux controller, and decide infrastructure-only
rehearsal versus usable beta. No deployment approval is requested while those
facts are unresolved. The cost sheet and vendor/readiness evidence are linked
from [AWS evidence](./aws-staging-evidence.md).

Once gates close, an approval must name the account/region, exact base and release
receipt, builder role/network, budget/retention window, then authorize (1) one
Packer builder and encrypted AMI/snapshots, (2) the reviewed Alchemy graph including
DNS/public entry point and shared-state writes, and (3) specifically enumerated
snapshot, restart/replacement, alarm and restore drills. Cleanup and any
prerequisite creation must also be explicit. This report grants none of them.
