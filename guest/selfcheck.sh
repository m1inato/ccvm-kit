#!/usr/bin/env bash
# VM 内以 root 运行（Mac 端经 stdin 传入：limactl shell ccvm sudo bash -s -- <基线IP> [quick]）。
# 只读检查；输出 PASS/FAIL 行，最后一行 "EGRESS <ip>"，有 FAIL 时退出码 1。
set -uo pipefail

EXPECTED="${1:-}"
MODE="${2:-full}"
TRACE_URL="https://1.1.1.1/cdn-cgi/trace"
fails=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
check() { local msg="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$msg"; else fail "$msg"; fi; }
refuse() { local msg="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$msg"; else pass "$msg"; fi; }
as_cc() { runuser -u cc -- env -i HOME=/home/cc USER=cc PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 "$@"; }
tcp_open() { timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2"; }

check "防火墙服务运行中" systemctl is-active --quiet ccvm-firewall.service
main_rules_loaded() { local r; r="$(nft list chain inet ccvm output 2>/dev/null)" || return 1; [[ "$r" == *"dport 17897"* ]]; }
check "主防火墙规则已加载（不是锁定模式）" main_rules_loaded
check "TUN 服务运行中且 sb-tun 存在" bash -c 'systemctl is-active --quiet ccvm-tun.service && ip link show sb-tun'

egress="$(as_cc curl -fsS --max-time 25 "$TRACE_URL" 2>/dev/null | awk -F= '$1=="ip"{print $2}')"
if [ -n "$egress" ]; then pass "VM（cc 用户，无代理变量）可经 TUN 出网：$egress"; else fail "VM 经 TUN 出网失败"; fi
if [ -n "$EXPECTED" ]; then
  if [ "$egress" = "$EXPECTED" ]; then pass "VM 出口 = 基线 $EXPECTED"; else fail "VM 出口 ${egress:-无} ≠ 基线 $EXPECTED"; fi
fi

if [ "$MODE" != quick ]; then
  check "通用 nftables.service 已屏蔽" bash -c '[ "$(systemctl is-enabled nftables.service 2>/dev/null)" = masked ]'
  check "/etc/resolv.conf 为静态文件且指向 172.31.255.2" bash -c '[ ! -L /etc/resolv.conf ] && [ "$(head -n1 /etc/resolv.conf)" = "nameserver 172.31.255.2" ]'
  check "IPv6 已关闭" bash -c '[ "$(sysctl -n net.ipv6.conf.all.disable_ipv6)" = 1 ]'
  check "没有宿主目录挂载" bash -c '[ -z "$(findmnt -rn -t virtiofs,9p,fuse.sshfs)" ]'
  refuse "cc 不在特权组" bash -c "id -nG cc | grep -Eqw 'sudo|admin|adm|lxd|docker'"
  refuse "cc 没有免密 sudo" as_cc sudo -n true
  check "cc 环境中没有代理变量" bash -c "! runuser -l cc -c env | grep -Eiq '^(https?|all|no)_proxy=.'"
  check "DNS 可解析（172.31.255.2 → DoH 经代理）" as_cc getent ahostsv4 api.anthropic.com
  code="$(as_cc curl -sS -o /dev/null -w '%{http_code}' --max-time 25 https://api.anthropic.com/ 2>/dev/null || true)"
  if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then pass "api.anthropic.com TLS 可达（HTTP ${code}）"; else fail "api.anthropic.com 不可达"; fi

  # 绕过尝试（TUN 正常时也必须失败）
  refuse "cc 不能直连 Mac 专用入口 192.168.5.2:17897" as_cc bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/192.168.5.2/17897"'
  refuse "root 也不能直连专用入口（只放行 sing-box 用户）" tcp_open 192.168.5.2 17897
  for port in 7897 7890 9097 9090; do
    refuse "cc 不能访问 Mac 回环其他端口 :${port}（日常代理/控制器）" as_cc bash -c "timeout 5 bash -c 'exec 3<>/dev/tcp/192.168.5.2/$port'"
  done
  refuse "cc 不能访问局域网/私网地址（192.168.1.1:80）" as_cc bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/192.168.1.1/80"'
fi

printf 'EGRESS %s\n' "${egress:-}"
[ "$fails" -eq 0 ]
