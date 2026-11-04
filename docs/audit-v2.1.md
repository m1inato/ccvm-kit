# v2.1 原始套件审计归档

以下为原始套件附带的历史验证报告。原报告的宿主桩测试框架未随套件提供，相关数字不代表本仓库 CI 已复现的结果。当前可运行测试与验证边界见 [验证说明](../verification/RESULTS.md)。

---

# 交付前验证结果

环境：Linux x86_64、nftables 1.0.9（与 Ubuntu 24.04 同版本）、Node 22、Python 3.13。上游源码取自固定 tag：sing-box v1.14.4、Lima v2.2.1、mihomo v1.19.33、Clash Verge Rev v2.5.10。
**没有**在真实 M5 / macOS / VZ / Clash Verge 上运行；也没有运行 sing-box / mihomo 二进制（本环境不允许构建上游代码）。实机部分请按 README 的验收矩阵执行。

## 1. 配置字段对照上游源码（`check_fields.py`）

把配置中出现的每个键与对应版本源码里的结构体标签（`json:` / `yaml:` / `group:` / `inbound:`）比对，并检查枚举值。

```
PASS sing-box 1.14.4 字段 (35 keys)
PASS sing-box 枚举值（dns_mode=disabled, stack=system, hijack-dns/reject, socks/https/tun, ipv4_only）
PASS Lima 2.2.1 字段 (23 keys)
PASS Lima 内置模板 _images/ubuntu-24.04 存在
PASS mihomo 1.19.33 proxy-group 字段 (5 keys)
PASS mihomo 1.19.33 mixed listener 字段 (6 keys)
```

源码阅读确认的行为（README「相对原方案的修复」中引用）：

- Lima `pkg/hostagent/port.go` + `pkg/limayaml/defaults.go`：`guestIP: 0.0.0.0` 时 `guestIPMustBeZero` 默认为 true，忽略规则只匹配绑定 0.0.0.0 的端口。
- Lima `pkg/driver/vz/vm_darwin.go`：SSH over vsock 依赖 systemd ≥ 256，否则回落到 user-mode 转发（Ubuntu 24.04 为 255）。
- Lima `pkg/driver/vz/vm_darwin.go` + `pkg/networks/usernet/gvproxy.go`：VZ 默认网络为进程内 gvisor-tap-vsock，网关 192.168.5.2，NAT 到宿主 127.0.0.1。
- Lima `pkg/hostagent/timesync.go`（v2.1.0 起存在，v2.0.0 没有）：经 guest agent 每 10 秒同步时钟，漂移阈值 100ms。
- mihomo `tunnel/tunnel.go` `resolveMetadata`：listener 的 `proxy`（SpecialProxy）优先于 rule/global/direct 模式。
- mihomo `adapter/outboundgroup/parser.go`：`empty-fallback` 默认 `COMPATIBLE`；`include-all` + `filter` 匹配不到时组内只剩 empty-fallback；没有 `default-selected` 字段（未知键被忽略）。
- Clash Verge Rev `src-tauri/src/enhance/`：`listeners`、`proxy-groups` 不在受控字段内；脚本异常时原样返回配置；`cleanup_proxy_groups` 只修剪 `use`/`proxies` 中不存在的名字。
- sing-box `docs/configuration/dns/server/https.md`：新 DNS server 默认等同直连拨号，必须用 `detour` 指向代理。
- sing-box `release/config/`：官方包的 `sing-box.service` 以 `sing-box` 用户 + ambient caps 运行；示例 config 是监听 `::` 的 Shadowsocks 服务端。

## 2. 防火墙功能测试（`netns-firewall-test.sh`，需 root）

两个网络命名空间：`ccg` 模拟 VM（veth 192.168.5.15/24），`cch` 模拟 VM 看到的 Mac 回环（192.168.5.2，含 17897/7897/443 回显服务）和一个假公网主机 1.1.1.1。加载渲染后的真实 `firewall.nft` / `lockdown.nft`，分别以 root、模拟的 sing-box 用户、模拟的 cc 用户和"Mac"侧发起连接。
说明：被 OUTPUT 丢弃的 TCP SYN 表现为超时，UDP 表现为 `sendto` 返回 EPERM；所有 TCP 目标都有服务在监听，所以超时可以明确判定为被拦截。

```
--- 基线（无防火墙）：确认拓扑可达，否则后续 EPERM 无意义
PASS 无防火墙时 cc → 1.1.1.1:443 可达  [OK]
PASS 无防火墙时 cc → 192.168.5.2:17897 可达  [OK]
--- 加载防火墙时，已有的 Mac→VM:22 会话（安装脚本所在 SSH 会话）不能被切断
  （主防火墙已加载）
PASS 已有 SSH 会话在加载防火墙后继续工作  [OK]
--- 无 TUN（等同 sing-box 停止/崩溃）
PASS sing-box 用户 → 192.168.5.2:17897 放行  [OK]
PASS cc → 192.168.5.2:17897 阻断  [TIMEOUT]
PASS root → 192.168.5.2:17897 阻断（只放行 sing-box 用户）  [TIMEOUT]
PASS sing-box 用户 → Mac 回环其他端口 :7897 阻断  [TIMEOUT]
PASS cc → 公网 1.1.1.1:443 直连阻断  [TIMEOUT]
PASS root → 公网 1.1.1.1:443 直连阻断  [TIMEOUT]
PASS sing-box 用户 → 公网直连阻断  [TIMEOUT]
PASS cc → UDP 8.8.8.8:53 阻断  [EPERM]
PASS cc → UDP 123 (NTP) 阻断  [EPERM]
PASS Mac → VM:22（Lima SSH）新连接往返正常  [OK]
PASS Mac → VM 其他端口 :2222 阻断  [TIMEOUT]
--- 有 TUN（模拟 auto_route：公网目的地路由进 sb-tun）
PASS cc → 公网经 sb-tun：防火墙放行（UDP 能发出 = 未被丢弃）  [SENT]
PASS root → 公网经 sb-tun：防火墙放行  [SENT]
PASS TUN 存在时 cc 仍不能直连 192.168.5.2:17897（该网段不进 TUN）  [TIMEOUT]
--- 锁定模式（模拟 ccvm-firewall.service 中主规则加载失败）
    table inet ccvm {
        comment "ccvm-lockdown"
PASS 主规则失败时回落到锁定规则
PASS 锁定模式：sing-box 用户也不能连专用入口  [TIMEOUT]
PASS 锁定模式：cc 经 TUN 也不能出网  [EPERM]
PASS 锁定模式：Lima SSH 仍可登录修复  [OK]
PASS 修复后可原子切回主规则
RESULT fails=0
```

v2.1 修正了本测试脚本自身的一处竞态（`nft list … | grep -q` 在 pipefail 下偶发 SIGPIPE，导致锁定模式判断不稳），之后连续运行 3 次均为 22/22。

## 3. Clash Verge 扩展脚本（`test-clash-script.js`）

```
PASS inline 订阅：生成组与监听，其他配置不变
PASS filter 只精确匹配目标节点（含 emoji、空格和正则元字符）
PASS 重复应用幂等
PASS provider 订阅（无 inline 节点）放行
PASS 未修改 NODE → 报错
PASS NODE 是策略组 → 报错
PASS NODE 是内置策略 → 报错
PASS NODE 是 direct 类型伪节点 → 报错
PASS 节点不存在且无 provider → 报错
PASS 与 mixed-port 冲突 → 报错
PASS 与其他 listener 端口冲突 → 报错
PASS 节点名含反引号 → 报错
PASS CVR cleanup_proxy_groups 不会改动 CC-VM-FIXED（组内无 use/proxies 字段）
13 tests passed
```

注：filter 的精确匹配在 JS 正则中测试；mihomo 使用 regexp2（.NET 语法），对本脚本转义过的字符行为一致。

## 4. Mac 侧脚本（桩环境）

用桩程序模拟 `limactl`、Mac 上的 `curl`/`netstat`/`lsof`/`uname`（`curl` 桩按真实 curl 的 NO_PROXY 规则决定是否绕过 `--proxy`），以及 VM 内的 `systemctl`/`nft`/`ip`/`curl`/`tcpdump` 等（带 TUN 开/关状态机），实际运行 `scripts/*.sh` 与 `guest/selfcheck.sh`、`guest/leaktest.sh`，检查参数传递、`set -e` 行为、输出解析和失败路径。`guest/install.sh` 会修改系统，未在桩环境运行，只做了语法检查和逐行审阅。

| 场景 | 退出码 | 关键输出 |
|---|---|---|
| 全新部署 setup.sh | 0 | 全部通过 ✔ 抓包对照：同一次抓包里有 3 个经专用入口 :17897 的包（证明抓包在 eth0 上确实有效） 断流测试通过 |
| 重复运行 setup.sh（幂等） | 0 | 全部通过 ✔ 抓包对照：同一次抓包里有 3 个经专用入口 :17897 的包（证明抓包在 eth0 上确实有效） 断流测试通过 |
| enter.sh 正常 | 0 | [would exec interactive shell as cc] |
| VM 出口≠基线 → check.sh | 1 | ✘ VM 出口 198.51.100.9 ≠ 基线 203.0.113.7 ✘ 存在未通过项（出口变了先看 README「更换节点 / 出口 IP 变化」，不要直接改基线） |
| Mac 出口≠基线 → check.sh | 1 | ! Mac 专用入口出口 198.51.100.9 ≠ 基线 203.0.113.7 ✘ 存在未通过项（出口变了先看 README「更换节点 / 出口 IP 变化」，不要直接改基线） |
| VM 出口≠基线 → enter.sh 拒绝 | 1 | FAIL VM 出口 198.51.100.9 ≠ 基线 203.0.113.7 ✘ 快速检查未通过，拒绝进入（排查用：bash scripts/check.sh；确需进入排障：CCVM_FORCE=1 bash scripts/enter.sh） |
| CCVM_FORCE=1 强制进入 | 0 | FAIL VM 出口 198.51.100.9 ≠ 基线 203.0.113.7 [would exec interactive shell as cc] |
| 抓包发现旁路包 → leaktest.sh | 1 | ✔ 抓包对照：同一次抓包里有 3 个经专用入口 :17897 的包（证明抓包在 eth0 上确实有效） ✘ 抓包：物理网卡上出现 1 个旁路包： ✘ 断流测试未通过：在定位原因之前不要登录或使用 Claude |
| ↳ 失败路径结束后 TUN 状态 | - | up |
| tcpdump 没启动 → leaktest.sh | 1 | ✘ 抓包：tcpdump 没有正常启动：tcpdump: eth0: You don't have permission to capture on that device  ✘ 断流测试未通过：在定位原因之前不要登录或使用 Claude |
| ↳ 失败路径结束后 TUN 状态 | - | up |
| 防火墙处于锁定模式 → check.sh | 1 | ✘ 主防火墙规则已加载（不是锁定模式） ✘ 存在未通过项（出口变了先看 README「更换节点 / 出口 IP 变化」，不要直接改基线） |
| :17897 监听在 * → setup.sh | 1 | ✘ :17897 还监听在非回环地址：* 。扩展脚本里必须是 listen: 127.0.0.1，并检查是否有其他程序占用了这个端口。 |
| Lima 2.0.1 → 拒绝 | 1 | ✘ Lima 2.0.1 过旧，需要 ≥ 2.1.0（VM 校时依赖它）：brew upgrade lima |
| VM 已停止 → enter.sh 自动启动 | 0 | [would exec interactive shell as cc] |
| rebaseline 两端一致 + yes | 0 | ✔ 基线已更新为 192.0.2.44 |
| rebaseline 输入 no | 1 | ✘ 已取消 |
| rebaseline 两端不一致 | 1 | ✘ Mac 与 VM 出口不一致：先排查（可能节点多出口或 VM 未走专用入口），不要更新基线 |
| rebaseline 时终端里有 NO_PROXY='*' | 0 | ✔ 基线已更新为 192.0.2.44 |

## 5. 语法

```
## bash -n
PASS scripts/check.sh
PASS scripts/enter.sh
PASS scripts/leaktest.sh
PASS scripts/lib.sh
PASS scripts/rebaseline.sh
PASS scripts/setup.sh
PASS guest/install.sh
PASS guest/leaktest.sh
PASS guest/selfcheck.sh
PASS verification/netns-firewall-test.sh
## 解析
PASS config/sing-box.json
PASS config/lima.yaml
```

## 6. v2.1 审计修复：修复前后对照

对 4 项审计意见逐条复现，再用同一套桩环境分别跑 v2 原包（修复前）和 v2.1（修复后）。

### 6.1 NO_PROXY 让显式 `--proxy` 失效（真实 curl 8.5.0 复现）

本地起一个只会回 `via-proxy` 的记录型代理，目标是一个不可达的文档地址：

```
无 NO_PROXY，--proxy                         → via-proxy
NO_PROXY='*'，--proxy                         → 直连目标（绕过代理）
no_proxy=203.0.113.10，--proxy                → 直连目标（绕过代理）
NO_PROXY='*'，--noproxy '' --proxy            → via-proxy
no_proxy=203.0.113.10，--noproxy '' --proxy   → via-proxy
代理日志行数: 3
```

结论：curl 的 `--proxy` 会被 NO_PROXY / no_proxy 覆盖，`--noproxy ''` 能把它压回去。v2.1 在 `host_ip`（Mac 出口检查）和 `guest/install.sh` 的两个显式代理 curl 上都加了 `--noproxy ''`，apt 用 `env -u no_proxy -u NO_PROXY` 启动。`guest/leaktest.sh` 的直连探针改用 `--noproxy '*'`，经代理探针用 `--noproxy ''`。

### 6.2 桩环境对照

| 审计项 | 场景 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | `NO_PROXY='*'` 时 check.sh | 退出 1：Mac 出口 192.0.2.250（直连）≠ 基线 | 退出 0：经专用入口，= 基线 |
| 1 | `no_proxy=1.1.1.1` 时 check.sh | 同上，误报 | 退出 0 |
| 1 | 全新部署且 `NO_PROXY='*'` | **把直连 IP 192.0.2.250 记成基线** | 记下的是节点出口 203.0.113.7 |
| 2 | tcpdump 没能启动 | 退出 0，「没有旁路流量」 | 退出 1，「tcpdump 没有正常启动」 |
| 2 | 抓到 0 个经 17897 的包（网卡不对 / 流量没走 TUN） | 退出 0 | 退出 1，「抓包对照为 0，结果不可信」 |
| 2 | tcpdump 非 0 退出 | 退出 0 | 退出 1，附退出码和 tcpdump 日志 |
| 2 | pcap 读不出来 | 退出 0 | 退出 1，「pcap 读不出来」 |
| 2 | 找不到通往 192.168.5.2 的网卡 | 退出 0（在空网卡名上"抓包"） | 退出 1 |
| 2 | 真有旁路包 | 退出 1 | 退出 1（同时显示对照 3 个包） |
| 2 | 一切正常 | 退出 0 | 退出 0，「对照 3 个包，旁路 0 个」 |
| 3 | 17897 同时监听在 192.168.1.10 | **退出 0，「只监听在回环地址」** | 退出 1，列出非回环地址 |
| 3 | 17897 监听在 `*` | 退出 1 | 退出 1 |
| 3 | netstat / lsof 都看不到 17897 | **退出 0，继续部署** | 退出 1，「确认不了，不继续」 |
| 3 | 127.0.0.1 + ::1 | 退出 0 | 退出 0 |
| 4 | `_config/override.yaml` 存在时 setup / enter / check | 三者都照常通过 | 三者都拒绝，指出文件路径 |
| 4 | `_config/default.yaml` 存在时 setup / enter / check | 三者都照常通过 | 三者都拒绝 |
| 4 | 实例实际配置里有 1 个挂载 | 退出 0 | 退出 1（`mounts networks = 1 0`） |
| 4 | 创建 VM 的参数 | `start --tty=false --name=ccvm …/lima.yaml` | `start --tty=false --name=ccvm --mount-none …/lima.yaml` |

另外确认：`CCVM_FORCE=1` 可以跳过监听检查进入排障，但**不能**跳过 `_config` 检查；`rebaseline.sh` 在 `NO_PROXY='*'` 下也取到节点出口。

### 6.3 关于 `_config` 的补充发现

审计意见说的是「旧目录里的全局配置」。对照 Lima 2.2.1 源码，`$LIMA_HOME/_config/default.yaml` 和 `override.yaml` 是在**每次加载实例时**合并的（`limayaml.Load`），不只是创建时。也就是说 VM 建好以后再有人放进一个 `override.yaml`，下次 `limactl start` 就会多出挂载或开机脚本。所以 v2.1 把这项检查放进了 `require_mac`，setup / check / enter / leaktest / rebaseline 每次都查，并且每次再用 `limactl list --format '{{len .Config.Mounts}} {{len .Config.Networks}}'` 核对实例的实际配置为 `0 0`。
