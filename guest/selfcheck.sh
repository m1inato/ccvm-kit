#!/usr/bin/env bash
# VM 内以 root 运行（Mac 端经 stdin 传入：limactl shell ccvm sudo bash -s）。
# 只读状态检查：防火墙、TUN、经代理能不能出网。
# 输出「PASS|FAIL <id> <说明>」行，最后一行 "EGRESS <ip>"；有 FAIL 时退出码 1。id 见 docs/events.md。
set -uo pipefail

TRACE_URL="https://1.1.1.1/cdn-cgi/trace"
fails=0
pass() { local id="$1"; shift; printf 'PASS %s %s\n' "$id" "$*"; }
fail() { local id="$1"; shift; printf 'FAIL %s %s\n' "$id" "$*"; fails=$((fails + 1)); }
as_cc() { runuser -u cc -- env -i HOME=/home/cc USER=cc PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 "$@"; }

firewall_ok() {
  systemctl is-active --quiet ccvm-firewall.service || return 1
  local r; r="$(nft list chain inet ccvm output 2>/dev/null)" || return 1
  [[ "$r" == *"dport 17897"* ]]
}
tun_ok() {
  systemctl is-active --quiet ccvm-tun.service && ip link show sb-tun >/dev/null 2>&1 \
    && ip rule show 2>/dev/null | grep -q 'lookup 2022' && [ -n "$(ip route show table 2022 2>/dev/null)" ]
}

if firewall_ok; then pass vm.firewall "防火墙在"; else fail vm.firewall "防火墙没有加载：journalctl -u ccvm-firewall"; fi
if tun_ok; then pass vm.tun "TUN 在"; else fail vm.tun "TUN 没有运行：journalctl -u ccvm-tun"; fi

egress=""
for t in 10 15; do
  egress="$(as_cc curl -fsS --max-time "$t" "$TRACE_URL" 2>/dev/null | awk -F= '$1=="ip"{print $2}')"
  [ -n "$egress" ] && break
done
if [ -n "$egress" ]; then pass vm.proxy "经代理出网，出口 $egress"; else fail vm.proxy "代理不通，VM 现在断网"; fi

printf 'EGRESS %s\n' "$egress"
[ "$fails" -eq 0 ]
