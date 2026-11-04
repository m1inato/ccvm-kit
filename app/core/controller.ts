// App 的大脑：定时检查、后台任务、状态推导、提醒去重。不依赖 Electron，便于测试。
// 它只调用 scripts/ 里的脚本和 `limactl list`，结论全部来自脚本事件。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { latestChecks } from './events';
import { limaEnv, parseLoginPath, scriptEnv, validateSettingsPaths } from './env';
import { JobStore } from './jobs';
import type { CoreManager } from './egress';
import { isIPv4, gitUrlProblem, parseLimaList, renderClashScript, toProject } from './parsers';
import { DEFAULT_LATENCY_URL, latencyUrlProblem } from './mihomo';
import { MATRIX } from './report';
import { runCommand, runScript } from './runner';
import { shareLines, sharePathProblem, sharesFileContent } from './shares';
import { vmPathProblem } from './vmpath';
import { TERMINAL_APPS } from './types';
import { AlertTracker, deriveLevel, issuesFromCheck, issuesFromCore, issuesFromLeak, newestCheck, Throttle } from './status';
import type {
  Caption,
  CheckRecord,
  ClaudeEvent,
  CoreStatus,
  EgressMode,
  FileListing,
  Issue,
  JobKind,
  JobSummary,
  Level,
  Project,
  RunResult,
  SessionItem,
  Settings,
  SharesState,
  ShareItem,
  Snapshot,
  VmInfo,
} from './types';

export interface Host {
  kitDir: string;
  dataDir: string;
  appVersion: string;
  home: string;
  user: string;
  tmpdir?: string;
  /** 登录 shell 的输出（含 PATH 标记）；拿不到时返回 undefined */
  loginPathOutput(): Promise<string | undefined>;
  notify(title: string, body: string): void;
  now?: () => number;
  /** 自带出口核心（M3）。没有时只支持 Clash Verge 模式 */
  core?: CoreManager;
}

interface Persisted {
  lastQuick?: CheckRecord;
  lastFull?: CheckRecord;
  lastLeak?: CheckRecord;
  lastPreflight?: CheckRecord;
  projects?: Project[];
  projectsAt?: number;
  claude?: { installed?: boolean; version?: string; checkedAt?: number };
  matrix?: Record<string, number>;
  sessions?: SessionItem[];
  /** hook 事件文件读到的位置；没有时从文件末尾开始（不补发旧事件） */
  eventsOffset?: number;
  /** 出口路径变了（换节点、重启或移除核心、切换出网方式）：在这之前的检查结论不再用来判断状态 */
  checksInvalidBefore?: number;
  /** 最近一次 share.sh status 列出的共享 */
  shares?: ShareItem[];
}

export function defaultSettings(home: string, dataDir: string): Settings {
  return {
    vmName: 'ccvm',
    limaHome: path.join(home, '.lima-ccvm'),
    stateDir: path.join(dataDir, 'state'),
    checkIntervalMin: 10,
    showCapsule: true,
    terminalApp: 'Terminal',
    launchAtLogin: false,
    // 新装默认用自带核心；已有部署的设置文件里存着 clash-verge，保持不变
    egressMode: 'builtin',
    nodeName: '',
    claudeLoginConfirmed: false,
    welcomeDone: false,
    hooksEnabled: false,
    sharedFolders: [],
    sharesEnabled: false,
    latencyTestUrl: DEFAULT_LATENCY_URL,
  };
}

const QUICK_TIMEOUT = 120_000;
const SHORT_TIMEOUT = 90_000;
/** 这些任务运行时不做快速检查，也不开始别的独占任务（断流测试会停掉 TUN） */
const EXCLUSIVE: JobKind[] = ['setup', 'leaktest', 'vm-start', 'vm-stop', 'shares'];
const CAPTION_MS = 8000;

export class Controller extends EventEmitter {
  settings: Settings;
  private state: Persisted;
  private jobs: JobStore;
  private vm: VmInfo;
  private checking = false;
  private alerts = new AlertTracker();
  private captions: Caption[] = [];
  private captionSeq = 0;
  private timers: NodeJS.Timeout[] = [];
  private checkTimer?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  private path?: string;
  private projectsError?: string;
  private kitVersion: string;
  private now: () => number;
  private coreStatus?: CoreStatus;
  private coreBusy = false;
  private later = new Set<NodeJS.Timeout>();
  private disposed = false;
  private pollingEvents = false;
  private vmSeq = 0;
  /** 「做完了」：同一项目 5 分钟内只弹一次；「在等你」：同一项目 1 分钟内一次 */
  private doneThrottle = new Throttle(5 * 60_000);
  private waitThrottle = new Throttle(60_000);

  constructor(private host: Host) {
    super();
    this.now = host.now ?? Date.now;
    fs.mkdirSync(host.dataDir, { recursive: true });
    this.settings = { ...defaultSettings(host.home, host.dataDir), ...readJson<Partial<Settings>>(this.file('settings.json')) };
    if (validateSettingsPaths(this.settings)) {
      const d = defaultSettings(host.home, host.dataDir);
      this.settings = { ...this.settings, vmName: d.vmName, limaHome: d.limaHome, stateDir: d.stateDir };
    }
    // 设置文件可能被手改：共享列表只留字符串
    const folders = (this.settings as { sharedFolders?: unknown }).sharedFolders;
    this.settings.sharedFolders = Array.isArray(folders) ? folders.filter((f): f is string => typeof f === 'string') : [];
    this.settings.sharesEnabled = this.settings.sharesEnabled === true;
    if (latencyUrlProblem(this.settings.latencyTestUrl)) this.settings.latencyTestUrl = DEFAULT_LATENCY_URL;
    this.state = readJson<Persisted>(this.file('app-state.json')) ?? {};
    this.jobs = new JobStore(path.join(host.dataDir, 'jobs'), host.kitDir, this.now);
    this.vm = { name: this.settings.vmName, status: 'Unknown' };
    this.kitVersion = (readText(path.join(host.kitDir, 'VERSION')) ?? 'unknown').trim();
    this.alerts.update(this.issues()); // 上次已经通知过的问题，重启 App 后不重复通知
  }

  // ------------------------------------------------------------------ 生命周期
  async init(): Promise<void> {
    this.path = parseLoginPath(await this.host.loginPathOutput().catch(() => undefined));
    await this.refreshVm();
    await this.refreshCore();
    void this.refreshShares();
    if (this.vm.status === 'Running') void this.quickCheck('启动');
    this.timers.push(setInterval(() => this.pollJobs(), 2000));
    this.timers.push(setInterval(() => void this.refreshVm().then(() => this.refreshCore()), 15_000));
    this.timers.push(setInterval(() => this.expireCaptions(), 1000));
    this.timers.push(setInterval(() => void this.pollClaudeEvents(), 10_000));
    this.armCheckTimer();
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.later) clearTimeout(t);
    for (const t of this.timers) clearInterval(t);
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.pending) clearTimeout(this.pending);
    this.removeAllListeners();
  }

  private armCheckTimer(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    const ms = Math.max(2, this.settings.checkIntervalMin) * 60_000;
    this.checkTimer = setInterval(() => void this.quickCheck('定时'), ms);
  }

  /** Mac 唤醒、切换网络后：等几秒网络稳定再查 */
  trigger(reason: 'wake' | 'network', delayMs = 5000): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void (async () => {
        // 自带核心：先跟上网卡（改绑 / 没网卡就停 / 网卡回来恢复），再检查
        if (this.builtin() && this.host.core) {
          try {
            const r = await this.host.core.onNetworkChange();
            if (r === 'rebound') this.caption('busy', `网络切换了，出口核心已改绑到 ${(await this.host.core.status()).iface ?? '新网卡'}`);
          } catch (err) {
            this.caption('error', `出口核心没能跟上网络切换：${(err as Error).message}`);
          }
        }
        await this.refreshVm();
        await this.refreshCore();
        await this.quickCheck(reason === 'wake' ? '唤醒' : '网络切换');
      })();
    }, delayMs);
  }

  // ------------------------------------------------------------------ 自带出口核心
  private builtin(): boolean {
    return this.settings.egressMode === 'builtin';
  }

  private requireCore(): CoreManager {
    if (!this.host.core) throw new Error('这个版本没有自带出口核心');
    return this.host.core;
  }

  async refreshCore(): Promise<void> {
    const core = this.host.core;
    if (!core || !this.builtin()) {
      if (this.coreStatus) {
        this.coreStatus = undefined;
        this.changed();
      }
      return;
    }
    await core.detect();
    if (core.needsUpdate() && !this.coreBusy) {
      this.coreBusy = true;
      try {
        const r = await core.update();
        if (r.changed) this.scheduleQuick();
      } catch {
        /* 下载失败只在设置里显示（lastUpdateError），不提醒、不变红 */
      } finally {
        this.coreBusy = false;
      }
    }
    this.coreStatus = await core.status();
    this.changed();
  }

  /** 核心启停后要等它开始监听，再检查 */
  private scheduleQuick(delayMs = 3000): void {
    const t = setTimeout(() => {
      this.later.delete(t);
      void this.refreshCore().then(() => this.quickCheck('出口核心变化'));
    }, delayMs);
    this.later.add(t);
  }

  /** 出口路径变了：旧的检查结论作废，状态先变灰「等待检查」，直到下一次检查 */
  private invalidateChecks(): void {
    this.state.checksInvalidBefore = this.now();
    this.save();
  }

  /** 用来判断状态的那次检查：取较新的一次，但出口路径变化之前的不算 */
  private currentCheck(): CheckRecord | undefined {
    const last = newestCheck(this.state.lastQuick, this.state.lastFull);
    const before = this.state.checksInvalidBefore;
    return last && before && last.at < before ? undefined : last;
  }

  /** 调用前主进程已经弹框确认过 */
  async setEgressMode(mode: EgressMode): Promise<Settings> {
    if (mode !== 'builtin' && mode !== 'clash-verge') throw new Error('未知的出网方式');
    if (mode === this.settings.egressMode) return this.settings;
    const core = this.host.core;
    if (mode === 'builtin' && !core) throw new Error('这个版本没有自带出口核心');
    if (mode === 'clash-verge' && core) {
      const st = await core.status();
      if (st.service.loaded) await core.stop('mode', '已切换到 Clash Verge 模式');
    }
    this.settings = { ...this.settings, egressMode: mode };
    writeJson(this.file('settings.json'), this.settings);
    this.invalidateChecks();
    let startError: Error | undefined;
    if (mode === 'builtin' && core) {
      const st = await core.status();
      if (st.node && !st.pending) {
        try {
          await core.start();
        } catch (err) {
          startError = err as Error;
        }
      }
    }
    await this.refreshCore();
    this.scheduleQuick();
    if (startError) throw new Error(`已切换到自带核心，但核心没有启动：${startError.message}`);
    return this.settings;
  }

  async setSubscription(url: string) {
    const nodes = await this.requireCore().setSubscription(url);
    await this.refreshCore();
    return nodes;
  }

  async updateSubscription() {
    const r = await this.requireCore().update();
    await this.refreshCore();
    if (r.changed) this.scheduleQuick(500);
    return r;
  }

  /** 调用前主进程已经弹框确认过（换节点或确认节点变化时） */
  async selectNode(name: string) {
    const pinned = await this.requireCore().selectNode(name);
    this.invalidateChecks();
    this.caption('busy', `出口核心改用「${pinned.name}」，正在检查出口`);
    await this.refreshCore();
    this.scheduleQuick();
    return pinned;
  }

  async restartCore() {
    await this.requireCore().restart();
    this.invalidateChecks();
    await this.refreshCore();
    this.scheduleQuick();
  }

  async removeCore() {
    await this.requireCore().remove();
    this.invalidateChecks();
    await this.refreshCore();
    this.scheduleQuick(500);
  }

  async clearSubscription() {
    this.requireCore().clearSubscription();
    await this.refreshCore();
  }

  async setCoreOptions(opts: { autoUpdate?: boolean; viaClashVerge?: boolean }) {
    this.requireCore().setOptions(opts);
    await this.refreshCore();
  }

  coreConnections() {
    return this.requireCore().connections();
  }

  async latencyTest() {
    const r = await this.requireCore().latencyTest(this.settings.latencyTestUrl);
    await this.refreshCore();
    return r;
  }

  // ------------------------------------------------------------------ 环境
  /** 内嵌终端用的环境：和脚本一样从零构造，没有代理变量 */
  terminalEnv(): Record<string, string> {
    return this.env();
  }

  private env(): Record<string, string> {
    return scriptEnv({ path: this.path ?? parseLoginPath(undefined), home: this.host.home, user: this.host.user, tmpdir: this.host.tmpdir, settings: this.settings });
  }

  private run(script: string, args: string[], timeoutMs = SHORT_TIMEOUT): Promise<RunResult> {
    return runScript({ kitDir: this.host.kitDir, script, args, env: this.env(), timeoutMs });
  }

  async refreshVm(): Promise<void> {
    // 拿到登录 shell 的 PATH 之前不查：默认 PATH 里可能找不到 limactl，会把 VM 错报成「找不到 limactl」
    if (this.path === undefined) return;
    const seq = ++this.vmSeq;
    const env = limaEnv({ path: this.path, home: this.host.home, user: this.host.user, tmpdir: this.host.tmpdir, settings: this.settings });
    const out = await runCommand('limactl', ['list', '--json'], env, 20_000);
    if (seq !== this.vmSeq) return; // 之后又发起了一次：以较新的那次为准，旧结果不覆盖它
    const prev = this.vm.status;
    if (out.code === 0) {
      this.vm = parseLimaList(out.stdout, this.settings.vmName);
    } else {
      this.vm = {
        name: this.settings.vmName,
        status: 'Unknown',
        error: /ENOENT|not found/i.test(out.stderr) ? '找不到 limactl（brew install lima）' : (out.stderr.trim().split('\n').pop() ?? 'limactl 读取失败'),
      };
    }
    if (prev !== this.vm.status) this.changed();
  }

  // ------------------------------------------------------------------ 检查
  async quickCheck(_reason = '手动'): Promise<void> {
    // init() 拿到登录 shell 的 PATH 之前不检查：否则会用默认 PATH 找错 limactl / uname，得出错误结论
    if (this.path === undefined || this.disposed || this.checking || this.jobs.runningOf(EXCLUSIVE)) return;
    if (this.vm.status !== 'Running') return;
    this.checking = true;
    this.changed();
    try {
      const result = await this.run('check.sh', ['--quick'], QUICK_TIMEOUT);
      this.state.lastQuick = toRecord('quick', result);
      this.save();
    } finally {
      this.checking = false;
      this.changed();
    }
  }

  async preflight(): Promise<CheckRecord> {
    const result = await this.run('preflight.sh', []);
    this.state.lastPreflight = toRecord('preflight', result);
    this.save();
    this.changed();
    return this.state.lastPreflight;
  }

  fullCheck(): string {
    return this.startJob('check-full', '完整验收', 'check.sh', []);
  }

  leaktest(): string {
    if (this.jobs.runningOf(['clone'])) throw new Error('克隆进行中，等它结束再做断流测试');
    return this.startJob('leaktest', '断流测试', 'leaktest.sh', [], ['leak.capture_control', 'leak.capture_bypass']);
  }

  setup(): string {
    return this.startJob('setup', '准备 VM', 'setup.sh', []);
  }

  vmStart(): string {
    return this.startJob('vm-start', '启动 VM', 'vm.sh', ['start']);
  }

  vmStop(): string {
    return this.startJob('vm-stop', '停止 VM', 'vm.sh', ['stop']);
  }

  clone(url: string): string {
    const problem = gitUrlProblem(url);
    if (problem) throw new Error(problem);
    return this.startJob('clone', '克隆项目', 'workspace.sh', ['clone', url.trim()]);
  }

  cancelJob(id: string): void {
    this.jobs.cancel(id);
    this.changed();
  }

  jobLog(id: string): string {
    return this.jobs.log(id);
  }

  private startJob(kind: JobKind, title: string, script: string, args: string[], required?: string[]): string {
    const busy = this.jobs.runningOf(EXCLUSIVE);
    if (busy) throw new Error(`「${busy.title}」还在进行，结束后再试`);
    if (kind === 'clone' && this.jobs.runningOf(['clone'])) throw new Error('已经有一个克隆在进行');
    const id = this.jobs.start(kind, title, script, args, this.env(), { required });
    this.changed();
    return id;
  }

  private pollJobs(): void {
    const running = this.jobs.list().some((j) => j.state === 'running');
    const finished = this.jobs.poll();
    for (const job of finished) this.onJobFinished(job);
    if (running || finished.length) this.changed();
  }

  private onJobFinished(job: JobSummary): void {
    const result = job.result;
    const ok = job.state === 'done';
    switch (job.kind) {
      case 'check-full':
        if (result && job.state !== 'cancelled') this.state.lastFull = toRecord('full', result);
        this.caption(ok ? 'ok' : 'error', ok ? '完整验收通过' : `完整验收没有通过：${job.reason ?? ''}`);
        break;
      case 'leaktest':
        if (result && job.state !== 'cancelled') this.state.lastLeak = toRecord('leak', result);
        this.caption(ok ? 'ok' : 'error', ok ? leakSummary(result) : `断流测试没有通过：${job.reason ?? ''}`);
        // 自带核心升级后，断流测试通过才算接受了新版本
        if (ok && this.builtin()) this.host.core?.acceptVersion();
        void this.refreshCore().then(() => this.quickCheck('断流测试后'));
        break;
      case 'setup':
        if (result) {
          const leak = result.checks.filter((c) => c.id.startsWith('leak.'));
          if (leak.length && job.state !== 'cancelled') {
            this.state.lastLeak = { kind: 'leak', at: result.finishedAt, ok: ok && leak.every((c) => c.ok), checks: leak, values: result.values, reason: job.reason };
          }
        }
        this.caption(ok ? 'ok' : 'error', ok ? '部署完成，可以登录 Claude 了' : `部署没有完成：${job.reason ?? ''}`);
        void this.refreshVm().then(() => this.quickCheck('部署后'));
        void this.refreshClaude();
        break;
      case 'vm-start':
      case 'vm-stop':
        void this.refreshVm().then(() => this.quickCheck('启停后'));
        if (!ok) this.caption('error', `${job.title}失败：${job.reason ?? ''}`);
        break;
      case 'shares':
        this.caption(ok ? 'ok' : 'error', ok ? '共享文件夹已应用，VM 已重启' : `共享文件夹没有应用好：${job.reason ?? ''}`);
        // 依次刷新共享、VM 状态、出口核心，再做一次快速检查
        void this.refreshShares()
          .then(() => this.refreshVm())
          .then(() => this.refreshCore())
          .then(() => this.quickCheck('应用共享后'));
        break;
      case 'push':
      case 'pull':
        this.caption(ok ? 'ok' : 'error', ok ? `${job.title}：完成` : `${job.title}失败：${job.reason ?? ''}`);
        break;
      case 'clone': {
        const name = result?.values.project;
        this.caption(ok ? 'ok' : 'error', ok ? `克隆完成：${name ?? ''}` : `克隆失败：${job.reason ?? ''}`);
        void this.refreshProjects();
        break;
      }
    }
    this.save();
  }

  // ------------------------------------------------------------------ 共享文件夹
  private shareContext() {
    return { home: this.host.home, limaHome: this.settings.limaHome, stateDir: this.settings.stateDir, kitDir: this.host.kitDir };
  }

  private sharesFile(): string {
    return path.join(this.settings.stateDir, 'shares.txt');
  }

  async refreshShares(): Promise<void> {
    const result = await this.run('share.sh', ['status'], 30_000);
    // 读不到状态就不显示已应用的共享（不确定就不当真）；路径问题照样记下
    if (result.exitCode === 0) this.state.shares = result.shares;
    else this.state.shares = undefined;
    this.save();
    this.changed();
  }

  private saveSettings(next: Settings): Settings {
    this.settings = next;
    writeJson(this.file('settings.json'), next);
    this.changed();
    return next;
  }

  /** 调用前主进程已经弹框选好文件夹；只改设置，应用时才写 shares.txt */
  addSharedFolder(folder: string): Settings {
    if (typeof folder !== 'string' || !folder.startsWith('/') || /[\n\r\0]/.test(folder)) throw new Error('无效的文件夹路径');
    const p = folder.length > 1 ? folder.replace(/\/+$/, '') : folder;
    if (this.settings.sharedFolders.includes(p)) return this.settings;
    if (this.settings.sharedFolders.length >= 32) throw new Error('最多共享 32 个文件夹');
    return this.saveSettings({ ...this.settings, sharedFolders: [...this.settings.sharedFolders, p] });
  }

  removeSharedFolder(folder: string): Settings {
    return this.saveSettings({ ...this.settings, sharedFolders: this.settings.sharedFolders.filter((f) => f !== folder) });
  }

  setSharesEnabled(on: boolean): Settings {
    return this.saveSettings({ ...this.settings, sharesEnabled: on === true });
  }

  /** 调用前主进程已经弹框说明风险。写 shares.txt，然后在后台跑 share.sh apply（会重启 VM） */
  applyShares(): string {
    const busy = this.jobs.runningOf(EXCLUSIVE);
    if (busy) throw new Error(`「${busy.title}」还在进行，结束后再试`);
    if (this.settings.sharesEnabled) {
      for (const p of this.settings.sharedFolders) {
        const problem = sharePathProblem(p, this.shareContext());
        if (problem) throw new Error(`不能共享：${problem}`);
      }
    }
    fs.mkdirSync(this.settings.stateDir, { recursive: true });
    const file = this.sharesFile();
    fs.writeFileSync(file + '.tmp', sharesFileContent(this.settings));
    fs.renameSync(file + '.tmp', file);
    return this.startJob('shares', '应用共享文件夹并重启 VM', 'share.sh', ['apply']);
  }

  private sharesState(): SharesState {
    const desired = shareLines(sharesFileContent(this.settings));
    const current = shareLines(readText(this.sharesFile()));
    const pendingApply = desired.length !== current.length || desired.some((p, i) => p !== current[i]);
    const problems: Record<string, string> = {};
    for (const p of this.settings.sharedFolders) {
      const problem = sharePathProblem(p, this.shareContext());
      if (problem) problems[p] = problem;
    }
    for (const s of this.state.shares ?? []) if (s.problem) problems[s.path] = s.problem;
    return {
      applied: (this.state.shares ?? []).map((s) => ({ path: s.path, name: s.name, view: s.view })),
      pendingApply,
      problems,
    };
  }

  // ------------------------------------------------------------------ 传文件
  private vmPath(p: unknown): string {
    if (typeof p !== 'string') throw new Error('VM 路径应为字符串');
    const problem = vmPathProblem(p);
    if (problem) throw new Error(problem);
    return p;
  }

  async listFiles(p: string): Promise<FileListing> {
    const result = await this.run('files.sh', ['list', this.vmPath(p)], 60_000);
    if (!result.ok) throw new Error(result.reason ?? '没能列出文件');
    const truncated = Number(result.values.truncated);
    return { path: result.values.path || p, entries: result.files, ...(Number.isFinite(truncated) && truncated > 0 ? { truncated } : {}) };
  }

  async makeDir(p: string): Promise<void> {
    const result = await this.run('files.sh', ['mkdir', this.vmPath(p)]);
    if (!result.ok) throw new Error(result.reason ?? '没能新建文件夹');
  }

  /** 调用前主进程已经确认过 */
  async removePath(p: string): Promise<boolean> {
    const result = await this.run('files.sh', ['rm', this.vmPath(p)], 120_000);
    if (!result.ok) throw new Error(result.reason ?? '没能删除');
    return true;
  }

  /** 主进程已经校验过 Mac 路径（绝对路径、存在、顶层不是符号链接）；每个路径一个后台任务 */
  pushPaths(paths: string[], destDir: string): string[] {
    const dest = this.vmPath(destDir);
    const ids: string[] = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('Mac 路径必须是绝对路径');
      ids.push(this.startJob('push', `上传 ${path.basename(p)}`, 'files.sh', ['push', p, dest]));
    }
    return ids;
  }

  /** 主进程已经弹过保存对话框；目标已存在时对话框里已经确认覆盖 */
  pullFile(vmFile: string, dest: string, overwrite: boolean): string {
    const src = this.vmPath(vmFile);
    if (typeof dest !== 'string' || !dest.startsWith('/')) throw new Error('Mac 目标必须是绝对路径');
    return this.startJob('pull', `下载 ${path.posix.basename(src)}`, 'files.sh', ['pull', src, dest, ...(overwrite ? ['--force'] : [])]);
  }

  // ------------------------------------------------------------------ 基线
  async previewRebaseline(): Promise<RunResult> {
    return this.run('rebaseline.sh', ['--dry-run'], QUICK_TIMEOUT);
  }

  /** 调用前必须已经二次确认（Electron 层用系统对话框） */
  async acceptRebaseline(ip: string): Promise<RunResult> {
    if (!isIPv4(ip)) throw new Error('不是有效的 IPv4');
    const result = await this.run('rebaseline.sh', ['--accept', ip], QUICK_TIMEOUT);
    if (result.ok) this.caption('ok', `基线已更新为 ${ip}`);
    await this.quickCheck('更新基线后');
    return result;
  }

  // ------------------------------------------------------------------ 项目与 Claude
  async refreshProjects(): Promise<void> {
    if (this.vm.status !== 'Running' || this.jobs.runningOf(['leaktest', 'setup'])) return;
    const result = await this.run('workspace.sh', ['list']);
    if (result.ok) {
      this.state.projects = result.items.map(toProject);
      this.state.sessions = result.sessions;
      this.state.projectsAt = this.now();
      this.projectsError = undefined;
    } else {
      this.projectsError = result.reason;
    }
    this.save();
    this.changed();
  }

  async refreshClaude(): Promise<void> {
    if (this.vm.status !== 'Running') return;
    const result = await this.run('workspace.sh', ['claude'], 60_000);
    const installed = result.values.claude_installed;
    if (installed === '1' || installed === '0') {
      this.state.claude = { installed: installed === '1', version: result.values.claude_version, checkedAt: this.now() };
      this.save();
      this.changed();
    }
  }

  // ------------------------------------------------------------------ tmux 会话与 Claude 事件
  async killSession(name: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('无效的会话名');
    const result = await this.run('workspace.sh', ['kill-session', name]);
    await this.refreshProjects();
    if (!result.ok) throw new Error(result.reason ?? '没能结束会话');
    return true;
  }

  /** 新会话的名字：<项目>-<序号>，tmux 会话名只用 [A-Za-z0-9_-] */
  nextSessionName(project: string): string {
    const base = project.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56);
    const taken = new Set((this.state.sessions ?? []).map((s) => s.name));
    for (let n = 1; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  async setHooks(enabled: boolean): Promise<Settings> {
    if (this.vm.status !== 'Running') throw new Error('VM 没有运行');
    const result = await this.run('hooks.sh', [enabled ? 'enable' : 'disable']);
    if (!result.ok) throw new Error(result.reason ?? 'hook 操作没有完成');
    this.settings = { ...this.settings, hooksEnabled: enabled };
    writeJson(this.file('settings.json'), this.settings);
    this.state.eventsOffset = undefined; // 重新开启时从文件末尾读，不补发旧事件
    this.save();
    this.changed();
    return this.settings;
  }

  async pollClaudeEvents(): Promise<void> {
    if (!this.settings.hooksEnabled || this.pollingEvents || this.vm.status !== 'Running' || this.jobs.runningOf(EXCLUSIVE)) return;
    this.pollingEvents = true;
    try {
      const offset = this.state.eventsOffset;
      const result = await this.run('workspace.sh', ['events', offset === undefined ? 'end' : String(offset)], 30_000);
      if (!result.ok) return;
      const size = Number(result.values.events_size);
      if (Number.isFinite(size)) this.state.eventsOffset = size;
      if (offset !== undefined) for (const e of result.claudeEvents) this.onClaudeEvent(e);
      this.save();
    } finally {
      this.pollingEvents = false;
    }
  }

  private onClaudeEvent(e: ClaudeEvent): void {
    const project = e.project || 'Claude';
    const now = this.now();
    if (e.event === 'Stop') {
      if (this.doneThrottle.allow(project, now)) this.caption('ok', `${project}：Claude 做完了`, false, undefined, e.project || undefined);
    } else if (this.waitThrottle.allow(project, now)) {
      const what = e.notification === 'permission_prompt' ? '在等你批准' : e.notification === 'idle_prompt' ? '在等你回复' : '有新消息';
      this.caption('busy', `${project}：Claude ${what}${e.message ? `——${e.message}` : ''}`, false, undefined, e.project || undefined);
    }
  }

  clashScript(node: string): { ok: boolean; script?: string; error?: string } {
    const template = readText(path.join(this.host.kitDir, 'config', 'clash-verge-script.js'));
    if (!template) return { ok: false, error: '找不到套件里的扩展脚本模板' };
    return renderClashScript(template, node);
  }

  // ------------------------------------------------------------------ 设置
  updateSettings(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.settings };
    const allowed: (keyof Settings)[] = [
      'vmName', 'limaHome', 'stateDir', 'checkIntervalMin', 'showCapsule', 'terminalApp',
      'launchAtLogin', 'nodeName', 'claudeLoginConfirmed', 'welcomeDone', 'latencyTestUrl',
    ];
    // hooksEnabled 只能经 setHooks 改（要在 VM 里装 / 删 hook）
    for (const key of allowed) {
      if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key];
    }
    const minutes = Number(next.checkIntervalMin);
    next.checkIntervalMin = Math.min(120, Math.max(2, Math.round(Number.isFinite(minutes) ? minutes : 10)));
    if (!TERMINAL_APPS.includes(next.terminalApp)) next.terminalApp = 'Terminal';
    // 出网方式只能经 setEgressMode 切换（要启停核心）
    next.nodeName = String(next.nodeName ?? '').slice(0, 200);
    for (const key of ['showCapsule', 'launchAtLogin', 'claudeLoginConfirmed', 'welcomeDone'] as const) next[key] = !!next[key];
    if (patch.latencyTestUrl !== undefined) {
      const bad = latencyUrlProblem(patch.latencyTestUrl);
      if (bad) throw new Error(bad);
    }
    const problem = validateSettingsPaths(next);
    if (problem) throw new Error(problem);
    const target = next.vmName !== this.settings.vmName || next.limaHome !== this.settings.limaHome || next.stateDir !== this.settings.stateDir;
    const interval = next.checkIntervalMin !== this.settings.checkIntervalMin;
    this.settings = next;
    writeJson(this.file('settings.json'), next);
    if (target) {
      // 指向了另一个 VM 或另一份基线：旧结论作废（手动验收矩阵也属于原来的 VM）
      this.state = {};
      this.save();
      void this.refreshVm().then(() => this.refreshShares()).then(() => this.quickCheck('设置变更'));
    }
    if (interval) this.armCheckTimer();
    this.changed();
    return next;
  }

  canOpenSession(): { ok: boolean; reason?: string } {
    const snap = this.snapshot();
    if (snap.newSessionsBlocked) return { ok: false, reason: `${snap.headline}：${snap.detail}` };
    return { ok: true };
  }

  setMatrix(id: string, done: boolean): void {
    if (!MATRIX.some((m) => m.id === id && !m.auto)) throw new Error('未知的验收项');
    const matrix = { ...(this.state.matrix ?? {}) };
    if (done) matrix[id] = this.now();
    else delete matrix[id];
    this.state.matrix = matrix;
    this.save();
    this.changed();
  }

  // ------------------------------------------------------------------ 字幕
  caption(level: Level, text: string, sticky = false, issueKey?: string, project?: string): void {
    this.captions.push({ id: ++this.captionSeq, at: this.now(), level, text, sticky, issueKey, project });
    this.captions = this.captions.slice(-5);
    this.changed();
  }

  dismissCaption(id: number): void {
    this.captions = this.captions.filter((c) => c.id !== id);
    this.changed();
  }

  private expireCaptions(): void {
    const now = this.now();
    const before = this.captions.length;
    this.captions = this.captions.filter((c) => c.sticky || now - c.at < CAPTION_MS);
    if (this.captions.length !== before) this.changed();
  }

  // ------------------------------------------------------------------ 快照
  issues(): Issue[] {
    const last = this.currentCheck();
    const core = this.builtin() ? issuesFromCore(this.coreStatus) : [];
    // 核心自己的问题说得更清楚；它导致的「专用入口不可用」不再重复报
    const fromCheck = issuesFromCheck(last).filter((i) => !(core.length && i.kind === 'listener_down'));
    return [...core, ...fromCheck, ...issuesFromLeak(this.state.lastLeak)];
  }

  snapshot(): Snapshot {
    const now = this.now();
    const coreIssues = this.builtin() ? issuesFromCore(this.coreStatus) : [];
    const issues = this.vm.status === 'Running' ? this.issues() : [...coreIssues, ...issuesFromLeak(this.state.lastLeak)];
    const jobs = this.jobs.list();
    const last = this.currentCheck();
    const { level, headline, detail } = deriveLevel({ issues, vm: this.vm, lastCheck: last, jobs, intervalMin: this.settings.checkIntervalMin, now });
    const v = last?.values ?? {};
    return {
      level,
      headline,
      detail,
      egress: { host: v.host_egress || undefined, vm: v.vm_egress || undefined, baseline: v.baseline || readBaseline(this.settings.stateDir) },
      vm: this.vm,
      lastQuick: this.state.lastQuick,
      lastFull: this.state.lastFull,
      lastLeak: this.state.lastLeak,
      lastPreflight: this.state.lastPreflight,
      lastCheckAt: last?.at,
      checking: this.checking,
      issues,
      newSessionsBlocked: level === 'error',
      jobs: jobs.slice(0, 20),
      projects: this.state.projects ?? [],
      sessions: this.state.sessions ?? [],
      projectsAt: this.state.projectsAt,
      projectsError: this.projectsError,
      claude: this.state.claude ?? {},
      core: this.builtin() ? this.coreStatus : undefined,
      captions: this.captions,
      shares: this.sharesState(),
      matrix: this.state.matrix ?? {},
      settings: this.settings,
      paths: {
        kit: this.host.kitDir,
        state: this.settings.stateDir,
        baselineFile: path.join(this.settings.stateDir, 'expected-ip.txt'),
        jobs: path.join(this.host.dataDir, 'jobs'),
      },
      kitVersion: this.kitVersion,
      appVersion: this.host.appVersion,
    };
  }

  private changed(): void {
    if (this.disposed) return; // dispose 之后还在路上的检查：不再通知、不再推送
    const snap = this.snapshot();
    // 新出现的问题：系统通知一次 + 常驻字幕；问题消失时撤掉对应字幕
    const fresh = this.alerts.update(snap.issues);
    for (const issue of fresh) {
      this.host.notify(`CCVM · ${issue.title}`, issue.detail);
      this.captions.push({ id: ++this.captionSeq, at: this.now(), level: 'error', text: `${issue.title}：${issue.detail}`, sticky: true, issueKey: issue.key });
    }
    const active = new Set(snap.issues.map((i) => i.key));
    this.captions = this.captions.filter((c) => !c.issueKey || active.has(c.issueKey)).slice(-5);
    this.emit('snapshot', fresh.length ? this.snapshot() : snap);
  }

  private save(): void {
    if (this.disposed) return;
    writeJson(this.file('app-state.json'), this.state);
  }

  private file(name: string): string {
    return path.join(this.host.dataDir, name);
  }
}

export function toRecord(kind: CheckRecord['kind'], result: RunResult): CheckRecord {
  return { kind, at: result.finishedAt, ok: result.ok, reason: result.reason, checks: result.checks, values: result.values };
}

export function leakSummary(result: RunResult | undefined): string {
  const v = result?.values ?? {};
  if (!result) return '断流测试结束';
  const ctrl = latestChecks(result.checks).get('leak.capture_control');
  return ctrl?.ok
    ? `断流测试通过：经专用入口 ${v.capture_control ?? '?'} 个包 · 旁路 ${v.capture_bypass ?? '?'} 个`
    : '断流测试结束';
}

function readBaseline(stateDir: string): string | undefined {
  const text = readText(path.join(stateDir, 'expected-ip.txt'))?.trim();
  return isIPv4(text) ? text : undefined;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson<T>(file: string): T | undefined {
  const text = readText(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}
