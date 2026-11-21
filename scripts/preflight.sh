#!/usr/bin/env bash
# 部署前的只读检查（欢迎页第 1 步）：Mac 环境、Lima、经代理入口能出网。
# 不需要 VM；每项都报告，不在第一项失败时停下。用法：preflight.sh [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
[ "${#REST[@]}" -eq 0 ] || die "未知参数：${REST[*]}"
rc=0
( require_mac ) || rc=1
if hip="$(host_ip)" && [[ "$hip" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
  value host_egress "$hip"
  pass host.proxy "代理入口通，出口 $hip"
else
  soft_fail host.proxy "代理入口 127.0.0.1:$PORT 不通"
  rc=1
fi
if command -v limactl >/dev/null 2>&1; then value vm_status "$(vm_status || true)"; fi
[ "$rc" -eq 0 ] || die "部署前检查未通过"
ok "部署前检查通过"
