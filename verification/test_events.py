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

SELFCHECK_OK = """PASS vm.firewall 防火墙在
PASS vm.tun TUN 在
PASS vm.proxy 经代理出网，出口 203.0.113.7
EGRESS 203.0.113.7
"""

SELFCHECK_DOWN = """PASS vm.firewall 防火墙在
PASS vm.tun TUN 在
FAIL vm.proxy 代理不通，VM 现在断网
EGRESS 
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
    printf 'TERM=%s\n' "${TERM-}" >> "$STUB_LOG"
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
      *"list_ports"*) out="${STUB_PORTS_OUT-}"; rc="${STUB_PORTS_RC:-0}" ;;
      *"macports.sh list"*) out="${STUB_MACPORTS_OUT-}"; rc="${STUB_MACPORTS_RC:-0}" ;;
      *"VM 内以 cc 身份运行"*) out="$STUB_WORKSPACE_OUT"; rc="${STUB_WORKSPACE_RC:-0}" ;;
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
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls.log"
        self.stub("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 90;; esac')
        # STUB_HOST_IP=down：代理入口不通
        self.stub("curl", '[ "${STUB_HOST_IP-}" = down ] && exit 7\nprintf \'ip=%s\\n\' "${STUB_HOST_IP-203.0.113.7}"')
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
        result = self.run_script("check.sh", "--json")
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]["type"], "start")
        self.assertEqual(events[0]["script"], "check")
        self.assertEqual(events[-1], {"v": 1, "type": "end", "ok": True, "code": 0})
        checks = self.checks(events)
        for cid in ["host.macos_arm64", "lima.version", "vm.running", "host.proxy", "vm.firewall", "vm.tun", "vm.proxy"]:
            self.assertIs(checks.get(cid), True, cid)
        values = self.values(events)
        self.assertEqual(values["host_egress"], "203.0.113.7")
        self.assertEqual(values["vm_egress"], "203.0.113.7")
        self.assertIn("正常", result.stderr)  # human text moves to stderr in JSON mode
        self.assertIn("sudo bash -s", self.log.read_text())

    def test_check_retries_incomplete_host_probe(self):
        self.stub("curl", """
if [ ! -f "$STUB_LOG.probe" ]; then
    touch "$STUB_LOG.probe"
    printf 'ip=198.51.100.9\\n'
    exit 28
fi
printf 'ip=203.0.113.7\\n'
""")
        result = self.run_script("check.sh", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.values(self.events(result))["host_egress"], "203.0.113.7")

    def test_a_different_exit_ip_still_passes(self):
        self.selfcheck.write_text(SELFCHECK_OK.replace("203.0.113.7", "198.51.100.9"))
        result = self.run_script("check.sh", "--json", STUB_HOST_IP="198.51.100.9")
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIs(events[-1]["ok"], True)
        self.assertEqual(self.values(events)["vm_egress"], "198.51.100.9")

    def test_proxy_down_fails_with_stable_ids(self):
        self.selfcheck.write_text(SELFCHECK_DOWN)
        result = self.run_script("check.sh", "--json", STUB_HOST_IP="down", STUB_SELFCHECK_RC="1")
        events = self.events(result)
        self.assertNotEqual(result.returncode, 0)
        self.assertIs(events[-1]["ok"], False)
        checks = self.checks(events)
        self.assertIs(checks["host.proxy"], False)
        self.assertIs(checks["vm.proxy"], False)
        self.assertIs(checks["vm.tun"], True)
        self.assertEqual(self.values(events)["host_egress"], "")
        self.assertTrue(any(e["type"] == "error" for e in events))

    def test_check_does_not_look_at_listeners_or_lima_config(self):
        (self.root / "lima/_config").mkdir(parents=True)
        (self.root / "lima/_config/default.yaml").write_text("mounts: []\n")
        result = self.run_script("check.sh", "--json", STUB_NETWORKS="1", STUB_MOUNTS="/Volumes/Work/x\n")
        self.assertEqual(result.returncode, 0, result.stderr)

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
        self.assertIn("正常", result.stdout)
        self.assertIn("经代理出网，出口 203.0.113.7", result.stdout)
        self.assertNotIn("vm.proxy", result.stdout)

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

    # ------------------------------------------------------------------ preflight / vm
    def test_preflight_reports_every_item(self):
        result = self.run_script("preflight.sh", "--json", STUB_HOST_IP="down", PATH=str(self.bin) + os.pathsep + "/usr/bin:/bin")
        events = self.events(result)
        checks = self.checks(events)
        self.assertIs(checks["host.proxy"], False)
        self.assertIs(checks["lima.version"], True)
        self.assertIs(events[-1]["ok"], False)
        result = self.run_script("preflight.sh", "--json")
        self.assertIs(self.checks(self.events(result))["host.proxy"], True)

    def test_vm_start_starts_a_stopped_vm(self):
        result = self.run_script("vm.sh", "start", "--json", STUB_VM_STATUS="Stopped")
        self.assertEqual(result.returncode, 0, result.stderr)
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

    def test_guest_session_listing_survives_real_tmux_output(self):
        # 真的 tmux 会把 -F 格式里的控制字符转义成 "\\037" 这样的文字：分隔符必须是可见字符
        text = (KIT / "guest/workspace.sh").read_text()
        func = re.search(r"^list_sessions\(\) \{.*?^\}$", text, re.S | re.M).group(0)
        self.stub("tmux", 'printf "%s\\n" "$*" >> "$STUB_LOG"\n'
                  'case "$1" in\n'
                  '  list-panes) printf "%s\\n" "my-api-1|11|claude" "my-api-1|01|bash" "scratch|11|bash" ;;\n'
                  '  list-sessions) printf "%s\\n" "my-api-1|1793000100|1|1793000900|/home/cc/work/my-api" "scratch|1793000200|0|1793000300|/home/cc/a|b" ;;\n'
                  'esac')
        r = subprocess.run([BASH_EXEC, "-c", "US=$'\\x1f'; clean() { tr -d '\\037\\r\\n' | cut -c1-200; }\n" + func + "\nlist_sessions"],
                           env=self.env, text=True, capture_output=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([l.split(US) for l in r.stdout.splitlines()], [
            ["SESSION", "my-api-1", "1793000100", "1", "/home/cc/work/my-api", "1793000900", "claude"],
            ["SESSION", "scratch", "1793000200", "0", "/home/cc/a|b", "1793000300", "bash"],
        ])
        self.assertNotRegex(self.log.read_text(), r"[\x00-\x08\x0b-\x1f]")   # 传给 tmux 的格式里没有控制字符
        # 宿主端把这些行转成会话事件
        result = self.run_script("workspace.sh", "list", "--json", STUB_WORKSPACE_OUT=str(self.write("ws", r.stdout)))
        sessions = [e for e in self.events(result) if e["type"] == "item" and e["kind"] == "session"]
        self.assertEqual([(x["name"], x["project"], x["activity"], x["command"]) for x in sessions],
                         [("my-api-1", "my-api", 1793000900, "claude"), ("scratch", "", 1793000300, "bash")])

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

    def test_enter_does_not_gate_on_checks(self):
        # 代理断了 VM 自己断网；进入 VM 不需要先通过检查
        self.selfcheck.write_text(SELFCHECK_DOWN)
        result = self.run_script("enter.sh", "--project", "my-api", "--session", "my-api-2", STUB_HOST_IP="down")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("tmux new-session -A -s my-api-2 -c /home/cc/work/my-api", calls)
        self.assertNotIn("bash -s", calls)

    def test_enter_starts_a_stopped_vm(self):
        result = self.run_script("enter.sh", STUB_VM_STATUS="Stopped")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("start --tty=false ccvm", self.log.read_text())

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

    def test_enter_replaces_the_ghostty_terminal_type(self):
        # VM 里没有 xterm-ghostty 的 terminfo：tmux 会起不来
        self.run_script("enter.sh", "--attach", "my-api-1", TERM="xterm-ghostty")
        self.assertIn("TERM=xterm-256color", self.log.read_text())
        self.assertNotIn("TERM=xterm-ghostty", self.log.read_text())
        self.log.unlink()
        self.run_script("enter.sh", "--project", "my-api", "--session", "auto", TERM="xterm-ghostty")
        self.assertNotIn("TERM=xterm-ghostty", self.log.read_text())
        self.log.unlink()
        self.run_script("enter.sh", "--attach", "my-api-1", TERM="screen-256color")
        self.assertIn("TERM=screen-256color", self.log.read_text())   # 别的终端类型不动

    def test_enter_rejects_bad_session_arguments(self):
        for args in [["--attach", "a b"], ["--session", "x"], ["--session", "auto"], ["--attach", "a", "--project", "p"], ["--project", "p", "--session", "a.b"]]:
            with self.subTest(args=args):
                if self.log.exists():
                    self.log.unlink()
                result = self.run_script("enter.sh", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")

    # ------------------------------------------------------------------ ports.sh
    def test_ports_list_becomes_items(self):
        out = self.write("ports", "".join(US.join(r) + "\n" for r in [
            ["PORT", "3000", "0.0.0.0", "node", "my-api"],
            ["PORT", "5173", "127.0.0.1", "vite", ""],
            ["PORT", "99999", "0.0.0.0", "bad", ""],
            ["PORT", "8080", "0.0.0.0", "evil name;x", "../x"],
        ]) + "PASS ports.list ok\n")
        result = self.run_script("ports.sh", "list", "--json", STUB_PORTS_OUT=str(out))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        items = [e for e in events if e["type"] == "item" and e["kind"] == "port"]
        self.assertEqual([(i["port"], i["process"], i["project"]) for i in items],
                         [(3000, "node", "my-api"), (5173, "vite", ""), (8080, "", "")])
        self.assertEqual(self.values(events)["port_count"], "3")
        self.assertIn("sudo -u cc", self.log.read_text())

    def test_ports_forward_uses_its_own_ssh_connection_on_loopback(self):
        (self.root / "lima/ccvm").mkdir(parents=True)
        (self.root / "lima/ccvm/ssh.config").write_text("Host lima-ccvm\n")
        self.stub("ssh", 'printf "%s\\n" "$*" >> "$STUB_LOG"')
        result = self.run_script("ports.sh", "forward", "3000", "13000")
        self.assertEqual(result.returncode, 0, result.stderr)
        call = self.log.read_text().splitlines()[-1]
        self.assertIn("-L 127.0.0.1:13000:127.0.0.1:3000 lima-ccvm", call)
        self.assertIn("-o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes", call)
        self.assertIn("-F %s/lima/ccvm/ssh.config" % self.root, call)

    def test_ports_forward_rejects_bad_ports_before_reaching_the_vm(self):
        for args in [["0"], ["70000"], ["3000", "x"], ["3000;id"], ["-1"]]:
            with self.subTest(args=args):
                if self.log.exists():
                    self.log.unlink()
                result = self.run_script("ports.sh", "forward", *args, "--json")
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("list", self.log.read_text() if self.log.exists() else "")

    def test_mac_ports_list_becomes_items(self):
        out = self.write("mp", "VALUE mac_ports_ready 1\nMACPORT 5432\nMACPORT 99999\nMACPORT 6379\nPASS macports.list ok\n")
        result = self.run_script("ports.sh", "mac", "list", "--json", STUB_MACPORTS_OUT=str(out))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([e["port"] for e in events if e["type"] == "item" and e["kind"] == "mac_port"], [5432, 6379])
        values = self.values(events)
        self.assertEqual(values["mac_ports_ready"], "1")
        self.assertEqual(values["mac_port_count"], "2")
        self.assertIn("sudo bash -s -- list", self.log.read_text())

    def test_mac_ports_allow_validates_before_reaching_the_vm(self):
        for port in ["17897", "0", "70000", "1;id", "abc"]:
            with self.subTest(port=port):
                if self.log.exists():
                    self.log.unlink()
                events = self.events(self.run_script("ports.sh", "mac", "allow", port, "--json"))
                self.assertIs(self.checks(events)["macports.allow"], False)
                self.assertNotIn("bash -s", self.log.read_text() if self.log.exists() else "")
        out = self.write("ok", "PASS macports.allow VM 现在可以访问 Mac 的 5432\n")
        result = self.run_script("ports.sh", "mac", "allow", "5432", "--json", STUB_SELFCHECK_OUT=str(out))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("sudo bash -s -- allow 5432", self.log.read_text())

    def test_ports_forward_needs_the_lima_ssh_config(self):
        events = self.events(self.run_script("ports.sh", "forward", "3000", "--json"))
        self.assertIs(self.checks(events)["ports.forward"], False)

    # ------------------------------------------------------------------ setup.sh
    def test_setup_json_reports_steps_and_failure_code(self):
        self.stub("limactl", 'case "$1" in --version) echo "limactl version 2.2.1";; list) exit 0;; template) exit 73;; *) exit 91;; esac')
        result = self.run_script("setup.sh", "--json", CCVM_LIMA_HOME=str(self.root / "new-vm"))
        events = self.events(result)
        self.assertEqual(result.returncode, 73)
        steps = [e["id"] for e in events if e["type"] == "step"]
        self.assertEqual(steps, ["setup.proxy", "setup.vm"])
        self.assertEqual(events[-1], {"v": 1, "type": "end", "ok": False, "code": 73})


class HostScriptLintTests(unittest.TestCase):
    """macOS Bash 3.2 reads a non-ASCII byte right after $name as part of the name: write ${name} there."""
    def test_no_bare_variable_before_non_ascii(self):
        bad = []
        for path in sorted((KIT / "scripts").glob("*.sh")):
            for no, line in enumerate(path.read_text().splitlines(), 1):
                if line.lstrip().startswith("#"):
                    continue
                if re.search(r"\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]", line):
                    bad.append(f"{path.name}:{no}: {line.strip()}")
        self.assertEqual(bad, [])


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
        self.assertGreater(len(ids), 25)
        for name, token in sorted(ids):
            with self.subTest(script=name, id=token):
                self.assertRegex(token, self.ID)
                documented = token.replace("${port}", "<port>")
                # 只报缺了哪个 id，不把整份文档打出来
                self.assertTrue("`" + documented + "`" in doc, f"{name}: `{documented}` 没写进 docs/events.md")

    def test_guest_lines_have_ids(self):
        for name in ["selfcheck.sh"]:
            text = (KIT / "guest" / name).read_text()
            for match in re.finditer(r'^\s*(?:check|refuse|pass|fail) "([^"]*)"', text, re.M):
                self.assertRegex(match.group(1), self.ID, f"{name}: {match.group(0)}")


if __name__ == "__main__":
    unittest.main()
