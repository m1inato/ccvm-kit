#!/usr/bin/env bash
# 日常入口：必要时启动 VM → 快速检查（专用入口只监听回环、VM 配置无挂载、防火墙/TUN、出口=基线）→ 以 cc 用户进入。
. "$(dirname "$0")/lib.sh"
require_mac
case "$(vm_status)" in
  "") die "VM 不存在：先运行 bash scripts/setup.sh" ;;
  Running) ;;
  *) info "启动 VM"; limactl start --tty=false "$VM" ;;
esac

force() {
  [ "${CCVM_FORCE:-0}" = 1 ] || die "$1（排查用：bash scripts/check.sh；确需进入排障：CCVM_FORCE=1 bash scripts/enter.sh）"
  warn "CCVM_FORCE=1：带着未通过的检查进入，不要在此状态下使用 Claude"
}

# 这两项失败时会直接 die；放在子 shell 里，CCVM_FORCE=1 时仍能进入排障
( check_listener ) || force "专用入口监听检查未通过，拒绝进入"
( check_effective_lima_config ) || force "VM 配置检查未通过，拒绝进入"

exp="$(baseline)" || die "缺少基线 ${BASELINE}：先运行 setup.sh"
if ! out="$(vm_script selfcheck.sh "$exp" quick)"; then
  printf '%s\n' "$out" | grep '^FAIL' >&2 || true
  force "快速检查未通过，拒绝进入"
else
  ok "出口 $(printf '%s\n' "$out" | awk '$1=="EGRESS"{print $2}') = 基线，进入 cc"
fi
exec limactl shell --workdir=/ "$VM" sudo -iu cc
