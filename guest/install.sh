#!/usr/bin/env bash
# 在 VM 内以 root 运行（由 Mac 端 scripts/setup.sh 复制并调用）。可重复执行。
# 顺序：先完成所有下载（显式走 Clash 专用入口）→ 写配置并校验 → 启用防火墙 → 启动 TUN → 以 cc 身份验收。
# 防火墙启用后本脚本不再访问网络，所以中途失败可以直接重跑。
set -euo pipefail

STAGE="${1:?用法: install.sh <包含配置文件的目录>}"
PROXY_URL="http://192.168.5.2:17897"
TRACE_URL="https://1.1.1.1/cdn-cgi/trace"
SB_SERIES_RE='^1\.14\.[0-9]+'   # 配置按 sing-box 1.14 编写；只接受 1.14.x
PKGS=(nftables curl ca-certificates tcpdump dnsutils git tmux)

log() { printf '\033[1;34m[vm]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[vm] 错误:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "需要 root"
[ "$(uname -m)" = aarch64 ] || die "只支持 ARM64 客体"
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "只支持 Ubuntu 24.04（当前：${PRETTY_NAME:-unknown}）"
for f in sing-box.json firewall.nft.in lockdown.nft; do [ -r "$STAGE/$f" ] || die "缺少 $STAGE/$f"; done

if [ -e /var/lib/ccvm/installed ]; then
  log "已安装过，跳过（要重装请重建 VM）"
  exit 0
fi

as_cc() { runuser -u cc -- env -i HOME=/home/cc USER=cc PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 "$@"; }
firewall_loaded() { nft list table inet ccvm >/dev/null 2>&1; }
# 注意：在 pipefail 下不用「cmd | grep -q」，grep 提前退出会让 cmd 收到 SIGPIPE 而误判失败
sb_ok() { command -v sing-box >/dev/null 2>&1 || return 1; local v; v="$(sing-box version 2>/dev/null)" || return 1; [[ "$(awk 'NR==1{print $3}' <<<"$v")" =~ $SB_SERIES_RE ]]; }
main_rules_loaded() { local r; r="$(nft list chain inet ccvm output 2>/dev/null)" || return 1; [[ "$r" == *"dport 17897"* ]]; }
pkgs_ok() { local p; for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || return 1; done; }

# ---------------------------------------------------------------- 1. 下载
if pkgs_ok && sb_ok; then
  log "依赖已就绪：$(sing-box version | awk 'NR==1')"
else
  firewall_loaded && die "防火墙已启用但依赖不完整；新 VM 尚无数据，最简单的处理是重建（见 README「删除与重建」）"
  log "检查 VM → ${PROXY_URL} 链路"
  # --noproxy ''：NO_PROXY/no_proxy 即使在指定 --proxy 时也会让 curl 直连，必须显式覆盖
  curl -fsS --max-time 20 --noproxy '' --proxy "$PROXY_URL" "$TRACE_URL" >/dev/null \
    || die "VM 无法经 ${PROXY_URL} 访问外网：检查 Clash 扩展脚本是否生效、节点是否可用"

  APT=(env -u no_proxy -u NO_PROXY apt-get -y -o "Acquire::http::Proxy=$PROXY_URL" -o "Acquire::https::Proxy=$PROXY_URL"
       -o Acquire::Retries=3 -o DPkg::Lock::Timeout=600)
  export DEBIAN_FRONTEND=noninteractive

  log "安装基础包（经专用入口）"
  "${APT[@]}" update
  "${APT[@]}" install --no-install-recommends "${PKGS[@]}"

  log "添加 SagerNet 官方签名 APT 源"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL --max-time 30 --noproxy '' --proxy "$PROXY_URL" https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
  chmod 0644 /etc/apt/keyrings/sagernet.asc
  cat > /etc/apt/sources.list.d/sagernet.sources <<'EOF'
Types: deb
URIs: https://deb.sagernet.org/
Suites: *
Components: *
Enabled: yes
Signed-By: /etc/apt/keyrings/sagernet.asc
EOF
  "${APT[@]}" update
  sb_ver="$(apt-cache madison sing-box | awk '{print $3}' | grep -E "$SB_SERIES_RE" | sort -V | tail -n1 || true)"
  [ -n "$sb_ver" ] || die "仓库里没有 sing-box 1.14.x（可能已只剩更新的大版本）。不要直接换版本：先按 sing-box 迁移文档核对 config/sing-box.json"
  log "安装 sing-box $sb_ver 并 hold"
  # 官方包自带的 sing-box.service 会读取 /etc/sing-box/config.json（示例是一个监听 :: 的 Shadowsocks 服务端），
  # 安装前就屏蔽，保证它任何时候都不会被启动；本方案使用自己的 ccvm-tun.service。
  systemctl mask sing-box.service >/dev/null
  "${APT[@]}" install "sing-box=$sb_ver"
  apt-mark hold sing-box >/dev/null
  sb_ok || die "sing-box 版本校验失败"
fi

id sing-box >/dev/null 2>&1 || die "缺少 sing-box 系统用户（应由官方 deb 的 sysusers 创建）"
SBUID="$(id -u sing-box)"
[ "$SBUID" -gt 0 ] || die "sing-box UID 异常"

# ---------------------------------------------------------------- 2. 写配置并离线校验
log "写入 /etc/ccvm 并校验"
install -d -m 0755 /etc/ccvm /var/lib/ccvm
install -m 0640 -o root -g sing-box "$STAGE/sing-box.json" /etc/ccvm/sing-box.json
sed "s/@SBUID@/$SBUID/g" "$STAGE/firewall.nft.in" > /etc/ccvm/firewall.nft
chmod 0644 /etc/ccvm/firewall.nft
install -m 0644 "$STAGE/lockdown.nft" /etc/ccvm/lockdown.nft
grep -q '@SBUID@' /etc/ccvm/firewall.nft && die "防火墙模板渲染失败"
runuser -u sing-box -- sing-box check -c /etc/ccvm/sing-box.json
nft -c -f /etc/ccvm/firewall.nft
nft -c -f /etc/ccvm/lockdown.nft

# 发行版自带的服务会加载另一套配置，屏蔽掉。nftables.service 的 ExecStop 是 `nft flush ruleset`，
# 先用 drop-in 清掉它再停止，避免重跑时把已加载的 ccvm 表一起清空。
install -d -m 0755 /etc/systemd/system/nftables.service.d
printf '[Service]\nExecStop=\n' > /etc/systemd/system/nftables.service.d/ccvm-no-flush.conf
systemctl daemon-reload
for unit in sing-box.service nftables.service; do
  if systemctl is-active --quiet "$unit"; then systemctl stop "$unit"; fi
  systemctl disable "$unit" >/dev/null 2>&1 || true
  systemctl mask "$unit" >/dev/null
done

# ---------------------------------------------------------------- 3. 无 sudo 的工作用户
if ! id cc >/dev/null 2>&1; then
  log "创建用户 cc（无 sudo、密码锁定）"
  useradd --create-home --user-group --shell /bin/bash cc
fi
passwd -l cc >/dev/null
for g in sudo admin adm lxd docker; do gpasswd -d cc "$g" >/dev/null 2>&1 || true; done
chmod 0700 /home/cc
install -d -o cc -g cc -m 0700 /home/cc/work
cat > /etc/profile.d/ccvm.sh <<'EOF'
# ccvm：VM 内统一走透明代理，不需要也不应设置代理变量
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
EOF

# Lima 默认通过宿主 DNS 解析 VM 自身的主机名；切换到公网 DoH 后需要本地映射，
# 否则每次 sudo 都会报 unable to resolve host。
if ! getent -s files hosts "$(hostname)" >/dev/null; then
  printf '127.0.1.1 %s\n' "$(hostname)" >> /etc/hosts
fi

# ---------------------------------------------------------------- 4. systemd 单元
cat > /etc/systemd/system/ccvm-firewall.service <<'EOF'
[Unit]
Description=ccvm fail-closed firewall
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target shutdown.target
After=local-fs.target systemd-sysctl.service
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
# 主规则失败时退到锁定规则（只留 SSH/DHCP），仍然断网但可以登录修复；两者都失败则网络服务不启动。
ExecStart=/bin/sh -c '/usr/sbin/nft -f /etc/ccvm/firewall.nft || { echo "ccvm: 主防火墙加载失败，进入锁定模式" >&2; /usr/sbin/nft -f /etc/ccvm/lockdown.nft; }'
# 故意没有 ExecStop：停止该服务不会放开防火墙。

[Install]
WantedBy=multi-user.target
EOF

install -d -m 0755 /etc/systemd/system/systemd-networkd.service.d
cat > /etc/systemd/system/systemd-networkd.service.d/ccvm.conf <<'EOF'
[Unit]
Requires=ccvm-firewall.service
After=ccvm-firewall.service
EOF

cat > /etc/systemd/system/ccvm-tun.service <<'EOF'
[Unit]
Description=ccvm sing-box TUN -> Mac Clash dedicated listener (192.168.5.2:17897)
Requires=ccvm-firewall.service
After=ccvm-firewall.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sing-box
Group=sing-box
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
StateDirectory=ccvm-sing-box
ExecStartPre=/usr/bin/sing-box check -c /etc/ccvm/sing-box.json
ExecStart=/usr/bin/sing-box -D /var/lib/ccvm-sing-box run -c /etc/ccvm/sing-box.json
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/sysctl.d/90-ccvm.conf <<'EOF'
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
# 防止 cc 通过 TIOCSTI 向管理员终端注入按键（内核不支持该项时忽略）
-dev.tty.legacy_tiocsti = 0
EOF

systemctl daemon-reload

# ---------------------------------------------------------------- 5. 切换（此后不再访问网络）
log "启用防火墙（从这里开始 VM 只能经 TUN 出网）"
systemctl enable ccvm-firewall.service >/dev/null
systemctl restart ccvm-firewall.service
main_rules_loaded || die "主防火墙未加载（处于锁定模式？）：journalctl -u ccvm-firewall"
systemctl restart systemd-sysctl.service

log "DNS 改为 172.31.255.2（由 sing-box 经代理做 DoH）"
systemctl disable --now systemd-resolved.service >/dev/null 2>&1 || true
rm -f /etc/resolv.conf
printf 'nameserver 172.31.255.2\noptions timeout:2 attempts:2\n' > /etc/resolv.conf
chmod 0644 /etc/resolv.conf

log "启动 TUN"
systemctl enable ccvm-tun.service >/dev/null
systemctl restart ccvm-tun.service
for _ in $(seq 1 20); do ip link show sb-tun >/dev/null 2>&1 && break; sleep 1; done
ip link show sb-tun >/dev/null 2>&1 || { journalctl -u ccvm-tun -n 50 --no-pager >&2; die "TUN 未就绪"; }

# ---------------------------------------------------------------- 6. 以 cc 身份验收
ip_out=""
for _ in 1 2 3; do
  ip_out="$(as_cc curl -fsS --max-time 25 "$TRACE_URL" 2>/dev/null | awk -F= '$1=="ip"{print $2}')" && [ -n "$ip_out" ] && break
  sleep 3
done
[ -n "$ip_out" ] || { journalctl -u ccvm-tun -n 50 --no-pager >&2; die "cc 经 TUN 访问外网失败"; }
as_cc getent ahostsv4 api.anthropic.com >/dev/null || die "DNS（DoH 经代理）解析失败"
touch /var/lib/ccvm/installed
log "完成。VM 出口 IP：$ip_out"
