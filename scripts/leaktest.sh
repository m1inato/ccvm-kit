#!/usr/bin/env bash
# 断流 / 抓包测试：会短暂停止 VM 内的 TUN（约 30 秒），结束后自动恢复。先结束正在运行的 Claude 任务。
. "$(dirname "$0")/lib.sh"
require_mac
[ "$(vm_status)" = Running ] || die "VM 未运行"

info "断流与抓包测试（VM 内）"
rc=0; out="$(vm_script leaktest.sh)" || rc=$?
while IFS= read -r line; do
  case "$line" in
    PASS\ *) ok "${line#PASS }" ;;
    FAIL\ *) printf '%s  ✘%s %s\n' "$R" "$N" "${line#FAIL }" ;;
    *) printf '      %s\n' "$line" ;;
  esac
done <<< "$out"
[ "$rc" -eq 0 ] || die "断流测试未通过：在定位原因之前不要登录或使用 Claude"
printf '%s断流测试通过%s\n' "$G" "$N"
