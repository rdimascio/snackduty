#!/bin/bash
# Public build inputs only. Never use deployment secrets or invoke packer build.
set -euo pipefail
test "$(uname -sm)" = "Linux x86_64"
inputs=${1:?new absolute input directory required}
evidence=${2:?absolute evidence directory required}
[[ "$inputs" = /* && "$evidence" = /* ]]
test ! -e "$inputs"
mkdir -p "$evidence"
tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT
commit=$(git rev-parse HEAD)

# Digests pinned from these exact HTTPS vendor downloads. Updating a version
# requires reviewing and updating its digest together; never trust latest URLs.
download() {
  local url=$1 digest=$2 file=$3
  curl --fail --silent --show-error --location --retry 3 "$url" -o "$file"
  printf '%s  %s\n' "$digest" "$file" | sha256sum --check --strict
  printf '%s  %s\n' "$digest" "$url" >> "$evidence/vendor-inputs.txt"
}
: > "$evidence/vendor-inputs.txt"
download https://github.com/oven-sh/bun/releases/download/bun-v1.3.5/bun-linux-x64.zip \
  7051d86a924aefea3e0b96213b5fd8f79c0793f9cae6534233e627e5c3db4669 "$tools/bun.zip"
unzip -q "$tools/bun.zip" -d "$tools"
export PATH="$tools/bun-linux-x64:$PATH"
test "$(bun --version)" = 1.3.5

# Both builds archive the checked-out commit and use the real frozen-dependency
# release script, in separate directories. Equality is an assertion, not a claim.
bash infra/ami/build-release.sh "$commit" "$inputs"
bash infra/ami/build-release.sh "$commit" "$tools/rebuild"
if ! cmp "$inputs/release.tar" "$tools/rebuild/release.tar"; then
  # Public build inputs only: diagnose differing paths without dumping file contents.
  python3 - "$inputs/release.tar" "$tools/rebuild/release.tar" <<'PY'
import hashlib
import sys
import tarfile
def entries(path):
    with tarfile.open(path) as archive:
        return {item.name: (item.mode, item.type.decode(), item.linkname,
                hashlib.file_digest(archive.extractfile(item), 'sha256').hexdigest() if item.isfile() else None)
                for item in archive}
left, right = map(entries, sys.argv[1:])
for name in sorted(left.keys() | right.keys()):
    if left.get(name) != right.get(name):
        print('non-reproducible member:', name)
PY
  exit 1
fi
cp "$inputs/build-receipt.txt" "$evidence/build-receipt.txt"
printf 'artifactDigest=sha256:%s\n' "$(sha256sum "$inputs/release.tar" | cut -d ' ' -f 1)" >> "$evidence/build-receipt.txt"
printf 'reproducibleTwoBuilds=true\nevidenceScope=linux-ci-synthetic-secrets\nstagingVerified=false\n' >> "$evidence/build-receipt.txt"
(cd "$inputs" && sha256sum release.tar) > "$evidence/release.sha256"
cp "$tools/bun-linux-x64/bun" "$inputs/bun"
download https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.27.49.zip \
  93842f724f8b76fbee05ac6a403dad603043b04eecfe3526f2035494718eb87b "$inputs/awscliv2.zip"
download https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/1.300072.0b1766/amazon-cloudwatch-agent.deb \
  05baeadca96c4bb8e43906ed09cf0bebd0f321ff6d41987bdc46ce681de0978d "$inputs/cloudwatch.deb"
for file in boot.py snackday.service cloudwatch-agent.json install-image.sh; do
  cp "infra/ami/$file" "$inputs/$file"
done
# ci-boot.py generates a real, ephemeral TLS CA and a synthetic-input SHA256SUMS.
# Neither is an approved AWS image receipt or a production RDS trust bundle.

download https://releases.hashicorp.com/packer/1.14.3/packer_1.14.3_linux_amd64.zip \
  95041cc0a30f05d5583be26a7c0b715f488e461418ce0c5d88ba204cb092bef1 "$tools/packer.zip"
unzip -q "$tools/packer.zip" -d "$tools/packer-bin"
export PATH="$tools/packer-bin:$PATH"
export AWS_EC2_METADATA_DISABLED=true CHECKPOINT_DISABLE=1
packer fmt -check infra/ami/snackday.pkr.hcl
packer init infra/ami/snackday.pkr.hcl
packer validate \
  -var 'account_id=000000000000' -var 'region=us-east-1' \
  -var 'base_ami=ami-00000000000000000' \
  -var 'subnet_id=subnet-00000000000000000' \
  -var 'security_group_id=sg-00000000000000000' \
  -var "inputs=$inputs" -var "release_commit=$commit" \
  -var "artifact_digest=$(sha256sum "$inputs/release.tar" | cut -d ' ' -f 1)" \
  infra/ami/snackday.pkr.hcl
printf 'packerVersion=1.14.3\namazonPluginVersion=1.3.9\nformat=passed\npluginInitialization=passed\nschemaValidation=passed\npackerBuild=not-run\nawsResourcesCreated=false\n' > "$evidence/packer-validation.txt"
{
  uname -srmo
  cat /etc/os-release
  systemd --version
  python3 --version
  openssl version
  dpkg-query -W -f='${Package}=${Version}\n' postgresql-16 openssl unzip logrotate
  printf 'bun=%s\n' "$(bun --version)"
  dpkg-deb -f "$inputs/cloudwatch.deb" Package Version Architecture
} > "$evidence/linux-toolchain.txt"
