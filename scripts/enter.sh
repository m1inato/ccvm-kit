#!/usr/bin/env bash
# 日常入口：必要时启动 VM → 快速检查（专用入口只监听回环、VM 配置无挂载、防火墙/TUN、出口=基线）→ 以 cc 用户进入。
# 用法：
#   enter.sh [--project 名称]                 进入后直接 cd 到 ~/work/<名称>
#   enter.sh --project 名称 --session 会话名   检查后新建或接入 VM 里 cc 的 tmux 会话（在项目目录里）
#   enter.sh --project 名称 --session auto     同上，会话名按 App 的规则自动取：<项目>-<第一个空闲序号>
#   enter.sh --attach 会话名                   只接入已经存在的 tmux 会话，不做检查（不开新会话，所以出错时也允许回到正在跑的会话）
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

force() {
  [ "${CCVM_FORCE:-0}" = 1 ] || die "$1（排查用：bash scripts/check.sh；确需进入排障：CCVM_FORCE=1 bash scripts/enter.sh）"
  warn "CCVM_FORCE=1：带着未通过的检查进入，不要在此状态下使用 Claude"
  printf '\033]0;CCVM 排障模式 · 不受保护\007'
}

# 这两项失败时会直接 die；放在子 shell 里，CCVM_FORCE=1 时仍能进入排障
( check_listener ) || force "专用入口监听检查未通过，拒绝进入"
( check_effective_lima_config ) || force "VM 配置检查未通过，拒绝进入"

exp="$(baseline)" || die "缺少基线 ${BASELINE}：先运行 setup.sh"
if ! out="$(vm_script selfcheck.sh "$exp" quick)"; then
  printf '%s\n' "$out" | grep '^FAIL' >&2 || true
  force "快速检查未通过，拒绝进入"
else
  ok "出口 $(printf '%s\n' "$out" | awk '$1=="EGRESS"{print $2}') = 基线，进入 cc"
fi
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
