#!/usr/bin/env bash
# 启停 VM。每次都先做 require_mac（含 Lima 全局配置检查），启动后核对实际配置。
# 用法：vm.sh start|stop|status [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
set -- "${REST[@]+"${REST[@]}"}"
[ $# -eq 1 ] || die "用法：vm.sh start|stop|status [--json]"
require_mac
st="$(vm_status)"
value vm_status "${st:-Missing}"
case "$1" in
  status)
    if [ -n "$st" ]; then
      value vm_resources "$(limactl list --format '{{.CPUs}} {{.Memory}} {{.Disk}}' "$VM" 2>/dev/null || true)"
    fi
    ok "VM ${VM}：${st:-不存在}"
    ;;
  start)
    [ -n "$st" ] || fail_check vm.exists "VM 不存在：先完成部署（setup.sh）"
    if [ "$st" = Running ]; then ok "VM 已在运行"; else info "启动 VM"; limactl start --tty=false "$VM"; fi
    check_effective_lima_config
    value vm_status "$(vm_status)"
    ;;
  stop)
    if [ "$st" = Running ]; then info "停止 VM"; limactl stop "$VM"; else ok "VM 没有在运行"; fi
    value vm_status "$(vm_status)"
    ;;
  *) die "未知操作：$1" ;;
esac
