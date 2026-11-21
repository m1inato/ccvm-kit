#!/usr/bin/env bash
# VM 内以 root 运行（Mac 端经 stdin 传入：limactl shell ccvm sudo bash -s -- <目标级别>）。
# 补装软件包（升级步骤）：早先部署的 VM 里可能缺后来才加进 install.sh 的包。
# 读 /var/lib/ccvm/level（不存在或读不懂当作 0），按顺序执行比它高的步骤，每完成一步写入新级别。
# 不改 sing-box 配置和 DNS。第 2 步加 networkd 的设置和一个 TUN 看门狗；第 3 步给防火墙加 VM → Mac 端口的集合。root 的流量同样走 TUN，apt 可以正常下载。
# 输出：PASS|FAIL vm.upgrade <说明>，以及 VALUE vm_level <级别>。
set -uo pipefail
LEVEL_FILE="${CCVM_LEVEL_FILE:-/var/lib/ccvm/level}"
# Lima 的 /etc/environment 可能带着宿主的代理变量：清掉，让 apt 经现有 TUN 下载（和 shares.sh 安装 bindfs 同一处理）
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
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

# 系统更新会重启 systemd-networkd：它默认清掉「不是自己建的」策略路由，sing-box 的 ip rule（查表 2022）就没了。
# TUN 进程还活着、Restart=always 不会触发，流量却进不了 TUN：VM 断网（防火墙还在，不会泄漏）。
#   1. networkd 不再管别人的策略路由（下次 networkd 启动时读到，不需要现在重启它）
#   2. 看门狗：TUN 在运行、但策略路由或 2022 表不见了，就重启 TUN 让 sing-box 重建（任何原因丢的都能恢复）
step_2() {
  local R="${CCVM_ROOT:-}"   # 测试时指向临时目录
  install -d -m 0755 "$R/etc/systemd/networkd.conf.d" "$R/usr/local/lib/ccvm" "$R/etc/systemd/system" || return 1
  cat > "$R/etc/systemd/networkd.conf.d/50-ccvm-tun.conf" <<'NETEOF' || return 1
[Network]
# 由 CCVM 安装：sing-box 自己管 TUN 的策略路由；networkd 重启时不要清掉它们。
ManageForeignRoutingPolicyRules=no
NETEOF
  cat > "$R/usr/local/lib/ccvm/tun-watchdog" <<'WDEOF' || return 1
#!/bin/sh
# 由 CCVM 安装：TUN 在运行、但策略路由丢了时重启 TUN，让 sing-box 重建。断流测试停 TUN 时（不在运行）什么也不做。
systemctl is-active --quiet ccvm-tun.service || exit 0
ip link show sb-tun >/dev/null 2>&1 || exit 0
# 刚启动 20 秒内 sing-box 可能还在建路由，不算
since=$(systemctl show -p ActiveEnterTimestampMonotonic --value ccvm-tun.service 2>/dev/null)
now=$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)
[ -n "$since" ] && [ $((now - since / 1000000)) -lt 20 ] && exit 0
if ip rule show | grep -q 'lookup 2022' && [ -n "$(ip route show table 2022 2>/dev/null)" ]; then exit 0; fi
logger -t ccvm-tun-watchdog "TUN 的策略路由丢了（ip rule 里没有表 2022），重启 ccvm-tun"
systemctl restart ccvm-tun.service
WDEOF
  chmod 0755 "$R/usr/local/lib/ccvm/tun-watchdog" || return 1
  cat > "$R/etc/systemd/system/ccvm-tun-watchdog.service" <<'SVCEOF' || return 1
[Unit]
Description=ccvm: restart the TUN when its policy routes are gone

[Service]
Type=oneshot
ExecStart=/usr/local/lib/ccvm/tun-watchdog
SVCEOF
  cat > "$R/etc/systemd/system/ccvm-tun-watchdog.timer" <<'TMEOF' || return 1
[Unit]
Description=ccvm: TUN policy route watchdog, every 30 seconds

[Timer]
OnBootSec=60
OnUnitActiveSec=30
AccuracySec=5

[Install]
WantedBy=timers.target
TMEOF
  systemctl daemon-reload || return 1
  systemctl enable --now ccvm-tun-watchdog.timer >&2
}

# VM → Mac 的端口：防火墙里加一个集合 mac_ports，放行到 192.168.5.2（= Mac 的 127.0.0.1）上这些端口的连接。
# 允许哪些端口记在 /etc/ccvm/mac-ports（一行一个，root 所有）；mac-ports-load 把它装进集合，开机时在防火墙之后运行。
# 17897 是代理入口，只给 sing-box 用，永远不进这个集合。
step_3() {
  local R="${CCVM_ROOT:-}" f
  f="$R/etc/ccvm/firewall.nft"
  install -d -m 0755 "$R/usr/local/lib/ccvm" "$R/etc/systemd/system/ccvm-firewall.service.d" || return 1
  [ -e "$R/etc/ccvm/mac-ports" ] || { : > "$R/etc/ccvm/mac-ports" && chmod 0644 "$R/etc/ccvm/mac-ports"; } || return 1
  cat > "$R/usr/local/lib/ccvm/mac-ports-load" <<'LDEOF' || return 1
#!/bin/sh
# 由 CCVM 安装：把 /etc/ccvm/mac-ports 里允许的 Mac 端口装进防火墙集合 mac_ports（整体替换，一次完成）。
list="${CCVM_ROOT:-}/etc/ccvm/mac-ports"
ports=$(grep -xE '[1-9][0-9]{0,4}' "$list" 2>/dev/null | awk '$1 <= 65535 && $1 != 17897' | sort -nu | paste -sd, -)
{
  echo "flush set inet ccvm mac_ports"
  [ -z "$ports" ] || echo "add element inet ccvm mac_ports { $ports }"
} | nft -f -
LDEOF
  chmod 0755 "$R/usr/local/lib/ccvm/mac-ports-load" || return 1
  printf '[Service]\n# 由 CCVM 安装：防火墙加载后装入允许的 Mac 端口（锁定模式下没有这个集合，失败也不影响）\nExecStartPost=-/usr/local/lib/ccvm/mac-ports-load\n' \
    > "$R/etc/systemd/system/ccvm-firewall.service.d/mac-ports.conf" || return 1
  if ! grep -q 'set mac_ports' "$f"; then
    awk '
      /^table inet ccvm \{/ { print; print "  set mac_ports { type inet_service; }"; next }
      /dport 17897 accept/  { print; print "    ip daddr 192.168.5.2 tcp dport @mac_ports accept comment \"VM → Mac 上允许的端口\""; next }
      { print }' "$f" > "$f.new" || return 1
    if ! grep -q 'set mac_ports' "$f.new" || ! grep -q '@mac_ports' "$f.new" || ! nft -c -f "$f.new" >&2; then
      rm -f "$f.new"; return 1
    fi
    chmod 0644 "$f.new" && mv -f "$f.new" "$f" || return 1
    # 原子替换整张表，立即生效；不重启 ccvm-firewall（那会连带重启网络服务和 TUN）
    nft -f "$f" >&2 || return 1
  fi
  "$R/usr/local/lib/ccvm/mac-ports-load" >&2 || return 1
  # VM 里用 host.lima.internal 指 Mac
  grep -qE '^[^#]*[[:space:]]host\.lima\.internal([[:space:]]|$)' "$R/etc/hosts" 2>/dev/null \
    || printf '192.168.5.2 host.lima.internal\n' >> "$R/etc/hosts" || return 1
  [ -n "$R" ] || systemctl daemon-reload || return 1
}
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
  echo "PASS vm.upgrade 已是最新（级别 ${cur}），不需要补装"
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
