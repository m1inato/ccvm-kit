#!/usr/bin/env bash
# VM 内以 root 运行（Mac 端经 stdin 传入：limactl shell ccvm sudo bash -s -- <操作> [参数]）。
# 把 Lima 的原始挂载 /mnt/ccvm-raw/<名字>（文件属主是 Mac 的 uid）用 bindfs 映射到 /home/cc/mac/<名字>：
# cc 看到的属主是 cc；cc 新建的文件在 Mac 上属于你。cc 进不了 /mnt/ccvm-raw（0700 root）。
#   apply <Mac uid> <Mac gid> <名字…>  安装 bindfs、写 /etc/ccvm/shares.list、装并重启 ccvm-shares.service，最后核对
#   remove                              停用并删除服务，卸载 /home/cc/mac 下的 bindfs
#   verify <名字…>                      只核对，不改任何东西
# 输出「PASS|FAIL share.guest <说明>」。
set -uo pipefail
LIST=/etc/ccvm/shares.list
UP=/usr/local/lib/ccvm/shares-up
UNIT=/etc/systemd/system/ccvm-shares.service
RAW=/mnt/ccvm-raw
VIEW=/home/cc/mac
NAME_RE='^[A-Za-z0-9._-]{1,64}$'
[ "$(id -u)" = 0 ] || { echo "FAIL share.guest 需要 root"; exit 1; }

valid_name() { [[ "$1" =~ $NAME_RE ]] && [ "$1" != . ] && [ "$1" != .. ]; }

verify() {
  local name missing=() n=0
  for name in "$@"; do
    if [ "$(findmnt -rn -o FSTYPE --mountpoint "$VIEW/$name" 2>/dev/null)" = fuse.bindfs ]; then
      n=$((n + 1))
    else
      missing+=("$VIEW/$name")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    echo "PASS share.guest 已映射 $n 个共享文件夹到 $VIEW（读写）"
  else
    echo "FAIL share.guest 没有挂上：${missing[*]}"
    return 1
  fi
}

unmount_views() {
  local d
  for d in "$VIEW"/*; do
    [ -d "$d" ] || continue
    if mountpoint -q "$d"; then umount "$d" || umount -l "$d"; fi
    rmdir "$d" 2>/dev/null || true
  done
}

case "${1:-}" in
  apply)
    shift
    [ $# -ge 3 ] || { echo "FAIL share.guest 用法：apply <uid> <gid> <名字…>"; exit 1; }
    uid="$1" gid="$2"; shift 2
    [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || { echo "FAIL share.guest uid / gid 必须是数字"; exit 1; }
    for name in "$@"; do valid_name "$name" || { echo "FAIL share.guest 无效的名字：$name"; exit 1; }; done
    if ! command -v bindfs >/dev/null 2>&1; then
      # Lima 的 /etc/environment 可能带有宿主代理；已部署的 VM 安装包应经现有 TUN。
      unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
      export DEBIAN_FRONTEND=noninteractive
      apt-get install -y --no-install-recommends bindfs >&2 \
        || { apt-get update >&2 && apt-get install -y --no-install-recommends bindfs >&2; } \
        || { echo "FAIL share.guest 安装 bindfs 失败"; exit 1; }
    fi
    install -d -o root -g root -m 0755 /etc/ccvm /usr/local/lib/ccvm
    { printf '%s %s\n' "$uid" "$gid"; printf '%s\n' "$@"; } > "$LIST.tmp"
    chown root:root "$LIST.tmp"; chmod 0644 "$LIST.tmp"; mv -f "$LIST.tmp" "$LIST"
    cat > "$UP.tmp" <<'UPEOF'
#!/bin/bash
# 由 CCVM 安装：等 Lima 把 /mnt/ccvm-raw/<名字> 挂好，再用 bindfs 映射到 /home/cc/mac/<名字>。任何一步失败都以非 0 退出。
set -uo pipefail
LIST=/etc/ccvm/shares.list RAW=/mnt/ccvm-raw VIEW=/home/cc/mac
read -r uid gid < "$LIST" || exit 1
[[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || exit 1
install -d -o root -g root -m 0700 "$RAW" || exit 1
chown root:root "$RAW" && chmod 0700 "$RAW" || exit 1
install -d -o cc -g cc -m 0700 "$VIEW" || exit 1
chown cc:cc "$VIEW" && chmod 0700 "$VIEW" || exit 1
rc=0
while IFS= read -r name; do
  if ! [[ "$name" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || [ "$name" = . ] || [ "$name" = .. ]; then rc=1; continue; fi
  # Lima 的挂载由开机脚本完成，时间点不固定：最多等 120 秒
  for _ in $(seq 120); do mountpoint -q "$RAW/$name" && break; sleep 1; done
  if ! mountpoint -q "$RAW/$name"; then echo "没有等到 $RAW/$name" >&2; rc=1; continue; fi
  mountpoint -q "$VIEW/$name" && continue
  install -d -o cc -g cc -m 0700 "$VIEW/$name" || { rc=1; continue; }
  bindfs -o allow_other,subtype=bindfs --force-user=cc --force-group=cc --create-for-user="$uid" --create-for-group="$gid" \
    --chown-ignore --chgrp-ignore "$RAW/$name" "$VIEW/$name" || rc=1
done < <(tail -n +2 "$LIST")
exit "$rc"
UPEOF
    chown root:root "$UP.tmp"; chmod 0755 "$UP.tmp"; mv -f "$UP.tmp" "$UP"
    cat > "$UNIT" <<'UNITEOF'
[Unit]
Description=CCVM shared folders (bindfs views for cc)
After=local-fs.target remote-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=15min
ExecStart=/usr/local/lib/ccvm/shares-up
ExecStop=/bin/sh -c 'for d in /home/cc/mac/*; do [ -d "$d" ] || continue; if mountpoint -q "$d"; then umount "$d" || umount -l "$d"; fi; rmdir "$d" 2>/dev/null; done; true'

[Install]
WantedBy=multi-user.target
UNITEOF
    chmod 0644 "$UNIT"
    systemctl daemon-reload
    systemctl enable ccvm-shares.service >&2 || { echo "FAIL share.guest 启用 ccvm-shares.service 失败"; exit 1; }
    systemctl restart ccvm-shares.service >&2 || { echo "FAIL share.guest ccvm-shares.service 启动失败（journalctl -u ccvm-shares 查看）"; }
    verify "$@"
    ;;
  remove)
    systemctl disable --now ccvm-shares.service >/dev/null 2>&1 || true
    unmount_views
    rm -f "$UNIT" "$UP" "$LIST"
    systemctl daemon-reload
    if [ -n "$(findmnt -rn -o TARGET -t fuse.bindfs 2>/dev/null | grep "^$VIEW/" || true)" ]; then
      echo "FAIL share.guest $VIEW 下还有 bindfs 挂载"; exit 1
    fi
    echo "PASS share.guest 已移除共享文件夹的映射，$VIEW 下没有挂载"
    ;;
  verify)
    shift
    for name in "$@"; do valid_name "$name" || { echo "FAIL share.guest 无效的名字：$name"; exit 1; }; done
    verify "$@"
    ;;
  *) echo "FAIL share.guest 用法：apply <uid> <gid> <名字…> | remove | verify <名字…>"; exit 1 ;;
esac
