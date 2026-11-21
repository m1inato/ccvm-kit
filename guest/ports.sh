#!/usr/bin/env bash
# VM 内以 cc 身份运行（Mac 端经 stdin 传入：sudo -u cc env -i ... bash -s -- list）。
#   list  正在监听的 TCP 端口，一个端口一行：PORT␟端口␟地址␟进程名␟项目
#         进程名和项目只对 cc 自己的进程读得到，别的为空；SSH（22）不列出
set -uo pipefail
US=$'\x1f'
WORK="$HOME/work"
[ "$(id -un)" = cc ] || { echo "FAIL guest.user 必须以 cc 身份运行"; exit 1; }
clean() { tr -d '\037\r\n' | cut -c1-80; }

list_ports() {
  declare -A seen=()
  local state recvq sendq local_addr peer rest addr port proc pid cwd proj
  # 一行形如：LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=20))
  while read -r state recvq sendq local_addr peer rest; do
    [ "$state" = LISTEN ] || continue
    port="${local_addr##*:}"
    addr="${local_addr%:*}"
    case "$port" in ''|*[!0-9]*) continue ;; esac
    [ "$port" != 22 ] || continue
    [ -z "${seen[$port]:-}" ] || continue
    seen[$port]=1
    proc="" proj=""
    if [[ "$rest" =~ \(\(\"([^\"]*)\",pid=([0-9]+) ]]; then
      proc="${BASH_REMATCH[1]}"
      pid="${BASH_REMATCH[2]}"
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
      case "$cwd" in "$WORK"/*) proj="${cwd#"$WORK"/}"; proj="${proj%%/*}" ;; esac
    fi
    printf 'PORT%s%s%s%s%s%s%s%s\n' "$US" "$port" "$US" "$(printf '%s' "$addr" | clean)" "$US" "$(printf '%s' "$proc" | clean)" "$US" "$(printf '%s' "$proj" | clean)"
  done < <(ss -Htlnp 2>/dev/null)
}

case "${1:-}" in
  list)
    command -v ss >/dev/null 2>&1 || { echo "FAIL ports.list VM 里没有 ss"; exit 1; }
    list_ports | sort -t "$US" -k2,2n
    echo "PASS ports.list 已列出监听端口" ;;
  *) echo "FAIL guest.usage 用法：ports.sh list"; exit 1 ;;
esac
