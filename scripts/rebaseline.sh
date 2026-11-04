#!/usr/bin/env bash
# 节点出口 IP 合法变化（更换节点 / 供应商换 IP）后，人工确认再更新基线。不要放进自动任务。
. "$(dirname "$0")/lib.sh"
require_mac
[ "$(vm_status)" = Running ] || die "VM 未运行"

old="$(baseline || echo 无)"
hip="$(host_ip)" || die "Mac 专用入口不通"
vip="$({ vm_script selfcheck.sh "" quick || true; } | awk '$1=="EGRESS"{print $2}')"
printf '旧基线：%s\nMac 专用入口出口：%s\nVM 出口：%s\n' "$old" "$hip" "${vip:-不通}"
[ "$hip" = "$vip" ] || die "Mac 与 VM 出口不一致：先排查（可能节点多出口或 VM 未走专用入口），不要更新基线"
read -r -p "已在 Clash「连接」中确认走的是 CC-VM-FIXED 和预期节点？输入 yes 更新基线：" ans
[ "$ans" = yes ] || die "已取消"
mkdir -p "$STATE"
printf '%s\n' "$hip" > "$BASELINE"
ok "基线已更新为 $hip"
