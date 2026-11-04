#!/usr/bin/env bash
# 「Claude 做完了」字幕用的 Claude Code hook：安装、移除、查看。可选功能，和网络隔离无关。
# hook 放在 VM 里 root 所有的 /etc/claude-code/managed-settings.d/50-ccvm.json，cc（也就是 Claude）改不了。
# 用法：hooks.sh enable|disable|status [--json]
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
set -- "${REST[@]+"${REST[@]}"}"
[ $# -eq 1 ] || die "用法：hooks.sh enable|disable|status [--json]"
case "$1" in enable|disable|status) ;; *) die "未知操作：$1" ;; esac
require_mac
require_running
rc=0; vm_script hooks.sh "$1" | relay_guest || rc=$?
[ "$rc" -eq 0 ] || die "hook 操作没有完成"
