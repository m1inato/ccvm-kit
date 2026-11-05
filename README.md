# CCVM

在 Apple Silicon Mac 上给 Claude Code 一台独立的 VM：所有流量只从你选定的一个代理节点出去，代理断了就断网，不会改走直连。

```text
VM 里的 cc 用户 → sing-box TUN → 192.168.5.2:17897
                                 │ Lima NAT
Mac 的 127.0.0.1:17897 → 你选定的节点
```

- Ubuntu 24.04 ARM64，默认 4 vCPU / 6 GB 内存 / 60 GB 磁盘。
- Claude 以没有 sudo 的 `cc` 用户运行。
- TCP 走节点，DNS 经节点做 DoH；UDP、IPv6、局域网一律不通。
- 出口 IP 和记下的基线不一致时，不开新会话。
- Mac 自己的代理设置不受影响。

## 需要

- Apple Silicon Mac、Homebrew、Lima 2.1 以上（`brew install lima`）
- 出口二选一：Homebrew 的 mihomo（`brew install mihomo`），或 Clash Verge Rev
- 建议 16 GB 内存、25 GB 可用磁盘

## 用桌面 App

打开 CCVM，按欢迎页的三步走：接上出口、准备 VM、在 VM 里登录 Claude。之后在菜单栏和项目页里使用。

构建 App 见 [app/README.md](app/README.md)。

## 用命令行

```bash
git clone https://github.com/m1inato/ccvm-kit.git
cd ccvm-kit
```

**1. 在 Clash Verge 里加专用入口**

```bash
cp config/clash-verge-script.js config/clash-verge-script.local.js
```

把副本里的 `NODE` 改成一个具体节点的完整名称（保留 emoji 和空格），在 Clash Verge 的订阅卡片上右键 → 扩展脚本，粘贴、保存，再重新激活订阅。已有 `main()` 时，把 `config = ccvmPatch(config);` 加到原来的 return 前。

```bash
curl --noproxy '' --proxy socks5h://127.0.0.1:17897 https://1.1.1.1/cdn-cgi/trace
```

能拿到出口 IP 就说明入口通了。

**2. 部署**

```bash
bash scripts/setup.sh
```

创建 VM、装好防火墙和 TUN、记下出口基线，最后做一遍完整检查和断流测试。可以重复运行。

**3. 进入 VM，安装 Claude Code**

```bash
bash scripts/enter.sh
```

在 VM 里：

```bash
curl -fsSL https://claude.ai/install.sh | bash -s stable
cd ~/work
claude
```

VM 里没有浏览器：把登录链接复制到 Mac 的浏览器里打开，再把授权码粘回终端。

## 日常

| 做什么 | 命令 |
|---|---|
| 检查后进入 VM | `bash scripts/enter.sh` |
| 完整检查 | `bash scripts/check.sh` |
| 断流测试（VM 会断网约 30 秒） | `bash scripts/leaktest.sh` |
| 换节点后更新出口基线 | `bash scripts/rebaseline.sh` |
| 更新已部署的 VM | `bash scripts/upgrade.sh` |
| 启动 / 停止 VM | `bash scripts/vm.sh start` / `stop` |
| 列出 VM 里的项目 | `bash scripts/workspace.sh list` |
| 共享 Mac 文件夹（编辑 `state/shares.txt` 后应用） | `bash scripts/share.sh apply` |
| 传文件 | `bash scripts/files.sh push <Mac路径> <VM目录>` / `pull <VM文件> <Mac路径>` |

脚本都支持 `--json`，格式见 [docs/events.md](docs/events.md)。

### `ccvm`

在 App 的 设置 → 通用 里安装后，任何终端里都能用：

| 命令 | 做什么 |
|---|---|
| `ccvm` | 进入 VM |
| `ccvm my-api` | 在 `~/work/my-api` 开一个新会话 |
| `ccvm -a my-api-1` | 接回已有会话 |

`~/.local/bin` 不在 PATH 里时，把 `export PATH="$HOME/.local/bin:$PATH"` 加到 `~/.zshrc`。只用来开 VM 的 Ghostty 可以在配置里写 `command = ~/.local/bin/ccvm`。

## 配置

默认实例名 `ccvm`，Lima 目录 `~/.lima-ccvm`，状态目录 `state/`。要改的话：

```bash
cp config/local.env.example config/local.env
```

详见 [docs/configuration.md](docs/configuration.md)。`config/*.local.js`、`config/local.env`、`state/` 都不进 Git。

## 文档

- [桌面端：工作方式与安全设计](docs/desktop-app.md)
- [设计说明](docs/design.md)
- [运维与排障](docs/operations.md)
- [脚本事件格式](docs/events.md)
- [验证](verification/RESULTS.md)

## 开发

```bash
bash verification/run.sh        # 离线检查，不启动 VM
bash scripts/package.sh HEAD    # 在 dist/ 生成发布包
```
