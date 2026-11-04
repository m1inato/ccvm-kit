#!/usr/bin/env bash
# VM 内以 root 运行（Mac 端经 stdin 传入）：安装 / 移除 Claude Code 的完成提醒 hook。
#   enable  写 /usr/local/lib/ccvm/claude-hook 与 /etc/claude-code/managed-settings.d/50-ccvm.json（root 所有，cc 改不了）
#   disable 删除这两个文件
#   status  报告是否已安装
# 只用于桌面端「Claude 做完了」字幕，和网络隔离无关。不改已有的 managed-settings.json。
set -uo pipefail
HOOK=/usr/local/lib/ccvm/claude-hook
DROPIN_DIR=/etc/claude-code/managed-settings.d
DROPIN=$DROPIN_DIR/50-ccvm.json
[ "$(id -u)" = 0 ] || { echo "FAIL hooks.installed 需要 root"; exit 1; }

installed() { [ -x "$HOOK" ] && [ -f "$DROPIN" ] && grep -q "$HOOK" "$DROPIN"; }

case "${1:-}" in
  enable)
    command -v python3 >/dev/null 2>&1 || { echo "FAIL hooks.installed VM 里没有 python3"; exit 1; }
    install -d -m 0755 /usr/local/lib/ccvm "$DROPIN_DIR"
    cat > "$HOOK.tmp" <<'EOF'
#!/bin/sh
# 由 CCVM 安装：把 Claude Code 的 Stop / Notification 事件追加到 ~/.ccvm/events.jsonl，只用于桌面端字幕。
# 只记事件类型、时间、工作目录和截断的通知文字，不记对话内容。永远 exit 0、不输出任何东西：不影响 Claude。
python3 -c '
import json, os, sys, time
try:
    d = json.load(sys.stdin)
    ev = str(d.get("hook_event_name", ""))
    if ev in ("Stop", "Notification"):
        rec = {"t": int(time.time()), "event": ev, "cwd": str(d.get("cwd", ""))[:300]}
        if ev == "Notification":
            rec["type"] = str(d.get("notification_type", ""))[:40]
            rec["message"] = str(d.get("message", ""))[:160]
        path = os.path.join(os.path.expanduser("~"), ".ccvm", "events.jsonl")
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        if os.path.exists(path) and os.path.getsize(path) > 1000000:
            os.replace(path, path + ".1")
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
except Exception:
    pass
' >/dev/null 2>&1 || true
exit 0
EOF
    chmod 0755 "$HOOK.tmp" && mv "$HOOK.tmp" "$HOOK"
    cat > "$DROPIN.tmp" <<EOF
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "$HOOK", "async": true, "timeout": 10 }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "$HOOK", "async": true, "timeout": 10 }] }]
  }
}
EOF
    chmod 0644 "$DROPIN.tmp" && mv "$DROPIN.tmp" "$DROPIN"
    python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$DROPIN" || { rm -f "$DROPIN"; echo "FAIL hooks.installed 生成的设置不是有效 JSON"; exit 1; }
    installed && echo "PASS hooks.installed 已安装完成提醒 hook（新开的 Claude 会话生效）" || { echo "FAIL hooks.installed 安装后核对失败"; exit 1; }
    ;;
  disable)
    rm -f "$DROPIN" "$HOOK"
    installed && { echo "FAIL hooks.installed 没能移除"; exit 1; }
    echo "PASS hooks.removed 已移除完成提醒 hook"
    ;;
  status)
    if installed; then echo "VALUE hooks_enabled 1"; else echo "VALUE hooks_enabled 0"; fi
    ;;
  *) echo "FAIL guest.usage 用法：hooks.sh enable|disable|status"; exit 1 ;;
esac
