# 运维与排障

以下命令中的实例名、Lima 目录使用默认值；自定义过配置时需使用相应值。

## 日常流程

- 进入工作用户：`bash scripts/enter.sh`，然后在 VM 内 `cd ~/work`、运行 `claude`。
- 退出会话：在 VM shell 输入 `exit`，VM 保持后台运行。
- 停机：在 Mac 运行 `LIMA_HOME="$HOME/.lima-ccvm" limactl stop ccvm`。
- 系统维护：`LIMA_HOME="$HOME/.lima-ccvm" limactl shell ccvm` 提供管理员用户；Claude 在无 sudo 的 `cc` 中运行。
- 项目和 Git 凭据单独放在 VM 内，使用分支推送或导出补丁带回改动。需要 Remote-SSH 时，为 cc 单独生成与配置 SSH 密钥。

## 验收矩阵

首次部署后，或更换节点及升级组件后，执行适用项目。以下是操作清单，不代表每项都已在所有版本和设备上测试。

| 场景 | 操作 | 预期 |
|---|---|---|
| 基础 | `bash scripts/check.sh` | 全部通过，出口与基线一致 |
| 断流 / 抓包 | 结束联网任务后运行 `bash scripts/leaktest.sh` | 正向对照 > 0，旁路 = 0，停止 TUN 后阻断，恢复后可联网 |
| VM 重启 | Mac 上 stop，再用 enter.sh 启动，随后 check 和 leaktest | 防火墙、TUN、DNS 恢复 |
| Mac 睡眠唤醒 | 唤醒后 check，对比两边 `date -u` | 时间同步，出口一致或明确报错 |
| 切换系统代理或 Mac TUN | 手动切换后 check | 专用入口可用时出口不变 |
| 切换 Clash 规则 / 全局 / 直连模式 | 手动切换后 check，测完恢复 | 专用 listener 仍指定固定出站 |
| 退出 Clash 内核 | VM 内尝试公网 curl，恢复后 check | 不可联网；恢复后检查通过 |
| 节点消失或改名 | 重新应用订阅后 check | REJECT 或入口不可用，无法联网 |
| 切换 Wi-Fi / 热点 | 切换后 check | 出口一致或明确失败 |
| Claude 登录与真实请求 | 登录后发简短提示，在 Clash 看连接链 | 流式返回，链路为指定节点 |

## 常见问题

| 现象 | 检查与处理 |
|---|---|
| `lima` 报 default 不存在 | 本项目用独立目录的 ccvm；使用 enter.sh，或指定 `LIMA_HOME="$HOME/.lima-ccvm" limactl start ccvm` |
| 17897 未监听或专用组为空 | 查看扩展脚本日志中的 `[ccvm]`，核对本地副本的 NODE，重新激活订阅 |
| 17897 有非回环监听 | 用 `netstat -an` 或 `sudo lsof -nP -iTCP:17897 -sTCP:LISTEN` 定位，专用入口应保持回环监听 |
| Lima 全局配置被拒绝 | 检查专用目录 `_config/default.yaml` / `override.yaml`，确认内容与用途后自行处理 |
| 出口与基线不一致 | 核对节点、供应商出口与连接链，确认后用 rebaseline.sh 手动更新；不会自动接受新 IP |
| 找不到基线 | 确认使用了正确状态目录；重新克隆时按配置说明迁移旧 state |
| 抓包对照为 0 或 tcpdump 失败 | 检查 VM 内 `ip -4 route get 192.168.5.2`、`sudo tcpdump -D`；不能将其视为通过 |
| 防火墙处于锁定模式 | 管理员 shell 查看 `journalctl -u ccvm-firewall` 和 `sudo nft -c -f /etc/ccvm/firewall.nft` |
| TUN 起不来 | 查看 `journalctl -u ccvm-tun -n 100`，核对 sing-box 版本及配置检查结果 |
| DNS / TLS 失败 | 核对 TUN、DoH 和时钟；本设计未配置本地 DNS 回退 |
| 端口转发、UDP、QUIC 或 Docker 网络不可用 | 这些不在本方案的支持范围内 |
| Claude 401 / 403 | 查看 Claude doctor 与账号状态；网络验收不等于账号授权有效 |

`CCVM_FORCE=1 bash scripts/enter.sh` 可在部分检查失败时进入排障；它不绕过专用 Lima 全局配置检查。修复并重新通过验收后再使用 Claude。

## 升级

- sing-box 安装器只接受 1.14.x，并设置 apt hold。升级次版本前对照 [官方迁移文档](https://sing-box.sagernet.org/migration/) 核对配置。
- Lima、Clash 或 sing-box 更新后执行 check 与 leaktest。
- Ubuntu 系统包在管理员 shell 中按需维护，网络流量同样经过已启用的 TUN。
- 本项目的安装标记用于避免重复安装，不能作为配置自动迁移机制。

## 重建前

删除 Lima 实例会永久删除其中的项目、凭据和文件。先推送分支或导出所需内容，再按 Lima 官方说明删除实例；状态目录里的出口基线需根据实际重建与节点情况核实。
