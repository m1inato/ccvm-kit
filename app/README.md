# CCVM 桌面端（Electron）

Mac 菜单栏应用加主窗口：主角是项目和 Claude 会话，网络隔离是底色。App 自己不做安全判断，所有结论都来自仓库里的脚本（`--json` 事件，见 [docs/events.md](../docs/events.md)）；App 退出、崩溃或被卸载，VM 照样只能走专用入口。

当前进度：M0（脚本 JSON 输出）+ M1（菜单栏、桌面胶囊、四种状态、定时检查与通知、启停 VM、用外部终端以 cc 打开）+ M2（工作区、项目页右侧面板、欢迎页、设置）+ M3（自带出口核心）+ M4（内嵌终端与 tmux 会话、「Claude 做完了」字幕）。VS Code 远程这一轮不做（原因见实现说明）；Mac 执行通道是 M5（暂缓，原因见 [实现说明](../docs/desktop-app.md)）。

出网方式二选一：

- **CCVM 自带核心**（新装默认）：用 Homebrew 装的 mihomo（`brew install mihomo`），App 用 launchd 作为你的后台服务运行。贴订阅链接、选一个节点即可；和日常 Clash Verge 完全独立。
- **我的 Clash Verge**：粘贴一次扩展脚本，加一个专用入口。已有部署保持这个方式，不会被自动切换。

## 开发

需要 Node.js ≥ 22。只在 Mac 上开发 App 时需要它；部署和日常使用 VM 不需要。

```bash
cd app
npm install
npm run rebuild     # 把 node-pty（内嵌终端）按 Electron 的 ABI 重新编译；npm install 之后跑一次
npm test            # 核心逻辑：事件解析、状态推导、后台任务、出口核心，端到端驱动真实脚本
MIHOMO_BIN=$(which mihomo) npm test   # 另外用真实 mihomo 跑一遍生成的核心配置
npm run typecheck
npm start           # 构建后用 Electron 打开
npm run dist        # 打包 dmg（未签名；发给别人需要签名和公证）
```

只看界面：`npm run dev`，浏览器打开 `http://localhost:5199/?demo=ok`。`demo` 可选 `ok`（自带核心）、`cv`（Clash Verge 模式）、`egress`（出口变了）、`node`（选定节点变了）、`busy`、`stopped`、`welcome`、`setup`、`shares`（共享文件夹与「文件」页）、`upgrade`（需要补装软件包）。这时用的是演示数据，不会调用任何脚本。

## 在任意终端里用 `ccvm`

桌面端的 设置 → 通用 →「安装命令行入口 `ccvm`」会生成 `~/.local/bin/ccvm`（权限 0755，不需要管理员权限）。它清掉代理变量，只带 CCVM 的设置和登录 shell 的 `PATH`，然后调用 App 包里套件的 `scripts/enter.sh`：先检查，检查不过就拒绝。VM 名、Lima 目录、状态目录改了，App 会自动重新生成它；文件开头写着「由 CCVM 生成，会被覆盖」，不要手改。

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

这样所有新窗口和新标签都直接进 VM（Ghostty 文档没有写明 `command` 里的 `~` 一定会展开；如果提示找不到命令，换成 `echo ~/.local/bin/ccvm` 打印出的绝对路径）。Ghostty 没有按窗口区分的配置，新建标签的动作也不能带命令，所以做不到「只在 VM 窗口里按 Cmd+T 自动进 VM」，原因见 [桌面端说明](../docs/desktop-app.md)。

## 结构

```
core/        不依赖 Electron 的逻辑，可以在任何平台测试
  events.ts    NDJSON 解析与结论（不确定就当失败）
  status.ts    四种状态、问题归类、提醒去重
  jobs.ts      后台任务：脱离 App 运行，App 退出后继续，重开时接回
  runner.ts    干净环境下运行脚本（只允许 scripts/ 里的白名单脚本）
  env.ts       构造脚本环境：没有任何代理变量，PATH 只取自登录 shell
  mihomo.ts    出口核心的配置生成与自检、订阅解析（只支持 Clash YAML）
  egress.ts    出口核心管理：launchd 服务、节点固定与变化确认、网卡改绑、测延迟、连接
  fetch.ts     下载订阅：直连或经 Clash Verge 的 7897，只接受 https
  controller.ts  定时检查、任务、快照
electron/    主进程（菜单栏、胶囊、主窗口、通知）与沙盒预加载
src/         React 界面
build/       打包脚本：copy-kit.mjs 只复制 Git 跟踪的套件文件
```

## 安全上的做法

- 界面运行在沙盒里（`contextIsolation`、`sandbox`、无 Node），只能经三个 IPC 入口调用白名单动作，主进程逐个校验参数。
- 窗口不能导航到外部页面；外链只放行少数 https 文档站点。会话拒绝所有权限请求，并拦截所有非本地请求。
- 脚本用从零构造的环境运行：不传 `HTTP(S)_PROXY`、`ALL_PROXY`、`NO_PROXY`。
- 更新出口基线要两步：先测量两端，再在系统对话框里确认；脚本写入前还会重新测量。
- 出问题时不再打开新会话（终端按钮变灰，`enter.sh` 也会拒绝）。
- 打包进 App 的只有 Git 跟踪的套件文件，本机的 `config/local.env`、`*.local.js`、`state/` 不会进去。
