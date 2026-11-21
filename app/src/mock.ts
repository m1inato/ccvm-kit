// 浏览器预览用的演示数据（不在 Electron 里加载）。IP、项目、节点名都是示例。
// 用 ?demo=ok（自带核心）| cv（Clash Verge）| down（代理断开）| busy | welcome | setup | stopped | shares | upgrade 切换场景；
// 加 &theme=light 或 &theme=dark 指定外观。
import { renderClashScript, gitUrlProblem, projectNameFromUrl } from '../core/parsers';
import type { CheckEvent, CheckRecord, CoreStatus, FileItem, JobSummary, Snapshot } from '../core/types';
import type { Bridge } from './api';

const IP = '203.0.113.7';
const MIN = 60_000;

const TEMPLATE = `// Clash Verge Rev 订阅「扩展脚本」(Script)。
const NODE = "REPLACE_WITH_EXACT_NODE_NAME";

const PORT = 17897;
const GROUP = "CC-VM-FIXED";
const LISTENER = "cc-vm-in";
// …其余与 config/clash-verge-script.js 相同
`;

function checks(list: [string, string][], fail: string[] = []): CheckEvent[] {
  return list.map(([id, msg]) => ({ id, ok: !fail.includes(id), msg }));
}

const PRE: [string, string][] = [
  ['host.macos_arm64', 'Apple Silicon Mac，原生 arm64'],
  ['lima.version', 'Lima 2.2.1（≥ 2.1.0）'],
];
const CHECK: [string, string][] = [
  ['vm.running', 'VM 运行中'],
  ['host.proxy', `代理入口 127.0.0.1:17897 通，出口 ${IP}`],
  ['vm.firewall', '防火墙在'],
  ['vm.tun', 'TUN 在'],
  ['vm.proxy', `经代理出网，出口 ${IP}`],
];

const NODES = [
  { name: '示例节点 · 东京 01', type: 'ss', server: 'jp1.example.com', port: 8388 },
  { name: '示例节点 · 东京 02', type: 'ss', server: 'jp2.example.com', port: 8388 },
  { name: '示例节点 · 新加坡 01', type: 'trojan', server: 'sg1.example.com', port: 443 },
  { name: '示例节点 · 美国 01', type: 'vmess', server: 'us1.example.com', port: 443 },
];

function coreStatus(now: number): CoreStatus {
  return {
    mihomo: { path: '/opt/homebrew/bin/mihomo', version: '1.19.33', versionOk: true },
    service: { loaded: true, running: true, pid: 4242, lastExit: '(never exited)' },
    listenerOwned: true,
    portBusy: true,
    node: NODES[0],
    nodeMissing: false,
    nodes: NODES,
    subscription: { set: true, masked: 'https://sub.example.com/api/v1/client/subscribe?token=••••••••', lastUpdate: now - 3 * 3600_000, autoUpdate: true, viaClashVerge: false },
    latency: {},
    checkedAt: now,
  };
}

function record(kind: CheckRecord['kind'], at: number, list: CheckEvent[], values: Record<string, string>, reason?: string): CheckRecord {
  const ok = list.every((c) => c.ok) && !reason;
  return { kind, at, ok, reason: ok ? undefined : reason ?? list.find((c) => !c.ok)?.msg, checks: list, values };
}

function initial(scenario: string): Snapshot {
  const now = Date.now();
  const last = record('check', now - 2 * MIN, checks(CHECK), { host_egress: IP, vm_egress: IP });
  const cloneJob: JobSummary = {
    id: 'demo-clone', kind: 'clone', title: '克隆项目', args: ['clone', 'git@github.com:you/scripts.git', '--json'],
    state: 'running', startedAt: now - 40_000, percent: 42, step: undefined,
  };
  const snap: Snapshot = {
    level: 'ok', headline: '已连接', detail: `出口 ${IP}`,
    egress: { host: IP, vm: IP },
    vm: { name: 'ccvm', status: 'Running', cpus: 4, memoryBytes: 6 * 1024 ** 3, diskBytes: 60 * 1024 ** 3, arch: 'aarch64' },
    lastCheck: last, lastCheckAt: last.at, checking: false,
    issues: [],
    jobs: [cloneJob],
    projects: [
      { name: 'my-api', branch: 'main', dirty: 3, ahead: 1, behind: 0, updated: Math.floor(now / 1000) - 3600, subject: '补 /health 单元测试', remote: 'git@github.com:you/my-api.git', claudeSessions: 1, claudeSince: Math.floor(now / 1000) - 12 * 60 },
      { name: 'web-app', branch: 'feature/login', dirty: 0, ahead: 0, behind: 2, updated: Math.floor(now / 1000) - 2 * 86400, subject: '登录页样式', remote: 'https://github.com/you/web-app.git', claudeSessions: 0, claudeSince: 0 },
      { name: 'infra', branch: 'main', dirty: 0, ahead: 0, behind: 0, updated: Math.floor(now / 1000) - 5 * 86400, subject: 'terraform: 升级 provider', remote: 'https://github.com/you/infra.git', claudeSessions: 0, claudeSince: 0 },
    ],
    sessions: [
      { name: 'my-api-1', created: Math.floor(now / 1000) - 12 * 60, attached: 1, project: 'my-api', activity: Math.floor(now / 1000) - 20, command: 'claude' },
      { name: 'review', created: Math.floor(now / 1000) - 3 * 3600, attached: 0, project: 'my-api', activity: Math.floor(now / 1000) - 40 * 60, command: 'claude' },
      { name: 'my-api-2', created: Math.floor(now / 1000) - 26 * 3600, attached: 0, project: 'my-api', activity: Math.floor(now / 1000) - 20 * 3600, command: 'bash' },
    ],
    projectsAt: now - MIN,
    claude: { installed: true, version: '2.1.311 (Claude Code)', checkedAt: now - 10 * MIN },
    core: coreStatus(now),
    captions: [],
    settings: {
      vmName: 'ccvm', limaHome: '~/.lima-ccvm', stateDir: '~/Library/Application Support/CCVM/state', checkIntervalMin: 3,
      showCapsule: true, terminalApp: 'Terminal', launchAtLogin: true, egressMode: 'builtin', nodeName: '示例节点 · 东京 01',
      claudeLoginConfirmed: true, welcomeDone: true, hooksEnabled: true, sharedFolders: [], sharesEnabled: false,
      latencyTestUrl: 'https://www.gstatic.com/generate_204', theme: 'system',
    },
    shares: { applied: [], pendingApply: false, needsRetry: false, problems: {} },
    vmPackages: { level: 2, target: 2, tmuxInstalled: true, needsUpgrade: false },
    paths: { kit: '/Applications/CCVM.app/Contents/Resources/kit', state: '~/Library/Application Support/CCVM/state', jobs: 'jobs' },
    kitVersion: '2.3.0', appVersion: '0.1.0',
  };

  if (scenario === 'down') {
    snap.lastCheck = record('check', now - MIN, checks(CHECK, ['host.proxy', 'vm.proxy']), { host_egress: '', vm_egress: '' });
    snap.lastCheckAt = snap.lastCheck.at;
    snap.egress = {};
    snap.level = 'error';
    snap.headline = '代理断开';
    snap.detail = '127.0.0.1:17897 连不上代理，VM 已断网。代理恢复后自动连上。';
    snap.issues = [{ key: 'proxy_down', kind: 'proxy_down', title: '代理断开', detail: snap.detail }];
    snap.captions = [{ id: 1, at: now, level: 'error', text: `代理断开：${snap.detail}`, sticky: true, issueKey: 'proxy_down' }];
  }
  if (scenario === 'cv') {
    snap.settings = { ...snap.settings, egressMode: 'clash-verge' };
    snap.core = undefined;
  }
  if (scenario === 'shares') {
    const folders = ['/Volumes/Work/my-api', '/Volumes/Work/design assets', '/Volumes/Work/new-notes'];
    snap.settings = { ...snap.settings, sharesEnabled: true, sharedFolders: folders };
    snap.shares = {
      applied: [
        { path: folders[0], name: 'my-api', view: '/home/cc/mac/my-api', mounted: true },
        { path: folders[1], name: 'design_assets', view: '/home/cc/mac/design_assets', mounted: false },
      ],
      pendingApply: true,
      needsRetry: false,
      problems: {},
    };
  }
  if (scenario === 'upgrade') {
    snap.vmPackages = { level: 1, target: 2, tmuxInstalled: true, needsUpgrade: true };
  }
  if (scenario === 'busy') {
    snap.jobs = [{ id: 'demo-start', kind: 'vm-start', title: '启动 VM', args: ['start', '--json'], state: 'running', startedAt: now - 12_000 }, cloneJob];
    snap.level = 'busy';
    snap.headline = '启动 VM';
    snap.detail = '';
  }
  if (scenario === 'stopped') {
    snap.vm = { ...snap.vm, status: 'Stopped' };
    snap.level = 'idle';
    snap.headline = 'VM 已停止';
    snap.detail = '';
  }
  if (scenario === 'welcome') {
    snap.vm = { name: 'ccvm', status: 'Missing' };
    snap.level = 'idle';
    snap.headline = '还没部署';
    snap.detail = '打开欢迎页完成部署';
    snap.lastCheck = undefined;
    snap.lastCheckAt = undefined;
    snap.egress = {};
    snap.projects = [];
    snap.jobs = [];
    snap.claude = {};
    snap.settings = { ...snap.settings, welcomeDone: false, claudeLoginConfirmed: false, nodeName: '' };
    snap.core = { ...coreStatus(now), node: undefined, nodes: [], service: { loaded: false, running: false }, listenerOwned: undefined, portBusy: false, subscription: { set: false, autoUpdate: true, viaClashVerge: false } };
  }
  if (scenario === 'setup') {
    snap.vm = { name: 'ccvm', status: 'Running' };
    snap.jobs = [{ id: 'demo-setup', kind: 'setup', title: '准备 VM', args: ['--json'], state: 'running', startedAt: now - 95_000, step: '3/4 安装 VM 网络层（sing-box TUN + 防火墙 + cc 用户）', stepId: 'setup.install' }];
    snap.level = 'busy';
    snap.headline = '准备 VM';
    snap.lastCheck = undefined;
    snap.projects = [];
    snap.settings = { ...snap.settings, welcomeDone: false };
  }
  return snap;
}

export function createMockBridge(): Bridge {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get('demo') ?? 'ok';
  let snap = initial(scenario);
  // ?theme=light|dark：截图核对两套配色用
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') {
    snap = { ...snap, settings: { ...snap.settings, theme } };
    document.documentElement.dataset.theme = theme; // 第一次渲染前就定下来，截图不会拍到切换中的颜色
  }
  const listeners = new Set<(s: Snapshot) => void>();
  const emit = () => listeners.forEach((l) => l(snap));
  const update = (patch: Partial<Snapshot>) => {
    snap = { ...snap, ...patch };
    emit();
  };
  const caption = (text: string, level: 'ok' | 'error' = 'ok') => {
    const c = { id: Date.now(), at: Date.now(), level, text, sticky: false };
    update({ captions: [...snap.captions, c] });
    setTimeout(() => update({ captions: snap.captions.filter((x) => x.id !== c.id) }), 8000);
  };
  const job = (kind: JobSummary['kind'], title: string, ms: number, then?: () => void): string => {
    const id = `demo-${kind}-${Date.now()}`;
    update({ jobs: [{ id, kind, title, args: [], state: 'running', startedAt: Date.now() }, ...snap.jobs], level: 'busy', headline: title });
    setTimeout(() => {
      update({ jobs: snap.jobs.map((j) => (j.id === id ? { ...j, state: 'done', finishedAt: Date.now() } : j)), level: snap.issues.length ? 'error' : 'ok', headline: snap.issues.length ? snap.headline : '已连接' });
      then?.();
    }, ms);
    return id;
  };

  // 演示用的 VM 文件树：目录 → 条目
  const t = Math.floor(Date.now() / 1000);
  const tree = new Map<string, FileItem[]>([
    ['/home/cc', [{ name: 'mac', file_type: 'dir', size: 4096, mtime: t - 3600 }, { name: 'work', file_type: 'dir', size: 4096, mtime: t - 600 }, { name: '.bashrc', file_type: 'file', size: 3771, mtime: t - 86400 * 9 }]],
    ['/home/cc/work', [{ name: 'my-api', file_type: 'dir', size: 4096, mtime: t - 600 }, { name: 'web-app', file_type: 'dir', size: 4096, mtime: t - 86400 }]],
    ['/home/cc/work/my-api', [{ name: 'src', file_type: 'dir', size: 4096, mtime: t - 900 }, { name: 'README.md', file_type: 'file', size: 2140, mtime: t - 3000 }, { name: 'package.json', file_type: 'file', size: 812, mtime: t - 7200 }, { name: 'passwd-link', file_type: 'link', size: 11, mtime: t - 99999 }]],
    ['/home/cc/work/my-api/src', [{ name: 'index.ts', file_type: 'file', size: 5120, mtime: t - 900 }]],
    ['/home/cc/work/web-app', []],
    ['/home/cc/mac', [{ name: 'my-api', file_type: 'dir', size: 4096, mtime: t - 60 }]],
    ['/home/cc/mac/my-api', [{ name: 'notes.md', file_type: 'file', size: 120, mtime: t - 60 }]],
  ]);
  const parent = (p: string) => p.replace(/\/[^/]+$/, '') || '/';
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

  let cli = { path: '~/.local/bin/ccvm', installed: false, generated: false, onPath: false, hint: 'export PATH="$HOME/.local/bin:$PATH"' };
  const actions: Record<string, (...a: never[]) => unknown> = {
    quickCheck: async () => {
      update({ checking: true });
      await sleep(900);
      update({ checking: false, lastCheckAt: Date.now(), lastCheck: snap.lastCheck && { ...snap.lastCheck, at: Date.now() } });
    },
    setup: () => job('setup', '准备 VM', 4000, () => update({ vm: { ...snap.vm, status: 'Running' }, egress: { host: IP, vm: IP }, lastCheck: record('check', Date.now(), checks(CHECK), { host_egress: IP, vm_egress: IP }) })),
    vmStart: () => job('vm-start', '启动 VM', 1500, () => update({ vm: { ...snap.vm, status: 'Running' }, level: 'ok', headline: '已连接' })),
    vmStop: () => job('vm-stop', '停止 VM', 1500, () => update({ vm: { ...snap.vm, status: 'Stopped' }, level: 'idle', headline: 'VM 已停止' })),
    cancelJob: (id: string) => update({ jobs: snap.jobs.map((j) => (j.id === id ? { ...j, state: 'cancelled', reason: '已取消' } : j)) }),
    jobLog: () => '==> 3/4 安装 VM 网络层（sing-box TUN + 防火墙 + cc 用户）\n[vm] 检查 VM → http://192.168.5.2:17897 链路\n[vm] 安装基础包\nReading package lists... Done\n',
    refreshProjects: async () => update({ projectsAt: Date.now() }),
    clone: (url: string) => {
      const problem = gitUrlProblem(url);
      if (problem) throw new Error(problem);
      const name = projectNameFromUrl(url)!;
      return job('clone', '克隆项目', 3000, () => {
        update({ projects: [...snap.projects, { name, branch: 'main', dirty: 0, ahead: 0, behind: 0, updated: Math.floor(Date.now() / 1000), subject: 'Initial commit', remote: url, claudeSessions: 0, claudeSince: 0 }] });
        caption(`克隆完成：${name}`);
      });
    },
    refreshClaude: async () => undefined,
    preflight: async () => {
      await sleep(400);
      const ready = !!snap.core?.node || !!snap.settings.nodeName;
      const list = checks([...PRE, ['host.proxy', ready ? `代理入口通，出口 ${IP}` : '代理入口 127.0.0.1:17897 不通']], ready ? [] : ['host.proxy']);
      const rec = record('preflight', Date.now(), list, { host_egress: ready ? IP : '', lima_version: '2.2.1' });
      update({ lastPreflight: rec });
      return rec;
    },
    openTerminal: async () => caption('已在终端里打开 cc（演示）'),
    openAdminShell: async () => caption('已打开管理员 shell（演示）'),
    updateSettings: async (patch: Partial<Snapshot['settings']>) => {
      update({ settings: { ...snap.settings, ...patch, egressMode: snap.settings.egressMode } });
      return snap.settings;
    },
    chooseStateDir: async () => null,
    clashScript: async (node: string) => renderClashScript(TEMPLATE, node),
    copyText: async (text: string) => {
      await navigator.clipboard?.writeText(text).catch(() => undefined);
      caption('已复制');
    },
    openMain: async (route?: string) => {
      if (route) window.location.hash = route;
    },
    openExternal: async (url: string) => window.open(url, '_blank', 'noopener'),
    dismissCaption: async (id: number) => update({ captions: snap.captions.filter((c) => c.id !== id) }),
    setEgressMode: async (mode: 'builtin' | 'clash-verge') => {
      if (!window.confirm(`切换到「${mode === 'builtin' ? 'CCVM 自带核心' : '我的 Clash Verge'}」？`)) return null;
      update({ settings: { ...snap.settings, egressMode: mode }, core: mode === 'builtin' ? coreStatus(Date.now()) : undefined });
      return snap.settings;
    },
    setSubscription: async (url: string) => {
      await sleep(600);
      const masked = url.replace(/(token=)[^&]+/, '$1••••••••');
      update({ core: { ...snap.core!, nodes: NODES, subscription: { ...snap.core!.subscription, set: true, masked, lastUpdate: Date.now() } } });
      return NODES;
    },
    updateSubscription: async () => {
      await sleep(600);
      update({ core: { ...snap.core!, subscription: { ...snap.core!.subscription, lastUpdate: Date.now(), error: undefined } } });
      return { changed: false };
    },
    selectNode: async (name: string) => {
      await sleep(800);
      const node = NODES.find((n) => n.name === name)!;
      update({ core: { ...coreStatus(Date.now()), node, nodes: NODES }, lastPreflight: record('preflight', Date.now(), checks([...PRE, ['host.proxy', `代理入口通，出口 ${IP}`]]), { host_egress: IP, lima_version: '2.2.1' }) });
      caption(`已切换到「${name}」`);
      return node;
    },
    restartCore: async () => caption('核心已重启（演示）'),
    removeCore: async () => {
      if (!window.confirm('移除出口核心？')) return false;
      update({ core: { ...snap.core!, node: undefined, service: { loaded: false, running: false } } });
      return true;
    },
    clearSubscription: async () => update({ core: { ...snap.core!, subscription: { set: false, autoUpdate: true, viaClashVerge: false }, nodes: [] } }),
    setCoreOptions: async (o: { autoUpdate?: boolean; viaClashVerge?: boolean }) =>
      update({ core: { ...snap.core!, subscription: { ...snap.core!.subscription, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) } } }),
    latencyTest: async () => {
      await sleep(1200);
      const latency = { [NODES[0].name]: 86, [NODES[1].name]: 92, [NODES[2].name]: 121, [NODES[3].name]: null };
      const url = snap.settings.latencyTestUrl;
      update({ core: { ...snap.core!, latency, latencyAt: Date.now(), latencyUrl: url, latencyUnified: true } });
      return { results: latency, url, unifiedDelay: true };
    },
    refreshCore: async () => undefined,
    renameSession: async (from: string, to: string) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(to)) throw new Error('会话名只能用 A-Z a-z 0-9 _ -，最长 64');
      if (snap.sessions.some((s) => s.name === to)) throw new Error(`已经有叫 ${to} 的会话`);
      update({ sessions: snap.sessions.map((s) => (s.name === from ? { ...s, name: to } : s)) });
      return true;
    },
    killSession: async (name: string) => {
      update({ sessions: snap.sessions.filter((s) => s.name !== name) });
      return true;
    },
    addSharedFolder: async () => {
      const p = `/Volumes/Work/demo-${snap.settings.sharedFolders.length + 1}`;
      update({ settings: { ...snap.settings, sharedFolders: [...snap.settings.sharedFolders, p] }, shares: { ...snap.shares, pendingApply: true } });
      return snap.settings;
    },
    removeSharedFolder: async (p: string) => {
      update({ settings: { ...snap.settings, sharedFolders: snap.settings.sharedFolders.filter((f) => f !== p) }, shares: { ...snap.shares, pendingApply: true } });
      return snap.settings;
    },
    setSharesEnabled: async (on: boolean) => {
      update({ settings: { ...snap.settings, sharesEnabled: on }, shares: { ...snap.shares, pendingApply: true } });
      return snap.settings;
    },
    applyShares: () =>
      job('shares', '应用共享文件夹并重启 VM', 3000, () => {
        const folders = snap.settings.sharesEnabled ? snap.settings.sharedFolders : [];
        const applied = folders.map((p) => {
          const name = base(p).replace(/[^A-Za-z0-9._-]/g, '_');
          return { path: p, name, view: `/home/cc/mac/${name}`, mounted: true };
        });
        update({ shares: { applied, pendingApply: false, needsRetry: false, problems: {} } });
        caption('共享文件夹已应用，VM 已重启');
      }),
    listFiles: async (p: string) => {
      await sleep(200);
      const entries = tree.get(p);
      if (!entries) throw new Error(`没能列出 ${p}`);
      return { path: p, entries: [...entries].sort((a, b) => Number(b.file_type === 'dir') - Number(a.file_type === 'dir')) };
    },
    makeDir: async (p: string) => {
      tree.set(p, []);
      tree.set(parent(p), [...(tree.get(parent(p)) ?? []), { name: base(p), file_type: 'dir', size: 4096, mtime: Math.floor(Date.now() / 1000) }]);
    },
    removePath: async (p: string) => {
      if (!window.confirm(p.startsWith('/home/cc/mac/') ? `这是 Mac 上的真实文件：删除 ${p}？` : `删除 ${p}？`)) return false;
      tree.set(parent(p), (tree.get(parent(p)) ?? []).filter((e) => e.name !== base(p)));
      return true;
    },
    pushPaths: async (paths: string[], dest: string) =>
      paths.map((p) =>
        job('push', `上传 ${base(p)}`, 1500, () => {
          tree.set(dest, [...(tree.get(dest) ?? []), { name: base(p), file_type: 'file', size: 1000, mtime: Math.floor(Date.now() / 1000) }]);
          caption(`上传 ${base(p)}：完成`);
        }),
      ),
    chooseUpload: async (dest: string) => [
      job('push', '上传 demo.txt', 1500, () => {
        tree.set(dest, [...(tree.get(dest) ?? []), { name: 'demo.txt', file_type: 'file', size: 42, mtime: Math.floor(Date.now() / 1000) }]);
      }),
    ],
    pullFile: async (p: string) => job('pull', `下载 ${base(p)}`, 1200, () => caption(`下载 ${base(p)}：完成`)),
    vmUpgrade: () =>
      job('vm-upgrade', '更新 VM', 2500, () => {
        update({ vmPackages: { level: 2, target: 2, tmuxInstalled: true, needsUpgrade: false } });
        caption('VM 已更新');
      }),
    cliStatus: async () => cli,
    installCli: async () => {
      cli = { ...cli, installed: true, generated: true };
      return cli;
    },
    setHooks: async (enabled: boolean) => {
      update({ settings: { ...snap.settings, hooksEnabled: enabled } });
      return snap.settings;
    },
  };

  // 演示用的假终端：回显输入，回车时给一句提示
  const termData = new Set<(id: string, data: string) => void>();
  const termExit = new Set<(id: string, code: number) => void>();
  let termSeq = 0;
  const line: Record<string, string> = {};
  const say = (id: string, text: string) => setTimeout(() => termData.forEach((cb) => cb(id, text)), 0);
  const term = {
    open: async (spec: { mode: 'new' | 'attach'; project?: string; session?: string }) => {
      const id = `demo${++termSeq}`;
      const project = spec.project ?? snap.sessions.find((s) => s.name === spec.session)?.project ?? 'my-api';
      const session = spec.session ?? `${project}-${snap.sessions.filter((s) => s.project === project).length + 1}`;
      if (!snap.sessions.some((s) => s.name === session)) update({ sessions: [...snap.sessions, { name: session, created: Math.floor(Date.now() / 1000), attached: 1, project, activity: Math.floor(Date.now() / 1000), command: "bash" }] });
      line[id] = '';
      say(id, `\x1b[2m[演示终端：真实 App 里这里是 VM 中 cc 的 tmux 会话 ${session}]\x1b[0m\r\n` +
        (spec.mode === 'attach' ? '\x1b[36m╭─ Claude Code ─────────────────────────────╮\r\n│ ✻ 测试都通过了。要我提交吗？(y/n)          │\r\n╰───────────────────────────────────────────╯\x1b[0m\r\n' : '') +
        `\x1b[32mcc@ccvm\x1b[0m:\x1b[34m~/work/${project}\x1b[0m$ `);
      return { id, session };
    },
    write: (id: string, data: string) => {
      if (data === '\r') {
        const cmd = line[id];
        line[id] = '';
        say(id, `\r\n${cmd ? `（演示）${cmd}\r\n` : ''}\x1b[32mcc@ccvm\x1b[0m:\x1b[34m~/work\x1b[0m$ `);
      } else if (data === '\x7f') {
        line[id] = line[id].slice(0, -1);
        say(id, '\b \b');
      } else {
        line[id] += data;
        say(id, data);
      }
    },
    resize: () => undefined,
    close: async (id: string) => {
      termExit.forEach((cb) => cb(id, 0));
    },
    onData: (cb: (id: string, data: string) => void) => {
      termData.add(cb);
      return () => termData.delete(cb);
    },
    onExit: (cb: (id: string, code: number) => void) => {
      termExit.add(cb);
      return () => termExit.delete(cb);
    },
  };

  return {
    term,
    snapshot: async () => snap,
    act: async (name, args) => {
      const fn = actions[name];
      if (!fn) throw new Error(`未知动作：${name}`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    },
    onSnapshot: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onNavigate: () => () => undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
