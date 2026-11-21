# 事件输出（--json）

宿主脚本加 `--json` 后，stdout 只输出 NDJSON 事件，一行一个；给人看的文字和 limactl、apt 等的输出都改到 stderr。不加 `--json` 时，命令行用法和输出与以前一样。

CCVM 桌面端只显示这里的结论和脚本原话，自己不做判断。所以界面上的每个结论，都能在终端用同一条命令复现：

```bash
bash scripts/check.sh --json
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
| `item` | `kind` 及其字段 | 列表项：`project`、`session`、`claude_event`、`share`、`file`（见文末） |
| `log` | `level`（`info` / `warn` / `detail`）、`msg` | 过程信息 |
| `error` | `msg` | 脚本因错误终止前的最后一句话 |
| `end` | `ok`、`code` | 最后一条事件 |

`setup.sh --json` 在第 4 步调用 `check.sh`，它的事件直接并入同一个流，不重复 `start` / `end`（子脚本运行时带 `CCVM_EVENT_CHILD=1`）。

## 脚本与参数

| 命令 | 作用 |
|---|---|
| `check.sh [--json]` | 状态检查：Mac 上的代理入口通不通，VM 里防火墙、TUN 在不在、能不能经代理出网 |
| `setup.sh [--json]` | 一键部署，步骤为 `setup.proxy` → `setup.vm` → `setup.install` → `setup.verify` |
| `preflight.sh [--json]` | 部署前检查，不需要 VM，逐项报告 |
| `upgrade.sh [--json]` | 更新已部署的 VM（`setup.sh` 看到已安装就跳过网络层安装，早先部署的 VM 会缺后来加的东西）。按级别逐步补上：1 = `git`、`tmux`；2 = networkd 保留 TUN 的策略路由（`ManageForeignRoutingPolicyRules=no`）+ TUN 看门狗（每 30 秒检查，路由丢了就重启 TUN）。不改防火墙规则、sing-box 配置和 DNS；`setup.sh` 每次也会跑一遍；步骤为 `upgrade.packages` → `upgrade.verify`，后者跑状态检查，事件并入同一个流 |
| `vm.sh start\|stop\|status [--json]` | 启停 VM |
| `workspace.sh list\|claude\|clone URL\|kill-session 会话名\|rename-session 旧名 新名 [--json]` | VM 里 `~/work` 的项目与 tmux 会话、Claude Code 是否已安装、以 cc 身份克隆、结束会话、给会话改名 |
| `hooks.sh enable\|disable\|status [--json]` | 「Claude 做完了」字幕用的 hook：装在 VM 里 root 所有的 managed-settings 目录里，cc 改不了 |
| `enter.sh [--project 名称] [--session 会话名\|auto] \| --attach 会话名` | 交互入口（没有 JSON 模式）。VM 没运行时先启动。`--session` 新建或接入 tmux 会话，`auto` 按 `<项目>-<第一个空闲序号>` 取名；`--attach` 只接入已有会话 |
| `share.sh status\|apply [--json]` | 共享文件夹（读写）。`status` 列出 `$STATE/shares.txt` 里的共享并逐个检查路径；VM 在运行时再到 VM 里只读核对 cc 看到的 `/home/cc/mac/<名字>` 挂没挂上；`apply` 检查路径 → 停 VM → `limactl edit --set '.mounts = [...]'` → 启动 → 在 VM 里设置 bindfs 映射。步骤为 `share.check` → `share.stop` → `share.edit` → `share.start` → `share.guest` |
| `files.sh list\|mkdir\|rm <VM路径> [--json]` | 浏览 VM 里 cc 的家目录；只能碰 `/home/cc` 下面，不能删 `/home/cc`、`/home/cc/mac`、`/home/cc/mac/<名字>` |
| `files.sh push <Mac源路径> <VM目标目录> [--json]` | 上传普通文件或文件夹（顶层不能是符号链接），`tar` 管道以 cc 身份解包 |
| `files.sh pull <VM文件> <Mac目标文件> [--force] [--json]` | 只下载单个普通文件，不跟符号链接、不支持目录；Mac 上目标已存在时要 `--force` |

## 检查项 id

id 是 App 与脚本之间的接口。可以改说明文字，改 id 要同时改 App 和这张表。`verification/test_events.py` 会核对脚本里出现的每个 id 都在这里有记录。

### Mac 与 Lima

| id | 含义 |
|---|---|
| `host.macos_arm64` | 在 Apple Silicon Mac 的原生 arm64 终端里运行 |
| `lima.version` | 已安装 Lima，且版本 ≥ 2.1.0 |
| `host.proxy` | 经 Mac 上的代理入口 127.0.0.1:17897 能拿到出口 IP |
| `vm.exists` | VM 实例存在 |
| `vm.upgrade` | VM 已更新到套件要求的级别（`guest/upgrade.sh`：读 `/var/lib/ccvm/level`，不存在当作 0，按顺序执行更高级别的步骤，每完成一步写入新级别） |
| `vm.running` | VM 正在运行 |

### VM 内（`guest/selfcheck.sh`）

| id | 含义 |
|---|---|
| `vm.firewall` | 防火墙服务运行中，主规则已加载 |
| `vm.tun` | TUN 服务运行、`sb-tun` 存在，策略路由在（`ip rule` 指向表 2022，表里有路由） |
| `vm.proxy` | cc 用户经代理出网；`EGRESS` 行给出出口 IP |

出口 IP 只用来显示。代理通着、IP 变了（换节点、供应商换 IP）都算正常。

### 项目（`guest/workspace.sh`，以 cc 身份运行）

| id | 含义 |
|---|---|
| `project.url` | Git 地址格式允许：`https://主机/路径`、`ssh://git@主机/路径`、`git@主机:路径`，不带账号或令牌 |
| `project.name` | 能从地址里取出合法项目名 |
| `project.clone` | 克隆完成 |
| `claude.installed` | cc 的 `~/.local/bin/claude` 存在且 `--version` 能运行 |
| `session.kill` | 结束了 cc 的一个 tmux 会话（会话名只允许 `[A-Za-z0-9_-]`，最长 64） |
| `session.rename` | 给 cc 的一个 tmux 会话改了名（新旧名字都只允许 `[A-Za-z0-9_-]`，最长 64；新名已被占用时失败）。接入着的终端不受影响 |

### 共享文件夹（`scripts/share.sh`、`guest/shares.sh`，可选）

| id | 含义 |
|---|---|
| `share.paths` | 共享路径可以共享：绝对路径、存在、是文件夹；按真实路径判断，不是 `/`、`/Users`、`/Volumes` 等系统目录，不是家目录本身或家目录下的隐藏目录，不等于、不在里面、也不包含 `~/Library`、`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config`、`~/.kube`、`~/.docker`、Lima 目录、状态目录和套件目录。`apply` 时有一个不通过就停止，不改动 VM |
| `share.lima_mounts` | `limactl edit` 已把挂载列表写进 Lima 实例配置 |
| `share.guest` | VM 里 `/home/cc/mac/<名字>` 都已经用 bindfs 挂上（`apply` / `verify`），或者映射已移除（`remove`） |

### 传文件（`scripts/files.sh`、`guest/files.sh`，以 cc 身份运行）

| id | 含义 |
|---|---|
| `files.path` | VM 路径是 `/home/cc` 或以 `/home/cc/` 开头，没有 `..` 段和换行（宿主端先查，不通过就不连 VM）；VM 内按真实路径（解开符号链接后）再查一遍 |
| `files.list` | 列出了一个文件夹 |
| `files.mkdir` | 新建了文件夹 |
| `files.rm` | 删除了文件或文件夹（删符号链接时删的是链接本身） |
| `files.push` | 目标是 cc 家目录下可写的文件夹；上传完成 |
| `files.pull` | 源是普通文件、不是符号链接；下载完成（先写到同目录的临时文件，成功后再改名） |

### 完成提醒 hook（`guest/hooks.sh`，可选）

| id | 含义 |
|---|---|
| `hooks.installed` | 已在 VM 里装好 `/usr/local/lib/ccvm/claude-hook` 和 `/etc/claude-code/managed-settings.d/50-ccvm.json` |
| `hooks.removed` | 已移除这两个文件 |
| `guest.user` / `guest.usage` | VM 内脚本的调用错误 |

## 常见的值（value）

| key | 来源 |
|---|---|
| `host_egress` | 经 Mac 代理入口的出口 IP；不通时为空 |
| `vm_egress` | VM 内 cc 用户的出口 IP；不通时为空 |
| `lima_version` | Lima 版本 |
| `vm_status` | `Running`、`Stopped`、`Missing` 等 |
| `vm_resources` | `CPU数 内存字节 磁盘字节` |
| `project` / `project_count` / `session_count` | 克隆出的项目名 / 列表中的项目数 / tmux 会话数 |
| `hooks_enabled` | 完成提醒 hook 是否已安装（`1` / `0`） |
| `events_size` | `~/.ccvm/events.jsonl` 读到的位置（字节），下次从这里接着读 |
| `claude_installed` / `claude_version` | `1` 或 `0` / 版本字符串 |
| `vm_level` / `vm_level_target` | VM 里的软件包级别（`/var/lib/ccvm/level`，读不到当作 0）/ 套件要求的级别（`scripts/lib.sh` 的 `VM_LEVEL`）。`workspace.sh list` 和 `upgrade.sh` 都会给出 |
| `tmux_installed` | VM 里有没有 tmux（`1` / `0`），`workspace.sh list` 给出；没有时 App 提示补装，内嵌终端不开新会话 |
| `share_count` | `shares.txt` 里的共享文件夹数 |
| `path` | `files.sh list` 列出的文件夹的真实路径 |
| `truncated` | `files.sh list` 条目太多时只列出的条数 |

## 项目列表项

`workspace.sh list --json` 为每个项目输出一条：

```json
{"v":1,"type":"item","kind":"project","name":"my-api","branch":"main","dirty":3,"ahead":1,"behind":0,
 "updated":1793000000,"subject":"最后一次提交的说明","remote":"https://github.com/you/my-api.git",
 "claude_sessions":1,"claude_since":1792999000}
```

同一次还会为 cc 的每个 tmux 会话输出一条：

```json
{"v":1,"type":"item","kind":"session","name":"my-api-1","created":1793000100,"attached":1,"project":"my-api","activity":1793000900,"command":"claude"}
```

`workspace.sh events <偏移|end>` 为 hook 记下的每条 Claude 事件输出一条（文件由 cc 写，内容按不可信处理：只接受 Stop / Notification，去掉控制字符并截断）：

```json
{"v":1,"type":"item","kind":"claude_event","t":1793000000,"event":"Stop","project":"my-api","notification":"","message":""}
```

`project` 由会话的起始目录推出（`~/work/<项目>`），不在项目里的会话为空字符串。`activity` 是最后活动时间，`command` 是会话当前窗格里在跑的命令（例如 `claude`、`bash`）。

`remote` 已去掉地址里的账号和令牌。`claude_sessions` 是工作目录在该项目下的 Claude Code 进程数，由 VM 内的 `/proc` 判断，不读 `~/.claude`。

## 共享文件夹与文件列表项

`share.sh status --json` 为 `shares.txt` 里的每个共享输出一条（`problem` 为空表示可以共享）：

```json
{"v":1,"type":"item","kind":"share","path":"/Volumes/Work/my-api","name":"my-api","mount_point":"/mnt/ccvm-raw/my-api","view":"/home/cc/mac/my-api","problem":"","mounted":true}
```

`mounted` 是 VM 里 cc 看到的目录挂没挂上；VM 没运行或读不到时为 `null`（不确定，不当作挂上了）。只写了 `shares.txt`、原始目录挂上了，不等于「已应用」。

名字取路径最后一级目录名，`[A-Za-z0-9._-]` 以外的字符（按字节）换成 `_`，重名依次加 `-2`、`-3`。这个规则只在 `scripts/lib.sh` 的 `share_names` 里实现，App 显示名字时读这里的输出。

`files.sh list --json` 为文件夹里的每个条目输出一条，目录在前：

```json
{"v":1,"type":"item","kind":"file","name":"README.md","file_type":"file","size":1234,"mtime":1793000000}
```

`file_type` 是 `file`、`dir`、`link`、`other` 之一（不叫 `type`：每条事件的 `type` 已经是 `item`）；名字里的 `\x1f`、`\r`、`\n` 已去掉。
