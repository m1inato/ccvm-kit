# 验证

## 自动化检查

运行 `bash verification/run.sh`。需要 Bash、Node.js 18 以上、Python 3.10 以上与 Git。

- Clash 扩展脚本：13 项合成订阅用例，覆盖精确匹配、端口冲突、保留原配置、幂等、provider 模式与误填拒绝。
- Python 标准库 unittest：配置优先级、路径中的空格和 Unicode、独立 Lima 目录、状态目录、配置错误、全局覆盖拒绝，以及 macOS Bash 3.2 的真实 setup 日志路径。
- 发布边界：拒绝已填写节点的发布模板、本机配置、运行日志、常见凭据与个人绝对路径。
- 打包集成：临时 Git 仓库中放入被忽略的个人文件，验证 tar.gz / zip 均未包含它们，相同提交的 tar.gz 可重复生成，未提交改动会阻止打包。
- 全部 Bash 文件执行语法检查；宿主脚本里变量不能紧跟非 ASCII 字符（macOS Bash 3.2）。
- 事件接口：用桩 `limactl` / `curl` / `netstat` 驱动真实脚本，核对 `--json` 事件和每个检查 id 都写进了 `docs/events.md`。

桌面端：`cd app && npm run typecheck && npm test && npm run build`。核心逻辑、控制器（端到端驱动真实脚本）、出口核心、共享路径规则、`ccvm` 脚本生成、图标都有用例；`MIHOMO_BIN=$(which mihomo) npm test` 另外用真实 mihomo 跑一遍核心配置。

CI 在 macOS 与 Linux 上分别运行上述检查。配置测试使用系统 `/bin/bash`，因此 macOS 会覆盖自带 Bash 3.2。

## Linux 防火墙功能检查

在独立 network namespaces 里加载真实 nftables 规则，用模拟的 VM、Mac 与公网地址验证允许、阻断和锁定回落。

在有 root 权限的临时 Linux 环境中：

```bash
sudo apt-get update
sudo apt-get install -y nftables
sudo bash verification/netns-firewall-test.sh "$PWD"
```

依赖 Python 3、util-linux、nftables，以及 TUN 与 network namespace 支持。

## 2.3.0

| 环境 | 检查 | 结果 |
|---|---|---|
| macOS（Apple Silicon，系统 Bash 3.2） | `bash verification/run.sh` | 通过 |
| Ubuntu 24.04 ARM64 | `bash verification/run.sh`；桌面端 typecheck、测试、构建 | 通过 |

### 实机验收

| 项目 | 结果 |
|---|---|
| `check.sh --json`、`leaktest.sh --json` 全部通过，抓包正向对照 > 0 | 待验证 |
| 菜单栏状态点、桌面胶囊；退出 App 后 VM 与出口核心照常工作 | 待验证 |
| 欢迎页 3 个步骤自动检测完成状态 | 待验证 |
| 出口变化：首页变红、只通知一次、不开新会话；「就用新的出口」后恢复 | 待验证 |
| Terminal、iTerm、Ghostty 打开 cc；`ccvm <项目>` 的会话出现在项目页；出错时新会话被拒、`ccvm -a` 可接回 | 待验证 |
| 内嵌终端：新建会话，关窗口后接回同一会话，结束会话前确认 | 待验证 |
| 「Claude 做完了」提醒：同一项目 5 分钟内只出现一次 | 待验证 |
| 自带核心：切换出网方式确认后验收通过；Wi-Fi / 热点 / 有线切换时改绑或明确断网；真实 mihomo 集成测试 | 待验证 |
| 睡眠唤醒后自动检查，VM 时钟与 Mac 一致 | 待验证 |
| 共享文件夹：应用后完整验收、断流测试通过 | 通过（3 个文件夹） |
| 共享文件夹：VM 与 Mac 双向创建、修改、删除，属主映射正确 | 通过（3 个文件夹） |
| 共享文件夹：未共享的 Mac 路径不可访问；多加一个挂载时 `lima.effective_config` 变红；关闭后恢复无挂载 | 待验证 |
| 文件：上传、拖入、下载；符号链接不能下载；删除 `/home/cc/mac/` 下内容有额外提醒 | 待验证 |
| VM 更新：旧 VM 更新到级别 2；重启 `systemd-networkd` 后网络不中断 | 网络服务重启已验证；从旧版本更新待验证 |

## 2.2.0

2026-11-04 的实际执行结果：

| 环境 | 检查 | 结果 |
|---|---|---|
| macOS 本地 | 13 项 Clash 脚本用例、12 项 Python 用例、Bash 语法、发布内容检查 | 通过 |
| macOS 本地 | 发布包解压后运行完整离线检查 | 通过 |
| Ubuntu 24.04 ARM64 VM | 12 项 Python 用例、Bash 语法、发布内容检查 | 通过 |
| Ubuntu 24.04 ARM64 VM | 独立 network namespaces 中 22 项真实 nftables 功能场景 | 通过，fails=0 |

## 2.2.0 实机部署

2026-11-04 在 Apple Silicon / macOS 26.6 上验证过：

| 组件 | 版本 |
|---|---|
| Lima | 2.2.1 |
| Clash Verge Rev / mihomo | 2.5.8 / 1.19.32 |
| Ubuntu ARM64 | 24.04.5 LTS |
| sing-box / nftables | 1.14.4 / 1.0.9 |
| Claude Code stable | 2.1.311 |

通过项：VZ 启动、无宿主挂载和额外网卡、Clash 专用入口及节点链路、出口基线一致、DoH、无 sudo 工作用户、绕过连接被阻断、抓包正向对照有效且旁路为 0、停止 TUN 后断流、恢复后联网，以及 VM 停机重启后的完整复验。Claude 原生安装与 `claude doctor` 通过，交互入口以 cc 身份工作。

