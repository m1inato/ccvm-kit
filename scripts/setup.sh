#!/usr/bin/env bash
# 一键部署：检查 Clash 专用入口 → 创建 VM → 安装 VM 网络层 → 记录出口基线 → 验收 + 断流测试。
# 可重复执行：已完成的步骤会跳过。用法：setup.sh [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
[ "${#REST[@]}" -eq 0 ] || die "未知参数：${REST[*]}"
require_mac

step setup.listener "1/5 Clash 专用入口 127.0.0.1:$PORT"
check_listener
hip="$(host_ip)" || fail_check egress.host_reachable "经 127.0.0.1:$PORT 访问外网失败：确认扩展脚本已保存并重新应用订阅、NODE 名称正确、节点可用"
[[ "$hip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || fail_check egress.host_reachable "没有拿到有效的 IPv4 出口：$hip"
value host_egress "$hip"
pass egress.host_reachable "专用入口出口 IP：${hip}（请在 Clash「连接」里确认这条请求走的是 CC-VM-FIXED → 你的节点）"

step setup.vm "2/5 创建/启动 VM（${VM}，LIMA_HOME=${LIMA_HOME}）"
case "$(vm_status)" in
  "")
    limactl template validate "$KIT/config/lima.yaml"
    mkdir -p "$LIMA_HOME"
    # 首次会下载约 600MB 的 Ubuntu 镜像，走 Mac 当前网络即可（镜像内容不敏感，Lima 自带的镜像模板会校验）
    # --mount-none：即使模板或以后的改动带了挂载，也在实例配置里清空
    limactl start --tty=false --name="$VM" --mount-none "$KIT/config/lima.yaml"
    ;;
  Running) ok "VM 已在运行" ;;
  *) limactl start --tty=false "$VM" ;;
esac
check_effective_lima_config
[ "$(vm uname -m)" = aarch64 ] || die "VM 架构不是 aarch64"
ok "VM 就绪：$(vm sh -c '. /etc/os-release; echo $PRETTY_NAME') / $(vm uname -r)"

step setup.install "3/5 安装 VM 网络层（sing-box TUN + 防火墙 + cc 用户）"
if vm sudo test -e /var/lib/ccvm/installed; then
  ok "已安装，跳过"
else
  warn "引导期（此步骤完成前）VM 的系统流量（apt/snap/NTP 等）走 Mac 当前网络；此时不要登录 Claude 或放入任何凭据"
  stage="$(vm mktemp -d /tmp/ccvm-stage.XXXXXX)"
  limactl copy "$KIT/config/sing-box.json" "$KIT/config/firewall.nft.in" "$KIT/config/lockdown.nft" \
    "$KIT/guest/install.sh" "$VM:$stage/"
  vm sudo bash "$stage/install.sh" "$stage"
  vm sudo rm -rf -- "$stage"
fi

step setup.baseline "4/5 出口基线"
mkdir -p "$STATE"
if [ -s "$BASELINE" ]; then
  ok "沿用已有基线 $(baseline)（更换节点后用 scripts/rebaseline.sh 更新）"
else
  printf '%s\n' "$hip" > "$BASELINE"
  ok "已记录基线 $hip → $BASELINE"
fi

step setup.verify "5/5 验收"
if [ "$CCVM_JSON" = 1 ]; then
  # 子脚本的检查事件直接并入本次事件流（不重复 start/end）
  CCVM_EVENT_CHILD=1 bash "$KIT/scripts/check.sh" --json >&3
  CCVM_EVENT_CHILD=1 bash "$KIT/scripts/leaktest.sh" --json >&3
else
  bash "$KIT/scripts/check.sh"
  bash "$KIT/scripts/leaktest.sh"
fi

printf '\n%s部署完成。%s下一步：bash scripts/enter.sh 进入 cc 用户，安装并登录 Claude Code（见 README）。\n' "$G" "$N"
