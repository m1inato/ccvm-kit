#!/usr/bin/env bash
# 只读验收：Mac 专用入口出口、VM 出口、基线三者一致；VM 内防火墙/TUN/DNS/用户隔离/绕过尝试。
# 用法：check.sh [--quick] [--json]
#   --quick  只做日常快速检查（App 每 10 分钟一次）：入口、Lima 配置、防火墙、TUN、两端出口 = 基线
#   --json   输出 NDJSON 事件（见 docs/events.md）
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
mode=full
for a in "${REST[@]+"${REST[@]}"}"; do
  case "$a" in
    --quick) mode=quick ;;
    *) die "未知参数：${a}（用法：check.sh [--quick] [--json]）" ;;
  esac
done
value mode "$mode"
require_mac
require_running "VM 未运行（bash scripts/enter.sh 会自动启动）"
exp="$(require_baseline)"

info "Mac 专用入口与 Lima 配置"
check_listener
check_effective_lima_config
hip="$(host_ip || true)"
value host_egress "$hip"
host_ok=1
if [ "$hip" = "$exp" ]; then
  pass egress.host_matches_baseline "Mac 专用入口出口 = 基线 $exp"
else
  soft_fail egress.host_matches_baseline "Mac 专用入口出口 ${hip:-不通} ≠ 基线 $exp"
  host_ok=0
fi

info "VM 内检查"
rc=0; vm_script selfcheck.sh "$exp" "$mode" | relay_guest || rc=$?

if [ "$rc" -eq 0 ] && [ "$host_ok" -eq 1 ]; then
  printf '%s全部通过%s\n' "$G" "$N"
else
  die "存在未通过项（出口变了先看 README「更换节点 / 出口 IP 变化」，不要直接改基线）"
fi
