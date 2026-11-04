#!/usr/bin/env bash
# VM 内以 root 运行（Mac 端经 stdin 传入：limactl shell ccvm sudo bash -s -- <目标级别>）。
# 补装软件包（升级步骤）：早先部署的 VM 里可能缺后来才加进 install.sh 的包。
# 读 /var/lib/ccvm/level（不存在或读不懂当作 0），按顺序执行比它高的步骤，每完成一步写入新级别。
# 不碰防火墙、TUN、sing-box 和 DNS 配置。root 的流量同样走 TUN，apt 可以正常下载。
# 输出：PASS|FAIL vm.upgrade <说明>，以及 VALUE vm_level <级别>。
set -uo pipefail
LEVEL_FILE="${CCVM_LEVEL_FILE:-/var/lib/ccvm/level}"
export DEBIAN_FRONTEND=noninteractive

current_level() {
  local l
  l="$(cat "$LEVEL_FILE" 2>/dev/null)" || { echo 0; return; }
  l="${l//[[:space:]]/}"
  if [[ "$l" =~ ^[0-9]{1,4}$ ]]; then echo "$((10#$l))"; else echo 0; fi
}

# 级别 cur → target 之间要执行的步骤号，一行一个
pending_steps() {
  local n
  for ((n = $1 + 1; n <= $2; n++)); do echo "$n"; done
}

apt_install() {
  apt-get install -y --no-install-recommends "$@" >&2 \
    || { apt-get update >&2 && apt-get install -y --no-install-recommends "$@" >&2; }
}

# ---------------------------------------------------------------- 升级步骤（只能往后加，不能改已有的）
step_1() { apt_install git tmux; }   # 内嵌终端与项目功能需要
# ----------------------------------------------------------------

highest_step() { local n=0; while declare -F "step_$((n + 1))" >/dev/null; do n=$((n + 1)); done; echo "$n"; }

[ "${CCVM_UPGRADE_LIB:-0}" = 1 ] && return 0 2>/dev/null   # 测试时只取函数
[ "$(id -u)" = 0 ] || { echo "FAIL vm.upgrade 需要 root"; exit 1; }
target="${1:-}"
[[ "$target" =~ ^[0-9]{1,4}$ ]] || { echo "FAIL vm.upgrade 用法：<目标级别>"; exit 1; }
highest="$(highest_step)"
[ "$target" -le "$highest" ] || { echo "FAIL vm.upgrade 目标级别 $target 高于这份脚本知道的 $highest"; exit 1; }
cur="$(current_level)"
if [ "$cur" -ge "$target" ]; then
  echo "PASS vm.upgrade 已是最新（级别 $cur），不需要补装"
  echo "VALUE vm_level $cur"
  exit 0
fi
install -d -m 0755 "$(dirname "$LEVEL_FILE")"
for n in $(pending_steps "$cur" "$target"); do
  if ! "step_$n"; then
    echo "FAIL vm.upgrade 第 $n 步没有完成（停在级别 ${cur}），可以重试"
    echo "VALUE vm_level $cur"
    exit 1
  fi
  printf '%s\n' "$n" > "$LEVEL_FILE.tmp" && chmod 0644 "$LEVEL_FILE.tmp" && mv -f "$LEVEL_FILE.tmp" "$LEVEL_FILE"
  cur="$n"
done
echo "PASS vm.upgrade 已补装到级别 $cur"
echo "VALUE vm_level $cur"
