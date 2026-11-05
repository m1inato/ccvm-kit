# Changelog

## 2.3.0 — 未发布

第一版桌面端（`app/`），以及它用到的脚本接口。命令行用法保持兼容。

### 桌面端

- 菜单栏状态点与桌面胶囊；首页、项目页、安全页、设置、欢迎页。出错时系统通知一次，并且不再开新会话。
- 两种出网方式：CCVM 自带核心（Homebrew 的 mihomo，以 LaunchAgent 运行，只支持 Clash YAML 订阅，节点变化先断网再确认）或 Clash Verge。
- 内嵌终端：会话跑在 VM 里 cc 的 tmux 中，关窗口只是断开；会话列表显示每个会话在跑什么、最后活动时间，可以改名。
- 安全页：链路、连接、检查和断流测试在同一页；连接列表核对每条是否只经过选定节点，两种出网方式都支持（Clash Verge 需要打开它的外部控制器，只读）。
- 测延迟和 Clash Verge 口径一致（统一延迟，测试地址可设置）。
- 外部终端：Terminal、iTerm、Ghostty；命令行入口 `ccvm`，在任意终端里 `ccvm`、`ccvm <项目>`、`ccvm -a <会话>`。
- 共享文件夹（可选，默认关闭）：把选定的 Mac 文件夹读写挂进 VM。这会削弱隔离，风险见 `docs/desktop-app.md`。
- 文件：浏览 VM 里 cc 的家目录，上传、下载、新建、删除。
- 「Claude 做完了」提醒（可选）。
- VM 需要更新时首页提示，一键更新。
- 浅色、深色主题。

### 脚本

- 宿主脚本支持 `--json`，输出带稳定 id 的事件，格式见 `docs/events.md`。
- 新增 `vm.sh`、`preflight.sh`、`workspace.sh`、`hooks.sh`、`share.sh`、`files.sh`、`upgrade.sh`。
- `check.sh --quick`；`rebaseline.sh --dry-run` 与 `--accept IP`。
- `enter.sh`：`--project`、`--session`（含 `auto`）、`--attach`。
- `upgrade.sh` 按级别更新已部署的 VM，`setup.sh` 每次也会运行它：补装 `git`、`tmux`；让 networkd 保留 TUN 的策略路由，并加 TUN 看门狗，系统更新重启网络服务后不再断网。
- 快速检查新增 `vm.tun_routes`；`lima.effective_config` 与 `vm.no_host_mounts` 按允许的共享文件夹核对。
- 断流测试被中断时也会恢复 TUN。
- 不再生成校验文件，规则见 `AGENTS.md`。

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
