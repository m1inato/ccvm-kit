# 运维与排障

以下命令中的实例名、Lima 目录使用默认值；自定义过配置时需使用相应值。

## 日常

- 进入工作用户：`bash scripts/enter.sh`，然后在 VM 内 `cd ~/work`、运行 `claude`。VM 没运行时会先启动。
- 退出会话：在 VM shell 输入 `exit`，VM 保持后台运行。
- 停机：`bash scripts/vm.sh stop`。
- 系统维护：`LIMA_HOME="$HOME/.lima-ccvm" limactl shell ccvm` 提供管理员用户；Claude 在无 sudo 的 `cc` 中运行。
- 看状态：`bash scripts/check.sh`。

## 常见问题

| 现象 | 处理 |
|---|---|
| 代理断开，`host.proxy` 不通 | 自带核心：网络页看核心状态，重启核心或换节点。Clash Verge：确认它在运行、扩展脚本已生效（日志里搜 `[ccvm]`）、节点可用 |
| `host.proxy` 通，`vm.proxy` 不通 | 多半是 TUN：`journalctl -u ccvm-tun -n 100`；停止再启动 VM 一般能恢复 |
| `vm.tun` 不通 | 同上。旧 VM 先在首页「更新 VM」装上 TUN 看门狗 |
| `vm.firewall` 不通 | 管理员 shell 查看 `journalctl -u ccvm-firewall` 和 `sudo nft -c -f /etc/ccvm/firewall.nft` |
| 17897 端口被占用 | 自带核心和 Clash Verge 扩展脚本只能用一个：在 Clash Verge 里移除扩展脚本，再重启核心 |
| `lima` 报 default 不存在 | 本项目用独立目录的 ccvm：用 `enter.sh`，或 `LIMA_HOME="$HOME/.lima-ccvm" limactl start ccvm` |
| DNS / TLS 失败 | 核对 TUN 和时钟 |
| UDP、QUIC、端口转发、Docker 网络不通 | VM 只放行经代理的 TCP |
| Claude 401 / 403 | 运行 `claude doctor`，检查账号登录状态 |

## 升级

- sing-box 只接受 1.14.x，并设置 apt hold。升级次版本前对照 [官方迁移文档](https://sing-box.sagernet.org/migration/) 核对配置。
- 更新套件后运行 `bash scripts/upgrade.sh`，补上旧 VM 缺的步骤。
- Ubuntu 系统包在管理员 shell 中按需维护，流量同样经过 TUN。

## 重建

删除 Lima 实例会永久删除其中的项目、凭据和文件。先推送分支或导出所需内容，再删除实例，然后重新运行 `bash scripts/setup.sh`。
