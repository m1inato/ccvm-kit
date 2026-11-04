# 事件输出（--json）

宿主脚本加 `--json` 后，stdout 只输出 NDJSON 事件，一行一个；给人看的文字和 limactl、apt 等的输出都改到 stderr。不加 `--json` 时，命令行用法和输出与以前一样。

CCVM 桌面端只显示这里的结论和脚本原话，自己不做判断。所以界面上的每个结论，都能在终端用同一条命令复现：

```bash
bash scripts/check.sh --quick --json
```

## 怎么判定一次运行通过

满足以下全部条件才算通过，其余情况一律当作失败（不确定就当失败）：

1. 进程退出码是 0；
2. 最后一条事件是 `end`，且 `ok` 为 `true`；
3. 没有 `ok: false` 的 `check` 事件，也没有 `error` 事件。

脚本被中断、没输出、输出不是 JSON、缺少 `end`，都算失败。

## 事件格式

每条事件都有 `"v": 1` 和 `type`。

| type | 字段 | 含义 |
|---|---|---|
| `start` | `script`、`kit` | 第一条事件：脚本名与套件版本 |
| `step` | `id`、`msg` | 多步骤任务进入下一步（如 `setup.vm`） |
| `check` | `id`、`ok`、`msg` | 一项检查的结论。`id` 稳定，`msg` 是给人看的原话 |
| `value` | `key`、`value` | 测得的值，例如出口 IP；值总是字符串 |
| `item` | `kind` 及其字段 | 列表项，目前只有 `kind: "project"` |
| `log` | `level`（`info` / `warn` / `detail`）、`msg` | 过程信息 |
| `error` | `msg` | 脚本因错误终止前的最后一句话 |
| `end` | `ok`、`code` | 最后一条事件 |

`setup.sh --json` 在第 5 步调用 `check.sh` 和 `leaktest.sh`，它们的事件直接并入同一个流，不重复 `start` / `end`（子脚本运行时带 `CCVM_EVENT_CHILD=1`）。

## 脚本与参数

| 命令 | 作用 |
|---|---|
| `check.sh [--quick] [--json]` | 完整验收；`--quick` 是日常快速检查 |
| `leaktest.sh [--json]` | 断流与抓包测试 |
| `setup.sh [--json]` | 一键部署，步骤为 `setup.listener` → `setup.vm` → `setup.install` → `setup.baseline` → `setup.verify` |
| `rebaseline.sh [--dry-run \| --accept IP] [--json]` | 不带参数时要求输入 yes。`--dry-run` 只测量；`--accept IP` 重新测量，Mac 与 VM 出口都等于 IP 才写入 |
| `preflight.sh [--json]` | 部署前检查，不需要 VM，逐项报告 |
| `vm.sh start\|stop\|status [--json]` | 启停 VM；每次都先检查 Lima 全局配置，启动后核对实际配置 |
| `workspace.sh list\|claude\|clone URL\|kill-session 会话名 [--json]` | VM 里 `~/work` 的项目与 tmux 会话、Claude Code 是否已安装、以 cc 身份克隆、结束会话 |
| `hooks.sh enable\|disable\|status [--json]` | 「Claude 做完了」字幕用的 hook：装在 VM 里 root 所有的 managed-settings 目录里，cc 改不了 |
| `enter.sh [--project 名称] [--session 会话名] \| --attach 会话名` | 交互入口（没有 JSON 模式）。`--session` 检查后新建或接入 tmux 会话；`--attach` 只接入已有会话，不做检查 |

## 检查项 id

id 是 App 与脚本之间的接口。可以改说明文字，改 id 要同时改 App 和这张表。`verification/test_events.py` 会核对脚本里出现的每个 id 都在这里有记录。

### Mac 与 Lima

| id | 含义 |
|---|---|
| `host.macos_arm64` | 在 Apple Silicon Mac 的原生 arm64 终端里运行 |
| `lima.version` | 已安装 Lima，且版本 ≥ 2.1.0 |
| `lima.no_global_config` | 专用 `LIMA_HOME/_config/` 里没有 `default.yaml`、`override.yaml` |
| `lima.effective_config` | VM 实际配置里挂载数和网络数都是 0 |
| `listener.loopback_only` | :17897 的每个监听地址都是 `127.0.0.1` / `::1`；看不到监听也算失败 |
| `egress.host_reachable` | 经专用入口能拿到 IPv4 出口 |
| `egress.host_matches_baseline` | Mac 专用入口的出口 = 基线 |
| `egress.host_matches_vm` | Mac 与 VM 的出口一致（更新基线的前提） |
| `baseline.present` | 有出口基线文件，内容是 IPv4 |
| `rebaseline.confirmed` | 基线已按确认的 IP 更新 |
| `vm.exists` | VM 实例存在 |
| `vm.running` | VM 正在运行 |

### VM 内（`guest/selfcheck.sh`）

| id | 含义 | 快速检查 |
|---|---|---|
| `vm.firewall_active` | 防火墙服务运行中 | ✓ |
| `vm.firewall_main_rules` | 主规则已加载（失败表示处于锁定模式） | ✓ |
| `vm.tun_up` | TUN 服务运行且 `sb-tun` 存在 | ✓ |
| `vm.egress_reachable` | cc 用户在没有代理变量时经 TUN 出网 | ✓ |
| `egress.vm_matches_baseline` | VM 出口 = 基线 | ✓ |
| `vm.nftables_masked` | 通用 `nftables.service` 已屏蔽 | |
| `vm.resolv_static` | `/etc/resolv.conf` 是静态文件，指向 172.31.255.2 | |
| `vm.ipv6_off` | IPv6 已关闭 | |
| `vm.no_host_mounts` | 没有 virtiofs / 9p / sshfs 挂载 | |
| `cc.no_priv_groups` | cc 不在 sudo、admin、adm、lxd、docker 组 | |
| `cc.no_sudo` | cc 没有免密 sudo | |
| `cc.no_proxy_env` | cc 的登录环境里没有代理变量 | |
| `vm.dns_doh` | DNS 经 DoH 可解析 | |
| `vm.anthropic_reachable` | api.anthropic.com TLS 可达 | |
| `bypass.cc_listener` | cc 直连 192.168.5.2:17897 被拒 | |
| `bypass.root_listener` | root 直连专用入口也被拒（只放行 sing-box 用户） | |
| `bypass.mac_port_<port>` | cc 连不到 Mac 回环上的 7897、7890、9097、9090 | |
| `bypass.lan` | cc 连不到局域网地址 | |

### 断流测试（`guest/leaktest.sh`）

| id | 含义 |
|---|---|
| `leak.precheck` | TUN 正常时能出网（否则测试没有意义） |
| `leak.capture_control` | 同一次抓包里经 :17897 的包数 > 0（正向对照）；抓包没起来、读不出也记在这里 |
| `leak.capture_bypass` | 物理网卡上旁路包数 = 0 |
| `leak.fw_persists` | 停止 TUN 后防火墙规则仍在 |
| `leak.tun_down_ipv4` | TUN 停止时 cc 的 IPv4 直连被阻断 |
| `leak.tun_down_ipv6` | TUN 停止时 cc 的 IPv6 直连被阻断 |
| `leak.tun_down_dns` | TUN 停止时 DNS 无法解析 |
| `leak.tun_down_udp_dns` | TUN 停止时外部 UDP DNS 不可用 |
| `leak.tun_down_root_direct` | TUN 停止时 root 直连被阻断 |
| `leak.tun_down_root_listener` | TUN 停止时 root 经专用入口也出不去 |
| `leak.tun_restored` | 测试后 TUN 恢复，能出网 |

断流测试同时输出 `capture_control`、`capture_bypass`、`capture_nic` 三个值，界面写成「经专用入口 N 个包 · 旁路 0 个」。只有 `leak.capture_control` 和 `leak.capture_bypass` 两项都出现且都通过，才算抓包通过：缺任意一项都按失败显示。

### 项目（`guest/workspace.sh`，以 cc 身份运行）

| id | 含义 |
|---|---|
| `project.url` | Git 地址格式允许：`https://主机/路径`、`ssh://git@主机/路径`、`git@主机:路径`，不带账号或令牌 |
| `project.name` | 能从地址里取出合法项目名 |
| `project.clone` | 克隆完成 |
| `claude.installed` | cc 的 `~/.local/bin/claude` 存在且 `--version` 能运行 |
| `session.kill` | 结束了 cc 的一个 tmux 会话（会话名只允许 `[A-Za-z0-9_-]`，最长 64） |

### 完成提醒 hook（`guest/hooks.sh`，可选）

| id | 含义 |
|---|---|
| `hooks.installed` | 已在 VM 里装好 `/usr/local/lib/ccvm/claude-hook` 和 `/etc/claude-code/managed-settings.d/50-ccvm.json` |
| `hooks.removed` | 已移除这两个文件 |
| `guest.user` / `guest.usage` | VM 内脚本的调用错误 |

## 常见的值（value）

| key | 来源 |
|---|---|
| `host_egress` | Mac 专用入口的出口 IP |
| `vm_egress` | VM 内 cc 用户的出口 IP |
| `baseline` / `old_baseline` | 当前 / 更新前的基线 |
| `listener_addrs` | :17897 的监听地址，空格分隔 |
| `lima_version` | Lima 版本 |
| `vm_status` | `Running`、`Stopped`、`Missing` 等 |
| `vm_resources` | `CPU数 内存字节 磁盘字节` |
| `mode` | `full` 或 `quick` |
| `capture_control` / `capture_bypass` / `capture_nic` | 断流测试的抓包统计 |
| `project` / `project_count` / `session_count` | 克隆出的项目名 / 列表中的项目数 / tmux 会话数 |
| `hooks_enabled` | 完成提醒 hook 是否已安装（`1` / `0`） |
| `events_size` | `~/.ccvm/events.jsonl` 读到的位置（字节），下次从这里接着读 |
| `claude_installed` / `claude_version` | `1` 或 `0` / 版本字符串 |

## 项目列表项

`workspace.sh list --json` 为每个项目输出一条：

```json
{"v":1,"type":"item","kind":"project","name":"my-api","branch":"main","dirty":3,"ahead":1,"behind":0,
 "updated":1793000000,"subject":"最后一次提交的说明","remote":"https://github.com/you/my-api.git",
 "claude_sessions":1,"claude_since":1792999000}
```

同一次还会为 cc 的每个 tmux 会话输出一条：

```json
{"v":1,"type":"item","kind":"session","name":"my-api-1","created":1793000100,"attached":1,"project":"my-api"}
```

`workspace.sh events <偏移|end>` 为 hook 记下的每条 Claude 事件输出一条（文件由 cc 写，内容按不可信处理：只接受 Stop / Notification，去掉控制字符并截断）：

```json
{"v":1,"type":"item","kind":"claude_event","t":1793000000,"event":"Stop","project":"my-api","notification":"","message":""}
```

`project` 由会话的起始目录推出（`~/work/<项目>`），不在项目里的会话为空字符串。

`remote` 已去掉地址里的账号和令牌。`claude_sessions` 是工作目录在该项目下的 Claude Code 进程数，由 VM 内的 `/proc` 判断，不读 `~/.claude`。
