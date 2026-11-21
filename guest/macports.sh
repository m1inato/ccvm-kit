#!/usr/bin/env bash
# VM 内以 root 运行（Mac 端经 stdin 传入：limactl shell ccvm sudo bash -s -- <操作> [端口]）。
# VM 能访问的 Mac 端口：VM 里经 192.168.5.2（host.lima.internal）连 Mac 的 127.0.0.1:<端口>。
#   list          VALUE mac_ports_ready 1|0（VM 有没有这项功能，没有时先更新 VM），然后每个允许的端口一行：MACPORT <端口>
#   allow <端口>   允许，立即生效
#   deny <端口>    不再允许，立即生效
# 允许的端口记在 /etc/ccvm/mac-ports，由 /usr/local/lib/ccvm/mac-ports-load 装进防火墙集合 mac_ports（升级步骤 3 安装）。
set -uo pipefail
R="${CCVM_ROOT:-}"
LIST="$R/etc/ccvm/mac-ports"
LOAD="$R/usr/local/lib/ccvm/mac-ports-load"

ready() { [ -x "$LOAD" ] && nft list set inet ccvm mac_ports >/dev/null 2>&1; }
valid() { [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$1" -le 65535 ]; }
ports() { grep -xE '[1-9][0-9]{0,4}' "$LIST" 2>/dev/null | sort -nu; }

write_list() {   # stdin：端口，一行一个
  sort -nu > "$LIST.tmp" && chmod 0644 "$LIST.tmp" && mv -f "$LIST.tmp" "$LIST"
}

op="${1:-}"; port="${2:-}"
case "$op" in
  list)
    if ready; then echo "VALUE mac_ports_ready 1"; else echo "VALUE mac_ports_ready 0"; fi
    ports | while read -r p; do echo "MACPORT $p"; done
    echo "PASS macports.list 已列出 VM 能访问的 Mac 端口"
    ;;
  allow|deny)
    valid "$port" || { echo "FAIL macports.$op 端口要是 1–65535 之间的整数：$port"; exit 1; }
    [ "$port" != 17897 ] || { echo "FAIL macports.$op 17897 是代理入口，只给 sing-box 用"; exit 1; }
    ready || { echo "FAIL macports.$op VM 还没有这项功能：先更新 VM"; exit 1; }
    if [ "$op" = allow ]; then
      { ports; echo "$port"; } | write_list || { echo "FAIL macports.allow 写不了 $LIST"; exit 1; }
    else
      { ports | grep -vx "$port" || true; } | write_list || { echo "FAIL macports.deny 写不了 $LIST"; exit 1; }
    fi
    "$LOAD" >&2 || { echo "FAIL macports.$op 防火墙没有更新"; exit 1; }
    if [ "$op" = allow ]; then echo "PASS macports.allow VM 现在可以访问 Mac 的 $port"; else echo "PASS macports.deny VM 不再能访问 Mac 的 $port"; fi
    ;;
  *) echo "FAIL guest.usage 用法：macports.sh list | allow <端口> | deny <端口>"; exit 1 ;;
esac
