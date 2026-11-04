# CCVM 桌面端：实现说明与设计修订

这份说明对应设计方案《CCVM 桌面端设计方案》（2026-11-04 定稿），记录实现时确定的选择、对方案的修订，以及还没解决的问题。App 的代码在 [`app/`](../app/)，用法见 [app/README.md](../app/README.md)。

## 已确定的选择

| 问题 | 选择 | 原因 |
|---|---|---|
| 技术栈 | Electron + React | 透明置顶胶囊、字幕、以后的 xterm.js 内嵌终端都好做 |
| 本轮范围 | M0 + M1 + M2 | 脚本 JSON 输出、菜单栏与胶囊、主窗口（工作区、项目页、欢迎页、设置） |
| 仓库结构 | 同一仓库的 `app/` 目录 | App 与脚本版本锁在一起；打包时只把 Git 跟踪的 `scripts/`、`guest/`、`config/` 复制进 App |
| 出口基线放在哪 | 默认 `~/Library/Application Support/CCVM/state` | 放在 App 包里会随更新丢失；可以在设置里改指命令行套件的 `state/`，两边共用一份基线 |
| 私有仓库凭据 | App 不管 | 由你在 VM 的 cc 用户里配置 `gh auth` 或 SSH 密钥；克隆失败时显示 git 原话 |
| Claude 登录检测 | 只检测安装，登录由你确认 | 安全约束第 13 条：App 不读 VM 里的 `~/.claude` |
| Mac 执行通道（M5） | 暂不实现 | 见下文「未解决：执行通道绕过固定出口」 |
| 订阅格式（M3） | 只支持 Clash YAML | App 自己解析，只把选定节点写进核心配置，节点任何字段变了都能精确发现；base64 / 链接格式提示改用 Clash Verge 模式 |
| 核心程序（M3） | Homebrew 的 mihomo | App 不分发 mihomo；记录版本，升级后提示重做断流测试，通过后才算接受新版本 |
| 后台服务（M3） | launchctl + LaunchAgent | 不需要原生代码和签名，配 Homebrew 版最顺；KeepAlive 意外退出自动拉起 |
| 节点域名解析（M3） | 当前网卡的 DHCP DNS | 读取系统完整 DHCP 租约，筛选路由走当前物理网卡的 IPv4 DNS，并用 `地址#网卡` 绑定；无可用地址时停止核心 |
| 节点密码（M3） | 只留选定节点的 | 其他节点只存名称、类型、服务器和指纹；换节点和测延迟时重新下载订阅，只在内存里用 |
| 测延迟（M3） | 加按钮，点了才测 | 临时起一个没有任何入口的 mihomo，测完立刻删掉临时配置 |
| 订阅更新失败 | 只在设置里显示 | 核心继续用原来的节点，隔离不受影响，不算出错 |
| 切换出网方式 | 系统对话框确认 | 切换会短暂断网，出口也可能变 |
| 已有 Clash Verge 部署 | 保持不变 | 新装默认自带核心；已有设置文件里的方式不动 |
| 终端会话（M4） | 跑在 VM 里 cc 的 tmux 中 | 关标签、窗口或 App 只是断开，Claude 继续跑；回来就接上，外部终端也能 `tmux attach` |
| 「做完了」字幕（M4） | 设置里的开关，点了才装 | 可选功能，和隔离无关；hook 放在 VM 里 root 所有的 managed-settings 目录 |
| VS Code 远程（M4） | 这轮不做 | 见下文「VS Code 远程为什么先不做」 |

## 对设计方案的修订

1. **「设计理念」表与「网络出口」一节矛盾。** 理念表写「调用本机 Lima 和用户自己的 Clash Verge，不自带代理内核」，网络出口一节写默认使用自带 mihomo 核心。前者是 v1 的旧话。按定稿：自带核心是 M3 之后的默认方式，Clash Verge 模式保留。M1–M2 只实现 Clash Verge 模式，设置里的自带核心显示为「M3 规划中」，不能选。
2. **版本号。** 方案里写「v2.1 安装包」，仓库当前是 2.2.0。本轮脚本改动发布为 2.3.0（新增 `--json`，VM 内脚本输出带 id）。
3. **`rebaseline.sh` 需要非交互确认。** 原脚本要求在终端里输入 `yes`，App 调用不了。新增 `--dry-run`（只测量）和 `--accept IP`：脚本重新测量，Mac 与 VM 出口都等于你确认的 IP 才写入，确认期间出口又变了就拒绝。App 的流程是：先 `--dry-run` 给你看两端，你点确认，主进程再弹系统对话框（二次确认），最后 `--accept`。
4. **Claude Code hooks 怎么装（M4）。** 方案说 hook 往 cc 家目录的事件文件追加一行，但把 hook 写进 `~/.claude/settings.json` 与「不碰 `~/.claude`」冲突，而且 cc 用户（也就是 Claude 自己）能改掉它。建议在 VM 里由 root 写 `/etc/claude-code/managed-settings.json`：cc 改不了，App 也不用碰 `~/.claude`。
5. **「Claude 运行中」不依赖 hooks。** M2 由 VM 内 `/proc` 判断 cc 名下的 Claude 进程及其工作目录（`guest/workspace.sh`），只用于显示，不影响任何安全判断。「做完了」字幕仍等 M4 的 hooks。
6. **项目操作以 cc 身份运行。** 列项目、克隆都经 `sudo -u cc env -i ... bash -s`。如果以 root 在 cc 可写的仓库里跑 `git status`，仓库配置里的 `core.fsmonitor` 等可以让 root 执行任意命令。
7. **断流测试被中断时的恢复。** App 可以取消后台任务；取消后 SSH 断开，VM 内脚本收到 SIGHUP。脚本现在在 HUP/PIPE 时也会恢复 TUN，并在停掉 TUN 前注册一个 5 分钟后自动拉起 TUN 的 systemd 定时器作为兜底。TUN 停着时 VM 只是断网，不会泄漏，所以这只关乎可用性。
8. **检查结论会过期。** 超过 2.5 个检查间隔没有新结论时，状态从绿变灰（「需要重新检查」）。这是「不确定就当失败」的延伸：旧的绿不能一直挂着。

## M3 自带出口核心怎么做的

- **配置**（`app/core/mihomo.ts`）：一个 mixed 入口 `127.0.0.1:17897`，只收 TCP，`proxy` 固定为选定节点；规则只有 `MATCH,REJECT`；`allow-lan: false`，不开虚拟网卡，不开任何默认端口；`interface-name` 绑定物理网卡；控制接口只有 `external-controller-unix`；`dns.enable: true`（文档写明关掉时会改用系统 DNS，可能被 Clash Verge 接管）但不设 `listen`，`proxy-server-nameserver` 使用筛选后的 DHCP DNS 地址并绑定物理网卡，不自行发送 DHCP 广播。每次写入前都用 `coreConfigProblems` 反向核对一遍，不满足就不写。
- **节点固定**：每天更新订阅时，把订阅里的选定节点和核心配置里正在用的节点逐字段比较（键排序后比内容，不用任何哈希）：变了或消失，就停核心并卸载 LaunchAgent（下次登录也不会用旧节点启动），首页变红，等你点「使用新的节点信息」或换节点。下载失败不动核心。
- **网卡**：从 `scutil --nwi` 取第一块 `en*` 网卡，跳过 utun 等虚拟网卡。网卡变了：先停、改绑、再启动；没有物理网卡就保持停止，网卡回来自动恢复。
- **冲突**：启动前如果 17897 已经被占着（多半是 Clash Verge 里没移除的扩展脚本），拒绝启动并说明原因；运行中发现 17897 不是核心自己在听，首页变红。
- **出口路径变化后**：换节点、重启或移除核心、切换出网方式之后，之前的检查结论作废，状态先变灰，等下一次检查出结论。

### M3 还没验证的

- 真实 mihomo 的集成测试（`app/test/mihomo-real.test.ts`）在这个容器里没跑：按你的决定没有在这里编译 mihomo。它会在 CI 的 macOS 任务里用 Homebrew 的 mihomo 跑，也可以在 Mac 上用 `MIHOMO_BIN=$(which mihomo) npm test` 跑。它核对：流量经过节点、非回环地址连不上入口、不开 TCP 控制口和 DNS 监听、节点停了不会直连、启动时不下载 geo 数据。
- DHCP DNS 在 Wi-Fi / 热点 / 有线之间切换时的更新，`launchctl bootstrap` / `bootout` 在各 macOS 版本上的行为，都要上机验证。
- 测延迟用的测试地址是 `https://www.gstatic.com/generate_204`；在一些网络下可能需要换。

## M4 工作流怎么做的

- **内嵌终端**：界面是 xterm.js，主进程每个标签起一个 node-pty，运行 `scripts/enter.sh`。新会话走 `--project 名称 --session 会话名`：先做和外部终端一样的检查，再 `tmux new-session -A`；接回已有会话走 `--attach 会话名`：不做检查，只 `tmux attach`。出错时只拦新会话，正在跑的会话可以接回（设计方案「正在跑的会话不打断」）。主进程在打开新会话前也会再判断一次，界面按钮变灰只是第二道。
- **会话**：`workspace.sh list` 同时列出 cc 的 tmux 会话，按起始目录归到项目。新会话名是 `<项目>-<序号>`，只用 `[A-Za-z0-9_-]`。结束会话要在系统对话框里确认。
- **终端的数据**：每个终端只属于打开它的那个窗口；写入、调整大小都核对归属。窗口关掉时它的终端随之断开，VM 里的会话不受影响。
- **node-pty 是原生模块**：`npm install` 后要 `npm run rebuild` 按 Electron 的 ABI 编译。它延迟加载：编译不对时只有内嵌终端不可用，菜单栏、检查和外部终端照常工作。
- **完成提醒 hook**：`scripts/hooks.sh enable` 在 VM 里写 `/usr/local/lib/ccvm/claude-hook` 和 `/etc/claude-code/managed-settings.d/50-ccvm.json`（都是 root 所有，cc 改不了；不动已有的 `managed-settings.json`）。hook 用 `async`，永远 exit 0、不输出任何东西，所以不会影响 Claude（Stop hook 退出码 2 会阻止 Claude 停下，这里刻意避开）。它只记事件类型、时间、工作目录和截断到 160 字的通知文字；Stop 事件带的 Claude 最后一条回复不记录。App 每 10 秒经 SSH 从 `~/.ccvm/events.jsonl` 读新事件；第一次从文件末尾开始，不补发旧事件。事件文件 cc 可以写，所以内容按不可信处理：只接受 Stop / Notification，去掉控制字符，只当文字显示。「做完了」同一项目 5 分钟内只弹一次，「在等你」1 分钟内一次，只出字幕，不发系统通知。

## 外部终端、`ccvm` 与 Ghostty

- **一份环境设置**：清代理变量、设 `CCVM_*` 和 `PATH`、调用 `enter.sh` 只写在 App 生成的 `ccvm` 脚本里（`app/core/cli.ts`）。App 自己用的一份在 `~/Library/Application Support/CCVM/bin/ccvm`，用户点「安装」后另写一份到 `~/.local/bin/ccvm`。Terminal / iTerm 运行的 `.command` 文件只有一行 `exec /bin/bash <ccvm> [项目]`；Ghostty 直接运行 `ccvm`。设置或登录 shell 的 `PATH` 变了，两份都自动重写；`~/.local/bin/ccvm` 已存在但不是 CCVM 生成的（第二行不是「由 CCVM 生成，会被覆盖。」），App 不覆盖它。
- **`ccvm <项目>` 的会话名**：`enter.sh --project P --session auto` 在检查通过之后，以 cc 身份读 `tmux list-sessions`（没有 tmux 服务端时当作没有会话），按 App 的 `nextSessionName` 同一规则取名：项目名里 `[A-Za-z0-9_-]` 以外的字符换成 `_`，接 `-序号`，取第一个空闲的序号。所以外部终端开的会话和内嵌终端开的一样出现在项目页。
- **Ghostty**：主进程用 `osascript` 执行 AppleScript（Ghostty 1.3.0 起支持）：`new surface configuration`，`command` 设成 `ccvm` 的绝对路径加参数，`initial working directory` 设成家目录，`wait after command` 设为真（检查不过被拒绝时窗口留着，能看到原因），然后 `new window with configuration`。`command` 带参数时 Ghostty 用 `/bin/sh -c` 执行，所以每个参数先按 shell 单引号加引号，整串再转义 `\` 和 `"` 写进 AppleScript。参数只来自校验过的项目名（`[A-Za-z0-9._-]`），仍然照样转义。被拒绝「自动化」权限时提示去 系统设置 → 隐私与安全性 → 自动化 里允许；AppleScript 不可用（Ghostty 低于 1.3.0）时提示升级或改用 `ccvm`。`open -na Ghostty --args -e …` 的行为文档里没有说明，不作为方案。
- **为什么做不到「在 VM 窗口里按 Cmd+T 自动进 VM」**：Ghostty 的配置不按窗口区分（`command` 对所有新窗口和标签生效），`new_tab` 动作也不能带命令。替代办法：Cmd+T 后输入 `ccvm`；或者这个 Ghostty 只用来开 VM 时，在配置里写 `command = ~/.local/bin/ccvm`。
- **快捷键 `cmd+shift+t` 新标签并输入 `ccvm`，尚未实测，暂不写进用法**：

  ```
  keybind = cmd+shift+t=new_tab
  keybind = chain=text:ccvm\n
  ```

  Ghostty 文档只说 chain 里的动作「按顺序执行」，没有说明 `new_tab` 之后的 `text:` 是输进新标签还是原来的标签。要在真机上试：文字进了新标签才写进 README；进了原来的标签就删掉这一条。

### 外部终端还没上机验证的

这一轮在 Linux 容器里完成，以下几项必须在 Mac 上逐项确认，结果补到这里：

1. 设置选 Ghostty 后，「在终端打开」能开出一个 Ghostty 窗口，先过检查再进 cc；拒绝「自动化」权限时界面给出提示。
2. 在 Ghostty 里按 Cmd+T，输入 `ccvm my-api`，新建的会话出现在 App 项目页的会话列表里。
3. 出口出错时，`ccvm my-api` 被拒绝，`ccvm -a <已有会话>` 可以接入。
4. 上面的快捷键到底输进哪个标签。

## VS Code 远程为什么先不做

设计方案只要求「一键用 VS Code 打开时写入 `remote.autoForwardPorts: false`」。核对后发现，VS Code 远程连接在 VM 和 Mac 之间打开的通道不止端口转发：

| 通道 | 方向与影响 |
|---|---|
| 剪贴板 | 远程端（VM 里）运行的 VS Code 扩展可以通过扩展 API 读写 Mac 的剪贴板 |
| Git 认证 | VS Code 会让远程终端里的 `git` 借用本机的认证（`git.terminalAuthentication`、`github.gitAuthentication`）：VM 里的进程可能拿到你 Mac 上 VS Code 登录的 GitHub 账号去推送 |
| 打开链接 | 远程端可以让本机打开浏览器；打开 `localhost` 链接时 VS Code 会自动建端口隧道 |
| 端口转发 | `remote.autoForwardPorts` 只是其中一项；还有 `remote.forwardOnOpen` 等 |
| SSH agent | Remote-SSH 默认可能转发本机 SSH agent（`remote.SSH.enableAgentForwarding`） |
| 连接本身 | 需要给 cc 一把能从 Mac 登录 VM 的 SSH 密钥（方向是 Mac → VM，本身可以接受） |

关键在于：Claude 在 VM 里以 cc 身份运行，能往 `~/.vscode-server/extensions` 装扩展。设置项可以关掉 Git 认证、端口转发和 agent 转发，但扩展 API 这类通道（剪贴板、打开链接）在设置里关不干净。这会削弱「VM 连不到 Mac」这条底线，所以这一轮不提供一键连接；代码继续只走 Git：在 VM 里推分支，回到 Mac 上审看。

以后如果要做，至少需要：独立的 cc SSH 密钥和 `ForwardAgent no`；远程与工作区设置里关掉端口转发、Git / GitHub 认证、agent 转发；并在界面上写明剪贴板和扩展 API 的残余风险，由你逐次确认。

## 未解决：执行通道绕过固定出口（M5）

方案里，被批准的命令以专用账户 `ccvm-bot` 在 Mac 上运行，影响范围写的是「`ccvm-bot` 和它的工作目录」。还漏了一项：**网络**。

- `xcodebuild test` 这类命令会运行项目里的代码，也就是 VM 里 Claude 写出来的代码。
- `ccvm-bot` 在 Mac 上的网络不受限：可以绕过固定节点直接出网，也能连到 Mac 本机的 Clash 日常端口 7897 和控制器 9090。
- 「以后都允许 xcodebuild test」之后，每次 VM 里改了测试代码，都等于在 Mac 上以不受限的网络运行一段新代码。「出网只有一条路」就不成立了。
- `ccvm-bot` 默认会在 `staff` 组，你家目录里对组可读的文件它能不能读到，需要在实机上逐一核对。

候选补法（需要在实机上验证 xcodebuild 和模拟器能否在限制下运行）：

| 方案 | 效果 | 风险 |
|---|---|---|
| pf 按用户过滤 | `ccvm-bot` 只能连 127.0.0.1:17897，其余出站全部拒绝；依赖下载也走固定节点 | pf 的 `user` 规则在 macOS 上的可靠性要实测；要管理员权限加载规则 |
| `sandbox-exec` 配置 | 禁网、只读系统目录和工作目录，最严格 | xcodebuild 与模拟器依赖 XPC 服务，可能跑不起来；`sandbox-exec` 已标记废弃 |
| 逐条审批不变、只靠人看 | 不改系统 | 漏洞仍在 |

在选定补法并实测之前，App 不启用这个功能（设置 → Mac 执行里写明了原因）。

## 验证范围

本轮在 Linux 云端容器里完成，**没有在真实的 Mac、Lima 或 Clash Verge 上运行过**。

- 脚本：33 项 Python 用例（含 21 项新的事件流用例），用桩 `limactl` / `curl` / `netstat` 驱动真实脚本。macOS 自带 Bash 3.2 没有在本地测，由 CI 的 macOS 任务覆盖。
- App 核心：49 项 vitest 用例，其中控制器用例端到端驱动真实的 `scripts/check.sh` 与 `rebaseline.sh`。
- 界面：浏览器里用演示数据（`?demo=`）走过「出口变了 → 测量两端 → 确认 → 恢复受保护」和克隆地址校验。
- 内嵌终端（M4）：在 Xvfb 下用 Playwright 驱动真实的 Electron App：点「新会话」后经真实的 node-pty 运行 `enter.sh`，检查通过后执行 `tmux new-session`（桩 limactl 把它换成交互式 bash），键入命令并在 xterm 里读到输出。真实 VM 里的 tmux、hook 在真实 Claude Code 下的触发，都还没验证。
- Electron：在 Linux 的 Xvfb 下以普通用户启动真实 App。它经登录 shell 找到桩 `limactl`，跑通快速检查，打开主窗口并列出项目。唯一的出网请求是 Chromium 在 Linux 上下载拼写词典；macOS 使用系统拼写检查，不下载。菜单栏、系统通知、`.command` 终端启动、登录启动都是 macOS 专属，没有验证。

上机后请先跑一遍：`bash scripts/check.sh --json`、`bash scripts/leaktest.sh --json`，再打开 App 对照。
