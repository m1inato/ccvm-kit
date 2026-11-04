"""NDJSON event output (--json) of the host scripts, driven with stub commands instead of a Mac/VM."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

KIT = Path(__file__).resolve().parents[1]
BASH_EXEC = os.environ.get("CCVM_TEST_BASH", "/bin/bash")
US = "\x1f"

SELFCHECK_OK = """PASS vm.firewall_active 防火墙服务运行中
PASS vm.firewall_main_rules 主防火墙规则已加载（不是锁定模式）
PASS vm.tun_up TUN 服务运行中且 sb-tun 存在
PASS vm.egress_reachable VM（cc 用户，无代理变量）可经 TUN 出网：203.0.113.7
PASS egress.vm_matches_baseline VM 出口 = 基线 203.0.113.7
EGRESS 203.0.113.7
"""

LIMACTL = r'''#!/bin/bash
printf '%s\n' "$*" >> "$STUB_LOG"
case "$1" in
  --version) echo "limactl version 2.2.1" ;;
  list)
    case "$*" in
      *"{{.Status}}"*) printf '%s\n' "${STUB_VM_STATUS-Running}" ;;
      *".Location"*) printf '%s' "${STUB_MOUNTS-}" ;;
      *"{{len .Config.Networks}}"*) echo "${STUB_NETWORKS-0}" ;;
      *"{{.CPUs}}"*) echo "4 6442450944 64424509440" ;;
    esac ;;
  edit)
    [ -z "${STUB_EDIT_FILE-}" ] || printf '%s' "$4" > "$STUB_EDIT_FILE"
    exit "${STUB_EDIT_RC:-0}" ;;
  shell)
    case "$*" in
      *"tmux list-sessions"*)
        [ -n "${STUB_TMUX_SESSIONS+x}" ] || { echo "no server running" >&2; exit 1; }
        printf '%s' "$STUB_TMUX_SESSIONS"; exit 0 ;;
      *"tar --no-same-owner -xf - -C "*)
        mkdir -p "$STUB_UNPACK" && exec tar -xf - -C "$STUB_UNPACK" ;;
      *"sudo -u cc -H cat -- "*)
        printf '%s' "${STUB_CAT-}"; exit "${STUB_CAT_RC:-0}" ;;
    esac
    body="$(cat)"
    case "$body" in
      *"VM 内以 cc 身份运行"*) out="$STUB_WORKSPACE_OUT"; rc="${STUB_WORKSPACE_RC:-0}" ;;
      *"断流 / 抓包"*|*"会短暂停止 TUN"*) out="$STUB_LEAK_OUT"; rc="${STUB_LEAK_RC:-0}" ;;
      *"ccvm-shares.service"*) out="${STUB_SHARES_OUT-}"; rc="${STUB_SHARES_RC:-0}" ;;
      *"补装软件包（升级步骤）"*) out="${STUB_UPGRADE_OUT-}"; rc="${STUB_UPGRADE_RC:-0}" ;;
      *) out="$STUB_SELFCHECK_OUT"; rc="${STUB_SELFCHECK_RC:-0}" ;;
    esac
    [ -n "$out" ] && cat "$out"
    exit "$rc" ;;
  start|stop) echo "limactl $1 (stub)" ;;
  *) exit 91 ;;
esac
'''


class ScriptHarness(unittest.TestCase):
    """Real host scripts driven with stub limactl / curl / netstat / uname. No tests of its own."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ccvm-events-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        (self.state / "expected-ip.txt").write_text("203.0.113.7\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls.log"
        self.stub("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 90;; esac')
        self.stub("curl", "printf 'ip=%s\\n' \"${STUB_HOST_IP-203.0.113.7}\"")
        self.stub("netstat", "printf 'tcp4 0 0 %s.17897 *.* LISTEN\\n' \"${STUB_LISTEN-127.0.0.1}\"")
        (self.bin / "limactl").write_text(LIMACTL)
        (self.bin / "limactl").chmod(0o755)
        self.selfcheck = self.write("selfcheck.out", SELFCHECK_OK)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("CCVM_")} | {
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "CCVM_CONFIG_FILE": str(self.write("local.env", "")),
            "CCVM_LIMA_HOME": str(self.root / "lima"),
            "CCVM_STATE_DIR": str(self.state),
            "STUB_LOG": str(self.log),
            "STUB_SELFCHECK_OUT": str(self.selfcheck),
        }

    def stub(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/bash\n" + body + "\n")
        path.chmod(0o755)

    def write(self, name, text):
        path = self.root / name
        path.write_text(text)
        return path

    def run_script(self, script, *args, **env):
        return subprocess.run([BASH_EXEC, str(KIT / "scripts" / script), *args], stdin=subprocess.DEVNULL,
                              env=self.env | env, text=True, capture_output=True, timeout=60)

    def events(self, result):
        lines = result.stdout.splitlines()
        self.assertTrue(lines, "no events; stderr:\n" + result.stderr)
        parsed = []
        for line in lines:
            try:
                parsed.append(json.loads(line))
            except ValueError:
                self.fail("non-JSON line on stdout: %r\nstderr:\n%s" % (line, result.stderr))
        for event in parsed:
            self.assertEqual(event["v"], 1)
        return parsed

    def checks(self, events):
        return {e["id"]: e["ok"] for e in events if e["type"] == "check"}

    def values(self, events):
        return {e["key"]: e["value"] for e in events if e["type"] == "value"}


class EventTests(ScriptHarness):
    # ------------------------------------------------------------------ check.sh
    def test_check_json_happy_path(self):
        result = self.run_script("check.sh", "--quick", "--json")
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]["type"], "start")
        self.assertEqual(events[0]["script"], "check")
        self.assertEqual(events[-1], {"v": 1, "type": "end", "ok": True, "code": 0})
        checks = self.checks(events)
        for cid in ["host.macos_arm64", "lima.version", "lima.no_global_config", "vm.running",
                    "baseline.present", "listener.loopback_only", "lima.effective_config",
                    "egress.host_matches_baseline", "vm.tun_up", "egress.vm_matches_baseline"]:
            self.assertIs(checks.get(cid), True, cid)
        values = self.values(events)
        self.assertEqual(values["host_egress"], "203.0.113.7")
        self.assertEqual(values["vm_egress"], "203.0.113.7")
        self.assertEqual(values["baseline"], "203.0.113.7")
        self.assertEqual(values["mode"], "quick")
        self.assertIn("全部通过", result.stderr)  # human text moves to stderr in JSON mode
        self.assertIn("sudo bash -s -- 203.0.113.7 quick", self.log.read_text())

    def test_check_json_reports_egress_change(self):
        self.selfcheck.write_text(SELFCHECK_OK.replace("PASS egress.vm_matches_baseline VM 出口 = 基线 203.0.113.7",
                                                       "FAIL egress.vm_matches_baseline VM 出口 198.51.100.9 ≠ 基线 203.0.113.7")
                                  .replace("EGRESS 203.0.113.7", "EGRESS 198.51.100.9"))
        result = self.run_script("check.sh", "--json", STUB_HOST_IP="198.51.100.9", STUB_SELFCHECK_RC="1")
        events = self.events(result)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["type"], "end")
        self.assertIs(events[-1]["ok"], False)
        checks = self.checks(events)
        self.assertIs(checks["egress.host_matches_baseline"], False)
        self.assertIs(checks["egress.vm_matches_baseline"], False)
        self.assertEqual(self.values(events)["vm_egress"], "198.51.100.9")
        self.assertTrue(any(e["type"] == "error" for e in events))

    def test_listener_on_lan_fails_with_stable_id(self):
        result = self.run_script("check.sh", "--json", STUB_LISTEN="192.168.1.10")
        events = self.events(result)
        self.assertIs(self.checks(events)["listener.loopback_only"], False)
        self.assertIs(events[-1]["ok"], False)

    def test_stopped_vm_is_reported_not_crashed(self):
        result = self.run_script("check.sh", "--json", STUB_VM_STATUS="Stopped")
        events = self.events(result)
        self.assertIs(self.checks(events)["vm.running"], False)
        self.assertEqual(self.values(events)["vm_status"], "Stopped")
        self.assertIs(events[-1]["ok"], False)

    def test_human_output_is_unchanged_without_json(self):
        result = self.run_script("check.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('{"v":1', result.stdout + result.stderr)
        self.assertIn("全部通过", result.stdout)
        self.assertIn("VM 出口 = 基线 203.0.113.7", result.stdout)
        self.assertNotIn("egress.vm_matches_baseline", result.stdout)

    def test_unknown_argument_is_an_error_event(self):
        events = self.events(self.run_script("check.sh", "--bogus", "--json"))
        self.assertEqual(events[-1]["type"], "end")
        self.assertIs(events[-1]["ok"], False)

    def test_config_errors_still_end_the_event_stream(self):
        result = self.run_script("check.sh", "--json", CCVM_NAME="../escape")
        events = self.events(result)
        self.assertEqual(events[0]["type"], "start")
        self.assertIs(events[-1]["ok"], False)

    # ------------------------------------------------------------------ json_str
    def test_json_strings_survive_awkward_text(self):
        samples = ['plain', 'quote " and backslash \\ and slash /', "tab\there", "two\nlines",
                   "ctrl\x01\x07\x1bchars", "中文：标点（全角）", "", "trailing\\"]
        for sample in samples:
            with self.subTest(sample=sample):
                result = subprocess.run([BASH_EXEC, "-c", '. "$1"; json_str "$2"', "t",
                                         str(KIT / "scripts/lib.sh"), sample],
                                        env=self.env, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                decoded = json.loads(result.stdout)
                expected = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", sample.replace("\t", " "))
                self.assertEqual(decoded, expected)

    # ------------------------------------------------------------------ rebaseline.sh
    def test_rebaseline_dry_run_never_writes(self):
        result = self.run_script("rebaseline.sh", "--dry-run", "--json", STUB_HOST_IP="198.51.100.9",
                                 STUB_SELFCHECK_OUT=str(self.write("sc", "EGRESS 198.51.100.9\n")))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.values(events)["host_egress"], "198.51.100.9")
        self.assertEqual((self.state / "expected-ip.txt").read_text(), "203.0.113.7\n")

    def test_rebaseline_accept_requires_both_ends_to_match_the_confirmed_ip(self):
        new_vm = str(self.write("sc", "EGRESS 198.51.100.9\n"))
        # confirmed an IP that is no longer what both ends see
        result = self.run_script("rebaseline.sh", "--accept", "198.51.100.10", "--json",
                                 STUB_HOST_IP="198.51.100.9", STUB_SELFCHECK_OUT=new_vm)
        self.assertNotEqual(result.returncode, 0)
        self.assertIs(self.checks(self.events(result))["rebaseline.confirmed"], False)
        self.assertEqual((self.state / "expected-ip.txt").read_text(), "203.0.113.7\n")
        # Mac and VM disagree
        result = self.run_script("rebaseline.sh", "--accept", "198.51.100.9", "--json",
                                 STUB_HOST_IP="198.51.100.9",
                                 STUB_SELFCHECK_OUT=str(self.write("sc2", "EGRESS 192.0.2.1\n")))
        self.assertIs(self.checks(self.events(result))["egress.host_matches_vm"], False)
        self.assertEqual((self.state / "expected-ip.txt").read_text(), "203.0.113.7\n")
        # both match the confirmed value
        result = self.run_script("rebaseline.sh", "--accept", "198.51.100.9", "--json",
                                 STUB_HOST_IP="198.51.100.9", STUB_SELFCHECK_OUT=new_vm)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.state / "expected-ip.txt").read_text(), "198.51.100.9\n")

    def test_rebaseline_rejects_non_ipv4_accept(self):
        result = self.run_script("rebaseline.sh", "--accept", "1.2.3.4; rm -rf /", "--json")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")

    # ------------------------------------------------------------------ preflight / vm
    def test_preflight_reports_every_item(self):
        result = self.run_script("preflight.sh", "--json", STUB_LISTEN="0.0.0.0")
        events = self.events(result)
        checks = self.checks(events)
        self.assertIs(checks["listener.loopback_only"], False)
        self.assertIs(checks["egress.host_reachable"], True)   # still measured after the listener failure
        self.assertIs(checks["lima.no_global_config"], True)
        self.assertIs(events[-1]["ok"], False)

    def test_preflight_fails_on_lima_global_config(self):
        (self.root / "lima/_config").mkdir(parents=True)
        (self.root / "lima/_config/default.yaml").write_text("mounts: []\n")
        events = self.events(self.run_script("preflight.sh", "--json"))
        self.assertIs(self.checks(events)["lima.no_global_config"], False)
        self.assertIs(events[-1]["ok"], False)

    def test_vm_start_checks_effective_config(self):
        result = self.run_script("vm.sh", "start", "--json", STUB_VM_STATUS="Stopped")
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIs(self.checks(events)["lima.effective_config"], True)
        self.assertIn("start --tty=false ccvm", self.log.read_text())

    def test_vm_start_refuses_missing_vm(self):
        events = self.events(self.run_script("vm.sh", "start", "--json", STUB_VM_STATUS=""))
        self.assertIs(self.checks(events)["vm.exists"], False)

    # ------------------------------------------------------------------ workspace.sh
    def test_workspace_list_becomes_project_items(self):
        line = US.join(["PROJECT", "my-api", "main", "3", "1", "0", "1793000000",
                        'fix "quoted" \\ subject', "https://github.com/you/my-api.git", "1", "1792999000"])
        out = self.write("ws", line + "\n" + US.join(["PROJECT", "web-app", "feature/login", "0", "0", "0",
                                                       "1792000000", "", "", "0", "0"]) + "\n")
        result = self.run_script("workspace.sh", "list", "--json", STUB_WORKSPACE_OUT=str(out))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        items = [e for e in events if e["type"] == "item"]
        self.assertEqual([i["name"] for i in items], ["my-api", "web-app"])
        self.assertEqual(items[0]["dirty"], 3)
        self.assertEqual(items[0]["subject"], 'fix "quoted" \\ subject')
        self.assertEqual(items[0]["claude_sessions"], 1)
        self.assertEqual(items[1]["branch"], "feature/login")
        self.assertEqual(items[1]["remote"], "")
        self.assertEqual(self.values(events)["project_count"], "2")

    def test_clone_rejects_unsafe_urls_before_reaching_the_vm(self):
        for url in ["https://user:token@github.com/you/x.git", "ext::sh -c touch% /tmp/pwn",
                    "https://github.com/you/x;rm -rf ~", "--upload-pack=touch /tmp/x",
                    "file:///etc", "https://github.com/you/$(id)", "git@github.com:you/x y.git"]:
            with self.subTest(url=url):
                if self.log.exists():
                    self.log.unlink()
                result = self.run_script("workspace.sh", "clone", url, "--json")
                events = self.events(result)
                self.assertIs(self.checks(events).get("project.url"), False)
                calls = self.log.read_text() if self.log.exists() else ""
                self.assertNotIn("shell", calls)

    def test_clone_accepts_common_url_forms(self):
        out = self.write("clone", "VALUE project my-api\nPASS project.clone 已克隆到 ~/work/my-api\n")
        for url in ["https://github.com/you/my-api.git", "git@github.com:you/my-api.git",
                    "ssh://git@example.com:2222/team/my-api"]:
            with self.subTest(url=url):
                result = self.run_script("workspace.sh", "clone", url, "--json", STUB_WORKSPACE_OUT=str(out))
                events = self.events(result)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIs(self.checks(events)["project.clone"], True)
                self.assertEqual(self.values(events)["project"], "my-api")

    # ------------------------------------------------------------------ tmux 会话
    def test_workspace_list_includes_tmux_sessions(self):
        lines = [US.join(["PROJECT", "my-api", "main", "0", "0", "0", "1793000000", "s", "", "0", "0"]),
                 US.join(["SESSION", "my-api-1", "1793000100", "1", "/home/cc/work/my-api"]),
                 US.join(["SESSION", "scratch", "1793000200", "0", "/home/cc"]),
                 US.join(["SESSION", "bad name;x", "1", "0", "/home/cc/work/x"])]
        result = self.run_script("workspace.sh", "list", "--json", STUB_WORKSPACE_OUT=str(self.write("ws", "\n".join(lines) + "\n")))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        sessions = [e for e in events if e["type"] == "item" and e["kind"] == "session"]
        self.assertEqual([(x["name"], x["project"], x["attached"]) for x in sessions],
                         [("my-api-1", "my-api", 1), ("scratch", "", 0)])
        self.assertEqual(self.values(events)["session_count"], "2")

    def test_claude_events_become_items(self):
        lines = [US.join(["CLAUDE", "1793000000", "Stop", "/home/cc/work/my-api/src", "", ""]),
                 US.join(["CLAUDE", "1793000005", "Notification", "/home/cc/work/my-api", "permission_prompt", 'needs "Bash"']),
                 US.join(["CLAUDE", "1793000006", "Exec", "/home/cc/work/x", "", ""]),
                 "VALUE events_size 512"]
        result = self.run_script("workspace.sh", "events", "0", "--json", STUB_WORKSPACE_OUT=str(self.write("ev", "\n".join(lines) + "\n")))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        items = [e for e in events if e["type"] == "item" and e["kind"] == "claude_event"]
        self.assertEqual([(i["event"], i["project"]) for i in items], [("Stop", "my-api"), ("Notification", "my-api")])
        self.assertEqual(items[1]["message"], 'needs "Bash"')
        self.assertEqual(self.values(events)["events_size"], "512")
        for bad in ["-1", "1e9", "end;id"]:
            with self.subTest(offset=bad):
                self.assertIs(self.events(self.run_script("workspace.sh", "events", bad, "--json"))[-1]["ok"], False)

    def test_kill_session_validates_name_before_reaching_the_vm(self):
        result = self.run_script("workspace.sh", "kill-session", "x;rm -rf ~", "--json")
        self.assertIs(self.checks(self.events(result))["session.kill"], False)
        self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")

    def test_rename_session_validates_names_before_reaching_the_vm(self):
        for args in [["a b", "x"], ["my-api-1", "x;rm -rf ~"], ["my-api-1", "my-api-1"], ["my-api-1", "a" * 65]]:
            with self.subTest(args=args):
                if self.log.exists():
                    self.log.unlink()
                events = self.events(self.run_script("workspace.sh", "rename-session", *args, "--json"))
                self.assertIs(self.checks(events)["session.rename"], False)
                self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")

    def test_rename_session_relays_the_guest_verdict(self):
        out = self.write("rn", "PASS session.rename 已把 my-api-1 改名为 api-review\n")
        result = self.run_script("workspace.sh", "rename-session", "my-api-1", "api-review", "--json", STUB_WORKSPACE_OUT=str(out))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIs(self.checks(self.events(result))["session.rename"], True)
        self.assertIn("rename-session my-api-1 api-review", self.log.read_text())

    def test_enter_attach_skips_checks_and_only_attaches(self):
        self.selfcheck.write_text("FAIL vm.tun_up TUN 停了\nEGRESS \n")
        # 桩 limactl 把 shell 的退出码一律当成 selfcheck 的（这里是 1）；要核对的是调用了什么
        self.run_script("enter.sh", "--attach", "my-api-1", STUB_SELFCHECK_RC="1")
        calls = self.log.read_text()
        self.assertIn("sudo -iu cc tmux attach-session -t =my-api-1", calls)
        self.assertNotIn("bash -s", calls)   # 没有跑 VM 内检查

    def test_enter_new_session_requires_passing_checks(self):
        result = self.run_script("enter.sh", "--project", "my-api", "--session", "my-api-2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tmux new-session -A -s my-api-2 -c /home/cc/work/my-api", self.log.read_text())
        self.log.unlink()
        self.selfcheck.write_text("FAIL vm.tun_up TUN 停了\nEGRESS \n")
        result = self.run_script("enter.sh", "--project", "my-api", "--session", "my-api-3", STUB_SELFCHECK_RC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("new-session", self.log.read_text())

    def test_enter_auto_session_picks_next_free_name(self):
        result = self.run_script("enter.sh", "--project", "my-api", "--session", "auto",
                                 STUB_TMUX_SESSIONS="my-api-1\r\nmy-api-2\r\nscratch\r\nmy-api-10\r\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("sudo -u cc -H tmux list-sessions -F #{session_name}", calls)
        self.assertIn("tmux new-session -A -s my-api-3 -c /home/cc/work/my-api", calls)

    def test_enter_auto_session_sanitizes_project_name_and_survives_no_tmux_server(self):
        # 没有 STUB_TMUX_SESSIONS：桩模拟「没有 tmux 服务端」，list-sessions 失败，当作没有会话
        result = self.run_script("enter.sh", "--project", "my.api", "--session", "auto")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tmux new-session -A -s my_api-1 -c /home/cc/work/my.api", self.log.read_text())

    def test_enter_auto_session_still_requires_passing_checks(self):
        self.selfcheck.write_text("FAIL vm.tun_up TUN 停了\nEGRESS \n")
        result = self.run_script("enter.sh", "--project", "my-api", "--session", "auto",
                                 STUB_SELFCHECK_RC="1", STUB_TMUX_SESSIONS="")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("new-session", self.log.read_text())
        self.assertNotIn("list-sessions", self.log.read_text())

    def test_enter_rejects_bad_session_arguments(self):
        for args in [["--attach", "a b"], ["--session", "x"], ["--session", "auto"], ["--attach", "a", "--project", "p"], ["--project", "p", "--session", "a.b"]]:
            with self.subTest(args=args):
                if self.log.exists():
                    self.log.unlink()
                result = self.run_script("enter.sh", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")

    # ------------------------------------------------------------------ setup.sh
    def test_setup_json_reports_steps_and_failure_code(self):
        self.stub("limactl", 'case "$1" in --version) echo "limactl version 2.2.1";; list) exit 0;; template) exit 73;; *) exit 91;; esac')
        result = self.run_script("setup.sh", "--json", CCVM_LIMA_HOME=str(self.root / "new-vm"))
        events = self.events(result)
        self.assertEqual(result.returncode, 73)
        steps = [e["id"] for e in events if e["type"] == "step"]
        self.assertEqual(steps, ["setup.listener", "setup.vm"])
        self.assertEqual(events[-1], {"v": 1, "type": "end", "ok": False, "code": 73})


class GuestProtocolTests(unittest.TestCase):
    """Every PASS/FAIL the VM scripts can print carries a stable id that docs/events.md documents."""
    ID = re.compile(r"^[a-z0-9_.]+(\$\{port\})?$")

    def script_ids(self):
        ids = set()
        call = re.compile(r'\b(?:pass|fail|check|refuse|pass_quiet|soft_fail|fail_check)\s+"?([A-Za-z0-9_.${}]+)"?\s')
        for path in list((KIT / "guest").glob("*.sh")) + list((KIT / "scripts").glob("*.sh")):
            for line in path.read_text().splitlines():
                stripped = line.strip()
                if stripped.startswith("#") or re.match(r"^\w+\(\)\s*\{", stripped):
                    continue
                for match in call.finditer(line):
                    token = match.group(1)
                    if token in {"$id", "$msg", '"$id"', "id"}:
                        continue
                    ids.add((path.name, token))
                for match in re.finditer(r'echo "(?:PASS|FAIL) ([a-z0-9_.]+) ', line):
                    ids.add((path.name, match.group(1)))
        return ids

    def test_ids_are_stable_identifiers_and_documented(self):
        doc = (KIT / "docs/events.md").read_text()
        ids = self.script_ids()
        self.assertGreater(len(ids), 40)
        for name, token in sorted(ids):
            with self.subTest(script=name, id=token):
                self.assertRegex(token, self.ID)
                documented = token.replace("${port}", "<port>")
                self.assertIn("`" + documented + "`", doc)

    def test_guest_lines_have_ids(self):
        for name in ["selfcheck.sh", "leaktest.sh"]:
            text = (KIT / "guest" / name).read_text()
            for match in re.finditer(r'^\s*(?:check|refuse|pass|fail) "([^"]*)"', text, re.M):
                self.assertRegex(match.group(1), self.ID, f"{name}: {match.group(0)}")


if __name__ == "__main__":
    unittest.main()
