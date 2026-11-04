#!/usr/bin/env bash
# 断流 / 抓包测试：会短暂停止 VM 内的 TUN（约 30 秒），结束后自动恢复。先结束正在运行的 Claude 任务。
# 用法：leaktest.sh [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
[ "${#REST[@]}" -eq 0 ] || die "未知参数：${REST[*]}"
require_mac
require_running

info "断流与抓包测试（VM 内）"
rc=0; vm_script leaktest.sh | relay_guest || rc=$?
[ "$rc" -eq 0 ] || die "断流测试未通过：在定位原因之前不要登录或使用 Claude"
printf '%s断流测试通过%s\n' "$G" "$N"
