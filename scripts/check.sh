#!/usr/bin/env bash
# 状态检查：Mac 上的代理入口通不通，VM 里防火墙、TUN 在不在、能不能经代理出网。只读。
# 用法：check.sh [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
[ "${#REST[@]}" -eq 0 ] || die "未知参数：${REST[*]}（用法：check.sh [--json]）"
require_mac
require_running "VM 没有运行（bash scripts/vm.sh start）"

rc=0
if hip="$(host_ip)"; then
  value host_egress "$hip"
  pass host.proxy "代理入口 127.0.0.1:$PORT 通，出口 $hip"
else
  value host_egress ""
  soft_fail host.proxy "代理入口 127.0.0.1:$PORT 不通"
  rc=1
fi

vm_script selfcheck.sh | relay_guest || rc=1

if [ "$rc" -eq 0 ]; then
  printf '%s正常%s\n' "$G" "$N"
else
  die "检查没有通过"
fi
