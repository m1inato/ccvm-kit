#!/usr/bin/env bash
# 被其他脚本 source。只读宿主信息，不修改 Mac 的路由、DNS、系统代理或 Clash 设置。
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=17897
TRACE_URL="https://1.1.1.1/cdn-cgi/trace"   # 字面 IPv4（证书含 IP SAN），两端都不涉及 DNS 与 IPv6 差异
LIMA_MIN="2.1.0"

if [ -t 1 ]; then B=$'\033[1;34m'; G=$'\033[1;32m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; N=$'\033[0m'; else B= G= Y= R= N=; fi
info() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s  ✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  !%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s  ✘ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

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
  [ "${#found[@]}" -eq 0 ] || die "发现 Lima 全局配置：${found[*]}。它们会被合并进 VM 配置（可能加挂载、网络或开机脚本）。检查内容后移走再继续。"
}

require_mac() {
  [ "$(uname -s)" = Darwin ] || die "请在 Mac 上运行"
  [ "$(uname -m)" = arm64 ] || die "当前终端运行在 Rosetta (x86_64) 下，请换原生 arm64 终端"
  command -v limactl >/dev/null || die "未安装 Lima：brew install lima"
  local v; v="$(limactl --version | awk '{print $NF}')"; v="${v#v}"
  ver_ge "$v" "$LIMA_MIN" || die "Lima $v 过旧，需要 ≥ ${LIMA_MIN}（VM 校时依赖它）：brew upgrade lima"
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
  [ -n "$addrs" ] || die "确认不了 :$PORT 的监听地址（netstat / lsof 都没有看到）。扩展脚本可能没有生效；也可以用 sudo lsof -nP -iTCP:$PORT -sTCP:LISTEN 查看。无法确认时不继续。"
  bad="$(awk '$0 != "127.0.0.1" && $0 != "::1"' <<<"$addrs")"
  [ -z "$bad" ] || die ":$PORT 还监听在非回环地址：$(tr '\n' ' ' <<<"$bad")。扩展脚本里必须是 listen: 127.0.0.1，并检查是否有其他程序占用了这个端口。"
  ok "专用入口只监听在回环地址（$(tr '\n' ' ' <<<"$addrs" | sed 's/ $//')）"
}

# Lima 合并后的实际配置里不能有挂载和额外网卡（防止 _config 之外的途径改了实例配置）
check_effective_lima_config() {
  local got
  got="$(limactl list --format '{{len .Config.Mounts}} {{len .Config.Networks}}' "$VM" 2>/dev/null || true)"
  [ "$got" = "0 0" ] || die "VM 实际配置里有挂载或额外网络（mounts networks = ${got:-读不到}）。查看 $LIMA_HOME/$VM/lima.yaml。"
  ok "VM 实际配置：无挂载、无额外网络"
}
