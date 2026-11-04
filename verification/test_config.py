"""Exercise configuration precedence and failure paths with real Bash, without a VM."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

KIT = Path(__file__).resolve().parents[1]
BASH_EXEC = os.environ.get("CCVM_TEST_BASH", "/bin/bash")


class LocalConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ccvm-config-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "local.env"
        self.config.write_text("")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("CCVM_")}
        self.env["CCVM_CONFIG_FILE"] = str(self.config)

    def run_bash(self, body, **overrides):
        env = self.env | overrides
        return subprocess.run([BASH_EXEC, "-c", '. "$1"\n' + body, "test", str(KIT / "scripts/lib.sh")],
                              env=env, text=True, capture_output=True)

    def values(self, **overrides):
        result = self.run_bash('printf "%s\\n" "$VM" "$LIMA_HOME" "$STATE" "$BASELINE"', **overrides)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def write_config(self):
        home = self.root / "VM home 空格"
        state = self.root / "state with spaces"
        self.config.write_text("VM_NAME=local-vm\nVM_HOME=" + shlex.quote(str(home))
                               + "\nSTATE_DIR=" + shlex.quote(str(state)) + "\n")
        return home, state

    def test_defaults_do_not_inherit_foreign_lima_home(self):
        got = self.values(LIMA_HOME=str(self.root / "unrelated-lima"))
        self.assertEqual(got, ["ccvm", str(Path.home() / ".lima-ccvm"), str(KIT / "state"),
                               str(KIT / "state/expected-ip.txt")])

    def test_local_settings_preserve_spaces_and_unicode(self):
        home, state = self.write_config()
        self.assertEqual(self.values(), ["local-vm", str(home), str(state), str(state / "expected-ip.txt")])
        self.assertFalse(home.exists())
        self.assertFalse(state.exists())

    def test_explicit_environment_overrides_local_settings(self):
        self.write_config()
        home, state = self.root / "override-home", self.root / "override-state"
        self.assertEqual(self.values(CCVM_NAME="override-vm", CCVM_LIMA_HOME=str(home),
                                     CCVM_STATE_DIR=str(state)),
                         ["override-vm", str(home), str(state), str(state / "expected-ip.txt")])

    def test_baseline_uses_selected_state_directory(self):
        _, state = self.write_config()
        state.mkdir()
        baseline = state / "expected-ip.txt"
        baseline.write_text("203.0.113.7\n")
        result = self.run_bash("baseline")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "203.0.113.7\n")
        self.assertEqual(baseline.read_text(), "203.0.113.7\n")

    def test_missing_explicit_config_fails(self):
        result = self.run_bash("true", CCVM_CONFIG_FILE=str(self.root / "missing.env"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("本地配置不可读", result.stderr)

    def test_invalid_names_and_relative_paths_fail(self):
        for overrides in [{"CCVM_NAME": "../other"}, {"CCVM_NAME": "--help"},
                          {"CCVM_LIMA_HOME": "relative"}, {"CCVM_STATE_DIR": "relative"}]:
            with self.subTest(overrides=overrides):
                self.assertNotEqual(self.run_bash("true", **overrides).returncode, 0)

    def test_lima_global_overrides_still_fail_with_force(self):
        home = self.root / "lima"
        (home / "_config").mkdir(parents=True)
        (home / "_config/override.yaml").write_text("mounts: []\n")
        result = self.run_bash("require_clean_lima_home", CCVM_LIMA_HOME=str(home), CCVM_FORCE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("发现 Lima 全局配置", result.stderr)

    def test_setup_messages_work_with_system_bash(self):
        # Stop before any VM creation. This catches the Bash 3.2 variable/Chinese
        # punctuation regression in the real setup.sh, rather than a copied string.
        commands = {
            "uname": 'case "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 90;; esac',
            "curl": "printf 'ip=203.0.113.7\\n'",
            "netstat": "printf 'tcp4 0 0 127.0.0.1.17897 *.* LISTEN\\n'",
            "limactl": 'case "$1" in --version) echo "limactl version 2.2.1";; list) exit 0;; template) exit 73;; *) exit 91;; esac',
        }
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, body in commands.items():
            path = bin_dir / name
            path.write_text("#!/bin/bash\n" + body + "\n")
            path.chmod(0o755)
        env = self.env | {"PATH": str(bin_dir) + os.pathsep + self.env["PATH"],
                          "CCVM_LIMA_HOME": str(self.root / "new-vm")}
        result = subprocess.run([BASH_EXEC, str(KIT / "scripts/setup.sh")], env=env,
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
        self.assertIn("203.0.113.7", result.stdout)
        self.assertIn("2/5", result.stdout)
        self.assertNotIn("unbound variable", result.stderr)
        self.assertFalse((self.root / "new-vm").exists())


if __name__ == "__main__":
    unittest.main()
