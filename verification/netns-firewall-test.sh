#!/usr/bin/env bash
# Functional test of the kit's nftables rules.
# netns "ccg" = the VM (eth = veth-g 192.168.5.15/24), netns "cch" = Mac loopback as seen from the VM (192.168.5.2)
# plus a fake "internet" host 1.1.1.1. Loads the real rendered firewall.nft / lockdown.nft and probes as
# root, a stand-in sing-box user, a stand-in cc user, and from the "Mac" side.
set -uo pipefail
[ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || { echo "Requires Linux and root" >&2; exit 2; }
T="$(cd "$(dirname "$0")" && pwd)"; KIT="${1:?usage: netns-firewall-test.sh KIT_DIRECTORY}"
W="$(mktemp -d)"   # scratch: rendered rules, netns handles
SBUID=990; CCUID=1501
# setpriv accepts numeric IDs; no host users need to be created for these isolated namespaces.
sed "s/@SBUID@/$SBUID/g" "$KIT/config/firewall.nft.in" > "$W/fw.nft"

NSD="$W/ns"; mkdir -p "$NSD"
SRV_PIDS=()
cleanup() {
  [ "${#SRV_PIDS[@]}" -gt 0 ] && kill "${SRV_PIDS[@]}" 2>/dev/null
  [ "${#SRV_PIDS[@]}" -gt 0 ] && wait "${SRV_PIDS[@]}" 2>/dev/null
  for n in ccg cch; do umount "$NSD/$n" 2>/dev/null; rm -f "${NSD:?}/${n:?}"; done
  rm -rf -- "${W:?}"
}
trap cleanup EXIT
for n in ccg cch; do touch "$NSD/$n"; unshare --net="$NSD/$n" true || { echo "cannot create netns"; exit 2; }; done
G() { nsenter --net="$NSD/ccg" "$@"; }
H() { nsenter --net="$NSD/cch" "$@"; }
NLG() { G python3 -I "$T/nl.py" "$@"; }
NLH() { H python3 -I "$T/nl.py" "$@"; }
NLG veth veth-g veth-h "$NSD/cch"
NLG up lo; NLG addr veth-g 192.168.5.15/24; NLG up veth-g; NLG route-default 192.168.5.2
NLH up lo; NLH addr veth-h 192.168.5.2/24; NLH up veth-h; NLH addr lo:1 1.1.1.1/32
nsenter --net="$NSD/cch" python3 -I "$T/echo_server.py" 17897 7897 443 >/dev/null 2>&1 & SRV_PIDS+=($!)
nsenter --net="$NSD/ccg" python3 -I "$T/echo_server.py" 22 2222 >/dev/null 2>&1 & SRV_PIDS+=($!)
sleep 1

# probe.py is fed on stdin (opened by root) so the unprivileged test users never need to read the scratch dir
P() {
  local who="$1"; shift
  case $who in
    cc)   G setpriv --reuid=$CCUID --regid=$CCUID --clear-groups python3 -I - "$@" < "$T/probe.py" ;;
    sb)   G setpriv --reuid=$SBUID --regid=$SBUID --clear-groups python3 -I - "$@" < "$T/probe.py" ;;
    root) G python3 -I - "$@" < "$T/probe.py" ;;
    mac)  H python3 -I - "$@" < "$T/probe.py" ;;
  esac
}
fails=0
expect() {
  local want="$1" desc="$2"; shift 2; local got; got="$(P "$@" 2>&1)"
  if [[ "$got" =~ ^($want)$ ]]; then echo "PASS $desc  [$got]"; else echo "FAIL $desc  [got $got, want $want]"; fails=$((fails+1)); fi
}

echo "--- 基线（无防火墙）：确认拓扑可达，否则后续 EPERM 无意义"
expect OK "无防火墙时 cc → 1.1.1.1:443 可达"           cc tcp 1.1.1.1 443 send
expect OK "无防火墙时 cc → 192.168.5.2:17897 可达"      cc tcp 192.168.5.2 17897 send

echo "--- 加载防火墙时，已有的 Mac→VM:22 会话（安装脚本所在 SSH 会话）不能被切断"
H timeout 15 python3 -I -c '
import socket,time
s=socket.create_connection(("192.168.5.15",22),timeout=5); s.sendall(b"a"); s.recv(4)
time.sleep(3)
s.sendall(b"b"); print("OK" if s.recv(4) else "NODATA")' > "$W/sess.out" 2>&1 &
sess_pid=$!
sleep 1
G nft -f "$W/fw.nft" && echo "  （主防火墙已加载）"
wait $sess_pid; sess="$(cat "$W/sess.out")"
if [ "$sess" = OK ]; then echo "PASS 已有 SSH 会话在加载防火墙后继续工作  [$sess]"; else echo "FAIL 已有 SSH 会话被切断 [$sess]"; fails=$((fails+1)); fi

echo "--- 无 TUN（等同 sing-box 停止/崩溃）"
expect OK      "sing-box 用户 → 192.168.5.2:17897 放行"               sb tcp 192.168.5.2 17897 send
expect "TIMEOUT|EPERM"   "cc → 192.168.5.2:17897 阻断"                          cc tcp 192.168.5.2 17897
expect "TIMEOUT|EPERM"   "root → 192.168.5.2:17897 阻断（只放行 sing-box 用户）" root tcp 192.168.5.2 17897
expect "TIMEOUT|EPERM"   "sing-box 用户 → Mac 回环其他端口 :7897 阻断"           sb tcp 192.168.5.2 7897
expect "TIMEOUT|EPERM"   "cc → 公网 1.1.1.1:443 直连阻断"                       cc tcp 1.1.1.1 443
expect "TIMEOUT|EPERM"   "root → 公网 1.1.1.1:443 直连阻断"                     root tcp 1.1.1.1 443
expect "TIMEOUT|EPERM"   "sing-box 用户 → 公网直连阻断"                         sb tcp 1.1.1.1 443
expect EPERM   "cc → UDP 8.8.8.8:53 阻断"                             cc udp 8.8.8.8 53
expect EPERM   "cc → UDP 123 (NTP) 阻断"                              cc udp 1.1.1.1 123
expect OK      "Mac → VM:22（Lima SSH）新连接往返正常"                 mac tcp 192.168.5.15 22 send
expect TIMEOUT "Mac → VM 其他端口 :2222 阻断"                          mac tcp 192.168.5.15 2222

echo "--- 有 TUN（模拟 auto_route：公网目的地路由进 sb-tun）"
NLG tun sb-tun; NLG addr sb-tun 172.31.255.1/30; NLG up sb-tun; NLG route-host 1.1.1.1 sb-tun
expect SENT    "cc → 公网经 sb-tun：防火墙放行（UDP 能发出 = 未被丢弃）" cc udp 1.1.1.1 443
expect SENT    "root → 公网经 sb-tun：防火墙放行" root udp 1.1.1.1 443
expect "TIMEOUT|EPERM"   "TUN 存在时 cc 仍不能直连 192.168.5.2:17897（该网段不进 TUN）"     cc tcp 192.168.5.2 17897

echo "--- 锁定模式（模拟 ccvm-firewall.service 中主规则加载失败）"
G sh -c "nft -f /nonexistent/firewall.nft 2>/dev/null || nft -f '$KIT/config/lockdown.nft'"
G nft list table inet ccvm | head -n 2 | sed "s/^/    /"
tbl="$(G nft list table inet ccvm)"   # 先取出再匹配：pipefail 下「nft | grep -q」会因 SIGPIPE 误判
if [[ "$tbl" == *ccvm-lockdown* ]]; then echo "PASS 主规则失败时回落到锁定规则"; else echo "FAIL 未进入锁定模式"; fails=$((fails+1)); fi
expect "TIMEOUT|EPERM"   "锁定模式：sing-box 用户也不能连专用入口"   sb tcp 192.168.5.2 17897
expect EPERM   "锁定模式：cc 经 TUN 也不能出网"            cc udp 1.1.1.1 443
expect OK      "锁定模式：Lima SSH 仍可登录修复"           mac tcp 192.168.5.15 22 send
G nft -f "$W/fw.nft"
out_chain="$(G nft list chain inet ccvm output)"
if [[ "$out_chain" == *"dport 17897"* ]]; then echo "PASS 修复后可原子切回主规则"; else echo "FAIL 切回主规则失败"; fails=$((fails+1)); fi

echo "RESULT fails=$fails"
exit $fails
