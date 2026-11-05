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
- 共享文件夹（读写，**有意的设计降级**，默认关闭）：`$STATE/shares.txt` 是唯一来源；新增 `share.sh status|apply`（`limactl edit` 写挂载、重启 VM）与 VM 内 `guest/shares.sh`（bindfs 把 `/mnt/ccvm-raw/<名字>` 映射到 `/home/cc/mac/<名字>`）。`lima.effective_config` 改为要求挂载集合正好等于 `shares.txt`；`vm.no_host_mounts` 改为「没有未经允许的宿主目录挂载」，`check.sh` 完整验收把共享名传给 VM。禁止共享家目录、敏感目录和 CCVM 自己的目录。说明见 `docs/desktop-app.md`。
- 传文件：新增 `files.sh list|mkdir|rm|push|pull`（以 cc 身份，只能碰 `/home/cc`，下载只支持单个普通文件）。
- 桌面端：设置新增「共享文件夹」分页，顶栏 / 胶囊 / 链路面板 / 验收记录常驻「共享 N 个文件夹 · 读写」；新增「文件」页（浏览、上传、拖入、新建、删除、下载）。
- 共享文件夹修复：安装 bindfs 前清除 Lima 继承的代理环境变量，经现有 TUN 下载；显式设置 `subtype=bindfs`，使实际挂载类型与验收一致。
- 修复 macOS Bash 3.2 下共享路径错误提示紧跟中文标点时的变量解析问题；新增代理环境清理与挂载类型的回归测试。
- 桌面端修复：`refreshVm` 在拿到登录 shell 的 PATH 之前不再运行，较早发起的结果也不会覆盖较新的（原来会偶发地把 VM 错报成「找不到 limactl」）。
- 测延迟和 Clash Verge 对齐口径：临时核心开 `unified-delay`，测试地址可在设置里改（默认 generate_204），每个节点热身一次再取第二次结果，超时 5 秒；界面显示实际用的地址。
- 新增 `upgrade.sh` 与 VM 内 `guest/upgrade.sh`：按 `/var/lib/ccvm/level` 给已部署的 VM 补装后来新加的软件包（第 1 步：`git`、`tmux`），不碰网络配置，完成后自动完整验收。新装的 VM 由 `install.sh` 直接写入当前级别。`workspace.sh list` 输出 `tmux_installed`、`vm_level`、`vm_level_target`；桌面端在需要时显示灰色的「VM 需要补装软件包」卡片（不算出错），补装是后台任务。
- 会话改名：`workspace.sh rename-session <旧名> <新名>`（检查 id `session.rename`）；项目页双击会话名改名，内嵌终端的标签跟着换名。
- 桌面端浅色主题：设置 → 通用 → 外观（跟随系统 / 深色 / 浅色），胶囊、主窗口底色和内嵌终端配色一起变。
- App 图标在构建时由 `app/build/make-icon.mjs` 画出（深色圆角方块 + 状态点绿色的盾牌），PNG 只用 Node 自带的 zlib 编码，macOS 上用 `iconutil` 转成 `.icns`；产物不进仓库，没有 `iconutil` 时只生成 PNG。
- 按共享文件夹修复的同一思路：`guest/upgrade.sh` 运行 apt 前也清掉 Lima 继承的代理变量；`files.sh` 修正 Bash 3.2 下变量紧跟中文标点的写法，并新增静态检查（宿主脚本里 `$变量` 后面不能直接跟非 ASCII 字符）。共享与补装的 apt 测试改为不依赖测试机上是否装了 bindfs。
- 桌面端：Clash Verge 模式的「连接」面板。只读它的外部控制器（地址只能是本机回环，只允许 `GET /connections`、`/version`、`/proxies/CC-VM-FIXED`），密钥存钥匙串；只看 `cc-vm-in` 的连接，链路不是正好 `[节点, CC-VM-FIXED]` 的在面板里标红（不影响首页状态）。和自带核心的面板共用一个组件。
- 系统更新后 VM 断网的修复进入正式版本：`guest/upgrade.sh` 第 2 级让 networkd 保留 sing-box 的策略路由（`ManageForeignRoutingPolicyRules=no`），并加 TUN 看门狗（路由丢了 30 秒内重启 TUN）；快速检查新增 `vm.tun_routes`，首页直接说「TUN 的路由丢了」。`setup.sh` 装完后总会跑升级步骤，已有的 VM 用首页的「更新 VM」或 `upgrade.sh`。
- 共享文件夹「已应用」的判断改为核对 VM 里 cc 看到的目录：`share.sh status` 在 VM 运行时逐个核对，输出 `mounted`；没挂上或上次应用失败时，设置页可以「重新应用并重启 VM」（原来设置没变就点不了）。
- 断流测试没通过时，提示卡说明怎么解除（问题修好后重新做一次，通过才解除；快速检查恢复正常代替不了），并给出「重新做断流测试」按钮。限制本身不变。
- 桌面端测试不再连本机真实的 17897：出口核心的端口探测可以注入，测试用假的；在出口核心正在运行的 Mac 上跑 `npm test` 也不会失败（真实探测改在随机空闲端口上测）。
- 内嵌终端：node-pty 的 `spawn-helper` 丢了执行权限时（解包、拷贝 App 后会报 `posix_spawnp failed`），打包的 `afterPack` 钩子和运行时都会补回 0755，补不上时说清楚原因。
- 构建追溯：构建时把套件来自的 Git 提交（以及有没有未提交的改动）写进 App 里的 `kit/BUILD`，设置页和导出的验收记录里显示。
- Ghostty 修复：`enter.sh` 进 VM 前把 Ghostty 的 `TERM=xterm-ghostty` 换成 `xterm-256color`（VM 里没有它的 terminfo，tmux 会起不来）；App 打包加上 Apple Events 授权和 `NSAppleEventsUsageDescription`（hardened runtime 下缺了它们，macOS 不弹「自动化」请求、直接拒绝）。
- 桌面胶囊修复：窗口跟内容一样大（原来 480×170 的透明窗口会挡住下面窗口的点击）；按钮第一下就能点（`acceptFirstMouse`）；打开胶囊不再隐藏 Dock 图标；显示器变化后拉回屏幕内；胶囊里的操作失败时显示原因。

- 打包不再生成校验文件；桌面端判断节点是否变化改为逐字段比较内容。项目不使用这类哈希，规则见 `AGENTS.md`。

桌面端最初在 Linux 容器中验证；共享文件夹修复已于 2026-11-05 在 Mac / Lima 实机验证，范围见 `verification/RESULTS.md`。

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
