# AWS staging evidence and handoff

## Readiness pass, September 17, 2026

PR #7 merged as `9f548e7c2a8e5552a54894ea18cb95138fb15da2` after all five
applicable hosted jobs passed. This pass starts from that freshly fetched main.
The [readiness report](./aws-staging-readiness.md) contains the complete input
ledger, ordered attended plan, acceptance and recovery/cleanup gates;
the [cost sheet](./aws-staging-costs.md) estimates us-east-1 at $62–67/month under
its stated assumptions. [Public input receipts](./evidence/aws-readiness-2026-09-17/production-inputs.md)
separate vendor verification from production image/build approval.

- **Passing fixture evidence:** the Linux receipts below remain fixture-only;
  their generated CA and synthetic Secrets Manager cannot be reused for AWS.
- **Read-only AWS observation:** local profile `staging` names us-east-1 and
  account `545738964453` in a login-session ARN. Explicit profile/region STS
  first hit a sandbox network boundary; the permitted unrestricted retry reported
  an expired session. No STS identity succeeded; no AWS resource, secret metadata
  or IAM policy was inspected. No secret values were retrieved.
- **Unexecuted:** production Linux release build, actual AMI/Packer build,
  Alchemy apply/destroy, DNS writes, snapshots, rotations and restores.
- **Unverified acceptance:** real EC2/IAM/Secrets Manager, RDS TLS, ALB release
  identity, Apple, invitations, persistence, logs/alarms and restore/rollback.
  Invitation delivery is a missing runtime adapter, and restored DB selection
  requires a reviewed graph seam. These cannot be fixed by supplying IDs alone.

No AWS resources were provisioned. `stagingVerified` remains false.

Local readiness validation on macOS/Bun 1.4.2 passed seven infrastructure tests
(45 assertions), four launcher tests and infrastructure typecheck. The unchanged
fast suite reproduced sandbox `EADDRINUSE` on port 0, then passed outside the
sandbox (306 web, 29 domain, 39 manifest and 61 script tests). No ports, retry
behavior or assertions were changed. Full Linux/systemd, PostgreSQL 16 and Mac
product validation for this documentation change are delegated to hosted CI;
final PR/check receipts must identify the published head.

Independent Astra and Sol plan reviews found two material procedure gaps, both
corrected: the pinned Packer SDK cannot consume the local `login_session`
directly, so the attended command now reuses `verifyAwsAccount` and passes its
in-memory credential snapshot; restored-DB preflight needs its own fresh manual
snapshot while retaining the source recovery point separately. No runtime or
infrastructure implementation was changed. Recovery/provider integration blockers
remain explicit rather than being bypassed.

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
an AMI; EC2 boot, Secrets Manager permissions, RDS
reachability, log arrival, SNS delivery, and restore/rollback acceptance remain
unverified. Required
account, network, image, certificate, sender and release identifiers must be real
and reviewed before an attended provisioning run. Keep `stagingVerified: false`.

Use the [PostgreSQL harness](./postgres-integration.md),
[AMI recipe](../infra/ami/README.md), and [staging runbook](./aws-staging-runbook.md)
for reproducible checks and the evidence required to close these gates.

## Linux image CI, September 17, 2026

PR #6 merged as `7733962868da6cf2464bb4463a09085b59f166dc` after independent
Astra/Sol reviews and six hosted checks. The subsequent Linux image workflow
builds committed source twice with Bun 1.3.5 and frozen dependencies, compares
archives, validates the Packer template/plugin without a build, and exercises
the actual installer, launcher and unchanged systemd unit on a disposable
Ubuntu 24.04 hosted VM. [Run 35207890015](https://github.com/rdimascio/snackduty/actions/runs/35207890015)
passes all 21 boot checks on PR #7 head `f544e98`; the built source is GitHub's
merge-test commit `c69993858e2ea9cfacd6ae8d682fa477f7106c0d`, with archive digest
`sha256:52665e4f87b895c3a72fafdbd4377aa09fde49002427554b8f35217942d31116`.
The retained receipt records PostgreSQL 16.15, systemd 255, three successful
starts, eleven initial migrations and empty migration replay, ten launcher
rejections and two runtime TLS startup rejections. Final-head check receipts
remain attached to [PR #7](https://github.com/rdimascio/snackduty/pull/7).

The first real builds exposed nondeterministic fallback/peer links from Bun
1.3.5's isolated linker. The release builder now uses the hoisted layout with
the same frozen lockfile; two independent output directories produce identical
archives. Packer formatting/schema validation exposed an unsupported
`allowed_account_ids` argument: the template now requires assuming an existing
builder role in the reviewed account. Invalid CA boot also exposed a failed
runtime remaining alive; the standalone entry point now exits explicitly after
its generic startup-failure event. The same negative boot cases subsequently pass.

Astra and Sol independently reviewed the frozen implementation. Their validated
findings tightened the build-receipt-to-installed-archive binding and required
actual redacted access events, in addition to correcting the Packer account
guard. Follow-up review covers these fixes and the runtime exit change.

The same head's full product gate exposed a separate existing Swift fixture race:
`logoutClearsLocalCredentialBeforeRevocationCompletes` exhausted 1,000 yields
before URLSession registered its request. Its fixture now signals registration
under the existing lock; the test awaits that signal with all assertions intact.
Final product-gate evidence must include this test's pass, not a retry-based waiver.

PostgreSQL 16 uses a generated trusted TLS certificate and SCRAM password.
Only Secrets Manager is synthetic: after verifying the installed vendor AWS
CLI, the harness replaces its executable with a strict fixture accepting only
the launcher's two AWSCURRENT requests. The launcher still captures its pipes,
validates secret JSON, constructs the connection URL, verifies the release and
drops privileges. This does **not** test AWS CLI credential resolution, IMDS,
IAM, the live Secrets Manager API, or CloudWatch delivery.
Vendor package bytes are pinned to official HTTPS downloads; CI's generated
input checksums and fixture CA are not a production input approval or vendor
signature-verification receipt.

The boot matrix requires migrations/readiness, exact archive/commit identity,
non-root UID/GID and empty supplementary groups/capabilities, runtime-denied
code writes, persistence of a synthetic application row through restart, and
fresh secret retrieval after rotating the database password. Negative boots
must exit unsuccessfully without readiness for bad digest, mismatched commit,
modified installed code, missing/malformed/empty secrets, invalid encryption
key, malformed CA and a valid but untrusted CA. A final valid boot checks recovery.

Only build/tool metadata and allowlisted boot receipts are uploaded. Generated
passwords, keys, private person markers and credential-bearing URLs are checked
against service, journal and database logs; raw logs, database files, fixture
secrets and private keys are never artifacts. The detector also must reject an
injected canary. This bounds the tested redaction claim to these exercised paths.
`stagingVerified` remains `false`; Linux fixture evidence cannot close any of the
external AWS, provider, restore/rollback or authenticated acceptance gates above.
