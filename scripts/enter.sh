#!/usr/bin/env bash
# 日常入口：必要时启动 VM，以 cc 用户进入。代理不通时 VM 自己断网，不影响进入。
# 用法：
#   enter.sh [--project 名称]                 进入后直接 cd 到 ~/work/<名称>
#   enter.sh --project 名称 --session 会话名   新建或接入 VM 里 cc 的 tmux 会话（在项目目录里）
#   enter.sh --project 名称 --session auto     同上，会话名按 App 的规则自动取：<项目>-<第一个空闲序号>
#   enter.sh --attach 会话名                   只接入已经存在的 tmux 会话
. "$(dirname "$0")/lib.sh"
project="" session="" attach=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project|--session|--attach)
      [ $# -ge 2 ] || die "$1 需要一个名称"
      case "$1" in --project) project="$2" ;; --session) session="$2" ;; --attach) attach="$2" ;; esac
      shift ;;
    *) die "未知参数：${1}（用法：enter.sh [--project 名称] [--session 会话名|auto] | --attach 会话名）" ;;
  esac
  shift
done
if [ -n "$project" ]; then
  [[ "$project" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "无效的项目名：$project"
fi
SESSION_RE='^[A-Za-z0-9_-]{1,64}$'
for s in "$session" "$attach"; do
  [ -z "$s" ] || [[ "$s" =~ $SESSION_RE ]] || die "无效的会话名：$s"
done
[ -z "$session" ] || [ -n "$project" ] || die "--session 需要和 --project 一起用"
[ -z "$attach" ] || { [ -z "$project" ] && [ -z "$session" ]; } || die "--attach 不能和其他参数一起用"

# Ghostty 把 TERM 设成 xterm-ghostty，limactl shell（ssh）会原样带进 VM；VM 里没有它的 terminfo，
# tmux 报 missing or unsuitable terminal 起不来、shell 也会乱。进 VM 前换成通用的 xterm-256color（Ghostty 兼容它）
case "${TERM:-}" in xterm-ghostty|ghostty) export TERM=xterm-256color ;; esac

if [ -n "$attach" ]; then
  require_mac
  [ "$(vm_status)" = Running ] || die "VM 没有运行，没有可以接入的会话"
  # 会话名已限定为 [A-Za-z0-9_-]；= 前缀表示精确匹配
  exec limactl shell --workdir=/ "$VM" sudo -iu cc tmux attach-session -t "=$attach"
fi
require_mac
case "$(vm_status)" in
  "") die "VM 不存在：先运行 bash scripts/setup.sh" ;;
  Running) ;;
  *) info "启动 VM"; limactl start --tty=false "$VM" ;;
esac

# 和 App 的 nextSessionName 同一规则：项目名里 [A-Za-z0-9_-] 以外的字符换成 _，最多 56 个字符，后接 -序号
auto_session_name() {
  local base taken n=1
  base="$(printf '%s' "$1" | LC_ALL=C sed 's/[^A-Za-z0-9_-]/_/g' | cut -c1-56)"
  # 没有 tmux 服务端时命令会失败：当作没有会话。stdin 接 /dev/null，免得 limactl shell 分配终端
  taken="$(vm sudo -u cc -H tmux list-sessions -F '#{session_name}' </dev/null 2>/dev/null | tr -d '\r' || true)"
  while printf '%s\n' "$taken" | grep -qxF -- "$base-$n"; do n=$((n + 1)); done
  printf '%s-%s\n' "$base" "$n"
}
if [ "$session" = auto ]; then
  session="$(auto_session_name "$project")"
  info "新会话：$session"
fi
if [ -n "$session" ]; then
  exec limactl shell --workdir=/ "$VM" sudo -iu cc tmux new-session -A -s "$session" -c "/home/cc/work/$project"
fi
if [ -n "$project" ]; then
  # 项目名已限定为 [A-Za-z0-9._-]，不含空格与 shell 元字符
  exec limactl shell --workdir=/ "$VM" sudo -iu cc bash -c "cd work/$project && exec bash -il"
fi
exec limactl shell --workdir=/ "$VM" sudo -iu cc
