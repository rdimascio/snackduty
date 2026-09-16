#!/usr/bin/python3
"""Root launcher. Secrets stay in process memory; failures never print exceptions."""
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
from urllib.parse import quote, urlencode

ROOT = Path("/opt/snackday")


def file_digest(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest


def database_url(config, secret):
    host = config["SNACKDAY_DATABASE_HOST"]
    port = config["SNACKDAY_DATABASE_PORT"]
    if not re.fullmatch(r"[a-z0-9.-]+", host) or not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError("endpoint")
    if not all(isinstance(secret.get(key), str) and secret[key] for key in ("username", "password")):
        raise ValueError("credentials")
    return "postgresql://{}:{}@{}:{}/{}?{}".format(
        quote(secret["username"], safe=""), quote(secret["password"], safe=""), host, port,
        quote(config["SNACKDAY_DATABASE_NAME"], safe=""),
        urlencode({"sslmode": "verify-full", "sslrootcert": str(ROOT / "rds-ca.pem")}),
    )


def fetch_secret(arn, region):
    result = subprocess.run(
        ["/usr/local/bin/aws", "secretsmanager", "get-secret-value", "--secret-id", arn,
         "--version-stage", "AWSCURRENT", "--region", region, "--output", "json", "--no-cli-pager"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "AWS_DEFAULT_REGION": region},
    )
    return json.loads(json.loads(result.stdout)["SecretString"])


def verify_release(root, expected_commit, expected_digest):
    if not re.fullmatch(r"[0-9a-f]{40}", expected_commit) or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_digest):
        raise ValueError("release identity")
    with (root / "release.tar").open("rb") as archive:
        actual = "sha256:" + file_digest(archive).hexdigest()
    if actual != expected_digest:
        raise ValueError("release digest")
    # The baked manifest describes every regular file and symlink in the installed tree.
    # It is inside the hash-verified archive, never trusted from the writable environment.
    import tarfile
    with tarfile.open(root / "release.tar") as archive:
        marker = archive.extractfile("./release-commit.txt")
        if marker is None or marker.read().decode().strip() != expected_commit:
            raise ValueError("release commit")
        entries = set()
        for entry in archive.getmembers():
            relative = Path(entry.name)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("archive path")
            path = root / "release" / relative
            entries.add(str(relative))
            if entry.isfile():
                data = archive.extractfile(entry)
                if data is None or path.is_symlink() or not path.is_file():
                    raise ValueError("release file")
                with path.open("rb") as installed:
                    if file_digest(data).digest() != file_digest(installed).digest():
                        raise ValueError("installed digest")
            elif entry.issym():
                if not path.is_symlink() or os.readlink(path) != entry.linkname:
                    raise ValueError("release symlink")
                if not path.resolve().is_relative_to((root / "release").resolve()):
                    raise ValueError("external symlink")
            elif not entry.isdir():
                raise ValueError("unsupported archive entry")
        for path in (root / "release").rglob("*"):
            if str(path.relative_to(root / "release")) not in entries:
                raise ValueError("unexpected installed file")


def main():
    config = {}
    for line in Path("/etc/snackday/staging.env").read_text().splitlines():
        key, value = line.split("=", 1)
        config[key] = value
    verify_release(ROOT, config["SNACKDAY_RELEASE_COMMIT"], config["SNACKDAY_RELEASE_DIGEST"])
    if not (ROOT / "rds-ca.pem").is_file():
        raise ValueError("missing CA")
    database = fetch_secret(config["SNACKDAY_DATABASE_SECRET_ARN"], config["AWS_REGION"])
    runtime = fetch_secret(config["SNACKDAY_RUNTIME_SECRET_ARN"], config["AWS_REGION"])
    key = runtime["SNACKDAY_INVITATION_OUTBOX_KEY"]
    if not isinstance(key, str) or len(base64.b64decode(key, validate=True)) != 32:
        raise ValueError("outbox key")
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "NODE_ENV": "production",
        "SNACKDAY_RUNTIME_MODE": "staging", "SNACKDAY_DATABASE_DIALECT": "postgres",
        "HOST": "0.0.0.0", "PORT": "3000", "DATABASE_URL": database_url(config, database),
        "SNACKDAY_PUBLIC_BASE_URL": config["SNACKDAY_PUBLIC_BASE_URL"],
        "SNACKDAY_APPLE_CLIENT_ID": config["SNACKDAY_APPLE_CLIENT_ID"],
        "SNACKDAY_INVITATION_OUTBOX_KEY": key,
        "SNACKDAY_RELEASE_COMMIT": config["SNACKDAY_RELEASE_COMMIT"],
        "SNACKDAY_ARTIFACT_DIGEST": config["SNACKDAY_RELEASE_DIGEST"],
    }
    account = pwd.getpwnam("snackday")
    os.chdir(ROOT / "release")
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    os.execve("/usr/local/bin/bun", ["bun", "apps/web/runtime/server.ts"], environment)


def run():
    try:
        main()
    except Exception:
        print('{"event":"runtime.boot_failed"}', file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(run())
