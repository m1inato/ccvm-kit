# 设计说明

## 网络怎么走

```text
VM 里的程序 → sing-box TUN → 192.168.5.2:17897 ─(Lima NAT)→ Mac 的 127.0.0.1:17897 → 代理节点
```

- VM 里只有一条出路：防火墙只放行 `sing-box` 系统用户连 `192.168.5.2:17897`（外加 Lima 的 SSH 回包和 DHCP）。其余流量，包括 root 的，一律丢弃。
- `127.0.0.1:17897` 由 CCVM 自带核心（mihomo）或 Clash Verge 的扩展脚本提供，固定走你选的一个节点；节点不在时拒绝连接，不会改走直连。
- DNS 由 sing-box 经代理做 DoH，UDP、IPv6、局域网不通。

## 代理断了会怎样

VM 自己就断网，不需要 App 做任何事：

- 代理核心停了、节点连不上、Clash Verge 退出：17897 不通，sing-box 出不去，防火墙也不让别的路走。
- sing-box 崩了或 TUN 停了：流量进不了 TUN，物理网卡上只有到 17897 的连接被放行。
- 防火墙规则加载失败：回落到锁定规则（只留 SSH 和 DHCP），照样断网，但还能登录修复。

所以状态只看一件事：**代理通不通**。通着就是「已连接」，出口 IP 只显示、不比对：换节点、供应商换 IP 都不影响使用。不通就是「代理断开」，恢复后自动变回绿色。

## 状态检查

`scripts/check.sh` 只读，做三件事：

| 检查 | 怎么查 |
|---|---|
| `host.proxy` | Mac 上经 `socks5h://127.0.0.1:17897` 访问 `https://1.1.1.1/cdn-cgi/trace`，拿到出口 IP |
| `vm.firewall`、`vm.tun` | VM 里防火墙服务和主规则在；TUN 服务、`sb-tun`、策略路由在 |
| `vm.proxy` | VM 里 cc 用户不带代理变量访问同一个地址，拿到出口 IP |

App 每 3 分钟查一次（可调），Mac 唤醒、切换网络后马上查；不通时每 30 秒查一次，恢复了马上变绿。

## 配置细节

| 地方 | 做法 | 原因 |
|---|---|---|
| curl 走代理 | 加 `--noproxy ''` | 终端里有 `NO_PROXY` 时，curl 即使指定了 `--proxy` 也会直连 |
| 测出口的地址 | 字面 IPv4 的 `https://1.1.1.1/cdn-cgi/trace` | 证书带 IP SAN，不依赖 DNS，两端都拿 IPv4 |
| Clash Verge 扩展脚本 | `include-all: true` + 整名精确 `filter` + `empty-fallback: REJECT` | 节点在时它是组里唯一成员；不在时 REJECT（mihomo 默认的 COMPATIBLE 相当于直连）。普通订阅和 provider 一套写法 |
| 自带核心 | 一个入口、一个节点、规则只有 `MATCH,REJECT`；不绑网卡，用 Mac 当前的网络和 DNS | 订阅更新后节点地址或密码变了，自动换上新的并重启核心 |
| `portForwards` | 「全部忽略」规则写上 `guestIPMustBeZero: false` | 否则 VM 里绑定 127.0.0.1 的端口仍会被转发到 Mac |
| 防火墙放行 | 只放行 `sing-box` 用户的 UID | root 进程也不能直连 17897 |
| 防火墙失败 | 自动加载锁定规则 | Ubuntu 24.04 的 SSH 走 user-mode 网络，网络起不来就进不去 VM |
| 校时 | Lima ≥ 2.1 的 guest agent 经 vsock 对齐时钟 | VM 里 NTP（UDP）不通；Mac 睡眠唤醒后不用重启 VM |
| sing-box 版本 | 只接受 1.14.x，装最新补丁版后 hold | 配置按 1.14 编写 |
| sing-box 示例服务 | 安装前先 mask `sing-box.service` | 官方包自带一个监听 `::` 的示例服务端 |
| Ubuntu 镜像 | `base: template:_images/ubuntu-24.04` | 用本机 Lima 自带的镜像清单，不写死日期目录 |
| 安装顺序 | 所有下载放在启用防火墙之前 | 中途失败可以直接重跑 |
| TUN 策略路由 | networkd 不管别人的策略路由；看门狗每 30 秒检查，丢了就重启 TUN | 系统更新重启 networkd 后不断网 |

**依据**（已对照上游源码确认）：VZ 默认网络是 Lima 进程内的 gvisor-tap-vsock，`192.168.5.2` NAT 到 Mac 的 `127.0.0.1`，所以代理只需监听回环；mihomo listener 的 `proxy` 字段优先于规则/全局/直连模式；sing-box 1.12+ 的 DNS server 默认直连拨号，`detour: clash` 必须写；Clash Verge Rev 扩展脚本抛异常时整份配置原样返回（17897 不存在 → VM 断网）。
