"""Shared folders (share.sh, lib.sh helpers) and file transfer (files.sh), with stub commands."""
import json
import os
from pathlib import Path
import re
import subprocess

from test_events import BASH_EXEC, KIT, US, ScriptHarness


class ShareTests(ScriptHarness):
    def setUp(self):
        super().setUp()
        self.home = self.root / "home"
        (self.home / ".ssh").mkdir(parents=True)
        (self.home / "projects" / "app").mkdir(parents=True)
        self.env["HOME"] = str(self.home)

    def lib(self, code, *args, **env):
        return subprocess.run([BASH_EXEC, "-c", '. "$0"; ' + code, str(KIT / "scripts/lib.sh"), *args],
                              env=self.env | env, text=True, capture_output=True, timeout=30)

    def problem(self, path, **env):
        result = self.lib('share_path_problem "$1"', str(path), **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def shares(self, *paths):
        (self.state / "shares.txt").write_text("".join(str(p) + "\n" for p in paths))

    # ------------------------------------------------------------------ share_path_problem
    def test_share_path_problem_rejects_dangerous_locations(self):
        wrap = self.root / "wrap"
        (wrap / "state").mkdir(parents=True)
        (self.root / "to-home").symlink_to(self.home)
        rejected = {
            "home itself": self.home,
            "~/.ssh": self.home / ".ssh",
            "contains ~/.ssh": self.root,
            "contains $STATE": wrap,
            "contains $KIT": KIT.parent,
            "/Volumes": "/Volumes",
            "relative": "projects/app",
            "missing": self.home / "nope",
            "symlink to home": self.root / "to-home",
            "a file": KIT / "VERSION",
        }
        for label, path in rejected.items():
            with self.subTest(label):
                self.assertNotEqual(self.problem(path, CCVM_STATE_DIR=str(wrap / "state")), "", path)
        for path in ["/", "/usr", "/etc", "/tmp"]:
            with self.subTest(path):
                self.assertIn("系统目录", self.problem(path))
        self.assertIn("家目录", self.problem(self.root / "to-home"))

    def test_share_path_problem_accepts_a_project_folder(self):
        self.assertEqual(self.problem(self.home / "projects" / "app"), "")
        self.assertEqual(self.problem(str(self.home / "projects" / "app") + "/"), "")

    def test_share_names_dedupe_and_sanitize(self):
        self.shares("/Volumes/a/proj", "/Volumes/b/proj/", "/Volumes/c/my app!", "/Volumes/d/中文", "/Volumes/e/proj", "/")
        result = self.lib("share_names")
        self.assertEqual(result.stdout.splitlines(), ["proj", "proj-2", "my_app_", "______", "proj-3", "share"])

    def test_share_status_lists_items_with_names_and_problems(self):
        self.shares(self.home / "projects" / "app", self.home / ".ssh")
        events = self.events(self.run_script("share.sh", "status", "--json", STUB_VM_STATUS="Stopped"))
        items = [e for e in events if e["type"] == "item"]
        self.assertEqual([(i["name"], i["view"], i["mount_point"]) for i in items],
                         [("app", "/home/cc/mac/app", "/mnt/ccvm-raw/app"), (".ssh", "/home/cc/mac/.ssh", "/mnt/ccvm-raw/.ssh")])
        self.assertEqual(items[0]["problem"], "")
        self.assertIsNone(items[0]["mounted"])   # VM 没运行：不确定，不当作挂上了
        self.assertNotEqual(items[1]["problem"], "")
        self.assertEqual(self.values(events)["share_count"], "2")
        self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")

    def test_share_status_checks_the_cc_views_when_the_vm_runs(self):
        a, b = self.home / "projects" / "app", self.home / "projects" / "web"
        b.mkdir()
        self.shares(a, b)
        guest = self.write("verify", "VIEW app 1\nVIEW web 0\nFAIL share.guest 没有挂上：/home/cc/mac/web\n")
        result = self.run_script("share.sh", "status", "--json", STUB_SHARES_OUT=str(guest), STUB_SHARES_RC="1")
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        items = {e["name"]: e["mounted"] for e in events if e["type"] == "item"}
        self.assertEqual(items, {"app": True, "web": False})
        self.assertIs(self.checks(events)["share.guest"], False)
        self.assertIn("sudo bash -s -- verify app web", self.log.read_text())

    def test_share_apply_writes_mounts_with_awkward_paths(self):
        weird = [self.home / "projects" / "with space", self.home / "projects" / "中文项目", self.home / "projects" / "it's \"q\""]
        for w in weird:
            w.mkdir()
        self.shares(*weird)
        edit = self.root / "edit.txt"
        guest = self.write("guest", "PASS share.guest 已映射 3 个共享文件夹到 /home/cc/mac（读写）\n")
        result = self.run_script("share.sh", "apply", "--json", STUB_EDIT_FILE=str(edit), STUB_SHARES_OUT=str(guest),
                                 STUB_MOUNTS="".join(str(w) + "\n" for w in weird))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        expr = edit.read_text()
        self.assertTrue(expr.startswith(".mounts = "), expr)
        mounts = json.loads(expr[len(".mounts = "):])
        self.assertEqual(mounts, [
            {"location": str(weird[0]), "mountPoint": "/mnt/ccvm-raw/with_space", "writable": True},
            {"location": str(weird[1]), "mountPoint": "/mnt/ccvm-raw/" + "_" * 12, "writable": True},
            {"location": str(weird[2]), "mountPoint": "/mnt/ccvm-raw/it_s__q_", "writable": True},
        ])
        checks = self.checks(events)
        for cid in ["share.paths", "share.lima_mounts", "share.guest"]:
            self.assertIs(checks.get(cid), True, cid)
        calls = self.log.read_text().splitlines()
        order = [c.split()[0] for c in calls if c.split()[0] in ("stop", "edit", "start")]
        self.assertEqual(order, ["stop", "edit", "start"])
        self.assertTrue(any("sudo bash -s -- apply %d %d with_space" % (os.getuid(), os.getgid()) in c for c in calls), calls)

    def test_share_apply_without_shares_clears_mounts_and_removes_guest_setup(self):
        edit = self.root / "edit.txt"
        guest = self.write("guest", "PASS share.guest 已移除共享文件夹的映射\n")
        result = self.run_script("share.sh", "apply", "--json", STUB_EDIT_FILE=str(edit), STUB_SHARES_OUT=str(guest))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(edit.read_text(), ".mounts = []")
        self.assertIn("sudo bash -s -- remove", self.log.read_text())

    def test_share_apply_refuses_bad_paths_before_touching_the_vm(self):
        self.shares(self.home / "projects" / "app", self.home)
        result = self.run_script("share.sh", "apply", "--json")
        events = self.events(result)
        self.assertNotEqual(result.returncode, 0)
        self.assertIs(self.checks(events)["share.paths"], False)
        for verb in ["stop", "edit", "start", "shell"]:
            self.assertFalse(any(c.split()[0] == verb for c in self.log.read_text().splitlines()), verb)

    def test_bindfs_install_drops_inherited_proxy_environment(self):
        self.stub("id", "echo 0")
        # 故意让所有安装尝试失败，在任何 root 文件写入之前结束。
        # 被测脚本的 PATH 只有桩：不管这台机器装没装 bindfs，都走安装分支，也到不了写 root 文件的步骤
        self.stub("apt-get", 'PATH=/usr/bin:/bin\nprintf "%s\\n" "$*" >> "$STUB_APT_CALLS"\n'
                  'env | sed -n -E "/^((HTTP|HTTPS|ALL|NO)_PROXY|(http|https|all|no)_proxy|DEBIAN_FRONTEND)=/p" '
                  '>> "$STUB_APT_ENV"\nexit 1')
        calls = self.root / "apt-calls"
        apt_env = self.root / "apt-env"
        proxies = dict.fromkeys(("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                                 "http_proxy", "https_proxy", "all_proxy", "no_proxy"),
                                "http://192.168.5.2:7897")
        result = subprocess.run([BASH_EXEC, str(KIT / "guest/shares.sh"), "apply", "501", "20", "test"],
                                env=self.env | proxies | {"PATH": str(self.bin), "STUB_APT_CALLS": str(calls), "STUB_APT_ENV": str(apt_env)},
                                text=True, capture_output=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL share.guest 安装 bindfs 失败", result.stdout)
        self.assertEqual(calls.read_text().splitlines(), ["install -y --no-install-recommends bindfs", "update"])
        for key in proxies:
            self.assertNotRegex(apt_env.read_text(), rf"(?m)^{key}=")
        self.assertIn("DEBIAN_FRONTEND=noninteractive", apt_env.read_text())

    def test_guest_view_sets_the_bindfs_mount_subtype(self):
        text = (KIT / "guest/shares.sh").read_text()
        program = re.search(r"<<'UPEOF'\n(.*?)\nUPEOF", text, re.S).group(1)
        program = program.replace("LIST=/etc/ccvm/shares.list", 'LIST="$STUB_SHARE_LIST"')
        share_list = self.write("shares.list", "501 20\nproject\n")
        for command in ["install", "chown", "chmod"]:
            self.stub(command, "exit 0")
        self.stub("mountpoint", '[ "$2" = /mnt/ccvm-raw/project ]')
        self.stub("bindfs", 'printf "%s\\n" "$@" > "$STUB_LOG"')
        result = subprocess.run([BASH_EXEC, "-s"], input=program,
                                env=self.env | {"STUB_SHARE_LIST": str(share_list)},
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = self.log.read_text().splitlines()
        self.assertIn("subtype=bindfs", args[args.index("-o") + 1].split(","))
        self.assertEqual(args[-2:], ["/mnt/ccvm-raw/project", "/home/cc/mac/project"])


class FilesTests(ScriptHarness):
    def test_paths_outside_home_never_reach_the_vm(self):
        for op, args in [("list", ["/etc"]), ("list", ["/home/cc/../x"]), ("rm", ["/home/cc/a\nb"]),
                         ("mkdir", ["/Volumes/home/cc/x"]), ("push", ["/Volumes/x", "/tmp"]), ("pull", ["/home/cc/../etc/passwd", "/Volumes/x"])]:
            with self.subTest(op=op, args=args):
                if self.log.exists():
                    self.log.unlink()
                events = self.events(self.run_script("files.sh", op, *args, "--json"))
                self.assertIs(self.checks(events).get("files.path"), False)
                self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")

    def test_list_turns_guest_lines_into_items(self):
        out = self.write("ls", "VALUE path /home/cc/work\n" + US.join(["FILE", "src", "dir", "4096", "1793000000"]) + "\n"
                         + US.join(["FILE", 'a "b".txt', "file", "12", "1793000001"]) + "\nPASS files.list 列出 2 项\n")
        result = self.run_script("files.sh", "list", "/home/cc/work", "--json", STUB_WORKSPACE_OUT=str(out))
        events = self.events(result)
        self.assertEqual(result.returncode, 0, result.stderr)
        items = [e for e in events if e["type"] == "item"]
        self.assertEqual([(i["name"], i["file_type"], i["size"]) for i in items], [("src", "dir", 4096), ('a "b".txt', "file", 12)])
        self.assertEqual(self.values(events)["path"], "/home/cc/work")

    def test_push_pipes_a_tar_stream_into_the_vm(self):
        src = self.root / "upload me"
        (src / "sub").mkdir(parents=True)
        (src / "sub" / "a.txt").write_text("hello\n")
        (src / "中文.md").write_text("x")
        unpack = self.root / "unpacked"
        ok = self.write("ok", "VALUE path /home/cc/work\nPASS files.push 目标文件夹可写\n")
        result = self.run_script("files.sh", "push", str(src), "/home/cc/work", "--json",
                                 STUB_WORKSPACE_OUT=str(ok), STUB_UNPACK=str(unpack))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((unpack / "upload me" / "sub" / "a.txt").read_text(), "hello\n")
        self.assertTrue((unpack / "upload me" / "中文.md").exists())
        self.assertIn("sudo -u cc -H tar --no-same-owner -xf - -C /home/cc/work", self.log.read_text())
        self.assertIs(self.checks(self.events(result))["files.push"], True)

    def test_push_refuses_a_top_level_symlink(self):
        (self.root / "link").symlink_to(self.root / "state")
        events = self.events(self.run_script("files.sh", "push", str(self.root / "link"), "/home/cc/work", "--json"))
        self.assertIs(self.checks(events)["files.push"], False)
        self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")

    def test_pull_refuses_existing_target_unless_forced(self):
        dst = self.root / "out.txt"
        dst.write_text("old")
        events = self.events(self.run_script("files.sh", "pull", "/home/cc/a.txt", str(dst), "--json"))
        self.assertIs(self.checks(events)["files.pull"], False)
        self.assertEqual(dst.read_text(), "old")
        self.assertNotIn("shell", self.log.read_text() if self.log.exists() else "")
        ok = self.write("ok", "VALUE path /home/cc/a.txt\nPASS files.pull 可以下载\n")
        result = self.run_script("files.sh", "pull", "/home/cc/a.txt", str(dst), "--force", "--json",
                                 STUB_WORKSPACE_OUT=str(ok), STUB_CAT="new content\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(dst.read_text(), "new content\n")
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith(".ccvm-pull")], [])

    def test_pull_stops_when_the_guest_refuses_a_symlink(self):
        refuse = self.write("no", "FAIL files.pull 不下载符号链接：/home/cc/x\n")
        dst = self.root / "x"
        result = self.run_script("files.sh", "pull", "/home/cc/x", str(dst), "--json", STUB_WORKSPACE_OUT=str(refuse), STUB_WORKSPACE_RC="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIs(self.checks(self.events(result))["files.pull"], False)
        self.assertFalse(dst.exists())
        self.assertNotIn("cat --", self.log.read_text())
