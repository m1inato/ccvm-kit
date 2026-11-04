"""Claude Code completion hook (guest/hooks.sh) and event pulling (workspace.sh events), without a VM."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

KIT = Path(__file__).resolve().parents[1]
US = "\x1f"


def hook_program():
    text = (KIT / "guest/hooks.sh").read_text()
    m = re.search(r"cat > \"\$HOOK\.tmp\" <<'EOF'\n(.*?)\nEOF\n", text, re.S)
    assert m, "hook body not found"
    return m.group(1) + "\n"


class HookProgramTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ccvm-hook-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.hook = self.home / "claude-hook"
        self.hook.write_text(hook_program())
        self.hook.chmod(0o755)

    def run_hook(self, payload):
        data = payload if isinstance(payload, str) else json.dumps(payload)
        return subprocess.run([str(self.hook)], input=data, text=True, capture_output=True,
                              env={"HOME": str(self.home), "PATH": "/usr/bin:/bin"}, timeout=20)

    def events(self):
        f = self.home / ".ccvm/events.jsonl"
        return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []

    def test_records_only_minimal_fields_and_never_influences_claude(self):
        r = self.run_hook({"hook_event_name": "Stop", "cwd": "/home/cc/work/my-api", "session_id": "s",
                           "transcript_path": "/home/cc/.claude/x.jsonl", "stop_hook_active": False,
                           "last_assistant_message": "secret plan"})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        r = self.run_hook({"hook_event_name": "Notification", "cwd": "/home/cc/work/my-api",
                           "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash" + "x" * 300})
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        ev = self.events()
        self.assertEqual([e["event"] for e in ev], ["Stop", "Notification"])
        self.assertEqual(set(ev[0]), {"t", "event", "cwd"})
        self.assertNotIn("secret", json.dumps(ev))
        self.assertLessEqual(len(ev[1]["message"]), 160)
        self.assertEqual(oct((self.home / ".ccvm").stat().st_mode & 0o777), "0o700")

    def test_garbage_input_is_ignored_and_still_exits_zero(self):
        for payload in ["not json", "", '{"hook_event_name": "PreToolUse"}', "[1,2]"]:
            with self.subTest(payload=payload):
                r = self.run_hook(payload)
                self.assertEqual((r.returncode, r.stdout), (0, ""))
        self.assertEqual(self.events(), [])

    def test_settings_dropin_is_async_and_uses_the_absolute_hook_path(self):
        text = (KIT / "guest/hooks.sh").read_text()
        m = re.search(r'cat > "\$DROPIN\.tmp" <<EOF\n(.*?)\nEOF\n', text, re.S)
        cfg = json.loads(m.group(1).replace("$HOOK", "/usr/local/lib/ccvm/claude-hook"))
        for event in ("Stop", "Notification"):
            h = cfg["hooks"][event][0]["hooks"][0]
            self.assertEqual(h["command"], "/usr/local/lib/ccvm/claude-hook")
            self.assertIs(h["async"], True)
        self.assertIn("/etc/claude-code/managed-settings.d", text)
        self.assertNotIn("managed-settings.json", re.sub(r"#.*", "", text))  # 不改已有的主文件


class GuestEventReaderTests(unittest.TestCase):
    """guest/workspace.sh events：按 cc 身份读文件，内容不可信"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ccvm-events-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        (self.home / ".ccvm").mkdir()
        bin_dir = self.home / "bin"
        bin_dir.mkdir()
        (bin_dir / "id").write_text("#!/bin/bash\necho cc\n")
        (bin_dir / "id").chmod(0o755)
        self.env = {"HOME": str(self.home), "PATH": f"{bin_dir}:/usr/bin:/bin"}

    def run_guest(self, *args):
        with open(KIT / "guest/workspace.sh") as script:
            return subprocess.run(["bash", "-s", "--", *args], stdin=script,
                                  text=True, capture_output=True, env=self.env, timeout=20)

    def test_reads_from_offset_and_sanitizes(self):
        lines = [
            json.dumps({"t": 1793000000, "event": "Stop", "cwd": "/home/cc/work/my-api"}),
            "garbage",
            json.dumps({"t": 1793000001, "event": "Exec", "cwd": "/"}),
            json.dumps({"t": 1793000002, "event": "Notification", "cwd": "/home/cc/work/my-api/src",
                        "type": "idle_prompt", "message": "line1\nline2\x1fFAKE\x1fx"}),
        ]
        f = self.home / ".ccvm/events.jsonl"
        f.write_text("\n".join(lines) + "\n")
        r = self.run_guest("events", "0")
        self.assertEqual(r.returncode, 0, r.stderr)
        out = r.stdout.splitlines()
        claude = [l.split(US) for l in out if l.startswith("CLAUDE")]
        self.assertEqual([c[2] for c in claude], ["Stop", "Notification"])
        self.assertTrue(all(len(c) == 6 for c in claude))
        self.assertEqual(claude[1][5], "line1line2FAKEx")
        self.assertEqual(out[-1], f"VALUE events_size {f.stat().st_size}")
        r = self.run_guest("events", str(f.stat().st_size))
        self.assertEqual([l for l in r.stdout.splitlines() if l.startswith("CLAUDE")], [])
        r = self.run_guest("events", "end")
        self.assertEqual(r.stdout.strip(), f"VALUE events_size {f.stat().st_size}")
        r = self.run_guest("events", "999999999")  # 文件被轮转：从头读
        self.assertEqual(len([l for l in r.stdout.splitlines() if l.startswith("CLAUDE")]), 2)


if __name__ == "__main__":
    unittest.main()
