import hashlib
from contextlib import redirect_stderr
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlparse, parse_qs, unquote

import boot


class BootTest(unittest.TestCase):
    def test_boot_failure_redacts_subprocess_and_secret_errors(self):
        output = io.StringIO()
        with patch("boot.main", side_effect=ValueError("sensitive-password")), redirect_stderr(output):
            self.assertEqual(boot.run(), 1)
        self.assertEqual(output.getvalue(), '{"event":"runtime.boot_failed"}\n')

    def test_encoded_tls_credentials(self):
        config = {"SNACKDAY_DATABASE_HOST": "db.example", "SNACKDAY_DATABASE_PORT": "5432", "SNACKDAY_DATABASE_NAME": "snackday"}
        url = urlparse(boot.database_url(config, {"username": "u:@/", "password": "p?#% &"}))
        self.assertEqual(unquote(url.username), "u:@/")
        self.assertEqual(unquote(url.password), "p?#% &")
        self.assertEqual(parse_qs(url.query)["sslmode"], ["verify-full"])
        self.assertEqual(parse_qs(url.query)["sslrootcert"], ["/opt/snackday/rds-ca.pem"])
        with self.assertRaises(ValueError):
            boot.database_url({**config, "SNACKDAY_DATABASE_HOST": "bad/@host"}, {"username": "u", "password": "p"})

    def test_archive_installed_tree_and_commit_verified(self):
        commit = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "release").mkdir()
            (root / "release/release-commit.txt").write_text(commit)
            with tarfile.open(root / "release.tar", "w") as archive:
                entry = tarfile.TarInfo("./release-commit.txt")
                entry.size = len(commit)
                archive.addfile(entry, io.BytesIO(commit.encode()))
            digest = "sha256:" + hashlib.sha256((root / "release.tar").read_bytes()).hexdigest()
            boot.verify_release(root, commit, digest)
            with self.assertRaisesRegex(ValueError, "commit"):
                boot.verify_release(root, "b" * 40, digest)
            with self.assertRaisesRegex(ValueError, "digest"):
                boot.verify_release(root, commit, "sha256:" + "0" * 64)
            (root / "release/release-commit.txt").write_text("tampered")
            with self.assertRaisesRegex(ValueError, "installed digest"):
                boot.verify_release(root, commit, digest)
            (root / "release/release-commit.txt").write_text(commit)
            (root / "release/extra.ts").write_text("unreviewed")
            with self.assertRaisesRegex(ValueError, "unexpected"):
                boot.verify_release(root, commit, digest)

    def test_secret_retrieved_each_time_with_captured_stderr(self):
        result = type("Result", (), {"stdout": b'{"SecretString":"{\\"password\\":\\"sensitive\\"}"}'})()
        with patch("boot.subprocess.run", return_value=result) as run:
            self.assertEqual(boot.fetch_secret("arn", "us-west-2")["password"], "sensitive")
            boot.fetch_secret("arn", "us-west-2")
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args.kwargs["stderr"], boot.subprocess.PIPE)
            self.assertNotIn("sensitive", str(run.call_args))


if __name__ == "__main__":
    unittest.main()
