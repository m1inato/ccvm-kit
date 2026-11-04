#!/usr/bin/env bash
# VM 内以 cc 身份运行（Mac 端经 stdin 传入：sudo -u cc env -i ... bash -s -- <操作> <路径>）。
# 每个操作先求真实路径（realpath -m，会解开符号链接），必须仍在 /home/cc 下，否则 FAIL files.path：拦住 ~/x -> /etc 这类链接。
#   list <目录>        每个条目一行 FILE␟名字␟类型(file|dir|link|other)␟大小␟修改时间，目录在前；VALUE path <真实路径>
#   mkdir <目录>       mkdir -p
#   rm <路径>          rm -rf --one-file-system（删的是链接本身，不是它指向的东西）；不能删 /home/cc、/home/cc/mac、/home/cc/mac/<名字>
#   check-dir <目录>   上传前：存在、是目录、在家目录下
#   check-file <文件>  下载前：是普通文件、不是符号链接、在家目录下；VALUE path <真实路径>
set -uo pipefail
US=$'\x1f'
MAX_ENTRIES=5000
[ "$(id -un)" = cc ] || { echo "FAIL files.path 必须以 cc 身份运行"; exit 1; }
op="${1:-}" arg="${2:-}"
[ -n "$op" ] && [ -n "$arg" ] || { echo "FAIL files.path 用法：<操作> <路径>"; exit 1; }

in_home() { case "$1" in /home/cc|/home/cc/*) return 0 ;; *) return 1 ;; esac; }
resolve() {
  local r
  r="$(realpath -m -- "$1")" || return 1
  in_home "$r" || return 1
  printf '%s\n' "$r"
}
protected() { case "$1" in /home/cc|/home/cc/mac) return 0 ;; /home/cc/mac/*/*) return 1 ;; /home/cc/mac/*) return 0 ;; *) return 1 ;; esac; }

if [ "$op" = rm ]; then
  [ "$(realpath -m -- "$arg")" != /home/cc ] || { echo "FAIL files.rm 不能删 /home/cc"; exit 1; }
  # 父目录求真实路径，最后一级保留原样：删符号链接时删的是链接
  parent="$(resolve "$(dirname -- "$arg")")" || { echo "FAIL files.path 不在 /home/cc 下：$arg"; exit 1; }
  base="$(basename -- "$arg")"
  case "$base" in .|..|"") echo "FAIL files.rm 不能删：$arg"; exit 1 ;; esac
  target="${parent%/}/$base"
  in_home "$target" || { echo "FAIL files.path 不在 /home/cc 下：$arg"; exit 1; }
  if protected "$target" || { [ ! -L "$target" ] && protected "$(realpath -m -- "$target")"; }; then
    echo "FAIL files.rm 不能删 $target"; exit 1
  fi
  [ -e "$target" ] || [ -L "$target" ] || { echo "FAIL files.rm 不存在：$target"; exit 1; }
  rm -rf --one-file-system -- "$target" || { echo "FAIL files.rm 没有删干净：$target"; exit 1; }
  echo "PASS files.rm 已删除 $target"
  exit 0
fi

real="$(resolve "$arg")" || { echo "FAIL files.path 真实路径不在 /home/cc 下：$arg"; exit 1; }
case "$op" in
  list)
    [ -d "$real" ] || { echo "FAIL files.list 不是文件夹：$arg"; exit 1; }
    echo "VALUE path $real"
    dirs="" others="" n=0
    while IFS=$'\t' read -r -d '' t size mtime name; do
      n=$((n + 1))
      [ "$n" -le "$MAX_ENTRIES" ] || continue
      case "$t" in d) type=dir ;; f) type=file ;; l) type=link ;; *) type=other ;; esac
      name="${name//[$'\x1f\r\n']/}"
      line="FILE$US$name$US$type$US$size$US${mtime%%.*}"
      if [ "$type" = dir ]; then dirs+="$line"$'\n'; else others+="$line"$'\n'; fi
    done < <(find "$real" -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%T@\t%f\0' 2>/dev/null | sort -z -t $'\t' -k4)
    printf '%s%s' "$dirs" "$others"
    [ "$n" -le "$MAX_ENTRIES" ] || echo "VALUE truncated $MAX_ENTRIES"
    echo "PASS files.list 列出 $n 项：$real"
    ;;
  mkdir)
    mkdir -p -- "$real" || { echo "FAIL files.mkdir 没能新建：$real"; exit 1; }
    echo "PASS files.mkdir 已新建 $real"
    ;;
  check-dir)
    [ -d "$real" ] || { echo "FAIL files.push 目标不是文件夹：$arg"; exit 1; }
    [ -w "$real" ] || { echo "FAIL files.push 目标文件夹不能写：$real"; exit 1; }
    echo "VALUE path $real"
    echo "PASS files.push 目标文件夹可写：$real"
    ;;
  check-file)
    [ ! -L "$arg" ] || { echo "FAIL files.pull 不下载符号链接：$arg"; exit 1; }
    [ -f "$real" ] && [ ! -L "$real" ] || { echo "FAIL files.pull 只能下载普通文件：$arg"; exit 1; }
    echo "VALUE path $real"
    echo "PASS files.pull 可以下载：$real"
    ;;
  *) echo "FAIL files.path 未知操作：$op"; exit 1 ;;
esac
