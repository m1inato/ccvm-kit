"""Package upgrades for already-deployed VMs: scripts/upgrade.sh, guest/upgrade.sh level logic, workspace values."""
import re
import subprocess

from test_events import BASH_EXEC, KIT, US, ScriptHarness


def lib_level():
    return int(re.search(r"^VM_LEVEL=(\d+)$", (KIT / "scripts/lib.sh").read_text(), re.M).group(1))


class UpgradeTests(ScriptHarness):
    def test_upgrade_runs_guest_steps_then_full_check(self):
        out = self.write("up", "PASS vm.upgrade 已补装到级别 1\nVALUE vm_level 1\n")
        result = self.run_script("upgrade.sh", "--json", STUB_UPGRADE_OUT=str(out))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([e["type"] for e in events].count("start"), 1)
        self.assertEqual(events[-1], {"v": 1, "type": "end", "ok": True, "code": 0})
        self.assertEqual([e["id"] for e in events if e["type"] == "step"], ["upgrade.packages", "upgrade.verify"])
        checks = self.checks(events)
        self.assertIs(checks["vm.upgrade"], True)
        self.assertIs(checks["vm.tun_up"], True)   # 完整验收的结论并在同一个流里
        values = self.values(events)
        self.assertEqual(values["vm_level"], "1")
        self.assertEqual(values["vm_level_target"], str(lib_level()))
        self.assertEqual(values["mode"], "full")
        calls = self.log.read_text()
        self.assertIn("sudo bash -s -- %d" % lib_level(), calls)
        self.assertIn("203.0.113.7 full", calls)

    def test_failed_upgrade_stops_before_the_check(self):
        out = self.write("up", "FAIL vm.upgrade 第 1 步没有完成（停在级别 0），可以重试\nVALUE vm_level 0\n")
        result = self.run_script("upgrade.sh", "--json", STUB_UPGRADE_OUT=str(out), STUB_UPGRADE_RC="1")
        events = self.events(result)
        self.assertNotEqual(result.returncode, 0)
        self.assertIs(self.checks(events)["vm.upgrade"], False)
        self.assertIs(events[-1]["ok"], False)
        self.assertNotIn("full", self.log.read_text())

    def test_upgrade_needs_a_running_vm(self):
        events = self.events(self.run_script("upgrade.sh", "--json", STUB_VM_STATUS="Stopped"))
        self.assertIs(self.checks(events)["vm.running"], False)
        self.assertNotIn("shell", self.log.read_text())

    def test_workspace_list_reports_packages(self):
        lines = [US.join(["PROJECT", "my-api", "main", "0", "0", "0", "1793000000", "s", "", "0", "0"]),
                 "VALUE tmux_installed 0", "VALUE vm_level 0"]
        result = self.run_script("workspace.sh", "list", "--json", STUB_WORKSPACE_OUT=str(self.write("ws", "\n".join(lines) + "\n")))
        values = self.values(self.events(result))
        self.assertEqual((values["tmux_installed"], values["vm_level"], values["vm_level_target"]), ("0", "0", str(lib_level())))

    # ------------------------------------------------------------------ guest/upgrade.sh 的级别逻辑
    def guest(self, code, level_text=None):
        level = self.root / "level"
        if level_text is not None:
            level.write_text(level_text)
        return subprocess.run([BASH_EXEC, "-c", 'CCVM_UPGRADE_LIB=1 . "$0"; ' + code, str(KIT / "guest/upgrade.sh")],
                              env=self.env | {"CCVM_LEVEL_FILE": str(level)}, text=True, capture_output=True, timeout=30)

    def test_current_level_reads_the_file_or_falls_back_to_zero(self):
        for text, want in [(None, "0"), ("1\n", "1"), (" 2 \n", "2"), ("007", "7"), ("garbage", "0"), ("", "0"), ("-1", "0")]:
            with self.subTest(text=text):
                r = self.guest("current_level", text)
                self.assertEqual(r.stdout.strip(), want, r.stderr)

    def test_pending_steps_and_highest_step(self):
        self.assertEqual(self.guest("pending_steps 0 3").stdout.split(), ["1", "2", "3"])
        self.assertEqual(self.guest("pending_steps 1 1").stdout.split(), [])
        self.assertEqual(self.guest("pending_steps 2 1").stdout.split(), [])
        # 套件要求的级别必须正好是 guest/upgrade.sh 里的步骤数
        self.assertEqual(int(self.guest("highest_step").stdout), lib_level())
