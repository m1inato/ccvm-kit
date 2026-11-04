# 设计与审计背景

本页保留 v2.1 原始套件的设计说明；历史源码核对与模拟测试记录见 [审计归档](audit-v2.1.md)。当前版本可复现的检查和实机验证范围见 [验证说明](../verification/RESULTS.md)。

## v2.1：本轮审计修复

四项审计意见都在代码和桩环境里复现过，确实存在。修复前后的对照见 `verification/RESULTS.md` 第 6 节。

| # | 问题 | 怎么会出事 | v2.1 的处理 |
|---|---|---|---|
| A | Mac 出口检查可能绕过专用入口 | curl 遇到 `NO_PROXY` / `no_proxy` 匹配时会忽略 `--proxy` 直连。终端里有 `NO_PROXY='*'`（不少开发环境会设）时，`host_ip` 拿到的是 Mac 本地出口；全新部署时这个 IP 还会被**记成基线** | `host_ip` 和 VM 安装脚本里两个显式代理 curl 都加 `--noproxy ''`；apt 去掉 `no_proxy` 后再跑；断流测试的直连探针用 `--noproxy '*'`。已用真实 curl 复现并验证 |
| B | 抓包测试可能假通过 | 原来只数「抓到的包」：tcpdump 没起来、网卡名为空、退出异常、pcap 读不出来，结果都是 0 个包 → 「没有旁路流量」 | 等 tcpdump 打出 `listening on` 才开始造流量；检查它的退出码和 pcap 可读；同一次抓包里另外统计经 :17897 的包作为**正向对照**，对照必须 > 0 才算数，旁路必须 = 0 |
| C | 回环监听检查放行「不确定状态」 | 原来只拦 `*` / `0.0.0.0`：同时监听在局域网 IP 不拦；`lsof` 看不到（端口属于 root 进程时常见）就直接继续 | 先用 `netstat -an`（不需要 sudo，能看到所有用户的监听），再用 `lsof` 兜底。所有 :17897 监听地址只能是 `127.0.0.1` / `::1`；看不到或有其他地址都终止 |
| D | 专用 `LIMA_HOME` 里的全局配置 | `~/.lima-ccvm/_config/default.yaml`、`override.yaml` 会被 Lima 合并进实例配置，可以悄悄加挂载、网络、开机脚本。核对源码后发现它在**每次启动时**都合并，不只是创建时 | 每个脚本启动时都检查这两个文件，存在就拒绝（`CCVM_FORCE` 也绕不过）；创建 VM 时加 `--mount-none`；每次再核对实例实际配置里挂载数和网络数都是 0 |

---

## 相对原方案的修复

| # | 原方案的问题 | 后果 | 本包的处理 |
|---|---|---|---|
| 1 | `portForwards` 的「全部忽略」规则写成 `guestIP: 0.0.0.0` 却没写 `guestIPMustBeZero: false`。Lima 在 guestIP 为 0.0.0.0 时默认把它设为 true，规则只匹配绑定在 0.0.0.0 的端口 | VM 里绑定 127.0.0.1 的服务（开发服务器、OAuth 回调等）照样被 Lima 默认规则转发到 Mac 的 127.0.0.1，和"不转发任何端口"的设计不符 | 补上 `guestIPMustBeZero: false`（已对照 Lima 2.2.1 `pkg/hostagent/port.go` 的匹配逻辑） |
| 2 | 出口比对用 `https://www.cloudflare.com/cdn-cgi/trace`：Mac 侧经 `socks5h` 让节点解析域名，VM 侧是 `ipv4_only` | 节点/Clash 开着 IPv6 时 Mac 侧可能拿到 IPv6 出口，VM 侧是 IPv4 → audit 永远不通过，或者被迫放宽比对 | 两端都改用字面 IPv4 的 `https://1.1.1.1/cdn-cgi/trace`（证书带 IP SAN，正常校验 TLS，不用 `-k`） |
| 3 | provider 模式下组里写 `proxies: [REJECT]` + `default-selected`；`default-selected` 在 mihomo 里不存在（被静默忽略） | 组默认选中 REJECT，必须手动点选节点；选择记录一丢 VM 就断网。普通订阅和 provider 还要两套写法 | 改为 `include-all: true` + 整名精确 `filter` + `empty-fallback: REJECT`：节点在时它就是组里唯一成员（不用手选），不在时自动 REJECT（mihomo 默认的 COMPATIBLE 相当于直连，所以这一项必须写）。两种订阅一套写法，去掉 `PROVIDER` 参数 |
| 4 | `systemd-networkd` 用 `Requires=` 依赖防火墙，但防火墙加载失败时没有退路 | Ubuntu 24.04 的 systemd 是 255，而 Lima 的 SSH over vsock 需要 ≥256，所以 SSH 走 user-mode 网络；网络起不来就 `limactl shell` 不进去，VM 只能整台删掉 | 主规则失败时自动加载锁定规则（只留 SSH/DHCP）：依旧断网，但还能登录修复 |
| 5 | 放行规则是 `meta skuid 0` → 192.168.5.2:17897 | VM 里任何 root 进程都能直连 Mac 上的专用入口 | sing-box 改用官方包自带的 `sing-box` 系统用户 + ambient capabilities 运行，防火墙只放行这个 UID |
| 6 | VM 内封了 NTP（UDP），时间问题靠"睡眠后重启 VM"，且对 Lima 版本没有要求 | Mac 睡眠后 VM 时钟落后 → TLS 报错、登录 token 异常 | Lima ≥ 2.1 的 guest agent 会每 10 秒经 vsock（不走网络）把 VM 时钟对齐到 Mac；`minimumLimaVersion: 2.1.0`，脚本也会检查版本 |
| 7 | sing-box 精确锁死 1.14.4 | SagerNet 的 APT 仓库一旦不再提供这个补丁版本，新装就失败 | 只接受 1.14.x（同一套配置格式），装仓库里最新的补丁版本后 hold |
| 8 | Ubuntu 镜像 URL 和校验值写死了日期目录 | 几个月后 Ubuntu 删掉旧目录，就会 404 | `base: template:_images/ubuntu-24.04`，用你本机 Lima 自带的镜像清单（带校验，失效时回落到官方 release 镜像） |
| 9 | 安装脚本中途失败就"别重跑，重建 VM" | 很小的问题也得重来 | 所有下载放在启用防火墙之前；之后只做本地操作，所以可以直接重跑 |
| 10 | 抓包验收全靠手工 | 容易漏做 | `leaktest.sh` 自动完成：TUN 正常时边产生流量边在物理网卡抓包，再停掉 TUN 验证断流；另外检查 cc 和 root 都碰不到 Mac 回环上的其他端口（日常代理口、控制器） |
| 11 | sing-box 官方包自带示例服务（监听 `::` 的 Shadowsocks 服务端，密码固定） | 原脚本是装完才 mask，中间有一个窗口 | 安装 sing-box **之前**先 mask `sing-box.service` |
| 12 | 小问题 | — | `route_exclude_address` 改为整个 `192.168.5.0/24`，这个网段只由防火墙决定放行；防火墙规则不再写死网卡名；sb-tun 的放行放在 `ct state invalid` 之前；加了限速的丢包日志（`journalctl -k \| grep ccvm-`）；`sysctl dev.tty.legacy_tiocsti=0`；镜像下载不再强制走节点（约 600MB，内容不敏感） |

**核对后保留的原方案判断**（已对照上游源码确认）：VZ 默认网络是 Lima 进程内的 gvisor-tap-vsock，`192.168.5.2` NAT 到 Mac 的 `127.0.0.1`，所以 Clash 只需监听回环，不用"允许局域网"；mihomo listener 的 `proxy` 字段优先于规则/全局/直连模式（`tunnel.resolveMetadata` 里先看 `SpecialProxy`）；sing-box 1.12+ 的新 DNS server 默认直连拨号，`detour: clash` 必须写；`dns_mode` 是 1.14 的合法字段；Clash Verge Rev 2.5.10 不会过滤 `listeners`，扩展脚本抛异常时整份配置原样返回（专用入口不存在 → VM 断网，不会直连）。

---
