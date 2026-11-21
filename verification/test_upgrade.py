"""Package upgrades for already-deployed VMs: scripts/upgrade.sh, guest/upgrade.sh level logic, workspace values."""
import re
import subprocess

from test_events import BASH_EXEC, KIT, US, ScriptHarness


def lib_level():
    return int(re.search(r"^VM_LEVEL=(\d+)$", (KIT / "scripts/lib.sh").read_text(), re.M).group(1))


class UpgradeTests(ScriptHarness):
    def test_upgrade_runs_guest_steps_then_check(self):
        out = self.write("up", "PASS vm.upgrade 已补装到级别 1\nVALUE vm_level 1\n")
        result = self.run_script("upgrade.sh", "--json", STUB_UPGRADE_OUT=str(out))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([e["type"] for e in events].count("start"), 1)
        self.assertEqual(events[-1], {"v": 1, "type": "end", "ok": True, "code": 0})
        self.assertEqual([e["id"] for e in events if e["type"] == "step"], ["upgrade.packages", "upgrade.verify"])
        checks = self.checks(events)
        self.assertIs(checks["vm.upgrade"], True)
        self.assertIs(checks["vm.proxy"], True)   # 状态检查的结论并在同一个流里
        values = self.values(events)
        self.assertEqual(values["vm_level"], "1")
        self.assertEqual(values["vm_level_target"], str(lib_level()))
        calls = self.log.read_text()
        self.assertIn("sudo bash -s -- %d" % lib_level(), calls)
        self.assertEqual(calls.count("sudo bash -s"), 2)   # 升级步骤 + 状态检查

    def test_failed_upgrade_stops_before_the_check(self):
        out = self.write("up", "FAIL vm.upgrade 第 1 步没有完成（停在级别 0），可以重试\nVALUE vm_level 0\n")
        result = self.run_script("upgrade.sh", "--json", STUB_UPGRADE_OUT=str(out), STUB_UPGRADE_RC="1")
        events = self.events(result)
        self.assertNotEqual(result.returncode, 0)
        self.assertIs(self.checks(events)["vm.upgrade"], False)
        self.assertIs(events[-1]["ok"], False)
        self.assertEqual(self.log.read_text().count("sudo bash -s"), 1)   # 没有接着做检查

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

    def test_apt_runs_without_inherited_proxy_environment(self):
        self.stub("id", "echo 0")
        # 让安装一直失败：在写级别文件之前结束，只核对 apt 看到的环境
        self.stub("apt-get", 'PATH=/usr/bin:/bin\nprintf "%s\\n" "$*" >> "$STUB_APT_CALLS"\n'
                  'env | sed -n -E "/^((HTTP|HTTPS|ALL|NO)_PROXY|(http|https|all|no)_proxy|DEBIAN_FRONTEND)=/p" >> "$STUB_APT_ENV"\n'
                  'exit 1')
        calls, apt_env, level = self.root / "apt-calls", self.root / "apt-env", self.root / "level"
        proxies = dict.fromkeys(("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                                 "http_proxy", "https_proxy", "all_proxy", "no_proxy"), "http://192.168.5.2:7897")
        result = subprocess.run([BASH_EXEC, str(KIT / "guest/upgrade.sh"), "1"],
                                env=self.env | proxies | {"PATH": str(self.bin), "STUB_APT_CALLS": str(calls), "STUB_APT_ENV": str(apt_env),
                                                          "CCVM_LEVEL_FILE": str(level)},
                                text=True, capture_output=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL vm.upgrade 第 1 步没有完成", result.stdout)
        self.assertIn("VALUE vm_level 0", result.stdout)
        self.assertFalse(level.exists())   # 失败的步骤不写级别
        self.assertEqual(calls.read_text().splitlines(),
                         ["install -y --no-install-recommends git tmux", "update"])
        for key in proxies:
            self.assertNotRegex(apt_env.read_text(), rf"(?m)^{key}=")
        self.assertIn("DEBIAN_FRONTEND=noninteractive", apt_env.read_text())

    def test_pending_steps_and_highest_step(self):
        self.assertEqual(self.guest("pending_steps 0 3").stdout.split(), ["1", "2", "3"])
        self.assertEqual(self.guest("pending_steps 1 1").stdout.split(), [])
        self.assertEqual(self.guest("pending_steps 2 1").stdout.split(), [])
        # 套件要求的级别必须正好是 guest/upgrade.sh 里的步骤数
        self.assertEqual(int(self.guest("highest_step").stdout), lib_level())


class TunRouteFixTests(ScriptHarness):
    """Step 2: networkd keeps sing-box's policy rules; a watchdog restarts the TUN when they are gone anyway."""

    def test_step_2_installs_networkd_setting_and_watchdog(self):
        root = self.root / "vmroot"
        self.stub("systemctl", 'printf "systemctl %s\\n" "$*" >> "$STUB_LOG"')
        result = subprocess.run([BASH_EXEC, "-c", 'CCVM_UPGRADE_LIB=1 . "$0"; step_2', str(KIT / "guest/upgrade.sh")],
                                env=self.env | {"CCVM_ROOT": str(root)}, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        conf = (root / "etc/systemd/networkd.conf.d/50-ccvm-tun.conf").read_text()
        self.assertRegex(conf, r"(?m)^\[Network\]$")
        self.assertRegex(conf, r"(?m)^ManageForeignRoutingPolicyRules=no$")
        watchdog = root / "usr/local/lib/ccvm/tun-watchdog"
        self.assertTrue(watchdog.stat().st_mode & 0o111)
        timer = (root / "etc/systemd/system/ccvm-tun-watchdog.timer").read_text()
        self.assertIn("OnUnitActiveSec=30", timer)
        self.assertIn("ExecStart=/usr/local/lib/ccvm/tun-watchdog", (root / "etc/systemd/system/ccvm-tun-watchdog.service").read_text())
        calls = self.log.read_text()
        self.assertIn("systemctl daemon-reload", calls)
        self.assertIn("systemctl enable --now ccvm-tun-watchdog.timer", calls)

    # ------------------------------------------------------------------ 第 3 步：VM → Mac 端口
    def old_firewall(self, root):
        """2.2.0 时装进 VM 的防火墙：没有 mac_ports"""
        text = (KIT / "config/firewall.nft.in").read_text().replace("@SBUID@", "990")
        text = re.sub(r"\n  set mac_ports \{[^}]*\}\n", "\n", text)
        text = re.sub(r"\n    ip daddr 192.168.5.2 tcp dport @mac_ports accept[^\n]*", "", text)
        text = text.replace("mac_ports", "")   # 头部注释也去掉，保证判断不靠注释
        (root / "etc/ccvm").mkdir(parents=True, exist_ok=True)
        (root / "etc/ccvm/firewall.nft").write_text(text)
        (root / "etc/hosts").write_text("127.0.0.1 localhost\n")

    def nft_stub(self, check_rc=0):
        # -c -f 是检查；-f - 从 stdin 读（记下内容）；其余只记命令
        self.stub("nft", 'printf "nft %s\\n" "$*" >> "$STUB_LOG"\n'
                  f'[ "$1" = -c ] && exit {check_rc}\n'
                  '[ "$1 $2" = "-f -" ] && sed "s/^/  /" >> "$STUB_LOG"\n'
                  'exit 0')
        self.stub("systemctl", 'printf "systemctl %s\\n" "$*" >> "$STUB_LOG"')

    def step_3(self, root):
        return subprocess.run([BASH_EXEC, "-c", 'CCVM_UPGRADE_LIB=1 . "$0"; step_3', str(KIT / "guest/upgrade.sh")],
                              env=self.env | {"CCVM_ROOT": str(root)}, text=True, capture_output=True, timeout=30)

    def test_step_3_adds_the_mac_ports_set_to_an_old_firewall(self):
        root = self.root / "vmroot"
        self.old_firewall(root)
        self.nft_stub()
        result = self.step_3(root)
        self.assertEqual(result.returncode, 0, result.stderr)
        fw = (root / "etc/ccvm/firewall.nft").read_text()
        self.assertIn("  set mac_ports { type inet_service; }", fw)
        lines = fw.splitlines()
        i = next(n for n, l in enumerate(lines) if "dport 17897 accept" in l)
        self.assertIn("ip daddr 192.168.5.2 tcp dport @mac_ports accept", lines[i + 1])
        self.assertIn("meta skuid 990", lines[i])          # 17897 仍然只给 sing-box
        calls = self.log.read_text()
        self.assertLess(calls.index("nft -c -f"), calls.index("nft -f %s" % (root / "etc/ccvm/firewall.nft")))
        self.assertNotIn("restart", calls)                 # 不重启防火墙服务（会连带重启网络和 TUN）
        self.assertIn("ExecStartPost=-/usr/local/lib/ccvm/mac-ports-load",
                      (root / "etc/systemd/system/ccvm-firewall.service.d/mac-ports.conf").read_text())
        self.assertIn("192.168.5.2 host.lima.internal", (root / "etc/hosts").read_text())
        # 再跑一遍：什么都不重复
        self.assertEqual(self.step_3(root).returncode, 0)
        self.assertEqual((root / "etc/ccvm/firewall.nft").read_text().count("set mac_ports"), 1)
        self.assertEqual((root / "etc/hosts").read_text().count("host.lima.internal"), 1)

    def test_step_3_leaves_the_firewall_alone_when_the_new_rules_do_not_check(self):
        root = self.root / "vmroot"
        self.old_firewall(root)
        before = (root / "etc/ccvm/firewall.nft").read_text()
        self.nft_stub(check_rc=1)
        self.assertNotEqual(self.step_3(root).returncode, 0)
        self.assertEqual((root / "etc/ccvm/firewall.nft").read_text(), before)
        self.assertFalse((root / "etc/ccvm/firewall.nft.new").exists())
        self.assertNotIn("nft -f %s" % (root / "etc/ccvm/firewall.nft"), self.log.read_text())

    def test_mac_ports_allow_deny_and_load_never_include_17897(self):
        root = self.root / "vmroot"
        self.old_firewall(root)
        self.nft_stub()
        self.assertEqual(self.step_3(root).returncode, 0)

        def mp(*args):
            return subprocess.run([BASH_EXEC, str(KIT / "guest/macports.sh"), *args], env=self.env | {"CCVM_ROOT": str(root)},
                                  text=True, capture_output=True, timeout=30)
        self.log.unlink()
        self.assertIn("PASS macports.allow", mp("allow", "6379").stdout)
        self.assertIn("PASS macports.allow", mp("allow", "5432").stdout)
        self.assertIn("FAIL macports.allow", mp("allow", "17897").stdout)
        self.assertIn("FAIL macports.allow", mp("allow", "0").stdout)
        self.assertIn("FAIL macports.allow", mp("allow", "1;id").stdout)
        self.assertEqual((root / "etc/ccvm/mac-ports").read_text(), "5432\n6379\n")
        self.assertIn("add element inet ccvm mac_ports { 5432,6379 }", self.log.read_text())
        out = mp("list").stdout
        self.assertIn("VALUE mac_ports_ready 1", out)
        self.assertEqual(re.findall(r"^MACPORT (\d+)$", out, re.M), ["5432", "6379"])
        # 有人手改了列表也一样：17897 和垃圾行不会装进集合
        (root / "etc/ccvm/mac-ports").write_text("17897\n5432\nabc\n99999\n")
        self.log.unlink()
        self.assertIn("PASS macports.deny", mp("deny", "6379").stdout)
        log = self.log.read_text()
        self.assertIn("flush set inet ccvm mac_ports", log)
        self.assertIn("add element inet ccvm mac_ports { 5432 }", log)
        mp("deny", "5432")
        self.assertNotIn("add element", self.log.read_text().split("flush set")[-1])

    def test_mac_ports_need_the_upgrade(self):
        root = self.root / "vmroot"
        self.old_firewall(root)
        self.stub("nft", "exit 1")
        r = subprocess.run([BASH_EXEC, str(KIT / "guest/macports.sh"), "allow", "5432"], env=self.env | {"CCVM_ROOT": str(root)},
                           text=True, capture_output=True, timeout=30)
        self.assertIn("FAIL macports.allow VM 还没有这项功能", r.stdout)
        self.assertFalse((root / "etc/ccvm/mac-ports").exists())

    def watchdog(self, active=True, rules=True, routes=True, since_us=0):
        text = (KIT / "guest/upgrade.sh").read_text()
        program = re.search(r"<<'WDEOF' \|\| return 1\n(.*?)\nWDEOF", text, re.S).group(1)
        self.stub("systemctl", 'case "$1" in\n'
                  '  is-active) [ "$STUB_ACTIVE" = 1 ] ;;\n'
                  '  show) echo "$STUB_SINCE" ;;\n'
                  '  restart) echo "restart $2" >> "$STUB_LOG" ;;\n'
                  'esac')
        self.stub("ip", 'case "$1 $2" in\n'
                  '  "link show") exit 0 ;;\n'
                  '  "rule show") [ "$STUB_RULES" = 1 ] && echo "9001: from all lookup 2022 suppress_prefixlength 0"; echo "32766: from all lookup main" ;;\n'
                  '  "route show") [ "$STUB_ROUTES" = 1 ] && echo "0.0.0.0/1 via 172.31.255.2 dev sb-tun table 2022" ;;\n'
                  'esac; exit 0')
        self.stub("logger", "exit 0")
        if self.log.exists():
            self.log.unlink()
        r = subprocess.run(["/bin/sh", "-s"], input=program, text=True, capture_output=True, timeout=30,
                           env=self.env | {"STUB_ACTIVE": "1" if active else "0", "STUB_RULES": "1" if rules else "0",
                                           "STUB_ROUTES": "1" if routes else "0", "STUB_SINCE": str(since_us)})
        self.assertEqual(r.returncode, 0, r.stderr)
        return self.log.read_text() if self.log.exists() else ""

    def test_watchdog_restarts_tun_only_when_routes_are_gone(self):
        self.assertEqual(self.watchdog(), "")                                   # 正常
        self.assertIn("restart ccvm-tun.service", self.watchdog(rules=False))   # ip rule 没了
        self.assertIn("restart ccvm-tun.service", self.watchdog(routes=False))  # 表 2022 空了
        self.assertEqual(self.watchdog(active=False, rules=False), "")          # TUN 停着：不管
        uptime_us = int(float(open("/proc/uptime").read().split()[0]) * 1_000_000)
        self.assertEqual(self.watchdog(rules=False, since_us=uptime_us), "")    # 刚启动：sing-box 还在建路由

    def test_selfcheck_reports_missing_policy_routes(self):
        text = (KIT / "guest/selfcheck.sh").read_text()
        func = re.search(r"^tun_ok\(\) \{.*?^\}$", text, re.S | re.M).group(0)
        self.stub("systemctl", "exit 0")
        self.stub("ip", 'case "$1 $2" in\n'
                  '  "rule show") [ "$STUB_RULES" = 1 ] && echo "9001: from all lookup 2022 suppress_prefixlength 0" ;;\n'
                  '  "route show") echo "0.0.0.0/1 via 172.31.255.2 dev sb-tun table 2022" ;;\n'
                  'esac; exit 0')
        for rules, ok in [("1", 0), ("0", 1)]:
            r = subprocess.run([BASH_EXEC, "-c", func + "\ntun_ok"], env=self.env | {"STUB_RULES": rules},
                               text=True, capture_output=True, timeout=30)
            self.assertEqual(r.returncode, ok, rules)
