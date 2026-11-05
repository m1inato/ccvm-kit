#!/usr/bin/env bash
# 浏览 VM 里 cc 的家目录、传文件。所有 VM 内操作都以 cc 身份进行，只能碰 /home/cc 下面。
# 用法：files.sh list|mkdir|rm <VM路径> [--json]
#       files.sh push <Mac源路径> <VM目标目录> [--json]     上传普通文件或文件夹（顶层不能是符号链接）
#       files.sh pull <VM文件> <Mac目标文件> [--force] [--json]  只下载单个普通文件（不支持目录，也不跟符号链接）
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
set -- "${REST[@]+"${REST[@]}"}"
USAGE="用法：files.sh list|mkdir|rm <VM路径> | push <Mac源路径> <VM目标目录> | pull <VM文件> <Mac目标文件> [--force]"
[ $# -ge 1 ] || die "$USAGE"
US=$'\x1f'
num() { case "$1" in ''|*[!0-9]*) printf 0 ;; *) printf '%s' "$1" ;; esac; }

# VM 路径先在宿主端校验：/home/cc 或 /home/cc/ 开头，没有 .. 段，没有换行。VM 内脚本还会按真实路径再查一遍。
vm_path() {
  case "$1" in *$'\n'*|*$'\r'*) fail_check files.path "VM 路径里不能有换行" ;; esac
  case "$1" in /home/cc|/home/cc/*) ;; *) fail_check files.path "只能访问 /home/cc 下面：$1" ;; esac
  case "$1/" in */../*) fail_check files.path "VM 路径里不能有 ..：$1" ;; esac
  pass_quiet files.path "VM 路径：$1"
}

# 把 VM 内脚本的输出转成事件：FILE 行变成 item，其余交给 relay_guest
relay_files() {
  local kind name type size mtime n=0
  while IFS="$US" read -r kind name type size mtime; do
    if [ "$kind" = FILE ]; then
      case "$type" in file|dir|link|other) ;; *) type=other ;; esac
      n=$((n + 1))
      [ "$CCVM_JSON" = 1 ] || printf '  %-5s %12s  %s\n' "$type" "$(num "$size")" "$name"
      ev item ",\"kind\":\"file\",\"name\":$(json_str "$name"),\"file_type\":\"$type\",\"size\":$(num "$size"),\"mtime\":$(num "$mtime")"
      continue
    fi
    printf '%s\n' "$kind" | relay_guest
  done
}

op="$1"; shift
force=0
if [ "$op" = pull ]; then
  args=()
  for a in "$@"; do if [ "$a" = --force ]; then force=1; else args+=("$a"); fi; done
  set -- "${args[@]+"${args[@]}"}"
fi
case "$op" in
  list|mkdir|rm) [ $# -eq 1 ] || die "$USAGE"; vm_path "$1" ;;
  push) [ $# -eq 2 ] || die "$USAGE"; vm_path "$2" ;;
  pull) [ $# -eq 2 ] || die "$USAGE"; vm_path "$1" ;;
  *) die "未知操作：${op}（${USAGE}）" ;;
esac
require_mac
require_running

case "$op" in
  list)
    rc=0; vm_script_cc files.sh list "$1" | relay_files || rc=$?
    [ "$rc" -eq 0 ] || die "没能列出 $1"
    ;;
  mkdir|rm)
    rc=0; vm_script_cc files.sh "$op" "$1" | relay_guest || rc=$?
    [ "$rc" -eq 0 ] || die "没有完成：$op $1"
    ;;
  push)
    src="$1" dest="$2"
    case "$src" in /*) ;; *) fail_check files.push "Mac 源路径必须是绝对路径：$src" ;; esac
    [ ! -L "$src" ] || fail_check files.push "不上传符号链接本身：$src"
    [ -f "$src" ] || [ -d "$src" ] || fail_check files.push "只能上传普通文件或文件夹：$src"
    base="$(basename "$src")"
    step files.push "检查 VM 里的目标目录"
    rc=0; vm_script_cc files.sh check-dir "$dest" | relay_guest || rc=$?
    [ "$rc" -eq 0 ] || die "VM 里的目标不是 cc 家目录下的文件夹：$dest"
    step files.push "上传 $base → $dest"
    COPYFILE_DISABLE=1 tar -C "$(dirname "$src")" -cf - "$base" | vm sudo -u cc -H tar --no-same-owner -xf - -C "$dest" \
      || fail_check files.push "上传没有完成：$base"
    pass files.push "已上传 $base 到 $dest"
    ;;
  pull)
    src="$1" dst="$2"
    case "$dst" in /*) ;; *) fail_check files.pull "Mac 目标必须是绝对路径：$dst" ;; esac
    [ -d "$(dirname "$dst")" ] || fail_check files.pull "Mac 上的目标文件夹不存在：$(dirname "$dst")"
    [ ! -d "$dst" ] || fail_check files.pull "Mac 上的目标是文件夹：$dst"
    if [ -e "$dst" ] || [ -L "$dst" ]; then
      [ "$force" = 1 ] || fail_check files.pull "Mac 上已经有这个文件：${dst}（覆盖要加 --force）"
    fi
    out="$(vm_script_cc files.sh check-file "$src")" || { printf '%s\n' "$out" | relay_guest; die "不能下载：$src"; }
    printf '%s\n' "$out" | relay_guest
    real="$(printf '%s\n' "$out" | awk '$1=="VALUE" && $2=="path" { sub(/^VALUE path /, ""); print; exit }')"
    case "$real" in /home/cc/*) ;; *) fail_check files.pull "VM 没有给出文件的真实路径" ;; esac
    tmp="$(mktemp "$(dirname "$dst")/.ccvm-pull.XXXXXX")" || fail_check files.pull "不能在 $(dirname "$dst") 里建临时文件"
    if ! vm sudo -u cc -H cat -- "$real" > "$tmp"; then
      rm -f "$tmp"
      fail_check files.pull "读取 VM 里的文件失败：$src"
    fi
    mv -f "$tmp" "$dst" || { rm -f "$tmp"; fail_check files.pull "写入失败：$dst"; }
    pass files.pull "已下载 $src 到 $dst"
    ;;
esac
