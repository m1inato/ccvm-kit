"""Release boundaries: local files stay local, archives contain committed source."""
import hashlib
import importlib.util
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

KIT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_check", KIT / "verification/check-release.py")
release_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_check)


class ReleasePolicyTests(unittest.TestCase):
    def files(self):
        return {"VERSION": b"2.2.0\n", "README.md": b"Generic kit\n",
                "config/clash-verge-script.js": b'const NODE = "REPLACE_WITH_EXACT_NODE_NAME";\n',
                "config/sing-box.json": b"{}\n"}

    def test_generic_source_is_allowed(self):
        self.assertEqual(release_check.validate(self.files()), [])

    def test_local_files_and_configured_node_are_rejected(self):
        for name in ["state/expected-ip.txt", "LOCAL_SETUP.md", "config/local.env",
                     "config/clash-verge-script.local.js", ".env", "dist/archive.zip"]:
            with self.subTest(name=name):
                files = self.files() | {name: b"local content"}
                self.assertTrue(release_check.validate(files))
        files = self.files()
        files["config/clash-verge-script.js"] = b'const NODE = "Configured example node";\n'
        self.assertTrue(release_check.validate(files))

    def test_machine_paths_and_credentials_are_rejected(self):
        for value in ["/" + "Users/example/private", "gh" + "p_" + "a" * 32,
                      "-----BEGIN " + "OPENSSH PRIVATE KEY-----"]:
            with self.subTest(kind=value[:8]):
                self.assertTrue(release_check.validate(self.files() | {"notes.txt": value.encode()}))
        self.assertEqual(release_check.validate(self.files() | {"notes.txt": b"/home/cc/work"}), [])


class PackagingTests(unittest.TestCase):
    def test_clean_commit_archives_exclude_ignored_local_files(self):
        with tempfile.TemporaryDirectory(prefix="ccvm-package-") as tmp:
            root = Path(tmp)
            project = root / "kit"
            project.mkdir()
            for name in release_check.source_files(KIT):
                dest = project / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(KIT / name, dest)
            env = {k: v for k, v in os.environ.items() if not k.startswith("CCVM_")}

            def git(*args):
                return subprocess.run(["git", "-C", str(project), *args], env=env,
                                      check=True, text=True, capture_output=True)

            git("init", "--quiet")
            git("config", "user.name", "Release Test")
            git("config", "user.email", "release@example.invalid")
            marker = "local-fixture-" + secrets.token_hex(24)
            for name in ["config/local.env", "config/clash-verge-script.local.js",
                         "LOCAL_SETUP.md", "state/expected-ip.txt"]:
                path = project / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(marker + "\n")
            git("add", ".")
            git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                "commit", "--quiet", "-m", "Fixture release")
            self.assertEqual(git("status", "--porcelain").stdout, "")

            def package():
                subprocess.run(["bash", str(project / "scripts/package.sh")], env=env,
                               check=True, text=True, capture_output=True)

            package()
            version = (project / "VERSION").read_text().strip()
            name = "ccvm-kit-" + version
            tar_path = project / "dist" / (name + ".tar.gz")
            zip_path = project / "dist" / (name + ".zip")
            with tarfile.open(tar_path) as archive:
                names = archive.getnames()
                self.assertIn(name + "/config/clash-verge-script.js", names)
                self.assertFalse(any(".local.js" in n or "/state/" in n
                                     or n.endswith("/local.env") or "LOCAL_SETUP.md" in n for n in names))
                for member in archive.getmembers():
                    if member.isfile():
                        self.assertNotIn(marker.encode(), archive.extractfile(member).read())
            with zipfile.ZipFile(zip_path) as archive:
                self.assertEqual({n.rstrip("/") for n in archive.namelist()},
                                 {n.rstrip("/") for n in names})
            before = hashlib.sha256(tar_path.read_bytes()).hexdigest()
            package()
            self.assertEqual(hashlib.sha256(tar_path.read_bytes()).hexdigest(), before)
            sums = (project / "dist" / (name + "-SHA256SUMS.txt")).read_text()
            self.assertIn(before + "  " + name + ".tar.gz", sums)
            # Releasing uncommitted source must fail rather than mix it into an archive.
            with (project / "README.md").open("a") as stream:
                stream.write("\nUncommitted change\n")
            result = subprocess.run(["bash", str(project / "scripts/package.sh")], env=env,
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
