# Public production-input verification — 2026-09-17

Scope: public HTTPS downloads and local cryptographic checks only, against the
pins in `infra/ami/ci-prepare.sh` at
`9f548e7c2a8e5552a54894ea18cb95138fb15da2`. No AWS authenticated API calls,
installation, release build, Packer build, or infrastructure changes were made.
`stagingVerified=false`. This is independent of Linux fixture boot evidence.

Public packages, detached signatures, keys, and CA bundle were downloaded into
`/private/tmp/snackday-production-inputs`. This temporary directory is a local
convenience, not a durable release artifact. Reacquire and reverify at execution
time; use a new release-input directory for `build-release.sh`.

| Input                                         | Exact download                                                                                           | SHA-256                                                            | Result                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| AWS CLI 2.27.49 Linux x86_64                  | https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.27.49.zip                                         | `93842f724f8b76fbee05ac6a403dad603043b04eecfe3526f2035494718eb87b` | Repository pin matched; detached `.zip.sig` valid              |
| CloudWatch agent 1.300072.0b1766 Ubuntu amd64 | https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/1.300072.0b1766/amazon-cloudwatch-agent.deb | `05baeadca96c4bb8e43906ed09cf0bebd0f321ff6d41987bdc46ce681de0978d` | Repository pin matched; detached `.deb.sig` valid              |
| Bun 1.3.5 Linux x64                           | https://github.com/oven-sh/bun/releases/download/bun-v1.3.5/bun-linux-x64.zip                            | `7051d86a924aefea3e0b96213b5fd8f79c0793f9cae6534233e627e5c3db4669` | Repository pin matched; no vendor signature verified           |
| Packer 1.14.3 Linux amd64                     | https://releases.hashicorp.com/packer/1.14.3/packer_1.14.3_linux_amd64.zip                               | `95041cc0a30f05d5583be26a7c0b715f488e461418ce0c5d88ba204cb092bef1` | Repository pin and vendor signed checksum matched              |
| RDS commercial global CA bundle               | https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem                                        | `e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3` | Actual AWS bundle; 108 parseable, currently valid certificates |

Verification used GnuPG 2.5.21 and LibreSSL 3.3.6 on macOS. An isolated public
keyring under the input directory avoided modifying the user's keyring. GPG
`--status-fd 1 --verify SIGNATURE FILE` returned exit 0 and `VALIDSIG` for all
three signatures. Fingerprints were compared with the official vendor pages:

- AWS CLI primary/signing key: `FB5DB77FD5C118B80511ADA8A6310ACC4672475C`;
  signature date 2025-07-03; refreshed public key expires 2027-07-01. Key
  extracted from the [official AWS CLI installation documentation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
- CloudWatch agent primary/signing key: `937616F3450B7D806CBD9725D58167303B789C72`;
  signature date 2026-08-11. Key downloaded from
  `https://amazoncloudwatch-agent.s3.amazonaws.com/assets/amazon-cloudwatch-agent.gpg`
  and matched to the [official fingerprint](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/verify-CloudWatch-Agent-Package-Signature.html).
- HashiCorp primary key: `C874011F0AB405110D02105534365D9472D7468F`, signing
  subkey: `374EC75B485913604A831CC7C820C6D5CD27AB87`; signature date 2025-11-18.
  Key downloaded from `https://www.hashicorp.com/.well-known/pgp-key.txt`, matched
  to the [published primary fingerprint](https://www.hashicorp.com/en/trust/privacy)
  and [verification guide's signing subkey](https://developer.hashicorp.com/well-architected-framework/verify-hashicorp-binary).
  Verified `packer_1.14.3_SHA256SUMS.sig` against `packer_1.14.3_SHA256SUMS`,
  then matched its `packer_1.14.3_linux_amd64.zip` entry against the actual archive.
  GPG also mentioned an expired, unused historical subkey; the valid signature
  used the current signing subkey above.

GPG's unknown-owner-trust warning is expected for this isolated keyring;
authenticity here rests on exact fingerprint comparison to official HTTPS
documentation, not personal web-of-trust certification. These checks establish
package provenance, not absence of vulnerabilities or successful installation.

The CA URL is the [documented commercial-region RDS trust bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).
Every certificate was parsed using `openssl x509`, with subject, dates, and
SHA-256 fingerprint retained locally in `rds-certificates.txt`. Every notBefore
is past and every notAfter is future as of this check. Earliest expiry:
2061-05-18 21:49:45 UTC; latest: 2125-05-20 02:44:07 UTC. The bundle contains
us-east-1 and us-west-2 RSA2048, RSA4096, and ECC384 G1 roots. This is not the
ephemeral CA generated by `ci-boot.py`. The final selected region and RDS CA
identifier still need binding to a real database; no server chain, hostname,
network connectivity, or database TLS session was verified.

Remaining image inputs: selected base AMI and owner/provenance, release commit
and archive digest, repository boot/install/config files from that same commit,
final `SHA256SUMS`, Linux tool and installed-package inventory, and resulting
AMI receipt. Public input verification does not approve or execute the build.
