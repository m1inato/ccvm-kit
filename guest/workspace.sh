#!/usr/bin/env bash
# VM 内以 cc 身份运行（Mac 端经 stdin 传入：sudo -u cc env -i ... bash -s -- <操作> [参数]）。
#   list          每个项目一行：PROJECT␟名称␟分支␟改动数␟领先␟落后␟最后提交时间␟提交说明␟远端␟Claude 进程数␟最早启动时间
#   claude        VALUE claude_installed 1|0、VALUE claude_version <版本>
#   clone <地址>  克隆到 ~/work/<名称>；git 的进度写到 stderr
#   list 还会输出 tmux 会话：SESSION␟会话名␟创建时间␟接入数␟起始目录␟最后活动时间␟当前命令；
#        最后是 VALUE tmux_installed 1|0、VALUE vm_level <级别>
#   kill-session <会话名>  结束 cc 的一个 tmux 会话
#   rename-session <旧名> <新名>  给 cc 的一个 tmux 会话改名（接入着的客户端不受影响）
#   events <偏移|end>  ~/.ccvm/events.jsonl 里偏移之后的 Claude 事件：CLAUDE␟时间␟事件␟目录␟通知类型␟通知文字；
#                     最后一行 VALUE events_size <字节数>。end 只报大小。文件由 cc 的 hook 写，内容按不可信处理
# 只读 cc 自己的仓库和进程；不读 ~/.claude。
set -uo pipefail
US=$'\x1f'
WORK="$HOME/work"
[ "$(id -un)" = cc ] || { echo "FAIL guest.user 必须以 cc 身份运行"; exit 1; }
clean() { tr -d '\037\r\n' | cut -c1-200; }
# 远端地址里可能带着账号或令牌（https://user:token@host/...），去掉再输出
strip_userinfo() { sed -E 's#^([a-z+]+://)[^/@]*@#\1#'; }

export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
GIT=(git -c protocol.ext.allow=never -c protocol.file.allow=never)

list_projects() {
  local d name branch dirty ab ahead behind updated subject remote now
  declare -A sessions=() since=()
  now="$(date +%s)"
  # 找出 cc 名下的 Claude Code 进程，按工作目录归到项目
  local p pid exe comm argv0 cwd proj et start
  for p in /proc/[0-9]*; do
    [ -O "$p" ] || continue
    pid="${p#/proc/}"
    exe="$(readlink "$p/exe" 2>/dev/null)" || continue
    comm="$(cat "$p/comm" 2>/dev/null)" || continue
    argv0="$(tr '\0' '\n' < "$p/cmdline" 2>/dev/null | head -n1)"
    case "$exe" in
      */.local/share/claude/*) ;;
      *) [ "$comm" = claude ] || [ "${argv0##*/}" = claude ] || continue ;;
    esac
    cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
    case "$cwd" in "$WORK"/*) proj="${cwd#"$WORK"/}"; proj="${proj%%/*}" ;; *) continue ;; esac
    et="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$et" ] || continue
    start=$((now - et))
    sessions[$proj]=$(( ${sessions[$proj]:-0} + 1 ))
    if [ -z "${since[$proj]:-}" ] || [ "$start" -lt "${since[$proj]}" ]; then since[$proj]="$start"; fi
  done

  [ -d "$WORK" ] || exit 0
  for d in "$WORK"/*/; do
    [ -d "$d.git" ] || continue
    d="${d%/}"; name="${d##*/}"
    branch="$("${GIT[@]}" -C "$d" symbolic-ref --short -q HEAD 2>/dev/null || "${GIT[@]}" -C "$d" rev-parse --short HEAD 2>/dev/null || echo '?')"
    dirty="$("${GIT[@]}" -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    ab="$("${GIT[@]}" -C "$d" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null || echo '0 0')"
    behind="${ab%%[[:space:]]*}"; ahead="${ab##*[[:space:]]}"
    updated="$("${GIT[@]}" -C "$d" log -1 --format=%ct 2>/dev/null || echo 0)"
    subject="$("${GIT[@]}" -C "$d" log -1 --format=%s 2>/dev/null | clean)"
    remote="$("${GIT[@]}" -C "$d" remote get-url origin 2>/dev/null | strip_userinfo | clean)"
    printf 'PROJECT%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\n' \
      "$US" "$(printf '%s' "$name" | clean)" "$US" "$(printf '%s' "$branch" | clean)" "$US" "$dirty" \
      "$US" "$ahead" "$US" "$behind" "$US" "$updated" "$US" "$subject" "$US" "$remote" \
      "$US" "${sessions[$name]:-0}" "$US" "${since[$name]:-0}"
  done
}

# 每个会话一行 SESSION␟会话名␟创建时间␟接入数␟起始目录␟最后活动时间␟当前在跑的命令。
# tmux 会把格式里的控制字符转义成 \037 这样的文字，所以先用 | 分隔（目录放最后，里面有 | 也不怕），再换成 ␟
list_sessions() {
  command -v tmux >/dev/null 2>&1 || return 0
  local cmds name created attached activity path cmd
  # 每个会话当前窗口、当前窗格里在跑什么（claude、bash……）
  cmds="$(tmux list-panes -a -F '#{session_name}|#{window_active}#{pane_active}|#{pane_current_command}' 2>/dev/null | awk -F'|' '$2 == "11" { print $1 "|" $3 }' || true)"
  # 没有 tmux 服务端时 list-sessions 返回非 0：等于没有会话
  tmux list-sessions -F '#{session_name}|#{session_created}|#{session_attached}|#{session_activity}|#{session_path}' 2>/dev/null | tr -d '\r' |
    while IFS='|' read -r name created attached activity path; do
      cmd="$(printf '%s\n' "$cmds" | awk -F'|' -v n="$name" '$1 == n { print $2; exit }')"
      printf 'SESSION%s%s%s%s%s%s%s%s%s%s%s%s\n' "$US" "$name" "$US" "$created" "$US" "$attached" "$US" "$path" "$US" "$activity" "$US" "$(printf '%s' "$cmd" | clean)"
    done || true
}

kill_session() {
  local name="$1"
  [[ "$name" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "FAIL session.kill 无效的会话名"; return 1; }
  if tmux kill-session -t "=$name" 2>/dev/null; then echo "PASS session.kill 已结束会话 $name"; else echo "FAIL session.kill 没有这个会话：$name"; return 1; fi
}

rename_session() {
  local old="$1" new="$2"
  [[ "$old" =~ ^[A-Za-z0-9_-]{1,64}$ && "$new" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "FAIL session.rename 会话名只能用 A-Z a-z 0-9 _ -，最长 64"; return 1; }
  tmux has-session -t "=$old" 2>/dev/null || { echo "FAIL session.rename 没有这个会话：$old"; return 1; }
  if tmux has-session -t "=$new" 2>/dev/null; then echo "FAIL session.rename 已经有叫 $new 的会话"; return 1; fi
  if tmux rename-session -t "=$old" "$new" 2>/dev/null; then echo "PASS session.rename 已把 $old 改名为 $new"; else echo "FAIL session.rename 改名失败：$old"; return 1; fi
}

claude_events() {
  local from="$1"
  python3 - "$from" <<'PY'
import json, os, sys
path = os.path.join(os.path.expanduser("~"), ".ccvm", "events.jsonl")
size = os.path.getsize(path) if os.path.exists(path) else 0
arg = sys.argv[1]
start = size if arg == "end" else int(arg) if arg.isdigit() else 0
if start > size:
    start = 0  # 文件被轮转过
out = []
if start < size:
    with open(path, "rb") as f:
        f.seek(start)
        data = f.read(256 * 1024)
    size = start + len(data)
    for raw in data.decode("utf-8", "replace").splitlines():
        try:
            d = json.loads(raw)
            t = int(d.get("t", 0))
            ev = d.get("event")
            if ev not in ("Stop", "Notification") or t <= 0:
                continue
            clean = lambda v, n: "".join(ch for ch in str(v or "") if ch not in "\x1f\r\n")[:n]
            out.append("\x1f".join(["CLAUDE", str(t), ev, clean(d.get("cwd"), 300), clean(d.get("type"), 40), clean(d.get("message"), 160)]))
        except Exception:
            continue
for line in out[-50:]:
    print(line)
print("VALUE events_size %d" % size)
PY
}

claude_info() {
  local bin="$HOME/.local/bin/claude" v
  if [ -x "$bin" ] && v="$(timeout 20 "$bin" --version 2>/dev/null | head -n1 | clean)" && [ -n "$v" ]; then
    echo "VALUE claude_installed 1"
    echo "VALUE claude_version $v"
    echo "PASS claude.installed Claude Code 已安装：$v"
  else
    echo "VALUE claude_installed 0"
    echo "FAIL claude.installed 还没有在 cc 用户里安装 Claude Code"
    return 1
  fi
}

clone_project() {
  local url="$1" name re_https re_ssh re_scp
  re_https='^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$'
  re_ssh='^ssh://git@[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$'
  re_scp='^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$'
  [[ "$url" =~ $re_https ]] || [[ "$url" =~ $re_ssh ]] || [[ "$url" =~ $re_scp ]] \
    || { echo "FAIL project.url 不支持的 Git 地址"; return 1; }
  name="${url%/}"; name="${name##*/}"; name="${name##*:}"; name="${name%.git}"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "FAIL project.name 从地址里取不出合法的项目名：$name"; return 1; }
  echo "VALUE project $name"
  command -v git >/dev/null 2>&1 || { echo "FAIL project.clone VM 里没有 git：在管理员 shell 里 sudo apt-get install git"; return 1; }
  [ ! -e "$WORK/$name" ] || { echo "FAIL project.clone ~/work/$name 已经存在"; return 1; }
  mkdir -p "$WORK"
  # 首次连接新主机时记下它的指纹（accept-new）；不会弹出交互提示
  if GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' \
     "${GIT[@]}" clone --progress -- "$url" "$WORK/$name" >&2; then
    echo "PASS project.clone 已克隆到 ~/work/$name"
  else
    echo "FAIL project.clone git clone 失败，原因见上面 git 的输出"
    return 1
  fi
}

# 补装提示用：tmux 装了没有、VM 的软件包级别（/var/lib/ccvm/level，读不到当作 0，App 会提示补装）
vm_packages() {
  local l
  if command -v tmux >/dev/null 2>&1; then echo "VALUE tmux_installed 1"; else echo "VALUE tmux_installed 0"; fi
  l="$(tr -d '[:space:]' < /var/lib/ccvm/level 2>/dev/null)" || l=0
  [[ "$l" =~ ^[0-9]{1,4}$ ]] || l=0
  echo "VALUE vm_level $((10#$l))"
}

case "${1:-}" in
  list) list_projects; list_sessions; vm_packages ;;
  kill-session) [ $# -eq 2 ] || { echo "FAIL session.kill 缺少会话名"; exit 1; }; kill_session "$2" ;;
  rename-session) [ $# -eq 3 ] || { echo "FAIL session.rename 需要旧名和新名"; exit 1; }; rename_session "$2" "$3" ;;
  events) [ $# -eq 2 ] || { echo "FAIL guest.usage 缺少偏移"; exit 1; }; claude_events "$2" ;;
  claude) claude_info ;;
  clone) [ $# -eq 2 ] || { echo "FAIL project.url 缺少 Git 地址"; exit 1; }; clone_project "$2" ;;
  *) echo "FAIL guest.usage 未知操作：${1:-}"; exit 1 ;;
esac
