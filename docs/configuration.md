# 本机配置与迁移

发布模板不包含个人节点、Mac 用户名或订阅地址。

## 配置优先级

宿主脚本按以下顺序取值：显式 `CCVM_*` 环境变量 → 本机配置文件 → 默认值。

| 配置项 | 本机文件变量 | 环境变量 | 默认值 |
|---|---|---|---|
| VM 实例名 | `VM_NAME` | `CCVM_NAME` | `ccvm` |
| 专用 Lima 目录 | `VM_HOME` | `CCVM_LIMA_HOME` | `$HOME/.lima-ccvm` |
| 状态目录（共享文件夹列表） | `STATE_DIR` | `CCVM_STATE_DIR` | `$KIT/state` |

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

之后检查、进入时需要使用相同的配置。建议把长期设置写入被忽略的本机配置文件。

## 哪些值属于协议配置

下面这些是各组件共享的固定值：

- `127.0.0.1:17897`：Mac 上的代理入口。
- `192.168.5.2:17897`：Lima 默认 user-mode 网络内访问该入口的地址。
- `172.31.255.1/30`、`172.31.255.2`：VM TUN 与 DNS 地址。
- `CC-VM-FIXED`、`cc-vm-in`、`cc`：专用策略组、listener 与工作用户。

这些值在 Clash、sing-box、防火墙和测试中配套使用，不能作为独立环境变量只覆盖一处。

## 已有部署升级

1. 保留 `config/*.local.js`、`config/local.env`、`state/` 和个人部署笔记。这些内容已被 Git 忽略。
2. 更新代码后运行 `bash scripts/upgrade.sh`，再用 `bash scripts/check.sh` 看状态。
3. `setup.sh` 看到 `/var/lib/ccvm/installed` 会跳过 VM 网络层安装，已装 VM 的防火墙和 sing-box 配置不会被覆盖；后来加的步骤由 `upgrade.sh` 按级别补上。

默认实例名、Lima 目录和状态目录与原套件一致，已有部署无需改名或重建。状态目录里旧版本留下的 `expected-ip.txt` 不再使用，可以删掉。

## 移动仓库或重新克隆

VM 数据位于专用 Lima 目录中，不在仓库内。移动源码目录不会移动 VM。

- 用了共享文件夹时，保留 `state/shares.txt`，或者在本地配置中把 `STATE_DIR` 指向旧目录的绝对路径。
- 更换 `VM_NAME` 或 `VM_HOME` 会指向另一个实例，并不迁移原 VM 数据。

直接使用 `limactl` 时，它不会读取本项目的 `config/local.env`，需要自行指定匹配的 `LIMA_HOME` 和实例名。
