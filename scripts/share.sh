#!/usr/bin/env bash
# 共享文件夹（读写）：Mac 上用户选定的具体文件夹，经 Lima 的 virtiofs 挂进 VM，再用 bindfs 映射给 cc。
# 这是一次有意的设计降级，见 docs/desktop-app.md「设计降级：共享文件夹（读写）」。
# 唯一来源是 $STATE/shares.txt（一行一个 Mac 绝对路径）；App 应用设置时写它，命令行用户可以手动编辑。
# 用法：share.sh status|apply [--json]
#   status  列出共享（名字、VM 里的位置）并逐个检查路径；不碰 VM
#   apply   检查路径 → 停 VM → limactl edit 写挂载 → 启动并核对实际配置 → 在 VM 里设置 bindfs 映射
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
set -- "${REST[@]+"${REST[@]}"}"
[ $# -eq 1 ] || die "用法：share.sh status|apply [--json]"
case "$1" in status|apply) ;; *) die "未知操作：$1（用法：share.sh status|apply [--json]）" ;; esac

paths=() names=()
while IFS= read -r p; do paths+=("$p"); done < <(share_list)
while IFS= read -r n; do names+=("$n"); done < <(share_names)
count="${#paths[@]}"

if [ "$1" = status ]; then
  i=0
  while [ "$i" -lt "$count" ]; do
    p="${paths[$i]}"; n="${names[$i]}"
    prob="$(share_path_problem "$p")"
    ev item ",\"kind\":\"share\",\"path\":$(json_str "$p"),\"name\":$(json_str "$n"),\"mount_point\":$(json_str "$SHARE_RAW/$n"),\"view\":$(json_str "$SHARE_VIEW/$n"),\"problem\":$(json_str "$prob")"
    if [ -z "$prob" ]; then
      pass share.paths "可以共享：$p → $SHARE_VIEW/$n"
    else
      soft_fail share.paths "$prob"
    fi
    i=$((i + 1))
  done
  [ "$count" -gt 0 ] || pass share.paths "没有共享文件夹（$STATE/shares.txt 为空或不存在）"
  value share_count "$count"
  exit 0
fi

# ---------------------------------------------------------------- apply
require_mac
step share.check "检查 $count 个共享路径"
for p in "${paths[@]+"${paths[@]}"}"; do
  prob="$(share_path_problem "$p")"
  [ -z "$prob" ] || fail_check share.paths "${prob}。没有改动 VM。"
done
pass share.paths "$count 个共享路径都可以共享"
value share_count "$count"
st="$(vm_status)"
[ -n "$st" ] || fail_check vm.exists "VM 不存在：先完成部署（setup.sh）"

step share.stop "停止 VM（会中断正在运行的 tmux 会话）"
if [ "$st" = Running ]; then limactl stop "$VM"; else ok "VM 没有在运行"; fi

step share.edit "写入 Lima 实例配置"
expr=".mounts = ["
i=0
while [ "$i" -lt "$count" ]; do
  [ "$i" -eq 0 ] || expr="$expr, "
  expr="$expr{\"location\":$(json_str "${paths[$i]}"),\"mountPoint\":$(json_str "$SHARE_RAW/${names[$i]}"),\"writable\":true}"
  i=$((i + 1))
done
expr="$expr]"
limactl edit "$VM" --set "$expr" || fail_check share.lima_mounts "limactl edit 没有成功：Lima 实例配置没有改动"
pass share.lima_mounts "Lima 实例配置已写入 $count 个读写挂载"

step share.start "启动 VM 并核对实际配置"
limactl start --tty=false "$VM"
check_effective_lima_config

step share.guest "在 VM 里设置 /home/cc/mac"
rc=0
if [ "$count" -gt 0 ]; then
  vm_script shares.sh apply "$(id -u)" "$(id -g)" "${names[@]}" | relay_guest || rc=$?
else
  vm_script shares.sh remove | relay_guest || rc=$?
fi
[ "$rc" -eq 0 ] || die "VM 里的共享映射没有完成"
