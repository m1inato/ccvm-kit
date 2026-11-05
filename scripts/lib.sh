#!/usr/bin/env bash
# 被其他脚本 source。只读宿主信息，不修改 Mac 的路由、DNS、系统代理或 Clash 设置。
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=17897
TRACE_URL="https://1.1.1.1/cdn-cgi/trace"   # 字面 IPv4（证书含 IP SAN），两端都不涉及 DNS 与 IPv6 差异
LIMA_MIN="2.1.0"
# VM 级别：guest/upgrade.sh 的步骤数（1：git、tmux；2：networkd 保留 TUN 策略路由 + TUN 看门狗）。
# install.sh 只覆盖第 1 级，setup.sh 装完再跑 upgrade.sh 到这个级别；App 低于它就提示更新
VM_LEVEL=2
# install.sh 自己做到的级别（它装了 git、tmux）
INSTALL_LEVEL=1

if [ -t 1 ]; then B=$'\033[1;34m'; G=$'\033[1;32m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; N=$'\033[0m'; else B= G= Y= R= N=; fi

# ---------------------------------------------------------------- 输出
# 默认是给人看的彩色文字。脚本收到 --json 时调用 json_on：fd 3 只写 NDJSON 事件（一行一个），
# 原 stdout 的其他内容（limactl、apt 等）一律改到 stderr。事件格式见 docs/events.md。
# 每个 JSON 运行以 end 事件结束；没有 end 的运行，调用方必须当作失败（不确定就当失败）。
CCVM_JSON=0
SCRIPT_ID="$(basename "$0" .sh)"

json_str() {  # 任意文本 → JSON 字符串字面量。只用 tr/sed/awk 的可移植写法，兼容 macOS Bash 3.2
  printf '%s' "$1" | LC_ALL=C tr '\t\r' '  ' | LC_ALL=C tr -d '\000-\010\013-\037\177' \
    | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | LC_ALL=C awk 'BEGIN { printf "%s", "\"" } { if (NR > 1) printf "%s", "\\n"; printf "%s", $0 } END { printf "%s", "\"" }'
}
ev() {  # ev <type> [,"key":value...]
  [ "$CCVM_JSON" = 1 ] || return 0
  printf '{"v":1,"type":"%s"%s}\n' "$1" "${2:-}" >&3
}
ev_end() {
  local rc="$1"
  [ "${CCVM_EVENT_CHILD:-0}" = 1 ] && return 0
  if [ "$rc" -eq 0 ]; then ev end ',"ok":true,"code":0'; else ev end ",\"ok\":false,\"code\":$rc"; fi
}
json_on() {
  [ "$CCVM_JSON" = 1 ] && return 0
  CCVM_JSON=1
  exec 3>&1 1>&2
  [ "${CCVM_EVENT_CHILD:-0}" = 1 ] || ev start ",\"script\":$(json_str "$SCRIPT_ID"),\"kit\":$(json_str "$(kit_version)")"
  trap 'ev_end $?' EXIT
}
kit_version() { tr -d ' \n' < "$KIT/VERSION" 2>/dev/null || echo unknown; }

info() { printf '%s==>%s %s\n' "$B" "$N" "$*"; ev log ",\"level\":\"info\",\"msg\":$(json_str "$*")"; }
ok()   { printf '%s  ✔%s %s\n' "$G" "$N" "$*"; ev log ",\"level\":\"info\",\"msg\":$(json_str "$*")"; }
warn() { printf '%s  !%s %s\n' "$Y" "$N" "$*" >&2; ev log ",\"level\":\"warn\",\"msg\":$(json_str "$*")"; }
die()  { printf '%s  ✘ %s%s\n' "$R" "$*" "$N" >&2; ev error ",\"msg\":$(json_str "$*")"; exit 1; }
# 带稳定 id 的检查项。pass/soft_fail 打印一行；pass_quiet 只发事件（命令行输出保持原样）；fail_check 发事件后终止。
pass()       { local id="$1"; shift; printf '%s  ✔%s %s\n' "$G" "$N" "$*"; ev check ",\"id\":\"$id\",\"ok\":true,\"msg\":$(json_str "$*")"; }
pass_quiet() { local id="$1"; shift; ev check ",\"id\":\"$id\",\"ok\":true,\"msg\":$(json_str "$*")"; }
soft_fail()  { local id="$1"; shift; printf '%s  ✘%s %s\n' "$R" "$N" "$*"; ev check ",\"id\":\"$id\",\"ok\":false,\"msg\":$(json_str "$*")"; }
fail_check() { local id="$1"; shift; ev check ",\"id\":\"$id\",\"ok\":false,\"msg\":$(json_str "$*")"; die "$*"; }
step()  { local id="$1"; shift; info "$*"; ev step ",\"id\":\"$id\",\"msg\":$(json_str "$*")"; }
value() { ev value ",\"key\":\"$1\",\"value\":$(json_str "$2")"; }

# 处理各脚本共用的参数；其余参数原样留给脚本。用法：parse_common_args "$@"; set -- "${REST[@]+"${REST[@]}"}"
parse_common_args() {
  REST=()
  local a
  for a in "$@"; do
    case "$a" in
      --json) json_on ;;
      *) REST+=("$a") ;;
    esac
  done
}

# 把 VM 内脚本的输出转成本地输出与事件。行格式：
#   PASS <id> <说明> / FAIL <id> <说明> / VALUE <key> <值> / EGRESS <ip> / 其他行原样作为详情
relay_guest() {
  local line kind rest id msg
  while IFS= read -r line; do
    case "$line" in
      PASS\ *|FAIL\ *)
        kind="${line%% *}"; rest="${line#* }"; id="${rest%% *}"; msg="${rest#* }"
        case "$id" in ""|*[!a-z0-9_.]*) id="guest.unknown"; msg="$rest" ;; esac
        [ "$msg" = "$rest" ] && [ "$id" != guest.unknown ] && msg="$id"
        if [ "$kind" = PASS ]; then pass "$id" "$msg"; else soft_fail "$id" "$msg"; fi
        ;;
      VALUE\ *)
        rest="${line#VALUE }"; id="${rest%% *}"; msg="${rest#* }"
        [ "$msg" = "$rest" ] && msg=""
        case "$id" in ""|*[!a-z0-9_]*) ;; *) value "$id" "$msg" ;; esac
        ;;
      EGRESS|EGRESS\ *) msg="${line#EGRESS}"; value vm_egress "${msg# }" ;;
      *)
        printf '      %s\n' "$line"
        ev log ",\"level\":\"detail\",\"msg\":$(json_str "$line")"
        ;;
    esac
  done
}

# 尽早打开 JSON 模式，让配置错误也能以事件报告。source 时 $* 就是调用脚本的参数。
case " $* " in *" --json "*) json_on ;; esac

# 本地配置只包含用户选择的实例名和路径，不写回发布模板。
# 显式 CCVM_* 环境变量 > 本地配置 > 默认值；不继承其他 Lima/Colima 的 LIMA_HOME。
load_local_config() {
  local config_file="${CCVM_CONFIG_FILE:-$KIT/config/local.env}"
  local VM_NAME=ccvm VM_HOME="$HOME/.lima-ccvm" STATE_DIR="$KIT/state"
  if [ -n "${CCVM_CONFIG_FILE:-}" ] || [ -e "$config_file" ]; then
    [ -f "$config_file" ] && [ -r "$config_file" ] || die "本地配置不可读：$config_file"
    . "$config_file" || die "本地配置加载失败：$config_file"
  fi
  VM="${CCVM_NAME:-$VM_NAME}"
  export LIMA_HOME="${CCVM_LIMA_HOME:-$VM_HOME}"
  STATE="${CCVM_STATE_DIR:-$STATE_DIR}"
  BASELINE="$STATE/expected-ip.txt"
  [[ "$VM" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "无效的 VM 名称：$VM"
  case "$LIMA_HOME" in /*) ;; *) die "Lima 目录必须是绝对路径：$LIMA_HOME" ;; esac
  case "$STATE" in /*) ;; *) die "状态目录必须是绝对路径：$STATE" ;; esac
}
load_local_config

ver_ge() {  # ver_ge 2.2.1 2.1.0 → 真
  awk -v a="$1" -v b="$2" 'BEGIN{split(a,x,".");split(b,y,".");for(i=1;i<=3;i++){if(x[i]+0>y[i]+0)exit 0;if(x[i]+0<y[i]+0)exit 1}exit 0}'
}

# Lima 每次加载实例（start / shell / list）都会把 $LIMA_HOME/_config/ 下这两个文件合并进配置，
# 其中的 mounts、networks、provision 会被追加，可能给 VM 挂上 Mac 目录、加网卡或在开机时以 root 跑脚本。
# 本方案的专用 LIMA_HOME 不应该有它们；存在就停止，而且每个脚本每次都检查，不只在创建时。
require_clean_lima_home() {
  local f found=()
  for f in default.yaml override.yaml; do
    [ -e "$LIMA_HOME/_config/$f" ] && found+=("$LIMA_HOME/_config/$f")
  done
  [ "${#found[@]}" -eq 0 ] || fail_check lima.no_global_config "发现 Lima 全局配置：${found[*]}。它们会被合并进 VM 配置（可能加挂载、网络或开机脚本）。检查内容后移走再继续。"
  pass_quiet lima.no_global_config "Lima 目录里没有全局覆盖配置（${LIMA_HOME}/_config）"
}

require_mac() {
  [ "$(uname -s)" = Darwin ] || fail_check host.macos_arm64 "请在 Mac 上运行"
  [ "$(uname -m)" = arm64 ] || fail_check host.macos_arm64 "当前终端运行在 Rosetta (x86_64) 下，请换原生 arm64 终端"
  pass_quiet host.macos_arm64 "Apple Silicon Mac，原生 arm64"
  command -v limactl >/dev/null || fail_check lima.version "未安装 Lima：brew install lima"
  local v; v="$(limactl --version | awk '{print $NF}')"; v="${v#v}"
  ver_ge "$v" "$LIMA_MIN" || fail_check lima.version "Lima $v 过旧，需要 ≥ ${LIMA_MIN}（VM 校时依赖它）：brew upgrade lima"
  pass_quiet lima.version "Lima ${v}（≥ ${LIMA_MIN}）"
  value lima_version "$v"
  require_clean_lima_home
}

trace_ip() { awk -F= '$1=="ip"{gsub(/\r/,"",$2); print $2}'; }

# Mac → Clash 专用入口 → 节点 的出口 IP。
# --noproxy '' 不能省：curl 的 NO_PROXY/no_proxy 即使在指定了 --proxy 时也会让请求绕过代理直连，
# 只有 --noproxy '' 能覆盖它（见 curl 手册 --noproxy 与 ENVIRONMENT 一节）。
host_ip() { curl -fsS --max-time 20 --noproxy '' --proxy "socks5h://127.0.0.1:$PORT" "$TRACE_URL" | trace_ip; }

vm_status() { limactl list --format '{{.Status}}' "$VM" 2>/dev/null || true; }
vm() { limactl shell --workdir=/ "$VM" "$@"; }
vm_script() { local f="$1"; shift; vm sudo bash -s -- "$@" < "$KIT/guest/$f"; }   # 把 guest/ 下的脚本经 stdin 交给 VM 内 root 执行
# 以 cc 身份、干净环境执行 guest/ 下的脚本（项目、Git 操作只用 cc，不让 root 在 cc 可写的仓库里跑 git）
vm_script_cc() {
  local f="$1"; shift
  vm sudo -u cc -H env -i HOME=/home/cc USER=cc LOGNAME=cc PATH=/home/cc/.local/bin:/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8 bash -s -- "$@" < "$KIT/guest/$f"
}

require_running() {
  local st; st="$(vm_status)"
  value vm_status "${st:-Missing}"
  [ "$st" = Running ] || fail_check vm.running "${1:-VM 未运行}（当前：${st:-不存在}）"
  pass_quiet vm.running "VM 运行中"
}
require_baseline() {
  local b
  b="$(baseline)" || fail_check baseline.present "缺少基线 ${BASELINE}：先运行 setup.sh"
  [[ "$b" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || fail_check baseline.present "基线文件内容不是 IPv4：${BASELINE}"
  pass_quiet baseline.present "出口基线 $b"
  value baseline "$b"
  printf '%s\n' "$b"
}

baseline() { [ -s "$BASELINE" ] && cat "$BASELINE"; }

# 打印所有监听 :$PORT 的本地地址，一行一个。
# 优先用 netstat：macOS 的 netstat 不需要 sudo 也能看到其他用户（包括以 root 运行的 Clash 内核）的监听。
listener_addrs() {
  local out=""
  if command -v netstat >/dev/null 2>&1; then
    # 本地地址形如 127.0.0.1.17897、::1.17897、*.17897、192.168.1.10.17897：最后一个点之后是端口
    out="$(netstat -an 2>/dev/null | awk -v p="$PORT" '$1 ~ /^tcp/ && $6 == "LISTEN" {
      n = split($4, a, "."); if (a[n] == p) print substr($4, 1, length($4) - length(a[n]) - 1) }' || true)"
  fi
  if [ -z "$out" ] && command -v lsof >/dev/null 2>&1; then
    # 退路：lsof 的 NAME 列形如 127.0.0.1:17897、[::1]:17897、*:17897
    out="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk -v p="$PORT" 'NR > 1 {
      for (i = 1; i <= NF; i++) if ($i ~ (":" p "$")) { s = $i; sub(":" p "$", "", s); gsub(/[][]/, "", s); print s } }' || true)"
  fi
  [ -n "$out" ] && sort -u <<<"$out"
}

# 专用入口的每一个监听地址都必须是 127.0.0.1 或 ::1；看不到监听、或无法确认时一律停止。
check_listener() {
  local addrs bad
  addrs="$(listener_addrs || true)"
  [ -n "$addrs" ] || fail_check listener.loopback_only "确认不了 :$PORT 的监听地址（netstat / lsof 都没有看到）。CCVM 自带核心没有在运行，或 Clash Verge 的扩展脚本没有生效；也可以用 sudo lsof -nP -iTCP:$PORT -sTCP:LISTEN 查看。无法确认时不继续。"
  bad="$(awk '$0 != "127.0.0.1" && $0 != "::1"' <<<"$addrs")"
  value listener_addrs "$(tr '\n' ' ' <<<"$addrs" | sed 's/ $//')"
  [ -z "$bad" ] || fail_check listener.loopback_only ":$PORT 还监听在非回环地址：$(tr '\n' ' ' <<<"$bad")。扩展脚本里必须是 listen: 127.0.0.1，并检查是否有其他程序占用了这个端口。"
  pass listener.loopback_only "专用入口只监听在回环地址（$(tr '\n' ' ' <<<"$addrs" | sed 's/ $//')）"
}

# ---------------------------------------------------------------- 共享文件夹
# 唯一来源：$STATE/shares.txt，一行一个 Mac 绝对路径；不存在或为空就是没有共享。
# 挂载名：路径最后一级目录名，[A-Za-z0-9._-] 以外的字符（按字节）换成 _，重名依次加 -2、-3。
# VM 里：Lima 的 virtiofs 挂在 /mnt/ccvm-raw/<名字>（父目录 0700 root），cc 看到的是 bindfs 映射的 /home/cc/mac/<名字>。
SHARE_RAW=/mnt/ccvm-raw
SHARE_VIEW=/home/cc/mac
share_list() {
  [ -f "$STATE/shares.txt" ] || return 0
  tr -d '\r' < "$STATE/shares.txt" | awk 'length($0) > 0'
}
share_names() {
  local p name n used="" cand
  while IFS= read -r p; do
    while [ "${p%/}" != "$p" ] && [ "$p" != / ]; do p="${p%/}"; done
    name="$(printf '%s' "${p##*/}" | LC_ALL=C sed 's/[^A-Za-z0-9._-]/_/g' | cut -c1-56)"
    case "$name" in ""|.|..) name=share ;; esac
    cand="$name"; n=1
    while printf '%s\n' "$used" | grep -qxF -- "$cand"; do n=$((n + 1)); cand="$name-$n"; done
    used="$used$cand"$'\n'
    printf '%s\n' "$cand"
  done < <(share_list)
}
# a 等于 b 或在 b 里面
path_within() { [ "$1" = "$2" ] || case "$1" in "${2%/}"/*) true ;; *) false ;; esac; }
real_dir() { (cd "$1" 2>/dev/null && pwd -P); }
# 可以共享就什么都不输出；不可以就输出一句原因。先求真实路径再判断，符号链接绕不过去。
share_path_problem() {
  local p="$1" real home s sreal
  case "$p" in /*) ;; *) echo "不是绝对路径：$p"; return 0 ;; esac
  case "$p" in *[[:cntrl:]]*) echo "路径里有控制字符：$p"; return 0 ;; esac
  [ -e "$p" ] || { echo "不存在：$p"; return 0; }
  [ -d "$p" ] || { echo "不是文件夹：$p"; return 0; }
  real="$(real_dir "$p")" || { echo "进不去这个文件夹：$p"; return 0; }
  home="$(real_dir "$HOME")" || home="$HOME"
  case "$real" in
    /|/Users|/Volumes|/System|/Library|/Applications|/private|/etc|/var|/usr|/opt|/tmp|/private/etc|/private/var|/private/tmp)
      echo "不能共享系统目录：$real"; return 0 ;;
  esac
  [ "$real" != "$home" ] || { echo "不能共享整个家目录：$real"; return 0; }
  case "$real" in "$home"/.*) echo "不能共享家目录下的隐藏目录：$real"; return 0 ;; esac
  # 敏感位置：不能等于、不能在里面、也不能包含。$STATE、$KIT 也算：否则 VM 能改写出口基线，或改写 Mac 上运行的脚本
  for s in "$home/Library" "$home/.ssh" "$home/.gnupg" "$home/.aws" "$home/.config" "$home/.kube" "$home/.docker" \
           "$LIMA_HOME" "$STATE" "$KIT"; do
    sreal="$(real_dir "$s")" || sreal="${s%/}"
    if path_within "$real" "$sreal"; then echo "在敏感位置里面：${real}（${sreal}）"; return 0; fi
    if path_within "$sreal" "$real"; then echo "包含敏感位置 ${sreal}：$real"; return 0; fi
  done
  return 0
}

# Lima 合并后的实际配置：不能有额外网卡；挂载位置的集合必须正好等于 share_list（多一个、少一个都不行），
# 而且每个允许的路径都要再过一遍 share_path_problem（防止有人手改 shares.txt）。
# --allow-missing 只给 setup.sh 用：新建的 VM 还没应用共享，缺挂载只提醒（多出来的照样失败）。
check_effective_lima_config() {
  local nets mounts want extra missing p prob n allow_missing=0
  [ "${1:-}" != --allow-missing ] || allow_missing=1
  nets="$(limactl list --format '{{len .Config.Networks}}' "$VM" 2>/dev/null || true)"
  [ "$nets" = 0 ] || fail_check lima.effective_config "VM 实际配置里有额外网络（networks = ${nets:-读不到}）。查看 $LIMA_HOME/$VM/lima.yaml。"
  mounts="$(limactl list --format '{{range .Config.Mounts}}{{.Location}}{{"\n"}}{{end}}' "$VM" 2>/dev/null)" \
    || fail_check lima.effective_config "读不到 VM 实际配置里的挂载。查看 $LIMA_HOME/$VM/lima.yaml。"
  mounts="$(printf '%s\n' "$mounts" | tr -d '\r' | awk 'length($0) > 0' | sed 's#\(.\)/*$#\1#' | LC_ALL=C sort -u)"
  want="$(share_list | sed 's#\(.\)/*$#\1#' | LC_ALL=C sort -u)"
  extra="$(LC_ALL=C comm -23 <(printf '%s\n' "$mounts" | awk 'length($0) > 0') <(printf '%s\n' "$want" | awk 'length($0) > 0'))"
  missing="$(LC_ALL=C comm -13 <(printf '%s\n' "$mounts" | awk 'length($0) > 0') <(printf '%s\n' "$want" | awk 'length($0) > 0'))"
  [ -z "$extra" ] || fail_check lima.effective_config "VM 实际配置里有没被允许的挂载：$(printf '%s\n' "$extra" | tr '\n' ' ')。允许的共享只来自 $STATE/shares.txt；查看 $LIMA_HOME/$VM/lima.yaml。"
  if [ -n "$missing" ] && [ "$allow_missing" = 1 ]; then
    warn "共享文件夹还没有挂进 VM：$(printf '%s\n' "$missing" | tr '\n' ' ')"
    want="$(LC_ALL=C comm -12 <(printf '%s\n' "$mounts" | awk 'length($0) > 0') <(printf '%s\n' "$want" | awk 'length($0) > 0'))"
    missing=""
  fi
  [ -z "$missing" ] || fail_check lima.effective_config "shares.txt 里的共享文件夹没有挂进 VM：$(printf '%s\n' "$missing" | tr '\n' ' ')。用 share.sh apply（或 App 的「应用并重启 VM」）重新应用。"
  n=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    prob="$(share_path_problem "$p")"
    [ -z "$prob" ] || fail_check lima.effective_config "挂进 VM 的共享文件夹不允许共享：$prob"
    n=$((n + 1))
  done <<<"$want"
  if [ "$n" -gt 0 ]; then
    pass lima.effective_config "VM 实际配置：无额外网络，挂载只有允许的 $n 个共享文件夹"
  else
    pass lima.effective_config "VM 实际配置：无挂载、无额外网络"
  fi
}
