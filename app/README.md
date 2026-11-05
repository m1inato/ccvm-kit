# CCVM 桌面端

菜单栏应用加主窗口：项目、Claude 会话、内嵌终端、出网与连接、共享文件夹、文件、定时检查与提醒。所有结论都来自仓库里的脚本（[docs/events.md](../docs/events.md)），App 退出后 VM 照样只能走专用入口。工作方式见 [docs/desktop-app.md](../docs/desktop-app.md)。

## 开发

需要 Node.js 22 以上。

```bash
cd app
npm install
npm run rebuild     # 按 Electron 的 ABI 编译 node-pty（内嵌终端）
npm test
MIHOMO_BIN=$(which mihomo) npm test   # 另外用真实 mihomo 跑一遍核心配置
npm run typecheck
npm start           # 构建并打开
npm run dist        # 打包 dmg
```

只看界面：`npm run dev`，打开 `http://localhost:5199/?demo=ok`。`demo` 可选 `ok`、`cv`（Clash Verge）、`egress`（出口变了）、`node`（节点变了）、`busy`、`stopped`、`welcome`、`setup`、`shares`、`upgrade`；加 `&theme=light` 或 `&theme=dark` 指定外观。演示数据不调用任何脚本。

## 结构

```
core/          不依赖 Electron 的逻辑
  controller.ts  定时检查、后台任务、快照
  events.ts      脚本事件解析与结论
  status.ts      状态推导与提醒去重
  jobs.ts        后台任务（App 退出后继续）
  runner.ts      在干净环境里运行白名单脚本
  env.ts         脚本环境：没有代理变量，PATH 取自登录 shell
  mihomo.ts      出口核心的配置与订阅解析
  egress.ts      出口核心：launchd 服务、节点固定、网卡改绑、测延迟
  clashVerge.ts  Clash Verge 外部控制器（只读）
  cli.ts         生成 ccvm 脚本与 Ghostty 的 AppleScript
electron/      主进程与沙盒预加载
src/           React 界面
build/         打包：复制套件、生成图标、afterPack
```

## 安全

- 界面在沙盒里运行（`contextIsolation`、`sandbox`、无 Node），只能调用白名单动作，主进程逐个校验参数。
- 窗口不能导航到外部页面；会话拒绝所有权限请求，拦截所有非本地请求。
- 脚本在从零构造的环境里运行，不带任何代理变量。
- 更新出口基线、切换出网方式、应用共享文件夹前，都先弹系统对话框确认。
- 打包进 App 的只有 Git 跟踪的套件文件。
