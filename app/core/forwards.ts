// 端口转发：每条转发是一个 `ports.sh forward <VM端口> <Mac端口>` 子进程（里面是 ssh -L，只绑 127.0.0.1）。
// 想要的转发记在设置里；VM 在运行时保持它们连着，进程退出（VM 重启、睡眠断线）就过一会儿重连。
// App 退出时全部结束。不依赖 Electron。
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { portInUse } from './egress';
import type { Forward } from './types';

export interface ForwardSpec {
  vmPort: number;
  macPort: number;
}

export interface ForwardsOptions {
  kitDir: string;
  env: () => Record<string, string>;
  onChange: () => void;
  portInUse?: (port: number) => Promise<boolean>;
  /** 断开后多久重连 */
  retryMs?: number;
  /** 等 ssh 开始监听的最长时间 */
  openTimeoutMs?: number;
}

interface Entry extends ForwardSpec {
  state: Forward['state'];
  error?: string;
  child?: ChildProcess;
  stderr: string;
  retry?: NodeJS.Timeout;
  /** 每次启动加一；旧进程的回调看到号码不对就不再改状态 */
  gen: number;
}

/** 转发到 Mac 的这些端口没有意义或会出问题 */
export function forwardProblem(vmPort: unknown, macPort: unknown): string | null {
  for (const [name, p] of [['VM 端口', vmPort], ['Mac 端口', macPort]] as const) {
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) return `${name}要是 1–65535 之间的整数`;
  }
  if (vmPort === 22) return 'VM 的 22 是 SSH，不需要转发';
  if (macPort === 17897) return 'Mac 的 17897 是代理入口，换一个端口';
  return null;
}

export class Forwards {
  private entries = new Map<number, Entry>();
  private running = false;
  private disposed = false;

  constructor(private opts: ForwardsOptions) {}

  list(): Forward[] {
    return [...this.entries.values()]
      .sort((a, b) => a.vmPort - b.vmPort)
      .map((e) => ({ vmPort: e.vmPort, macPort: e.macPort, state: e.state, ...(e.error ? { error: e.error } : {}) }));
  }

  /** 让实际运行的转发和想要的一致。VM 没运行时只记着，不起进程 */
  sync(wanted: ForwardSpec[], vmRunning: boolean): void {
    if (this.disposed) return;
    this.running = vmRunning;
    const keep = new Map(wanted.map((w) => [w.vmPort, w]));
    for (const e of [...this.entries.values()]) {
      const w = keep.get(e.vmPort);
      if (!w || w.macPort !== e.macPort) {
        this.stop(e);
        this.entries.delete(e.vmPort);
      }
    }
    for (const w of wanted) {
      let e = this.entries.get(w.vmPort);
      if (!e) {
        e = { ...w, state: 'retrying', stderr: '', gen: 0 };
        this.entries.set(w.vmPort, e);
      }
      if (!vmRunning) {
        this.stop(e);
        e.state = 'retrying';
        e.error = 'VM 没有运行';
      } else if (!e.child && !e.retry) {
        void this.start(e);
      }
    }
    this.opts.onChange();
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) this.stop(e);
  }

  private stop(e: Entry): void {
    e.gen += 1;
    if (e.retry) clearTimeout(e.retry);
    e.retry = undefined;
    const child = e.child;
    e.child = undefined;
    if (child?.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM'); // 整个进程组：bash 已经 exec 成 ssh，组里就是它
      } catch {
        child.kill('SIGTERM');
      }
    }
  }

  private later(e: Entry, error: string): void {
    e.state = 'retrying';
    e.error = error;
    if (this.disposed || !this.running || e.retry) return;
    const gen = e.gen;
    e.retry = setTimeout(() => {
      e.retry = undefined;
      if (gen === e.gen && this.entries.get(e.vmPort) === e && this.running) void this.start(e);
    }, this.opts.retryMs ?? 5000);
  }

  private async start(e: Entry): Promise<void> {
    const gen = ++e.gen;
    e.state = 'starting';
    e.error = undefined;
    e.stderr = '';
    this.opts.onChange();
    const inUse = this.opts.portInUse ?? portInUse;
    if (await inUse(e.macPort)) {
      if (gen !== e.gen) return;
      this.later(e, `Mac 上 127.0.0.1:${e.macPort} 已被占用`);
      this.opts.onChange();
      return;
    }
    if (gen !== e.gen || this.disposed) return;
    const script = path.join(this.opts.kitDir, 'scripts', 'ports.sh');
    const child = spawn('/bin/bash', [script, 'forward', String(e.vmPort), String(e.macPort)], {
      env: this.opts.env(),
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    e.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      e.stderr = (e.stderr + d).slice(-2000);
    });
    child.on('error', () => undefined);
    child.on('exit', () => {
      if (gen !== e.gen) return;
      e.child = undefined;
      this.later(e, lastLine(e.stderr) || '转发断开了');
      this.opts.onChange();
    });
    // ssh 开始监听本地端口，转发就通了
    const until = Date.now() + (this.opts.openTimeoutMs ?? 15_000);
    while (gen === e.gen && e.child === child && Date.now() < until) {
      if (await inUse(e.macPort)) {
        if (gen === e.gen && e.child === child) {
          e.state = 'open';
          e.error = undefined;
          this.opts.onChange();
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    // 一直没监听上：结束它，过一会儿再试
    if (gen === e.gen && e.child === child) {
      this.stop(e);
      this.later(e, lastLine(e.stderr) || '连不上 VM 的 SSH');
      this.opts.onChange();
    }
  }
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
  return (lines.at(-1) ?? '').replace(/^\s*✘\s*/, '').slice(0, 200);
}
