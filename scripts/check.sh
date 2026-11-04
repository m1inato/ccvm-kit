#!/usr/bin/env bash
# 只读验收：Mac 专用入口出口、VM 出口、基线三者一致；VM 内防火墙/TUN/DNS/用户隔离/绕过尝试。
. "$(dirname "$0")/lib.sh"
require_mac
[ "$(vm_status)" = Running ] || die "VM 未运行（bash scripts/enter.sh 会自动启动）"
exp="$(baseline)" || die "缺少基线 ${BASELINE}：先运行 setup.sh"

info "Mac 专用入口与 Lima 配置"
check_listener
check_effective_lima_config
hip="$(host_ip || true)"
host_ok=1
if [ "$hip" = "$exp" ]; then ok "Mac 专用入口出口 = 基线 $exp"; else warn "Mac 专用入口出口 ${hip:-不通} ≠ 基线 $exp"; host_ok=0; fi

info "VM 内检查"
rc=0; out="$(vm_script selfcheck.sh "$exp" full)" || rc=$?
while IFS= read -r line; do
  case "$line" in
    PASS\ *) ok "${line#PASS }" ;;
    FAIL\ *) printf '%s  ✘%s %s\n' "$R" "$N" "${line#FAIL }" ;;
  esac
done <<< "$out"

if [ "$rc" -eq 0 ] && [ "$host_ok" -eq 1 ]; then
  printf '%s全部通过%s\n' "$G" "$N"
else
  die "存在未通过项（出口变了先看 README「更换节点 / 出口 IP 变化」，不要直接改基线）"
fi
