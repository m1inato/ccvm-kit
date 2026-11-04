// Electron 主进程：菜单栏、桌面胶囊、主窗口、系统通知。所有判断在 core/ 与脚本里，这里只接线。
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../core/controller';
import { CoreManager, type SecretStore } from '../core/egress';
import { fetchSubscription } from '../core/fetch';
import { runCommand } from '../core/runner';
import { LOGIN_PATH_COMMAND, parseLoginPath } from '../core/env';
import { isIPv4, PROJECT_NAME } from '../core/parsers';
import { isMacPath } from '../core/vmpath';
import { reportMarkdown } from '../core/report';
import { relativeTime } from '../core/status';
import type { CliStatus, EgressMode, Settings, Snapshot } from '../core/types';
import { ccvmScript, isGeneratedCcvm, pathHas, PATH_HINT } from '../core/cli';
import { adminCommandFile, ccCommandFile, ccvmArgs, openCommandFile, openGhostty, writeCcvm } from './terminal';
import { Terminals, type OpenSpec } from './terminals';
import { dotImage } from './trayIcon';

app.setName('CCVM');
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.exit(0);

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const kitDir = app.isPackaged ? path.join(process.resourcesPath, 'kit') : path.resolve(__dirname, '..', '..');
const rendererFile = path.join(__dirname, '..', 'dist', 'index.html');
const EXTERNAL_HOSTS = new Set(['code.claude.com', 'docs.anthropic.com', 'claude.ai', 'github.com', 'lima-vm.io', 'www.clashverge.dev']);

let controller: Controller;
let terminals: Terminals;
let mainWin: BrowserWindow | null = null;
let capsuleWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let blink: NodeJS.Timeout | undefined;
let quitting = false;

// ---------------------------------------------------------------- 窗口
const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
};

function load(win: BrowserWindow, route: string): void {
  if (DEV_URL) void win.loadURL(`${DEV_URL}#${route}`);
  else void win.loadFile(rendererFile, { hash: route });
}

function isOwnUrl(url: string): boolean {
  if (DEV_URL && url.startsWith(DEV_URL)) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && decodeURIComponent(u.pathname) === rendererFile;
  } catch {
    return false;
  }
}

function openMain(route?: string): void {
  if (!mainWin) {
    mainWin = new BrowserWindow({
      width: 1240,
      height: 800,
      minWidth: 980,
      minHeight: 640,
      title: 'CCVM',
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#0d1117',
      show: false,
      webPreferences,
    });
    load(mainWin, route ?? (controller.settings.welcomeDone ? '/' : '/welcome'));
    mainWin.once('ready-to-show', () => mainWin?.show());
    mainWin.on('close', (e) => {
      if (quitting) return;
      e.preventDefault(); // 关掉窗口只是隐藏，菜单栏和后台检查继续
      mainWin?.hide();
      app.dock?.hide();
    });
    mainWin.on('closed', () => {
      mainWin = null;
    });
  } else {
    if (route) mainWin.webContents.send('ccvm:navigate', route);
    mainWin.show();
  }
  void app.dock?.show();
  mainWin.focus();
}

// 胶囊窗口只和内容一样大：透明窗口的空白部分在 macOS 上也会挡住下面窗口的点击。
// 胶囊页面量好自己的大小发过来；窗口以右上角为锚点伸缩（拖动过也一样），并且始终留在屏幕内。
const CAPSULE_MAX = { width: 720, height: 420 };

function placeCapsule(width: number, height: number): void {
  if (!capsuleWin || capsuleWin.isDestroyed()) return;
  const b = capsuleWin.getBounds();
  const right = b.x + b.width;
  const area = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(right - width, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
  capsuleWin.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

function syncCapsule(snap: Snapshot): void {
  if (!snap.settings.showCapsule) {
    capsuleWin?.close();
    capsuleWin = null;
    return;
  }
  if (capsuleWin) return;
  const width = 480;
  const area = screen.getPrimaryDisplay().workArea;
  capsuleWin = new BrowserWindow({
    width,
    height: 48,
    x: area.x + area.width - width - 12,
    y: area.y + 8,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    // 胶囊永远不会成为活动窗口；不开这个，macOS 会把第一下点击吞掉用来「激活」，按钮点不动
    acceptFirstMouse: true,
    show: false,
    webPreferences,
  });
  capsuleWin.setAlwaysOnTop(true, 'floating');
  // skipTransformProcessType：否则 Electron 会顺手隐藏 Dock 图标（主窗口开着时打开胶囊，Dock 图标和菜单就没了）。
  // Dock 由 openMain / 关主窗口自己管。
  capsuleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  load(capsuleWin, '/capsule');
  capsuleWin.once('ready-to-show', () => capsuleWin?.showInactive());
  capsuleWin.on('closed', () => {
    capsuleWin = null;
  });
}

/** 显示器拔掉或分辨率变了：把胶囊拉回屏幕内 */
function keepCapsuleOnScreen(): void {
  if (!capsuleWin || capsuleWin.isDestroyed()) return;
  const b = capsuleWin.getBounds();
  placeCapsule(b.width, b.height);
}

// ---------------------------------------------------------------- 菜单栏
function updateTray(snap: Snapshot): void {
  if (!tray) tray = new Tray(dotImage(snap.level));
  if (blink) clearInterval(blink);
  blink = undefined;
  tray.setImage(dotImage(snap.level));
  if (snap.level === 'busy') {
    let dim = false;
    blink = setInterval(() => {
      dim = !dim;
      tray?.setImage(dotImage('busy', dim));
    }, 700);
  }
  // 平时菜单栏只有一个点；出错时加一句短话
  tray.setTitle(snap.level === 'error' ? ` ${snap.headline}` : '');
  tray.setToolTip(`CCVM · ${snap.headline}`);

  const now = Date.now();
  const running = snap.vm.status === 'Running';
  const busyJob = snap.jobs.find((j) => j.state === 'running');
  const items: MenuItemConstructorOptions[] = [
    { label: `${snap.headline}${snap.egress.vm || snap.egress.baseline ? ` · 出口 ${snap.egress.vm ?? snap.egress.baseline}` : ''}`, enabled: false },
    { label: snap.checking ? '正在检查…' : `上次检查：${relativeTime(snap.lastCheckAt, now)}`, enabled: false },
  ];
  if (snap.core?.node) items.push({ label: `出口核心：${snap.core.node.name}${snap.core.service.running ? '' : '（已停）'}`, enabled: false });
  if (busyJob) items.push({ label: `进行中：${busyJob.title}${busyJob.step ? ` · ${busyJob.step}` : ''}`, enabled: false });
  items.push(
    { type: 'separator' },
    { label: '打开 CCVM', click: () => openMain() },
    { label: '在终端打开 cc', enabled: running && !snap.newSessionsBlocked, click: () => act('openTerminal', []) },
    { label: '立即检查', enabled: running && !snap.checking, click: () => act('quickCheck', []) },
    { label: '断流测试', enabled: running && !busyJob, click: () => act('leaktest', []) },
  );
  if (snap.level === 'error') items.push({ label: '查看问题…', click: () => openMain('/') });
  items.push(
    { type: 'separator' },
    running
      ? { label: '停止 VM', enabled: !busyJob, click: () => act('vmStop', []) }
      : { label: '启动 VM', enabled: snap.vm.status !== 'Missing' && !busyJob, click: () => act('vmStart', []) },
    { label: '显示桌面胶囊', type: 'checkbox', checked: snap.settings.showCapsule, click: (m) => act('updateSettings', [{ showCapsule: m.checked }]) },
    { label: '设置…', click: () => openMain('/settings') },
    { type: 'separator' },
    { label: '退出 CCVM（VM 与隔离照常工作）', click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------------------------------------------------------------- 动作
function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`参数 ${name} 应为字符串`);
  return v;
}

async function confirm(message: string, detail: string, ok: string, type: 'warning' | 'question' = 'warning'): Promise<boolean> {
  const opts = { type, message, detail, buttons: ['取消', ok], defaultId: 0, cancelId: 0 };
  const res = mainWin ? await dialog.showMessageBox(mainWin, opts) : await dialog.showMessageBox(opts);
  return res.response === 1;
}

const MODE_TEXT: Record<EgressMode, string> = { builtin: 'CCVM 自带核心', 'clash-verge': '我的 Clash Verge' };

function confirmMode(mode: EgressMode): Promise<boolean> {
  const detail =
    mode === 'builtin'
      ? '切换时 VM 会短暂断网。\n\n切换前请先在 Clash Verge 里移除 CCVM 扩展脚本（否则 17897 会被它占着），自带核心才能接上。还没选节点时，选好节点后核心才启动。\n\n切换后会自动检查；出口和基线不一致时会变红，核实后用「就用新的出口」更新基线。'
      : '自带核心会停止并卸载，VM 断网，直到 Clash Verge 的扩展脚本接上 17897。\n\n切换后会自动检查；出口和基线不一致时会变红，核实后用「就用新的出口」更新基线。';
  return confirm(`切换到「${MODE_TEXT[mode]}」？`, detail, '切换');
}

async function confirmNode(name: string): Promise<boolean> {
  const core = controller.snapshot().core;
  if (core?.pending && core.node?.name === name) {
    return confirm(
      `使用「${name}」的新节点信息？`,
      '订阅里这个节点的地址、端口或密码变了。确认后核心会用新信息重新启动，出口可能随之改变：检查发现出口变了时，核实后再更新基线。',
      '使用新信息',
    );
  }
  if (core?.node && core.node.name !== name) {
    return confirm(
      `换到「${name}」？`,
      `换节点等于换出口。核心会改用这个节点重启，VM 短暂断网；之后检查会发现出口变了，核实两端一致后再用「就用新的出口」更新基线。\n\n当前节点：${core.node.name}`,
      '换节点',
    );
  }
  return true; // 第一次选节点
}

async function confirmRebaseline(ip: string): Promise<boolean> {
  const opts = {
    type: 'warning' as const,
    message: `把出口基线改成 ${ip}？`,
    detail:
      `Mac 专用入口和 VM 现在都走 ${ip}。\n\n` +
      '确认前，请在 Clash Verge 的「连接」里核对：这条链路是 cc-vm-in → CC-VM-FIXED → 你选定的节点。\n' +
      '确认后，脚本会重新测量两端出口，仍然都等于这个 IP 才写入（等同 rebaseline.sh）。',
    buttons: ['取消', `就用 ${ip}`],
    defaultId: 0,
    cancelId: 0,
  };
  const res = mainWin ? await dialog.showMessageBox(mainWin, opts) : await dialog.showMessageBox(opts);
  return res.response === 1;
}

function loginPath(): string {
  return parseLoginPath(cachedLoginPath);
}
let cachedLoginPath: string | undefined;

// ---------------------------------------------------------------- 命令行入口 ccvm
// App 自己用的一份放在 userData/bin/ccvm（外部终端和 Ghostty 都调用它）；用户点「安装」后另写一份到 ~/.local/bin/ccvm。
// VM 名、Lima 目录、状态目录、PATH 或 App 位置变了，两份都自动重写；~/.local/bin/ccvm 不是 CCVM 生成的就不动。
const userCcvm = path.join(os.homedir(), '.local', 'bin', 'ccvm');
let lastCcvm: string | undefined;

function internalCcvm(): string {
  return path.join(app.getPath('userData'), 'bin', 'ccvm');
}

function syncCcvm(): string {
  const content = ccvmScript(kitDir, controller.settings, loginPath());
  if (content !== lastCcvm) {
    writeCcvm(internalCcvm(), content);
    try {
      if (isGeneratedCcvm(fs.readFileSync(userCcvm, 'utf8'))) writeCcvm(userCcvm, content);
    } catch {
      /* 没安装，或者不是 CCVM 生成的：不动 */
    }
    lastCcvm = content;
  }
  return internalCcvm();
}

function cliStatus(): CliStatus {
  let content: string | undefined;
  try {
    content = fs.readFileSync(userCcvm, 'utf8');
  } catch {
    content = undefined;
  }
  return {
    path: userCcvm,
    installed: content !== undefined,
    generated: content !== undefined && isGeneratedCcvm(content),
    onPath: pathHas(loginPath(), path.dirname(userCcvm)),
    hint: PATH_HINT,
  };
}

async function openInTerminal(project?: string): Promise<void> {
  const ccvm = syncCcvm();
  const term = controller.settings.terminalApp;
  if (term === 'Ghostty') await openGhostty(ccvm, ccvmArgs(project), os.homedir());
  else openCommandFile(path.join(app.getPath('userData'), 'run'), project ? `cc-${project}.command` : 'cc.command', ccCommandFile(ccvm, project), term);
}

// ---------------------------------------------------------------- 共享文件夹与传文件
function strList(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) throw new Error(`参数 ${name} 应为非空的字符串列表`);
  return v.map((x, i) => str(x, `${name}[${i}]`));
}

/** 上传前再校验一遍 Mac 路径：绝对路径、存在、顶层不是符号链接、是普通文件或文件夹 */
function checkUploadPath(p: string): string {
  if (!path.isAbsolute(p) || /[\n\r\0]/.test(p)) throw new Error(`不是有效的绝对路径：${p}`);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    throw new Error(`不存在：${p}`);
  }
  if (st.isSymbolicLink()) throw new Error(`不上传符号链接本身：${p}`);
  if (!st.isFile() && !st.isDirectory()) throw new Error(`只能上传普通文件或文件夹：${p}`);
  return p;
}

async function confirmApplyShares(): Promise<boolean> {
  const snap = controller.snapshot();
  const s = snap.settings;
  const folders = s.sharesEnabled ? s.sharedFolders : [];
  const sessions = snap.sessions.length;
  const detail = [
    `会重启 VM：正在运行的 ${sessions} 个 tmux 会话（包括里面的 Claude）会被中断。完成后会自动检查一遍。`,
    '',
    folders.length
      ? '共享是读写的：VM 里的程序（包括 Claude）可以修改这些文件夹里的任何文件，包括脚本、.git/hooks、package.json 里的 scripts。之后在 Mac 上运行它们，就等于以你的权限执行。这些内容也可以经固定出口发出去。'
      : '这次会移除所有共享：VM 里不再有 Mac 的文件夹。',
    '',
    folders.length ? `要共享的文件夹（VM 里在 /home/cc/mac/ 下）：\n${folders.map((f) => `• ${f}`).join('\n')}` : '',
    '',
    '网络隔离不变：VM 仍然只能经选定节点出网，也连不到 Mac 的网络服务。',
  ].join('\n');
  return confirm(folders.length ? `共享 ${folders.length} 个文件夹给 VM（读写）并重启 VM？` : '关闭共享文件夹并重启 VM？', detail.trim(), '应用并重启 VM');
}

async function dispatch(name: string, args: unknown[]): Promise<unknown> {
  switch (name) {
    case 'quickCheck':
      await controller.refreshVm();
      return controller.quickCheck('手动');
    case 'fullCheck':
      return controller.fullCheck();
    case 'leaktest':
      return controller.leaktest();
    case 'setup':
      return controller.setup();
    case 'vmStart':
      return controller.vmStart();
    case 'vmStop':
      return controller.vmStop();
    case 'cancelJob':
      return controller.cancelJob(str(args[0], 'id'));
    case 'jobLog':
      return controller.jobLog(str(args[0], 'id'));
    case 'refreshProjects':
      return controller.refreshProjects();
    case 'clone':
      return controller.clone(str(args[0], 'url'));
    case 'refreshClaude':
      return controller.refreshClaude();
    case 'preflight':
      return controller.preflight();
    case 'previewRebaseline':
      return controller.previewRebaseline();
    case 'acceptRebaseline': {
      const ip = str(args[0], 'ip');
      if (!isIPv4(ip)) throw new Error('不是有效的 IPv4');
      if (!(await confirmRebaseline(ip))) return null;
      return controller.acceptRebaseline(ip);
    }
    case 'openTerminal': {
      const project = args[0] === undefined || args[0] === null ? undefined : str(args[0], 'project');
      if (project !== undefined && !PROJECT_NAME.test(project)) throw new Error('无效的项目名');
      const gate = controller.canOpenSession();
      if (!gate.ok) throw new Error(`现在不打开新会话：${gate.reason}`);
      await openInTerminal(project);
      // 带项目时 ccvm 会新建 tmux 会话：过一会儿刷新，让它出现在项目页
      if (project) setTimeout(() => void controller.refreshProjects(), 6000);
      return;
    }
    case 'openAdminShell': {
      const runDir = path.join(app.getPath('userData'), 'run');
      const content = adminCommandFile(controller.settings, loginPath());
      if (controller.settings.terminalApp === 'Ghostty') {
        fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(runDir, 'admin.command'), content, { mode: 0o700 });
        await openGhostty('/bin/bash', [path.join(runDir, 'admin.command')], os.homedir());
      } else {
        openCommandFile(runDir, 'admin.command', content, controller.settings.terminalApp);
      }
      return;
    }
    case 'cliStatus':
      syncCcvm();
      return cliStatus();
    case 'installCli':
      writeCcvm(userCcvm, ccvmScript(kitDir, controller.settings, loginPath()));
      lastCcvm = undefined;
      syncCcvm();
      return cliStatus();
    case 'updateSettings': {
      const patch = args[0];
      if (!patch || typeof patch !== 'object') throw new Error('设置格式不对');
      const next = controller.updateSettings(patch as Partial<Settings>);
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
      return next;
    }
    case 'chooseStateDir': {
      const opts: Electron.OpenDialogOptions = {
        title: '选择存放出口基线的状态目录',
        message: '可以选命令行套件的 state 目录，让 App 和脚本共用同一份基线',
        properties: ['openDirectory', 'createDirectory'],
      };
      const res = mainWin ? await dialog.showOpenDialog(mainWin, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths[0]) return null;
      return controller.updateSettings({ stateDir: res.filePaths[0] });
    }
    case 'clashScript':
      return controller.clashScript(str(args[0], 'node'));
    case 'copyText':
      clipboard.writeText(str(args[0], 'text'));
      return;
    case 'exportReport': {
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const opts: Electron.SaveDialogOptions = {
        defaultPath: path.join(app.getPath('documents'), `CCVM-验收记录-${stamp}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      };
      const res = mainWin ? await dialog.showSaveDialog(mainWin, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return null;
      fs.writeFileSync(res.filePath, reportMarkdown(controller.snapshot(), Date.now()));
      return res.filePath;
    }
    case 'openMain':
      openMain(args[0] === undefined || args[0] === null ? undefined : str(args[0], 'route'));
      return;
    case 'openExternal': {
      const url = new URL(str(args[0], 'url'));
      if (url.protocol !== 'https:' || !EXTERNAL_HOSTS.has(url.hostname)) throw new Error('不打开这个地址');
      await shell.openExternal(url.toString());
      return;
    }
    case 'dismissCaption':
      return controller.dismissCaption(Number(args[0]));
    case 'setEgressMode': {
      const mode = str(args[0], 'mode');
      if (mode !== 'builtin' && mode !== 'clash-verge') throw new Error('未知的出网方式');
      if (mode === controller.settings.egressMode) return controller.settings;
      if (!(await confirmMode(mode))) return null;
      return controller.setEgressMode(mode);
    }
    case 'setSubscription':
      return controller.setSubscription(str(args[0], 'url'));
    case 'updateSubscription':
      return controller.updateSubscription();
    case 'selectNode': {
      const name = str(args[0], 'name');
      if (!(await confirmNode(name))) return null;
      return controller.selectNode(name);
    }
    case 'restartCore':
      return controller.restartCore();
    case 'removeCore':
      if (!(await confirm('移除出口核心？', '核心会停止并从登录项里卸载，VM 断网，直到你重新选节点或切换到 Clash Verge。订阅链接保留，可以单独清除。', '移除'))) return false;
      await controller.removeCore();
      return true;
    case 'clearSubscription':
      if (!(await confirm('清除订阅链接？', '钥匙串里的订阅链接会被删除。正在运行的核心不受影响，但之后不能更新订阅或换节点，除非重新填写。', '清除'))) return;
      return controller.clearSubscription();
    case 'setCoreOptions': {
      const o = (args[0] ?? {}) as Record<string, unknown>;
      return controller.setCoreOptions({
        autoUpdate: typeof o.autoUpdate === 'boolean' ? o.autoUpdate : undefined,
        viaClashVerge: typeof o.viaClashVerge === 'boolean' ? o.viaClashVerge : undefined,
      });
    }
    case 'coreConnections':
      return controller.coreConnections();
    case 'latencyTest':
      return controller.latencyTest();
    case 'refreshCore':
      return controller.refreshCore();
    case 'killSession': {
      const name = str(args[0], 'name');
      if (!(await confirm(`结束会话「${name}」？`, '会话里正在运行的程序（包括 Claude）会被结束，没保存的东西会丢。只是想关掉标签的话，直接关标签：会话会继续在 VM 里运行。', '结束会话'))) return false;
      return controller.killSession(name);
    }
    case 'setHooks': {
      const on = args[0] === true;
      if (on && !(await confirm('开启「Claude 做完了」提醒？', '会在 VM 里写两个 root 所有的文件：/usr/local/lib/ccvm/claude-hook 和 /etc/claude-code/managed-settings.d/50-ccvm.json。hook 只记录事件类型、时间、工作目录和截断的通知文字，不记录对话内容，永远不影响 Claude 的行为。新开的 Claude 会话生效。', '开启', 'question'))) return controller.settings;
      return controller.setHooks(on);
    }
    case 'addSharedFolder': {
      const opts: Electron.OpenDialogOptions = {
        title: '选择要共享给 VM 的文件夹',
        message: '选具体的项目文件夹。VM 可以读写里面的所有文件。',
        properties: ['openDirectory', 'createDirectory'],
      };
      const res = mainWin ? await dialog.showOpenDialog(mainWin, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths[0]) return null;
      return controller.addSharedFolder(res.filePaths[0]);
    }
    case 'removeSharedFolder':
      return controller.removeSharedFolder(str(args[0], 'path'));
    case 'setSharesEnabled':
      if (typeof args[0] !== 'boolean') throw new Error('参数 on 应为 true / false');
      return controller.setSharesEnabled(args[0]);
    case 'applyShares':
      if (!(await confirmApplyShares())) return null;
      return controller.applyShares();
    case 'listFiles':
      return controller.listFiles(str(args[0], 'path'));
    case 'makeDir':
      return controller.makeDir(str(args[0], 'path'));
    case 'removePath': {
      const p = str(args[0], 'path');
      const mac = isMacPath(p);
      const ok = await confirm(
        mac ? `删除 Mac 上的「${path.posix.basename(p)}」？` : `删除「${path.posix.basename(p)}」？`,
        mac
          ? `这是 Mac 上的真实文件：${p} 在共享文件夹里，删掉的是你 Mac 上的文件，不会进废纸篓，不能恢复。`
          : `${p}\n\n会连同里面的所有内容一起删除，不能恢复。`,
        '删除',
      );
      if (!ok) return false;
      return controller.removePath(p);
    }
    case 'pushPaths': {
      const paths = strList(args[0], 'paths').map(checkUploadPath);
      return controller.pushPaths(paths, str(args[1], 'destDir'));
    }
    case 'chooseUpload': {
      const dest = str(args[0], 'destDir');
      const folders = args[1] === true;
      const opts: Electron.OpenDialogOptions = {
        title: folders ? '选择要上传到 VM 的文件夹' : '选择要上传到 VM 的文件',
        properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      };
      const res = mainWin ? await dialog.showOpenDialog(mainWin, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths.length) return [];
      return controller.pushPaths(res.filePaths.map(checkUploadPath), dest);
    }
    case 'pullFile': {
      const src = str(args[0], 'vmPath');
      const opts: Electron.SaveDialogOptions = { title: '下载到 Mac', defaultPath: path.join(app.getPath('downloads'), path.posix.basename(src)) };
      const res = mainWin ? await dialog.showSaveDialog(mainWin, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return null;
      // 已存在时系统保存对话框已经问过要不要替换
      return controller.pullFile(src, res.filePath, fs.existsSync(res.filePath));
    }
    case 'setMatrix':
      return controller.setMatrix(str(args[0], 'id'), args[1] === true);
    default:
      throw new Error(`未知动作：${name}`);
  }
}

function act(name: string, args: unknown[]): void {
  dispatch(name, args).catch((err) => controller.caption('error', String((err as Error).message ?? err)));
}

function fromOwnPage(e: IpcMainInvokeEvent): boolean {
  return !!e.senderFrame && isOwnUrl(e.senderFrame.url);
}

function fromOwnPageEvent(e: Electron.IpcMainEvent): boolean {
  return !!e.senderFrame && isOwnUrl(e.senderFrame.url);
}

// ---------------------------------------------------------------- 启动
function readLoginPath(): Promise<string | undefined> {
  // 只为了拿 PATH 才启动登录 shell；不继承 App 自己的环境，结果里除了 PATH 什么都不用
  const shellPath = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh';
  const env = { HOME: os.homedir(), USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: shellPath, TERM: 'dumb' };
  return new Promise((resolve) => {
    execFile(shellPath, ['-l', '-c', LOGIN_PATH_COMMAND], { env, timeout: 8000, cwd: os.homedir() }, (err, stdout) => {
      cachedLoginPath = err ? undefined : stdout;
      resolve(cachedLoginPath);
    });
  });
}

/** 订阅链接只放钥匙串：safeStorage 的加密密钥存在 macOS 钥匙串里，磁盘上只有密文 */
function keychainSecret(file: string): SecretStore {
  return {
    get: () => {
      try {
        if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return undefined;
        return safeStorage.decryptString(fs.readFileSync(file));
      } catch {
        return undefined;
      }
    },
    set: (value) => {
      if (value === undefined) {
        fs.rmSync(file, { force: true });
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) throw new Error('钥匙串不可用，不能保存订阅链接');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, safeStorage.encryptString(value), { mode: 0o600 });
    },
  };
}

function watchNetwork(): void {
  const signature = () =>
    Object.entries(os.networkInterfaces())
      .flatMap(([name, addrs]) => (addrs ?? []).filter((a) => !a.internal && a.family === 'IPv4').map((a) => `${name}=${a.address}`))
      .sort()
      .join(',');
  let last = signature();
  setInterval(() => {
    const now = signature();
    if (now !== last) {
      last = now;
      controller.trigger('network');
    }
  }, 15_000);
}

app.on('second-instance', () => openMain());
app.on('before-quit', () => {
  quitting = true;
  terminals?.closeAll(); // 只断开本机这一端，VM 里的 tmux 会话继续
});
app.on('window-all-closed', () => {
  /* 菜单栏 App：没有窗口也继续运行 */
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => {
    if (!isOwnUrl(url)) ev.preventDefault();
  });
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    act('openExternal', [url]);
    return { action: 'deny' };
  });
});

void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setSpellCheckerEnabled(false); // 否则 Chromium 会去下载拼写词典
  // App 自己不需要联网：界面只加载本地文件。所有出网都在脚本里，经专用入口。
  const devHost = DEV_URL ? new URL(DEV_URL).host : undefined;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    let allowed = false;
    try {
      const u = new URL(details.url);
      allowed = ['file:', 'devtools:', 'data:'].includes(u.protocol) || (!!devHost && u.host === devHost && ['http:', 'ws:'].includes(u.protocol));
    } catch {
      allowed = false;
    }
    cb({ cancel: !allowed });
  });
  app.dock?.hide();

  const dataDir = app.getPath('userData');
  const core = new CoreManager({
    dataDir,
    home: os.homedir(),
    uid: os.userInfo().uid,
    // 系统命令同样用干净环境：只有登录 shell 的 PATH（找 Homebrew 的 mihomo），没有代理变量
    exec: (cmd, args, timeoutMs = 10_000) =>
      runCommand(cmd, args, { PATH: loginPath(), HOME: os.homedir(), USER: os.userInfo().username, LANG: 'en_US.UTF-8' }, timeoutMs),
    secrets: keychainSecret(path.join(dataDir, 'core', 'subscription.enc')),
    fetchText: (url, viaClashVerge) => fetchSubscription(url, viaClashVerge ? { via: { host: '127.0.0.1', port: 7897 } } : {}),
  });

  controller = new Controller({
    core,
    kitDir,
    dataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    home: os.homedir(),
    user: os.userInfo().username,
    tmpdir: process.env.TMPDIR,
    loginPathOutput: readLoginPath,
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
  });

  ipcMain.handle('ccvm:snapshot', (e) => {
    if (!fromOwnPage(e)) throw new Error('拒绝');
    return controller.snapshot();
  });
  ipcMain.handle('ccvm:act', (e, name: unknown, args: unknown) => {
    if (!fromOwnPage(e)) throw new Error('拒绝');
    return dispatch(str(name, 'name'), Array.isArray(args) ? args : []);
  });

  terminals = new Terminals(kitDir, () => controller.terminalEnv());
  ipcMain.handle('ccvm:term:open', (e, raw: unknown) => {
    if (!fromOwnPage(e)) throw new Error('拒绝');
    const r = (raw ?? {}) as Record<string, unknown>;
    const mode = r.mode === 'attach' ? 'attach' : 'new';
    const cols = Number(r.cols) || 100;
    const rows = Number(r.rows) || 30;
    if (mode === 'new') {
      const project = str(r.project, 'project');
      if (!PROJECT_NAME.test(project)) throw new Error('无效的项目名');
      const gate = controller.canOpenSession();
      if (!gate.ok) throw new Error(`现在不打开新会话：${gate.reason}`);
      const spec: OpenSpec = { mode, project, session: controller.nextSessionName(project), cols, rows };
      const opened = terminals.open(e.sender, spec);
      setTimeout(() => void controller.refreshProjects(), 4000);
      return opened;
    }
    return terminals.open(e.sender, { mode, session: str(r.session, 'session'), cols, rows });
  });
  ipcMain.on('ccvm:term:write', (e, id: unknown, data: unknown) => {
    if (fromOwnPageEvent(e)) terminals.write(e.sender, String(id), data);
  });
  ipcMain.on('ccvm:term:resize', (e, id: unknown, cols: unknown, rows: unknown) => {
    if (fromOwnPageEvent(e)) terminals.resize(e.sender, String(id), cols, rows);
  });
  ipcMain.handle('ccvm:term:close', (e, id: unknown) => {
    if (fromOwnPage(e)) terminals.close(e.sender, String(id));
  });
  ipcMain.on('ccvm:capsule:size', (e, w: unknown, h: unknown) => {
    if (!fromOwnPageEvent(e) || !capsuleWin || e.sender !== capsuleWin.webContents) return;
    if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return;
    placeCapsule(Math.min(CAPSULE_MAX.width, Math.max(60, Math.ceil(w))), Math.min(CAPSULE_MAX.height, Math.max(30, Math.ceil(h))));
  });
  screen.on('display-removed', keepCapsuleOnScreen);
  screen.on('display-metrics-changed', keepCapsuleOnScreen);

  controller.on('snapshot', (snap: Snapshot) => {
    try {
      syncCcvm();
    } catch {
      /* 写不了时，下次打开终端会再试并报错 */
    }
    updateTray(snap);
    syncCapsule(snap);
    for (const win of [mainWin, capsuleWin]) {
      if (win && !win.isDestroyed()) win.webContents.send('ccvm:snapshot', snap);
    }
  });

  powerMonitor.on('resume', () => controller.trigger('wake'));
  watchNetwork();
  await controller.init();
  const snap = controller.snapshot();
  updateTray(snap);
  syncCapsule(snap);
  if (!controller.settings.welcomeDone) openMain('/welcome');

  // 主窗口开着时，每分钟刷新一次项目列表
  setInterval(() => {
    if (mainWin?.isVisible()) void controller.refreshProjects();
  }, 60_000);
});
