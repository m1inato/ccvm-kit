#!/usr/bin/env bash
# 节点出口 IP 合法变化（更换节点 / 供应商换 IP）后，人工确认再更新基线。不要放进自动任务。
# 用法：
#   rebaseline.sh               交互确认（输入 yes）
#   rebaseline.sh --dry-run     只测两端出口，不写基线（App 先用它给你看）
#   rebaseline.sh --accept IP   非交互：重新测量，只有 Mac 与 VM 出口都等于 IP 才写入。
#                               IP 必须是你刚刚看到并确认过的值；期间出口又变了就拒绝。
#   以上都可以加 --json
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
action=ask accept=""
set -- "${REST[@]+"${REST[@]}"}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) action=dry ;;
    --accept)
      [ $# -ge 2 ] || die "--accept 需要一个 IPv4"
      action=accept; accept="$2"; shift ;;
    *) die "未知参数：$1" ;;
  esac
  shift
done
if [ "$action" = accept ]; then
  [[ "$accept" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "--accept 的值不是 IPv4：$accept"
fi
require_mac
require_running

old="$(baseline || echo 无)"
value old_baseline "$old"
hip="$(host_ip)" || fail_check egress.host_reachable "Mac 专用入口不通"
value host_egress "$hip"
vip="$({ vm_script selfcheck.sh "" quick || true; } | awk '$1=="EGRESS"{print $2}')"
value vm_egress "$vip"
printf '旧基线：%s\nMac 专用入口出口：%s\nVM 出口：%s\n' "$old" "$hip" "${vip:-不通}"
[[ "$hip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || fail_check egress.host_matches_vm "没有拿到有效的 Mac 出口：$hip"
[ "$hip" = "$vip" ] || fail_check egress.host_matches_vm "Mac 与 VM 出口不一致：先排查（可能节点多出口或 VM 未走专用入口），不要更新基线"
pass egress.host_matches_vm "Mac 与 VM 出口一致：$hip"

case "$action" in
  dry) ok "仅预览，未修改基线"; exit 0 ;;
  accept)
    [ "$hip" = "$accept" ] || fail_check rebaseline.confirmed "出口在确认期间又变了（确认的是 ${accept}，现在是 ${hip}），未更新基线"
    ;;
  ask)
    read -r -p "已在 Clash「连接」中确认走的是 CC-VM-FIXED 和预期节点？输入 yes 更新基线：" ans
    [ "$ans" = yes ] || die "已取消"
    ;;
esac
mkdir -p "$STATE"
printf '%s\n' "$hip" > "$BASELINE.tmp"
mv "$BASELINE.tmp" "$BASELINE"
pass rebaseline.confirmed "基线已更新为 $hip"
value baseline "$hip"
