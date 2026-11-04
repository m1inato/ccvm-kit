#!/usr/bin/env bash
# VM 里 ~/work 下的项目：列出、克隆，以及 Claude Code 是否已安装。所有 Git 操作都以 cc 身份在 VM 内执行。
# 用法：workspace.sh list|claude [--json]
#       workspace.sh clone <git 地址> [--json]
#       workspace.sh kill-session <会话名> [--json]
#       workspace.sh events <偏移|end> [--json]     hook 记下的 Claude 事件（「做完了」字幕用）
# 克隆只接受 https://主机/路径、ssh://git@主机/路径、git@主机:路径；不接受地址里带账号或令牌。
# 私有仓库的凭据由你自己在 VM 的 cc 用户里配置（gh auth / SSH 密钥），App 不经手。
. "$(dirname "$0")/lib.sh"
parse_common_args "$@"
set -- "${REST[@]+"${REST[@]}"}"
[ $# -ge 1 ] || die "用法：workspace.sh list|claude|clone <git 地址>"
US=$'\x1f'

valid_git_url() {
  local re_https='^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$'
  local re_ssh='^ssh://git@[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$'
  local re_scp='^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$'
  [[ "$1" =~ $re_https ]] || [[ "$1" =~ $re_ssh ]] || [[ "$1" =~ $re_scp ]]
}
num() { case "$1" in ''|*[!0-9]*) printf 0 ;; *) printf '%s' "$1" ;; esac; }

relay_projects() {
  local kind name branch dirty ahead behind updated subject remote sessions since n=0 s=0
  while IFS="$US" read -r kind name branch dirty ahead behind updated subject remote sessions since; do
    if [ "$kind" = SESSION ]; then
      # 字段复用：name=会话名 branch=创建时间 dirty=接入数 ahead=目录
      case "$name" in ""|*[!A-Za-z0-9_-]*) continue ;; esac
      s=$((s + 1))
      proj="${ahead#/home/cc/work/}"; proj="${proj%%/*}"
      [ "$proj" != "$ahead" ] || proj=""
      ev item ",\"kind\":\"session\",\"name\":$(json_str "$name"),\"created\":$(num "$branch"),\"attached\":$(num "$dirty"),\"project\":$(json_str "$proj")"
      continue
    fi
    if [ "$kind" = CLAUDE ]; then
      # 字段复用：name=时间 branch=事件 dirty=目录 ahead=通知类型 behind=通知文字
      case "$branch" in Stop|Notification) ;; *) continue ;; esac
      proj="${dirty#/home/cc/work/}"; proj="${proj%%/*}"
      [ "$proj" != "$dirty" ] || proj=""
      case "$proj" in *[!A-Za-z0-9._-]*) proj="" ;; esac
      ev item ",\"kind\":\"claude_event\",\"t\":$(num "$name"),\"event\":\"$branch\",\"project\":$(json_str "$proj"),\"notification\":$(json_str "$ahead"),\"message\":$(json_str "$behind")"
      continue
    fi
    if [ "$kind" != PROJECT ]; then
      printf '%s\n' "$kind" | relay_guest
      continue
    fi
    n=$((n + 1))
    printf '  %-24s %-20s 改动 %-4s %s\n' "$name" "$branch" "$(num "$dirty")" \
      "$([ "$(num "$sessions")" -gt 0 ] && echo "Claude 运行中" || true)"
    ev item ",\"kind\":\"project\",\"name\":$(json_str "$name"),\"branch\":$(json_str "$branch"),\"dirty\":$(num "$dirty"),\"ahead\":$(num "$ahead"),\"behind\":$(num "$behind"),\"updated\":$(num "$updated"),\"subject\":$(json_str "$subject"),\"remote\":$(json_str "$remote"),\"claude_sessions\":$(num "$sessions"),\"claude_since\":$(num "$since")"
  done
  value project_count "$n"
  value session_count "$s"
}

require_mac
require_running
case "$1" in
  list)
    [ $# -eq 1 ] || die "list 不带参数"
    info "~/work 下的项目"
    value vm_level_target "$VM_LEVEL"
    rc=0; vm_script_cc workspace.sh list | relay_projects || rc=$?
    [ "$rc" -eq 0 ] || die "读取项目列表失败"
    ;;
  claude)
    [ $# -eq 1 ] || die "claude 不带参数"
    rc=0; vm_script_cc workspace.sh claude | relay_guest || rc=$?
    [ "$rc" -eq 0 ] || die "Claude Code 还没有安装"
    ;;
  clone)
    [ $# -eq 2 ] || die "用法：workspace.sh clone <git 地址>"
    url="$2"
    valid_git_url "$url" || fail_check project.url "不支持的 Git 地址：只接受 https://主机/路径、ssh://git@主机/路径、git@主机:路径，且不能带账号或令牌"
    pass_quiet project.url "Git 地址格式正确"
    info "在 VM 里克隆（以 cc 身份，经专用出口）"
    rc=0; vm_script_cc workspace.sh clone "$url" | relay_guest || rc=$?
    [ "$rc" -eq 0 ] || die "克隆失败（私有仓库需要先在 VM 的 cc 用户里配置凭据）"
    ;;
  events)
    [ $# -eq 2 ] || die "用法：workspace.sh events <偏移|end>"
    case "$2" in end|[0-9]*) ;; *) die "偏移必须是数字或 end" ;; esac
    case "$2" in *[!0-9]*) [ "$2" = end ] || die "偏移必须是数字或 end" ;; esac
    rc=0; vm_script_cc workspace.sh events "$2" | relay_projects >/dev/null || rc=$?
    [ "$rc" -eq 0 ] || die "读取 Claude 事件失败"
    ;;
  kill-session)
    [ $# -eq 2 ] || die "用法：workspace.sh kill-session <会话名>"
    [[ "$2" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || fail_check session.kill "无效的会话名：$2"
    rc=0; vm_script_cc workspace.sh kill-session "$2" | relay_guest || rc=$?
    [ "$rc" -eq 0 ] || die "没能结束会话 $2"
    ;;
  *) die "未知操作：$1" ;;
esac
