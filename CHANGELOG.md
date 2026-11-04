# Changelog

## 2.3.0 — 未发布

为桌面端准备的脚本接口，以及第一版桌面端（M0–M2）。

- 宿主脚本支持 `--json`：stdout 只输出带稳定 id 的 NDJSON 事件，说明见 `docs/events.md`。不加参数时用法和输出不变。
- VM 内脚本的输出改为 `PASS|FAIL <id> <说明>`，宿主端边收边显示。脚本每次经 stdin 传入，已部署的 VM 不需要重装。
- `check.sh --quick`；`rebaseline.sh --dry-run` 与 `--accept IP`（重新测量，两端都等于确认的 IP 才写入）。
- 新增 `vm.sh`（启停前检查 Lima 全局配置）、`preflight.sh`（部署前逐项检查）、`workspace.sh`（以 cc 身份列项目、克隆、检测 Claude Code）。
- `enter.sh --project 名称`：进入后直接切到 `~/work/<名称>`。
- 断流测试在 SIGHUP / SIGPIPE 时也恢复 TUN，并在停 TUN 期间挂一个 5 分钟后自动恢复的 systemd 定时器。
- 新装 VM 的基础包加入 `git`。
- 新增 `app/`：Electron 桌面端（菜单栏、桌面胶囊、工作区、项目页、欢迎页、设置），见 `app/README.md` 与 `docs/desktop-app.md`。
- 桌面端 M3：自带出口核心。用 Homebrew 的 mihomo，App 以 LaunchAgent 运行；只支持 Clash YAML 订阅，节点变化先断网再确认；绑定物理网卡，节点域名用当前网卡的 DHCP DNS；「连接」面板直接读核心。
- `listener.loopback_only` 失败时的说明同时提到自带核心和 Clash Verge 两种情况。
- 桌面端 M4：内嵌终端（xterm.js + node-pty），会话跑在 VM 里 cc 的 tmux 中，关窗口只是断开；可选的「Claude 做完了」字幕（root 所有的 managed-settings hook）。
- `enter.sh --session` / `--attach`；`workspace.sh` 列出 tmux 会话、`kill-session`、`events`；新增 `hooks.sh`。新装 VM 的基础包加入 `tmux`。
- VS Code 远程这一轮不做：它在 VM 和 Mac 之间打开的通道不止端口转发，见 `docs/desktop-app.md`。
- `enter.sh --project P --session auto`：检查通过后按 App 的规则自动取会话名（`<项目>-<第一个空闲序号>`）。
- 桌面端：命令行入口 `ccvm`（设置 → 通用里安装到 `~/.local/bin/ccvm`，设置变了自动重写）；`.command` 文件改为只调用它；「用哪个终端打开 cc」增加 Ghostty（AppleScript，需要 1.3.0 或更新）。
- 桌面胶囊修复：窗口跟内容一样大（原来 480×170 的透明窗口会挡住下面窗口的点击）；按钮第一下就能点（`acceptFirstMouse`）；打开胶囊不再隐藏 Dock 图标；显示器变化后拉回屏幕内；胶囊里的操作失败时显示原因。

- 打包不再生成校验文件；桌面端判断节点是否变化改为逐字段比较内容。项目不使用这类哈希，规则见 `AGENTS.md`。

本次改动在 Linux 容器中验证；尚未在 Mac / Lima / Clash Verge 实机上运行。

## 2.2.0 — 2026-11-04

首个 GitHub 发布版，基于原始 v2.1 套件整理。

- 发布的 Clash 脚本使用节点占位符，个人节点保存在被忽略的本地副本。
- 增加可选本机配置文件、环境变量优先级与独立状态目录设置。
- 排除本机部署记录、日志、出口基线、下载与发布产物。
- 保留 macOS Bash 3.2 中文标点变量解析修复，以及 VM 主机名本地解析修复。
- 增加可重复的 Git 提交打包与 tar.gz / zip（当时附带的校验文件已在 2.3.0 移除）。
- 增加跨平台配置测试、发布边界测试及 Linux network namespace 防火墙 CI；测试不创建宿主系统用户。
- 重写通用部署、手动 Lima 管理、升级和验证说明，历史审计单独归档。

本次未添加许可证。网络协议地址、端口与隔离边界保持原套件设计。

发行验证在本地 macOS 与 Ubuntu VM 完成；GitHub 托管 CI 待执行，详见验证记录。
