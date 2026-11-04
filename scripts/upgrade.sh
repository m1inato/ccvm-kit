#!/usr/bin/env bash
# 给已部署的 VM 补装软件包：setup.sh 看到已安装就跳过，早先部署的 VM 里可能缺后来才加的包（git、tmux）。
# 只装软件包，不碰防火墙、TUN、sing-box 和 DNS；完成后自动跑一次完整验收。
# 用法：upgrade.sh [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
[ "${#REST[@]}" -eq 0 ] || die "未知参数：${REST[*]}（用法：upgrade.sh [--json]）"
require_mac
require_running
value vm_level_target "$VM_LEVEL"
step upgrade.packages "补装软件包（目标级别 ${VM_LEVEL}）"
rc=0; vm_script upgrade.sh "$VM_LEVEL" | relay_guest || rc=$?
[ "$rc" -eq 0 ] || die "补装没有完成"
step upgrade.verify "完整验收"
if [ "$CCVM_JSON" = 1 ]; then
  CCVM_EVENT_CHILD=1 bash "$KIT/scripts/check.sh" --json >&3
else
  bash "$KIT/scripts/check.sh"
fi
