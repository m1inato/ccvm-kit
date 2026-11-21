#!/usr/bin/env bash
# 一键部署：检查代理入口 → 创建 VM → 安装 VM 网络层 → 状态检查。
# 可重复执行：已完成的步骤会跳过。用法：setup.sh [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
[ "${#REST[@]}" -eq 0 ] || die "未知参数：${REST[*]}"
require_mac

step setup.proxy "1/4 代理入口 127.0.0.1:$PORT"
hip="$(host_ip)" || fail_check host.proxy "经 127.0.0.1:$PORT 访问外网失败：确认出口核心在运行，或 Clash Verge 的扩展脚本已生效、节点可用"
value host_egress "$hip"
pass host.proxy "代理入口通，出口 $hip"

step setup.vm "2/4 创建/启动 VM（${VM}，LIMA_HOME=${LIMA_HOME}）"
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
[ "$(vm uname -m)" = aarch64 ] || die "VM 架构不是 aarch64"
ok "VM 就绪：$(vm sh -c '. /etc/os-release; echo $PRETTY_NAME') / $(vm uname -r)"

step setup.install "3/4 安装 VM 网络层（sing-box TUN + 防火墙 + cc 用户）"
if vm sudo test -e /var/lib/ccvm/installed; then
  ok "已安装，跳过"
else
  stage="$(vm mktemp -d /tmp/ccvm-stage.XXXXXX)"
  limactl copy "$KIT/config/sing-box.json" "$KIT/config/firewall.nft.in" "$KIT/config/lockdown.nft" \
    "$KIT/guest/install.sh" "$VM:$stage/"
  vm sudo bash "$stage/install.sh" "$stage" "$INSTALL_LEVEL"
  vm sudo rm -rf -- "$stage"
fi

# 新装和已有的 VM 都走一遍升级步骤：早先部署的 VM 也能拿到后来加的修复（已是最新时什么也不做）
info "VM 升级步骤（目标级别 ${VM_LEVEL}）"
rc=0; vm_script upgrade.sh "$VM_LEVEL" | relay_guest || rc=$?
[ "$rc" -eq 0 ] || die "VM 升级步骤没有完成（可以重跑 setup.sh 或 upgrade.sh）"

step setup.verify "4/4 状态检查"
if [ "$CCVM_JSON" = 1 ]; then
  # 子脚本的检查事件直接并入本次事件流（不重复 start/end）
  CCVM_EVENT_CHILD=1 bash "$KIT/scripts/check.sh" --json >&3
else
  bash "$KIT/scripts/check.sh"
fi

if [ -n "$(share_list)" ]; then
  # 建 VM 时仍然是 --mount-none；共享文件夹要单独应用（会重启 VM），这里不自动执行
  warn "$STATE/shares.txt 里有共享文件夹，部署时没有挂载。需要时运行：bash scripts/share.sh apply"
fi
printf '\n%s部署完成。%s下一步：bash scripts/enter.sh 进入 cc 用户，安装并登录 Claude Code（见 README）。\n' "$G" "$N"
