// 自带出口核心：App 用 launchd 管理一个 mihomo（Homebrew 安装）。只在主进程里用。
// 规则（设计方案「网络出口」「安全约束」5–8）：
//  - 只有一个入口 127.0.0.1:17897，只连选定节点，其余拒绝；绑定物理网卡；节点域名用当前网卡的 DHCP DNS 解析
//  - 订阅链接只在钥匙串；Mac 上只留选定节点的完整内容（配置文件 0600），其他节点只记名称、类型、服务器和指纹
//  - 选定节点变了或消失：先停核心（VM 断网），等你确认；不会悄悄换节点
//  - 网卡切换：改绑后重启核心；找不到物理网卡就保持停止
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildCoreConfig, buildProbeConfig, CORE_LABEL, CORE_PORT, coreConfigProblems, launchAgentPlist, MIHOMO_MIN,
  nodeFromConfig, parseDhcpDns, parseConnections, parseLaunchctlPrint, parseMihomoVersion, parseSubscription, physicalInterface,
  subscriptionUrlProblem, maskSubscription, versionAtLeast, type CoreConnection, type NodeInfo, type RawNode,
} from './mihomo';

export type ExecFn = (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface SecretStore {
  get(): string | undefined;
  set(url: string | undefined): void;
}

export interface CoreDeps {
  dataDir: string;
  home: string;
  uid: number;
  exec: ExecFn;
  secrets: SecretStore;
  /** 下载订阅：直连，或经 Clash Verge 的 127.0.0.1:7897 */
  fetchText(url: string, viaClashVerge: boolean): Promise<string>;
  now?: () => number;
}

export type StopReason = 'node_changed' | 'node_missing' | 'no_iface' | 'no_dns' | 'user' | 'mode';

/** 选定的节点：只记名称、类型、服务器和端口；完整内容只在核心配置文件里（0600） */
export type PinnedNode = NodeInfo;

interface CoreState {
  node?: PinnedNode;
  nodes?: NodeInfo[];
  iface?: string;
  dnsServers?: string[];
  acceptedVersion?: string;
  lastUpdate?: number;
  lastUpdateError?: string;
  autoUpdate: boolean;
  viaClashVerge: boolean;
  stopped?: { reason: StopReason; at: number; detail: string };
  pending?: { kind: 'changed' | 'missing'; at: number; info?: NodeInfo };
}

export interface CoreStatus {
  mihomo: { path?: string; version?: string; versionOk: boolean; versionChanged: boolean };
  service: { loaded: boolean; running: boolean; pid?: number; lastExit?: string };
  /** 核心进程自己在监听 17897（不是别的程序占着） */
  listenerOwned?: boolean;
  portBusy?: boolean;
  iface?: string;
  node?: PinnedNode;
  nodes: NodeInfo[];
  subscription: { set: boolean; masked?: string; lastUpdate?: number; error?: string; autoUpdate: boolean; viaClashVerge: boolean };
  pending?: CoreState['pending'];
  stopped?: CoreState['stopped'];
  latency: Record<string, number | null>;
  latencyAt?: number;
  checkedAt: number;
}

/** 两个节点的全部字段是否完全相同（键排序后逐项比较内容）。地址、端口、密码任何一项变了就不同。 */
export function sameNode(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export class CoreManager {
  readonly dir: string;
  readonly configFile: string;
  readonly socketPath: string;
  readonly plistPath: string;
  private stateFile: string;
  private state: CoreState;
  private latency: Record<string, number | null> = {};
  private latencyAt?: number;
  private mihomoPath?: string;
  private mihomoVersion?: string;
  private now: () => number;

  constructor(private deps: CoreDeps) {
    this.now = deps.now ?? Date.now;
    this.dir = path.join(deps.dataDir, 'core');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    this.configFile = path.join(this.dir, 'config.yaml');
    this.socketPath = path.join(this.dir, 'mihomo.sock');
    this.stateFile = path.join(this.dir, 'state.json');
    this.plistPath = path.join(deps.home, 'Library', 'LaunchAgents', `${CORE_LABEL}.plist`);
    this.state = { autoUpdate: true, viaClashVerge: false, ...readJson<CoreState>(this.stateFile) };
  }

  private get target(): string {
    return `gui/${this.deps.uid}/${CORE_LABEL}`;
  }

  // ---------------------------------------------------------------- 状态
  async detect(): Promise<void> {
    const which = await this.deps.exec('/bin/sh', ['-c', 'command -v mihomo'], 5000);
    this.mihomoPath = which.code === 0 ? which.stdout.trim().split('\n')[0] : undefined;
    if (this.mihomoPath) {
      const v = await this.deps.exec(this.mihomoPath, ['-v'], 5000);
      this.mihomoVersion = parseMihomoVersion(v.stdout + v.stderr);
    } else this.mihomoVersion = undefined;
  }

  async status(): Promise<CoreStatus> {
    const printed = await this.deps.exec('launchctl', ['print', this.target], 5000);
    const service = parseLaunchctlPrint(printed.code, printed.stdout);
    let listenerOwned: boolean | undefined;
    if (service.running && service.pid) {
      const lsof = await this.deps.exec('lsof', ['-nP', '-a', '-p', String(service.pid), `-iTCP:${CORE_PORT}`, '-sTCP:LISTEN'], 5000);
      listenerOwned = lsof.code === 0 && lsof.stdout.includes(`:${CORE_PORT}`);
    }
    const portBusy = await portInUse(CORE_PORT);
    const url = this.deps.secrets.get();
    return {
      mihomo: {
        path: this.mihomoPath,
        version: this.mihomoVersion,
        versionOk: versionAtLeast(this.mihomoVersion, MIHOMO_MIN),
        versionChanged: !!this.mihomoVersion && !!this.state.acceptedVersion && this.mihomoVersion !== this.state.acceptedVersion,
      },
      service,
      listenerOwned,
      portBusy,
      iface: this.state.iface,
      node: this.state.node,
      nodes: this.state.nodes ?? [],
      subscription: {
        set: !!url,
        masked: url ? maskSubscription(url) : undefined,
        lastUpdate: this.state.lastUpdate,
        error: this.state.lastUpdateError,
        autoUpdate: this.state.autoUpdate,
        viaClashVerge: this.state.viaClashVerge,
      },
      pending: this.state.pending,
      stopped: this.state.stopped,
      latency: this.latency,
      latencyAt: this.latencyAt,
      checkedAt: this.now(),
    };
  }

  /** 断流测试在新版本 mihomo 下通过后，记下这个版本 */
  acceptVersion(): void {
    if (this.mihomoVersion) {
      this.state.acceptedVersion = this.mihomoVersion;
      this.save();
    }
  }

  setOptions(opts: { autoUpdate?: boolean; viaClashVerge?: boolean }): void {
    if (opts.autoUpdate !== undefined) this.state.autoUpdate = !!opts.autoUpdate;
    if (opts.viaClashVerge !== undefined) this.state.viaClashVerge = !!opts.viaClashVerge;
    this.save();
  }

  // ---------------------------------------------------------------- 订阅
  async setSubscription(url: string): Promise<NodeInfo[]> {
    const problem = subscriptionUrlProblem(url);
    if (problem) throw new Error(problem);
    const parsed = await this.download(url.trim());
    this.deps.secrets.set(url.trim());
    return this.applyList(parsed.raw);
  }

  clearSubscription(): void {
    this.deps.secrets.set(undefined);
    this.state.nodes = [];
    this.save();
  }

  needsUpdate(): boolean {
    return this.state.autoUpdate && !!this.deps.secrets.get() && this.now() - (this.state.lastUpdate ?? 0) > 24 * 3600_000;
  }

  /** 更新订阅。选定节点变了或消失：停核心，等确认。下载失败不动核心。 */
  async update(): Promise<{ changed: boolean; detail?: string }> {
    const url = this.deps.secrets.get();
    if (!url) throw new Error('还没有订阅链接');
    let parsed: { raw: RawNode[] };
    try {
      parsed = await this.download(url);
    } catch (err) {
      this.state.lastUpdateError = (err as Error).message;
      this.save();
      throw err;
    }
    this.applyList(parsed.raw);
    const pinned = this.state.node;
    if (!pinned) return { changed: false };
    const fresh = parsed.raw.find((n) => n.name === pinned.name);
    if (!fresh) {
      this.state.pending = { kind: 'missing', at: this.now() };
      await this.stop('node_missing', `选定节点「${pinned.name}」不在订阅里了`);
      return { changed: true, detail: this.state.stopped?.detail };
    }
    // 和核心配置里正在用的节点逐字段比较；配置读不到也按「变了」处理（不确定就当失败）
    const current = this.configuredNode();
    if (!current || !sameNode(current, fresh)) {
      this.state.pending = { kind: 'changed', at: this.now(), info: info(fresh) };
      await this.stop('node_changed', `选定节点「${pinned.name}」的地址、端口或密码变了`);
      return { changed: true, detail: this.state.stopped?.detail };
    }
    this.save();
    return { changed: false };
  }

  private async download(url: string): Promise<{ raw: RawNode[] }> {
    const text = await this.deps.fetchText(url, this.state.viaClashVerge);
    const parsed = parseSubscription(text);
    if (!parsed.ok) throw new Error(parsed.error);
    this.state.lastUpdate = this.now();
    this.state.lastUpdateError = undefined;
    return parsed;
  }

  private applyList(raw: RawNode[]): NodeInfo[] {
    this.state.nodes = raw.map(info);
    this.save();
    return this.state.nodes;
  }

  // ---------------------------------------------------------------- 节点与服务
  /** 选定（或确认）节点：重新下载订阅取完整内容，写配置，启动核心。调用前要已经确认过。 */
  async selectNode(name: string): Promise<PinnedNode> {
    const url = this.deps.secrets.get();
    if (!url) throw new Error('还没有订阅链接');
    const parsed = await this.download(url);
    this.applyList(parsed.raw);
    const node = parsed.raw.find((n) => n.name === name);
    if (!node) throw new Error(`订阅里没有节点「${name}」`);
    const iface = await this.currentIface();
    if (!iface) throw new Error('找不到可用的物理网卡（Wi-Fi / 有线）');
    await this.writeConfig(node, iface);
    this.state.node = info(node);
    this.state.pending = undefined;
    this.state.stopped = undefined;
    this.save();
    await this.start();
    return this.state.node;
  }

  async start(): Promise<void> {
    await this.detect();
    if (!this.mihomoPath) throw new Error('找不到 mihomo：先在终端运行 brew install mihomo');
    if (!versionAtLeast(this.mihomoVersion, MIHOMO_MIN)) throw new Error(`mihomo ${this.mihomoVersion ?? '?'} 太旧，需要 ≥ ${MIHOMO_MIN}：brew upgrade mihomo`);
    if (!this.state.node) throw new Error('还没有选定节点');
    if (this.state.pending) throw new Error('选定节点变了，先确认再启动');
    const node = this.configuredNode();
    const pinned = this.state.node;
    if (!node || node.name !== pinned.name || String(node.type).toLowerCase() !== pinned.type || node.server !== pinned.server || Number(node.port) !== pinned.port) {
      throw new Error('核心配置和选定节点对不上，请重新选择节点');
    }
    const iface = await this.currentIface();
    if (!iface) {
      await this.stop('no_iface', '没有可用的物理网卡，出口核心保持停止（VM 断网）');
      return;
    }
    try {
      await this.writeConfig(node, iface);
    } catch (err) {
      await this.stop('no_dns', String((err as Error).message));
      throw err;
    }
    const status = parseLaunchctlPrint((await this.deps.exec('launchctl', ['print', this.target], 5000)).code, '');
    // 刚停掉的旧进程可能还没释放端口：最多等 3 秒
    let busy = !status.loaded && (await portInUse(CORE_PORT));
    for (let i = 0; busy && i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      busy = await portInUse(CORE_PORT);
    }
    if (busy) {
      throw new Error('127.0.0.1:17897 已经被别的程序占着（多半是 Clash Verge 里的 CCVM 扩展脚本）。先在 Clash Verge 里移除扩展脚本并重新激活订阅');
    }
    fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });
    writePrivate(this.plistPath, launchAgentPlist(this.mihomoPath, this.dir, this.configFile, path.join(this.dir, 'mihomo.log')), 0o644);
    await this.deps.exec('launchctl', ['bootout', this.target], 10_000);
    const boot = await this.deps.exec('launchctl', ['bootstrap', `gui/${this.deps.uid}`, this.plistPath], 10_000);
    if (boot.code !== 0) throw new Error(`launchctl bootstrap 失败：${(boot.stderr || boot.stdout).trim()}`);
    this.state.stopped = undefined;
    this.save();
  }

  async restart(): Promise<void> {
    if (!this.state.node) throw new Error('还没有选定节点');
    await this.start();
  }

  /** 停止并卸载服务（删除 plist，登录时也不会再启动）。VM 随之断网。 */
  async stop(reason: StopReason, detail: string): Promise<void> {
    await this.deps.exec('launchctl', ['bootout', this.target], 10_000);
    fs.rmSync(this.plistPath, { force: true });
    this.state.stopped = { reason, at: this.now(), detail };
    this.save();
  }

  /** 移除出口核心：停服务、删配置和选定节点；订阅链接保留，可以单独清除 */
  async remove(): Promise<void> {
    await this.stop('user', '出口核心已移除');
    fs.rmSync(this.configFile, { force: true });
    this.state.node = undefined;
    this.state.pending = undefined;
    this.state.iface = undefined;
    this.save();
  }

  /** 网络切换后调用：网卡变了就改绑重启；没有物理网卡就停；网卡回来且之前是因为没网卡停的，就恢复 */
  async onNetworkChange(): Promise<'unchanged' | 'rebound' | 'stopped' | 'resumed'> {
    if (!this.state.node || this.state.pending) return 'unchanged';
    const stopped = this.state.stopped;
    if (stopped && stopped.reason !== 'no_iface' && stopped.reason !== 'no_dns') return 'unchanged';
    const iface = await this.currentIface();
    if (!iface) {
      if (!stopped) await this.stop('no_iface', '没有可用的物理网卡，出口核心已停（VM 断网）');
      return stopped ? 'unchanged' : 'stopped';
    }
    let dnsServers: string[];
    try { dnsServers = await this.currentDns(iface); }
    catch (err) {
      await this.stop('no_dns', String((err as Error).message));
      return 'stopped';
    }
    if (stopped?.reason === 'no_iface' || stopped?.reason === 'no_dns' || iface !== this.state.iface
      || JSON.stringify(dnsServers) !== JSON.stringify(this.state.dnsServers)) {
      // 先断网再改绑：停 → 写新配置 → 启动；跟不上就保持停止
      await this.deps.exec('launchctl', ['bootout', this.target], 10_000);
      await this.start();
      return stopped ? 'resumed' : 'rebound';
    }
    return 'unchanged';
  }

  /** 核心配置文件里正在用的完整节点 */
  private configuredNode(): RawNode | undefined {
    const text = readText(this.configFile);
    return text ? nodeFromConfig(text) : undefined;
  }

  private async currentIface(): Promise<string | undefined> {
    const nwi = await this.deps.exec('scutil', ['--nwi'], 5000);
    return nwi.code === 0 ? physicalInterface(nwi.stdout) : undefined;
  }

  private async currentDns(iface: string): Promise<string[]> {
    const packet = await this.deps.exec('/usr/sbin/ipconfig', ['getpacket', iface], 5000);
    const servers: string[] = [];
    for (const ip of packet.code === 0 ? parseDhcpDns(packet.stdout) : []) {
      const route = await this.deps.exec('/sbin/route', ['-n', 'get', ip], 5000);
      if (route.code === 0 && route.stdout.match(/^\s*interface:\s*(\S+)/m)?.[1] === iface) servers.push(ip);
    }
    if (!servers.length) throw new Error(`网卡 ${iface} 没有经物理网卡可达的 DHCP DNS；核心保持停止`);
    return servers;
  }

  private async writeConfig(node: RawNode, iface: string): Promise<void> {
    const dnsServers = await this.currentDns(iface);
    const text = buildCoreConfig({ node, iface, dnsServers, socketPath: this.socketPath });
    const problems = coreConfigProblems(text, node.name);
    if (problems.length) throw new Error(`生成的核心配置没有通过自检：${problems.join('；')}`);
    writePrivate(this.configFile, text, 0o600);
    this.state.iface = iface;
    this.state.dnsServers = dnsServers;
  }

  // ---------------------------------------------------------------- 读数据
  async connections(): Promise<CoreConnection[]> {
    const json = await unixGet(this.socketPath, '/connections', 3000);
    return parseConnections(json);
  }

  /** 测延迟：重新下载订阅（只在内存里），临时起一个没有任何入口的 mihomo，逐个节点访问 generate_204，测完就删 */
  async latencyTest(): Promise<Record<string, number | null>> {
    await this.detect();
    if (!this.mihomoPath) throw new Error('找不到 mihomo：brew install mihomo');
    const url = this.deps.secrets.get();
    if (!url) throw new Error('还没有订阅链接');
    const iface = await this.currentIface();
    if (!iface) throw new Error('找不到可用的物理网卡');
    const parsed = await this.download(url);
    this.applyList(parsed.raw);
    const dnsServers = await this.currentDns(iface);
    // socket 路径不能太长，用系统临时目录下的短目录（0700）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-probe-'));
    fs.chmodSync(tmp, 0o700);
    const sock = path.join(tmp, 'p.sock');
    const cfgFile = path.join(tmp, 'probe.yaml');
    writePrivate(cfgFile, buildProbeConfig({ nodes: parsed.raw, iface, dnsServers, socketPath: sock }), 0o600);
    const child = spawn(this.mihomoPath, ['-d', tmp, '-f', cfgFile], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: this.deps.home } });
    const result: Record<string, number | null> = {};
    try {
      await waitFor(() => fs.existsSync(sock), 8000);
      const names = parsed.raw.map((n) => n.name);
      let next = 0;
      const worker = async () => {
        while (next < names.length) {
          const name = names[next++];
          try {
            const r = (await unixGet(sock, `/proxies/${encodeURIComponent(name)}/delay?timeout=4000&url=${encodeURIComponent('https://www.gstatic.com/generate_204')}`, 6000)) as { delay?: number };
            result[name] = typeof r?.delay === 'number' ? r.delay : null;
          } catch {
            result[name] = null;
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    this.latency = result;
    this.latencyAt = this.now();
    return result;
  }

  private save(): void {
    writePrivate(this.stateFile, JSON.stringify(this.state, null, 2), 0o600);
  }
}

function info(n: RawNode): NodeInfo {
  return { name: n.name, type: String(n.type).toLowerCase(), server: n.server, port: Number(n.port) };
}

function writePrivate(file: string, text: string, mode: number): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson<T>(file: string): T | undefined {
  const t = readText(file);
  if (!t) return undefined;
  try {
    return JSON.parse(t) as T;
  } catch {
    return undefined;
  }
}

export function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export function unixGet(socketPath: string, urlPath: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
        if (body.length > 8 * 1024 * 1024) req.destroy(new Error('响应太大'));
      });
      res.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch {
          reject(new Error('核心返回的不是 JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('核心没有响应')));
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(fn: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('临时核心没有启动');
    await new Promise((r) => setTimeout(r, 100));
  }
}
