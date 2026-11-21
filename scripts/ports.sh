#!/usr/bin/env bash
# 端口，两个方向：
#   Mac 访问 VM：列出 VM 里正在监听的端口，或者把一个转发到 Mac 的 127.0.0.1
#     ports.sh list [--json]
#     ports.sh forward <VM端口> [Mac端口]     前台运行，Ctrl-C 结束。Mac 端口默认和 VM 端口相同
#     转发走 Lima 现有的 SSH 连接（ssh -L），只绑 Mac 的 127.0.0.1；不改 Lima 配置，不用重启 VM。
#   VM 访问 Mac：VM 经 192.168.5.2（host.lima.internal）连 Mac 的 127.0.0.1:<端口>，由 VM 防火墙按端口放行
#     ports.sh mac list [--json]
#     ports.sh mac allow|deny <端口> [--json]   立即生效，VM 重启后保留
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
set -- "${REST[@]+"${REST[@]}"}"
[ $# -ge 1 ] || die "用法：ports.sh list | forward <VM端口> [Mac端口]"
US=$'\x1f'

valid_port() { [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$1" -le 65535 ]; }

relay_ports() {
  local kind port addr proc proj n=0
  while IFS="$US" read -r kind port addr proc proj; do
    if [ "$kind" != PORT ]; then
      printf '%s\n' "$kind" | relay_guest
      continue
    fi
    valid_port "$port" || continue
    case "$proj" in *[!A-Za-z0-9._-]*) proj="" ;; esac
    case "$proc" in *[!A-Za-z0-9._+-]*) proc="" ;; esac
    n=$((n + 1))
    printf '  %-6s %-16s %-16s %s\n' "$port" "$addr" "$proc" "$proj"
    ev item ",\"kind\":\"port\",\"port\":$port,\"address\":$(json_str "$addr"),\"process\":$(json_str "$proc"),\"project\":$(json_str "$proj")"
  done
  value port_count "$n"
}

relay_mac() {
  local line n=0
  while IFS= read -r line; do
    case "$line" in
      "MACPORT "*)
        line="${line#MACPORT }"
        valid_port "$line" || continue
        n=$((n + 1))
        printf '  %s\n' "$line"
        ev item ",\"kind\":\"mac_port\",\"port\":$line"
        ;;
      *) printf '%s\n' "$line" | relay_guest ;;
    esac
  done
  value mac_port_count "$n"
}

case "$1" in
  mac)
    [ $# -ge 2 ] || die "用法：ports.sh mac list | allow <端口> | deny <端口>"
    case "$2" in
      list)
        [ $# -eq 2 ] || die "mac list 不带参数"
        require_mac
        require_running
        rc=0; vm_script macports.sh list | relay_mac || rc=$?
        [ "$rc" -eq 0 ] || die "读取失败"
        ;;
      allow|deny)
        [ $# -eq 3 ] || die "用法：ports.sh mac $2 <端口>"
        if [ "$2" = allow ]; then id=macports.allow; else id=macports.deny; fi
        valid_port "$3" || fail_check "$id" "端口要是 1–65535 之间的整数：$3"
        [ "$3" != "$PORT" ] || fail_check "$id" "${PORT} 是代理入口，只给 sing-box 用"
        require_mac
        require_running
        rc=0; vm_script macports.sh "$2" "$3" | relay_guest || rc=$?
        [ "$rc" -eq 0 ] || die "没有改成"
        ;;
      *) die "未知操作：mac $2" ;;
    esac
    ;;
  list)
    [ $# -eq 1 ] || die "list 不带参数"
    require_mac
    require_running
    rc=0; vm_script_cc ports.sh list | relay_ports || rc=$?
    [ "$rc" -eq 0 ] || die "读取端口失败"
    ;;
  forward)
    [ $# -ge 2 ] && [ $# -le 3 ] || die "用法：ports.sh forward <VM端口> [Mac端口]"
    vport="$2"; mport="${3:-$2}"
    valid_port "$vport" || fail_check ports.forward "VM 端口不对：$vport"
    valid_port "$mport" || fail_check ports.forward "Mac 端口不对：$mport"
    require_mac
    require_running
    cfg="$LIMA_HOME/$VM/ssh.config"
    [ -r "$cfg" ] || fail_check ports.forward "找不到 Lima 的 SSH 配置：$cfg"
    info "转发：Mac 127.0.0.1:${mport} → VM 127.0.0.1:${vport}（Ctrl-C 结束）"
    # 不复用 Lima 的控制连接：转发归这个进程所有，进程结束转发就结束
    exec ssh -F "$cfg" -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o LogLevel=ERROR \
      -N -L "127.0.0.1:$mport:127.0.0.1:$vport" "lima-$VM"
    ;;
  *) die "未知操作：$1" ;;
esac
