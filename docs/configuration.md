# 本机配置与迁移

发布模板不包含个人节点、Mac 用户名、订阅地址或已接受的出口 IP。

## 配置优先级

宿主脚本按以下顺序取值：显式 `CCVM_*` 环境变量 → 本机配置文件 → 默认值。

| 配置项 | 本机文件变量 | 环境变量 | 默认值 |
|---|---|---|---|
| VM 实例名 | `VM_NAME` | `CCVM_NAME` | `ccvm` |
| 专用 Lima 目录 | `VM_HOME` | `CCVM_LIMA_HOME` | `$HOME/.lima-ccvm` |
| 出口基线与状态目录 | `STATE_DIR` | `CCVM_STATE_DIR` | `$KIT/state` |

`KIT` 由脚本自身位置计算，与终端当前目录无关。脚本不会继承其他 Lima/Colima 的 `LIMA_HOME`。

复制 `config/local.env.example` 为 `config/local.env` 后编辑。也可用 `CCVM_CONFIG_FILE` 指定另一份文件；显式指定的文件不存在或不可读时会报错，不会静默切换默认配置。

```bash
# config/local.env 示例
VM_NAME="ccvm"
VM_HOME="$HOME/.lima-ccvm"
STATE_DIR="$KIT/state"
```

文件由 Bash source，仅使用自己信任的内容。路径须为绝对路径；带空格的路径应加引号。节点设置独立存放在 `config/clash-verge-script.local.js`，该文件不会由宿主脚本自动安装进 Clash，需要在 Clash 内应用。

单次覆盖示例：

```bash
CCVM_NAME=work-vm CCVM_LIMA_HOME="$HOME/.lima-work-vm" bash scripts/setup.sh
```

之后检查、进入或更新基线时需要使用相同的配置。建议把长期设置写入被忽略的本机配置文件。

## 哪些值属于协议配置

以下是各组件共享的网络约定，保留在发布代码中，并非个人机器信息：

- `127.0.0.1:17897`：Mac 上的专用回环入口。
- `192.168.5.2:17897`：Lima 默认 user-mode 网络内访问该入口的地址。
- `172.31.255.1/30`、`172.31.255.2`：VM TUN 与 DNS 地址。
- `CC-VM-FIXED`、`cc-vm-in`、`cc`：专用策略组、listener 与工作用户。

这些值在 Clash、sing-box、防火墙和测试中配套使用，不能作为独立环境变量只覆盖一处。

## 已有部署升级

1. 保留 `config/*.local.js`、`config/local.env`、`state/` 和个人部署笔记。这些内容已被 Git 忽略。
2. 更新公开代码后，运行 `bash verification/run.sh`（开发检查）与 `bash scripts/check.sh`（VM 只读验收）。
3. `setup.sh` 看到 `/var/lib/ccvm/installed` 会跳过 VM 网络层安装。因此代码更新不会自动覆盖已装 VM 的 systemd 或防火墙配置；需要按具体升级说明操作。

2.2.0 的默认实例名、Lima 目录和状态目录与原套件一致，已有默认部署无需改名或重建。已部署的 Clash 扩展脚本也不会因为通用模板恢复占位符而被覆盖；个人节点保留在本地副本中。

## 移动仓库或重新克隆

VM 数据位于专用 Lima 目录中，不在仓库内。移动源码目录不会移动 VM，但默认的 `state/expected-ip.txt` 会随源码目录位置变化。

- 整体移动旧目录时保留 `state/`。
- 新克隆目录时，可从旧位置复制已核实的状态目录，或者在本地配置中把 `STATE_DIR` 指向旧目录的绝对路径。
- 不要把已有基线缺失当成自动接受新出口的理由。更换出口应先核对 Clash 连接链，再运行 `scripts/rebaseline.sh` 手动确认。
- 更换 `VM_NAME` 或 `VM_HOME` 会指向另一个实例，并不迁移原 VM 数据。

自定义状态目录应位于仓库外，或使用已忽略的 `state/`。直接使用 `limactl` 时，它不会读取本项目的 `config/local.env`，需要自行指定匹配的 `LIMA_HOME` 和实例名。
