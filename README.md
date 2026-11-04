# CCVM Kit

在 Apple Silicon Mac 上，以 Lima + Ubuntu Server 为 Claude Code 提供独立的工作环境。VM 内的 sing-box TUN 经 Clash Verge Rev 的专用回环入口使用一个指定节点；nftables 在 TUN 不可用时阻断直接出网。

当前版本：**2.3.0**（未发布）。本项目不附带订阅、代理节点、账户凭据或个人出口 IP；许可证暂未选择。

## 工作方式

```text
VM 中的 cc 用户 → sing-box TUN → 192.168.5.2:17897
                                 │ Lima user-mode NAT
Mac 的 127.0.0.1:17897 → CC-VM-FIXED → 你指定的具体节点
```

- Ubuntu 24.04 ARM64，默认 4 vCPU / 6 GiB 内存 / 60 GiB 稀疏磁盘。
- 工作用户 `cc` 无 sudo；不挂载 Mac 目录，不转发应用端口或 SSH agent。
- 公网 TCP 经过代理，DNS 经代理做 DoH；普通 UDP、IPv6 和局域网访问被阻断。
- Mac 日常 Clash 规则、系统代理与 TUN 开关由用户原有配置管理。
- 固定节点可能有多个出口 IP；出口与基线不一致时，检查和日常入口会拒绝通过。

网络设计与历史修复见 [设计说明](docs/design.md)。验证范围与可运行测试见 [验证说明](verification/RESULTS.md)。

桌面端（菜单栏、桌面胶囊和主窗口）在 [`app/`](app/README.md)，它只调用这里的脚本；脚本永远可以脱离 App 单独使用。实现选择与对设计方案的修订见 [桌面端说明](docs/desktop-app.md)。

## 前置条件

- Apple Silicon Mac，原生 ARM64 终端，Homebrew 与 Lima ≥ 2.1。
- Clash Verge Rev / mihomo，支持专用 listener 与 `empty-fallback`。
- 建议 16 GB 内存、25 GB 以上可用磁盘。
- 安装 Claude Code 时，需要可使用该服务的账号与网络条件，见 [官方安装说明](https://code.claude.com/docs/en/setup)。
- 日常部署使用 Bash、curl、Lima；**不需要为 Claude 原生安装另装 Node.js**。Node.js ≥ 18、Python 3.10+ 和 Git 只用于本项目的开发检查及打包。

实机验证版本：macOS 26.6 / Lima 2.2.1 / Clash Verge Rev 2.5.8 / mihomo 1.19.32 / Ubuntu 24.04.5 / sing-box 1.14.4。其他版本需重新运行验收。

## 1. 获取发布版

从 [Releases](https://github.com/m1inato/ccvm-kit/releases) 下载并解压，或：

```bash
git clone --branch v2.2.0 https://github.com/m1inato/ccvm-kit.git
cd ccvm-kit
brew install lima
```

后续的 Mac 端脚本都在仓库目录中运行。

## 2. 配置自己的 Clash 节点

创建 Git 忽略的本地副本：

```bash
cp config/clash-verge-script.js config/clash-verge-script.local.js
```

在 **本地副本** 中，把 `NODE` 改成一个具体代理节点的完整名称，保留 emoji 和空格。策略组、自动选择或负载均衡组不能作为节点填写。

在 Clash Verge Rev 的订阅扩展脚本中应用该副本：
1. 订阅页 → 当前订阅右键 → 扩展脚本。
2. 空模板可整体替换；已有 `main()` 时，合并常量与 `ccvmPatch()`，在原返回前调用它，保留一个 `main()`。
3. 保存并重新激活订阅，确认 `CC-VM-FIXED` 组只包含指定节点，入口仅监听 `127.0.0.1:17897`。

验证专用入口：

```bash
curl --noproxy '' --proxy socks5h://127.0.0.1:17897 https://1.1.1.1/cdn-cgi/trace
```

在 Clash 连接页核对链路为 `cc-vm-in → CC-VM-FIXED → 指定节点`。端口 17897 是各层一致的协议配置，不能只改某一处。

## 3. 可选的本机设置

默认实例名是 `ccvm`，专用 Lima 目录是 `$HOME/.lima-ccvm`，状态目录是仓库内的 `state/`。默认值均从当前用户与仓库位置计算。

需要自定义时：

```bash
cp config/local.env.example config/local.env
```

编辑本地配置中的 `VM_NAME`、`VM_HOME`、`STATE_DIR`。环境变量 `CCVM_NAME`、`CCVM_LIMA_HOME`、`CCVM_STATE_DIR` 优先于该文件；`CCVM_CONFIG_FILE` 可指定另一份配置文件。

配置文件是受信任的 Bash 赋值文件。路径须为绝对路径，可使用 `$HOME`、`$KIT`。详细优先级与升级方法见 [配置说明](docs/configuration.md)。

## 4. 部署并验收

```bash
bash scripts/setup.sh
```

脚本依次检查 Clash 监听地址、创建无挂载 VM、安装 sing-box 1.14.x 与防火墙、记录出口基线，然后执行完整检查与断流抓包测试。两项验收通过才报告部署完成。

首次引导阶段，Ubuntu 自身尚未受该防火墙保护；完成验收后再登录 Claude 或放入任何凭据。安装失败可重新运行脚本；已有安装标记会跳过网络层安装，修改源码不会自动更新已装 VM。

## 5. 进入 VM 并安装 Claude Code

在 Mac 终端：

```bash
bash scripts/enter.sh
```

该入口在需要时启动 VM，检查隔离与出口基线，再以 `cc` 用户进入。以下命令在 **VM 内** 运行：

```bash
curl -fsSL https://claude.ai/install.sh | bash -s stable
export PATH="$HOME/.local/bin:$PATH"
claude --version
claude doctor
cd ~/work
claude
```

Ubuntu 默认的 `~/.profile` 会在下次登录时加入已存在的 `~/.local/bin`。按 CLI 提示完成登录；VM 没有浏览器，可将登录链接复制到 Mac 浏览器，并在需要时粘贴授权码回终端。项目在 VM 内 clone，凭据单独配置。

## 日常命令与 Lima 的区别

| 目的 | 在 Mac 终端执行 |
|---|---|
| 检查后进入 cc 用户 | `bash scripts/enter.sh` |
| 只读验收 | `bash scripts/check.sh` |
| 断流与抓包测试 | `bash scripts/leaktest.sh` |
| 确认新出口后更新基线 | `bash scripts/rebaseline.sh` |
| 启停 VM（先检查 Lima 配置） | `bash scripts/vm.sh start` / `stop` |
| VM 里的项目 | `bash scripts/workspace.sh list` |

以上脚本都可以加 `--json`，输出给程序读的事件（格式见 [事件输出](docs/events.md)）。

断流测试会短暂停止 VM 内的 TUN，执行前结束正在联网的任务。

直接使用 Lima 时，以下示例针对默认配置：

```bash
# 开机
LIMA_HOME="$HOME/.lima-ccvm" limactl start ccvm
# 以工作用户进入
LIMA_HOME="$HOME/.lima-ccvm" limactl shell --workdir=/ ccvm sudo -iu cc
# 从 VM 返回 Mac：在 VM shell 中输入 exit
# 关机：在 Mac 执行
LIMA_HOME="$HOME/.lima-ccvm" limactl stop ccvm
```

Lima 通过 `limactl` 管理后台 VM。直接输入 `lima` 会尝试进入默认实例 `default`，本项目使用独立目录中的 `ccvm`。手动开机会启动已启用的防火墙和 TUN；`enter.sh` 还会核对实际配置与出口。自定义过实例名或目录时，手动命令也要使用相应值。

系统包维护可用管理员 shell：
`LIMA_HOME="$HOME/.lima-ccvm" limactl shell ccvm`。Claude 应在工作用户 `cc` 中运行。

## 在任意终端里用 `ccvm`

桌面端的 设置 → 通用 →「安装命令行入口 `ccvm`」会生成 `~/.local/bin/ccvm`（权限 0755，不需要管理员权限）。它清掉代理变量，只带 CCVM 的设置和登录 shell 的 `PATH`，然后调用 App 里的 `scripts/enter.sh`：先检查，检查不过就拒绝。VM 名、Lima 目录、状态目录改了，App 会自动重新生成它；文件开头写着「由 CCVM 生成，会被覆盖」，不要手改。

在任何终端（Terminal、iTerm、Ghostty……）里按 Cmd+T 开新标签，然后：

| 输入 | 做什么 |
|---|---|
| `ccvm` | 进入 cc 的普通 shell |
| `ccvm my-api` | 在 `~/work/my-api` 新建一个 tmux 会话（名字是 `my-api-<第一个空闲序号>`），App 项目页的会话列表里能看到它 |
| `ccvm -a my-api-1` | 接回已有的会话。不做检查，所以出口出错时也能回到正在跑的 Claude |

其他以 `-` 开头的参数原样传给 `enter.sh`。如果 `~/.local/bin` 不在 `PATH` 里，App 会给出一行，加到 `~/.zshrc` 即可（App 不会自己改 shell 配置）：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**Ghostty**：设置里「用哪个终端打开 cc」可以选 Ghostty（需要 1.3.0 或更新，经 AppleScript 新开窗口；第一次会请求「自动化」权限）。如果这个 Ghostty 只用来开 VM，可以在 Ghostty 配置里写

```
command = ~/.local/bin/ccvm
```

这样所有新窗口和新标签都直接进 VM（Ghostty 文档没有写明 `command` 里的 `~` 一定会展开；如果提示找不到命令，换成 `echo ~/.local/bin/ccvm` 打印出的绝对路径）。Ghostty 没有按窗口区分的配置，新建标签的动作也不能带命令，所以做不到「只在 VM 窗口里按 Cmd+T 自动进 VM」，原因见 [桌面端说明](docs/desktop-app.md)。

## 本地文件与发布文件

| 文件 | 用途 | Git / 发布包 |
|---|---|---|
| `config/clash-verge-script.js` | 未配置节点的通用模板 | 包含 |
| `config/local.env.example` | 可选本机设置示例 | 包含 |
| `config/*.local.js`、`config/local.env` | 自己的节点和路径 | 忽略 |
| `state/` | 出口基线、日志、备份等 | 忽略 |
| `LOCAL_SETUP.md` | 个人部署笔记 | 忽略 |
| `dist/` | 生成的发布压缩包 | 忽略 |

已有部署升级时保留本地文件与状态。更换实例名或 Lima 目录不会迁移 VM；新克隆目录也不会自动携带原出口基线。详见 [配置与迁移](docs/configuration.md)。

## 开发与发布

```bash
bash verification/run.sh
```

检查仅使用合成配置和临时目录，不启动 VM 或修改 Clash。CI 在 Linux 和 macOS 运行这些检查，并在独立 Linux network namespaces 中验证真实 nftables 规则。

本次发行已完成本地 macOS 与 Ubuntu VM 验证；GitHub 托管 CI 未能启动，执行状态详见 [验证记录](verification/RESULTS.md)。

提交所有发布文件后：

```bash
bash scripts/package.sh HEAD
```

`dist/` 中会生成版本化的 tar.gz 和 zip。打包基于 Git 提交中的文件，并再次检查通用节点模板、本机文件边界与凭据模式；忽略的本地文件不会进入压缩包。

## 使用边界

隔离覆盖无 sudo 的 `cc` 用户及其子进程。VM root、内核漏洞或宿主被入侵不在防护范围内。此方案允许公网 TCP，并非域名白名单，也不保证第三方账号状态。普通 UDP / QUIC、应用端口转发和依赖转发链的 Docker 网络不在支持范围内。

排障、手动验收场景与升级说明见 [运维说明](docs/operations.md)。原始设计审计见 [归档](docs/audit-v2.1.md)。

## 许可证

本版本暂未添加开源许可证。
