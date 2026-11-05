# 验证方式与范围

## 2.3.0 开发中：共享文件夹、传文件、`ccvm` 与 Ghostty（2026-11-05）

最初的开发检查在 Linux 容器里完成。2026-11-05 补充了共享文件夹的 Mac / Lima 实机验收，结果见下表；其余上机项目仍未执行。

| 环境 | 检查 | 结果 |
|---|---|---|
| Linux 容器 | `bash verification/run.sh`：Bash 语法、Clash 脚本用例、Python 用例（含共享路径规则、`share.sh apply` 的 `limactl edit` 表达式、实际挂载集合核对、`files.sh` 路径校验与 tar 管道、`mounts_ok`、`enter.sh --session auto`）、发布内容检查 | 通过 |
| Linux 容器 | `cd app && npm run typecheck && npm test && npm run build`（含 `sharePathProblem` 与 `lib.sh` 逐例对照、控制器端到端驱动真实 `share.sh apply`、`ccvm` 脚本生成） | 通过 |
| Linux 容器 | `guest/files.sh` 在本机以 cc 用户直接运行：列目录、`~/x -> /etc` 被拒、`check-file` 拒绝符号链接、删除链接不跟随 | 通过 |
| macOS 本地（2026-11-05） | `bash verification/run.sh`：69 项 Python 用例、Clash 脚本用例、Bash 语法及发布内容检查；新增安装 bindfs 时清理继承代理环境、设置挂载类型的回归测试 | 通过 |

### 共享文件夹与传文件（上机）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 应用共享文件夹；VM 重启后完整验收、断流测试都通过 | 通过（2026-11-05）；3 个共享目录，服务开机自动启动，完整验收与断流测试通过 |
| 2 | VM 里以 cc 在 `/home/cc/mac/<名字>` 新建、修改、删除文件，Mac 上能看到；Mac 上新建的文件在 VM 里属主是 cc | 通过（2026-11-05）；3 个目录均用临时文件验证双向创建、修改、删除及属主映射，测试后清理 |
| 3 | VM 里访问没共享的 Mac 路径，访问不到 | 未执行（没有 Mac） |
| 4 | 手动在 Lima 实例配置里多加一个挂载，完整验收变红（`lima.effective_config`） | 未执行（没有 Mac）；脚本层由 `test_shares.py` 用桩 limactl 覆盖 |
| 5 | 共享 `~/Documents`、`~/Desktop` 时 macOS 的隐私授权由谁申请（limactl 还是 App） | 未执行（没有 Mac） |
| 6 | 关闭共享并应用后 `/home/cc/mac` 下没有挂载，验收恢复「无挂载」 | 未执行（没有 Mac） |
| 7 | 上传文件、文件夹、Finder 拖入，下载单个文件；`~/x -> /etc/passwd` 不能下载；删除 `/home/cc/mac/` 下文件有额外警告 | 未执行（没有 Mac）；符号链接拒绝已在容器里对 `guest/files.sh` 实测 |

### `ccvm` 与 Ghostty（上机）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 设置选 Ghostty 后「在终端打开」开出 Ghostty 窗口，先过检查再进 cc；拒绝「自动化」权限时界面有提示 | 未执行（没有 Mac / Ghostty） |
| 2 | Ghostty 里 Cmd+T 输入 `ccvm my-api`，会话出现在 App 项目页 | 未执行（没有 Mac / Ghostty） |
| 3 | 出口出错时 `ccvm my-api` 被拒绝，`ccvm -a <已有会话>` 能接入 | 未执行（没有 Mac）；脚本层由 `test_events.py` 覆盖 |
| 4 | `keybind = chain=text:ccvm\n` 的文字进新标签还是原标签 | 未执行（没有 Ghostty）；README 暂不推荐这条 |

## 2.2.0 发行时的执行记录

2026-11-04 的实际执行结果：

| 环境 | 检查 | 结果 |
|---|---|---|
| macOS 本地 | 13 项 Clash 脚本用例、12 项 Python 用例、Bash 语法、发布内容检查 | 通过 |
| macOS 本地 | 发布包解压后运行完整离线检查 | 通过 |
| Ubuntu 24.04 ARM64 VM | 12 项 Python 用例、Bash 语法、发布内容检查 | 通过 |
| Ubuntu 24.04 ARM64 VM | 独立 network namespaces 中 22 项真实 nftables 功能场景 | 通过，fails=0 |
| GitHub 托管 macOS / Ubuntu runner | 工作流已配置，平台未启动任务 | 待执行 |

Linux 补测使用临时目录与独立网络命名空间，未切换现有 VM 的 TUN；结束后防火墙及 TUN 服务仍处于 active 状态。Linux VM 未另装 Node.js，Clash JavaScript 用例在 macOS 上运行。

## 本仓库提供的自动化检查

运行 `bash verification/run.sh`。需要 Bash、Node.js ≥ 18、Python 3.10+ 与 Git；不需要 Lima、代理订阅或 Claude 账号。

- Clash 扩展脚本：13 项合成订阅用例，覆盖精确匹配、端口冲突、保留原配置、幂等、provider 模式与误填拒绝。
- Python 标准库 unittest：配置优先级、路径中的空格和 Unicode、独立 Lima 目录、状态目录、配置错误、全局覆盖拒绝，以及 macOS Bash 3.2 的真实 setup 日志路径。
- 发布边界：拒绝已填写节点的发布模板、本机配置、运行日志、常见凭据与个人绝对路径。
- 打包集成：临时 Git 仓库中放入被忽略的个人文件，验证 tar.gz / zip 均未包含它们，校验和正确、相同提交的 tar.gz 可重复生成，未提交改动会阻止打包。
- 全部 Bash 文件执行语法检查。

CI 在 macOS 与 Linux 上分别运行上述检查。配置测试使用系统 `/bin/bash`，因此 macOS 会覆盖自带 Bash 3.2。

## Linux 防火墙功能检查

此测试在独立 network namespaces 内加载真实 nftables 模板，用模拟 VM、Mac 与公网地址验证允许、阻断和锁定回落，不切换任何现有 VM 的 TUN，也不创建测试系统用户。

在有 root 权限的临时 Linux 环境中：

```bash
sudo apt-get update
sudo apt-get install -y nftables
sudo bash verification/netns-firewall-test.sh "$PWD"
```

依赖 Python 3、util-linux（unshare / nsenter / setpriv / mount）、nftables、可用的 TUN 与 network namespace 支持。CI 使用 Ubuntu 24.04；限制容器若无所需权限，会明确失败。

## 已做过的实机部署验证

2026-11-04 在 Apple Silicon / macOS 26.6 上验证过：

| 组件 | 版本 |
|---|---|
| Lima | 2.2.1 |
| Clash Verge Rev / mihomo | 2.5.8 / 1.19.32 |
| Ubuntu ARM64 | 24.04.5 LTS |
| sing-box / nftables | 1.14.4 / 1.0.9 |
| Claude Code stable | 2.1.311 |

通过项：VZ 启动、无宿主挂载和额外网卡、Clash 专用入口及节点链路、出口基线一致、DoH、无 sudo 工作用户、绕过连接被阻断、抓包正向对照有效且旁路为 0、停止 TUN 后断流、恢复后联网，以及 VM 停机重启后的完整复验。Claude 原生安装与 `claude doctor` 通过，交互入口以 cc 身份工作。

此实机记录针对默认网络配置和安装修复；它不代替新用户的本机验收。本次发布整理保留了该配置，新增的本机设置与打包由独立自动化测试覆盖。

尚未验证：Claude 账号登录及真实提示词请求、Mac 睡眠唤醒、Wi-Fi / 热点切换，以及逐项切换系统代理、TUN 和 Clash 模式。新环境或组件升级后应执行 README 与 [运维说明](../docs/operations.md) 中的验收。

个人节点名、出口 IP、文件路径、运行日志与登录凭据不属于公开验证材料。

## 历史报告

v2.1 原包附带的源码字段核对、Linux 防火墙和宿主桩测试记录保存在 [审计归档](../docs/audit-v2.1.md)。原包未提供其宿主桩测试框架；这些历史数字不作为当前 CI 已复现的结果。
