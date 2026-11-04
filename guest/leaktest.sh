#!/usr/bin/env bash
# VM 内以 root 运行（Mac 端经 stdin 传入）。会短暂停止 TUN，结束（含 Ctrl-C）时自动恢复。
#  A. TUN 正常：生成各类流量，同时在物理网卡上抓全部包。事后分两次统计：
#     对照 = 经专用入口 :17897 的包，必须 > 0（证明抓包真的在工作）；旁路 = 除 17897/SSH/DHCP 外的包，必须 = 0
#  B. TUN 停止：IPv4/IPv6 直连、DNS、root 直连、root 经专用入口都必须失败
set -uo pipefail

TRACE_URL="https://1.1.1.1/cdn-cgi/trace"
LEAK_FILTER='not arp and not (host 192.168.5.2 and (tcp port 17897 or tcp port 22)) and not (udp port 67 or udp port 68)'
CTRL_FILTER='host 192.168.5.2 and tcp port 17897'
fails=0
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
refuse() { local msg="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$msg"; else pass "$msg"; fi; }
as_cc() { runuser -u cc -- env -i HOME=/home/cc USER=cc PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 "$@"; }
oneline() { tr '\n' ' ' < "$1" 2>/dev/null | cut -c1-240; }

work="$(mktemp -d /tmp/ccvm-leak.XXXXXX)"
cap_pid=""
restore() {
  systemctl start ccvm-tun.service
  for _ in $(seq 1 20); do ip link show sb-tun >/dev/null 2>&1 && break; sleep 1; done
}
cleanup() {
  if [ -n "$cap_pid" ]; then kill -TERM "$cap_pid" 2>/dev/null; wait "$cap_pid" 2>/dev/null; fi
  restore
  rm -rf -- "${work:?}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

as_cc curl -fsS --max-time 20 "$TRACE_URL" >/dev/null || { fail "对照探针失败（TUN 正常时就不通），先跑 check.sh"; exit 1; }
pass "对照：TUN 正常时 https://1.1.1.1 可达"

# ---------------------------------------------------------------- A. 抓包
nic="$(ip -4 route get 192.168.5.2 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
if [ -z "$nic" ] || ! ip link show "$nic" >/dev/null 2>&1; then
  fail "抓包：找不到通往 192.168.5.2 的物理网卡（得到「${nic:-空}」），无法抓包"
elif ! command -v tcpdump >/dev/null 2>&1; then
  fail "抓包：VM 里没有 tcpdump，无法抓包"
else
  pcap="$work/cap.pcap"
  # 抓包时不过滤，事后用两个过滤条件分别统计，这样「对照」和「旁路」出自同一次抓包
  timeout 120 tcpdump -U -n -i "$nic" -w "$pcap" >/dev/null 2>"$work/tcpdump.log" &
  cap_pid=$!
  started=0
  for _ in $(seq 1 20); do
    if grep -q 'listening on' "$work/tcpdump.log" 2>/dev/null; then started=1; break; fi
    kill -0 "$cap_pid" 2>/dev/null || break
    sleep 0.5
  done
  if [ "$started" != 1 ]; then
    fail "抓包：tcpdump 没有正常启动：$(oneline "$work/tcpdump.log")"
    kill -TERM "$cap_pid" 2>/dev/null; wait "$cap_pid" 2>/dev/null; cap_pid=""
  else
    as_cc curl -sS -o /dev/null --max-time 15 https://api.anthropic.com/ || true
    as_cc curl -sS -o /dev/null --max-time 15 http://example.com/ || true
    as_cc curl -sS -o /dev/null --max-time 15 https://github.com/ || true
    as_cc getent ahostsv4 claude.ai >/dev/null 2>&1 || true
    as_cc dig +time=2 +tries=1 @8.8.8.8 example.com >/dev/null 2>&1 || true          # 指定外部 DNS：应被 TUN 劫持
    as_cc bash -c 'echo x > /dev/udp/162.159.200.1/123' 2>/dev/null || true           # NTP/UDP：应被拒绝
    as_cc bash -c 'timeout 3 bash -c "exec 3<>/dev/tcp/192.168.5.2/7897"' 2>/dev/null || true
    sleep 1
    kill -TERM "$cap_pid" 2>/dev/null; wait "$cap_pid"; cap_rc=$?; cap_pid=""
    if [ "$cap_rc" -ne 0 ]; then
      fail "抓包：tcpdump 异常退出（退出码 ${cap_rc}）：$(oneline "$work/tcpdump.log")"
    elif ! tcpdump -nr "$pcap" "$CTRL_FILTER" >"$work/ctrl.txt" 2>"$work/read.log" \
      || ! tcpdump -nr "$pcap" "$LEAK_FILTER" >"$work/leak.txt" 2>>"$work/read.log"; then
      fail "抓包：pcap 读不出来：$(oneline "$work/read.log")"
    else
      ctrl="$(wc -l < "$work/ctrl.txt" | tr -d ' ')"
      leaked="$(wc -l < "$work/leak.txt" | tr -d ' ')"
      if [ "$ctrl" -gt 0 ]; then
        pass "抓包对照：同一次抓包里有 $ctrl 个经专用入口 :17897 的包（证明抓包在 $nic 上确实有效）"
      else
        fail "抓包对照为 0：没有抓到任何经专用入口的包，抓包结果不可信（网卡不对，或流量没有走 TUN）"
      fi
      if [ "$leaked" -eq 0 ]; then
        pass "抓包：物理网卡 $nic 上没有旁路流量（仅 17897 / SSH / DHCP）"
      else
        fail "抓包：物理网卡上出现 $leaked 个旁路包："
        head -n 20 "$work/leak.txt"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- B. 停止 TUN
systemctl stop ccvm-tun.service
sleep 1
check_table() { local r; r="$(nft list chain inet ccvm output 2>/dev/null)" || return 1; [[ "$r" == *"dport 17897"* ]]; }
if check_table; then pass "停止 TUN 后防火墙仍在"; else fail "停止 TUN 后防火墙消失"; fi
# 直连探针用 --noproxy '*'，经代理探针用 --noproxy ''：环境里的代理变量都不能改变测试对象
refuse "TUN 停止：cc 的 IPv4 直连（字面 IP，排除 DNS 因素）被阻断" as_cc curl -4 -fsS --noproxy '*' --connect-timeout 4 --max-time 8 "$TRACE_URL"
refuse "TUN 停止：cc 的 IPv6 直连被阻断" as_cc curl -6 -fsS --noproxy '*' --connect-timeout 4 --max-time 8 'https://[2606:4700:4700::1111]/cdn-cgi/trace'
refuse "TUN 停止：DNS 无法解析" as_cc getent ahostsv4 example.com
refuse "TUN 停止：外部 UDP DNS 无法使用" as_cc dig +time=2 +tries=1 @8.8.8.8 example.com
refuse "TUN 停止：root 直连也被阻断" curl -4 -fsS --noproxy '*' --connect-timeout 4 --max-time 8 "$TRACE_URL"
refuse "TUN 停止：root 无法经专用入口出网（仅 sing-box 用户放行）" \
  curl -fsS --noproxy '' --connect-timeout 4 --max-time 8 --proxy http://192.168.5.2:17897 "$TRACE_URL"

# ---------------------------------------------------------------- 恢复
restore
if as_cc curl -fsS --max-time 25 "$TRACE_URL" >/dev/null 2>&1; then pass "TUN 已恢复，出网正常"; else fail "TUN 恢复后仍不通"; fi

[ "$fails" -eq 0 ]
