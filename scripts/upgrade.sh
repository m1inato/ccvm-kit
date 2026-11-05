#!/usr/bin/env bash
# 更新已部署的 VM：setup.sh 看到已安装就跳过网络层安装，早先部署的 VM 里会缺后来才加的东西
# （git、tmux；networkd 保留 TUN 策略路由 + TUN 看门狗）。按 guest/upgrade.sh 的级别逐步补上；
# 不改防火墙规则、sing-box 配置和 DNS；完成后自动跑一次完整验收。
# 用法：upgrade.sh [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
[ "${#REST[@]}" -eq 0 ] || die "未知参数：${REST[*]}（用法：upgrade.sh [--json]）"
require_mac
require_running
value vm_level_target "$VM_LEVEL"
step upgrade.packages "VM 升级步骤（目标级别 ${VM_LEVEL}）"
rc=0; vm_script upgrade.sh "$VM_LEVEL" | relay_guest || rc=$?
[ "$rc" -eq 0 ] || die "VM 更新没有完成"
step upgrade.verify "完整验收"
if [ "$CCVM_JSON" = 1 ]; then
  CCVM_EVENT_CHILD=1 bash "$KIT/scripts/check.sh" --json >&3
else
  bash "$KIT/scripts/check.sh"
fi
