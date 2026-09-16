#!/bin/bash
# Run on the same reviewed Linux x86_64 base/toolchain used for the AMI.
set -euo pipefail
test "$(uname -sm)" = "Linux x86_64"
test "$(bun --version)" = "1.3.5"
commit=${1:?exact source commit required}
out=${2:?new absolute output directory required}
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
[[ "$out" = /* ]]
test ! -e "$out"
mkdir -p "$out/release"
git archive "$commit" | tar -x -C "$out/release"
cd "$out/release"
bun install --frozen-lockfile --ignore-scripts
bun run --filter web build
printf '%s\n' "$commit" > release-commit.txt
# Reject links that could escape the artifact (Bun workspace links are internal).
python3 -c 'from pathlib import Path; p=Path.cwd(); assert all(x.resolve().is_relative_to(p) for x in p.rglob("*") if x.is_symlink())'
tar --hard-dereference --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf "$out/release.tar" .
sha256sum "$out/release.tar"
printf 'releaseCommit=%s\nbunVersion=1.3.5\n' "$commit" > "$out/build-receipt.txt"
