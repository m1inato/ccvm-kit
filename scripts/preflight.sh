#!/usr/bin/env bash
# 部署前的只读检查（欢迎页第 1 步）：Mac 环境、Lima、专用入口只听回环、经专用入口能出网。
# 不需要 VM 和基线；每项都报告，不在第一项失败时停下。用法：preflight.sh [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
[ "${#REST[@]}" -eq 0 ] || die "未知参数：${REST[*]}"
rc=0
( require_mac ) || rc=1
( check_listener ) || rc=1
if hip="$(host_ip)" && [[ "$hip" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
  value host_egress "$hip"
  pass egress.host_reachable "经专用入口出网正常，出口 $hip"
else
  soft_fail egress.host_reachable "经 127.0.0.1:$PORT 访问外网失败"
  rc=1
fi
if command -v limactl >/dev/null 2>&1; then value vm_status "$(vm_status || true)"; fi
b="$(baseline || true)"; [ -z "$b" ] || value baseline "$b"
[ "$rc" -eq 0 ] || die "部署前检查未通过"
ok "部署前检查通过"
