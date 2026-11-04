// 内嵌终端：每个标签是一个 node-pty，跑 enter.sh 进入 VM 里 cc 的 tmux 会话。
// 关掉标签、窗口或 App 只是断开（tmux 会话和里面的 Claude 继续跑）；结束会话要单独确认。
// 新会话经 enter.sh --session（先做检查）；接回已有会话经 --attach（不开新会话，出错时也允许）。
import os from 'node:os';
import path from 'node:path';
import type * as Pty from 'node-pty';
import type { WebContents } from 'electron';
import { PROJECT_NAME } from '../core/parsers';

// node-pty 是原生模块，必须按 Electron 的 ABI 编译（npm run rebuild）。延迟加载：
// 它坏了只影响内嵌终端，菜单栏、检查和外部终端照常工作。
let ptyModule: typeof Pty | undefined;
function loadPty(): typeof Pty {
  if (!ptyModule) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ptyModule = require('node-pty') as typeof Pty;
    } catch (err) {
      throw new Error(`内嵌终端不可用：node-pty 没有为这个 Electron 编译（在 app 目录运行 npm run rebuild）。可以先用外部终端。${(err as Error).message.split('\n')[0]}`);
    }
  }
  return ptyModule;
}

const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WRITE = 64 * 1024;

export interface OpenSpec {
  mode: 'new' | 'attach';
  project?: string;
  session: string;
  cols: number;
  rows: number;
}

interface Term {
  id: string;
  proc: Pty.IPty;
  owner: WebContents;
  session: string;
  pending: string;
  timer?: NodeJS.Timeout;
}

export class Terminals {
  private terms = new Map<string, Term>();
  private seq = 0;

  constructor(private kitDir: string, private env: () => Record<string, string>) {}

  open(owner: WebContents, spec: OpenSpec): { id: string; session: string } {
    if (!SESSION.test(spec.session)) throw new Error('无效的会话名');
    const args =
      spec.mode === 'attach'
        ? ['--attach', spec.session]
        : (() => {
            if (!spec.project || !PROJECT_NAME.test(spec.project)) throw new Error('无效的项目名');
            return ['--project', spec.project, '--session', spec.session];
          })();
    const id = `t${++this.seq}`;
    const proc = loadPty().spawn('/bin/bash', [path.join(this.kitDir, 'scripts', 'enter.sh'), ...args], {
      name: 'xterm-256color',
      cols: clamp(spec.cols, 20, 500),
      rows: clamp(spec.rows, 5, 300),
      cwd: os.homedir(),
      env: { ...this.env(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const term: Term = { id, proc, owner, session: spec.session, pending: '' };
    this.terms.set(id, term);
    proc.onData((data) => {
      term.pending += data;
      term.timer ??= setTimeout(() => this.flush(term), 16);
    });
    proc.onExit(({ exitCode }) => {
      this.flush(term);
      if (!owner.isDestroyed()) owner.send('ccvm:term:exit', id, exitCode);
      this.terms.delete(id);
    });
    owner.once('destroyed', () => this.closeOwnedBy(owner));
    return { id, session: spec.session };
  }

  write(owner: WebContents, id: string, data: unknown): void {
    const term = this.owned(owner, id);
    if (term && typeof data === 'string' && data.length <= MAX_WRITE) term.proc.write(data);
  }

  resize(owner: WebContents, id: string, cols: unknown, rows: unknown): void {
    const term = this.owned(owner, id);
    if (term && typeof cols === 'number' && typeof rows === 'number') term.proc.resize(clamp(cols, 20, 500), clamp(rows, 5, 300));
  }

  /** 断开：结束本机这一端（ssh / tmux 客户端），VM 里的 tmux 会话不受影响 */
  close(owner: WebContents, id: string): void {
    const term = this.owned(owner, id);
    if (term) term.proc.kill('SIGHUP');
  }

  closeAll(): void {
    for (const t of this.terms.values()) t.proc.kill('SIGHUP');
  }

  private closeOwnedBy(owner: WebContents): void {
    for (const t of this.terms.values()) if (t.owner === owner) t.proc.kill('SIGHUP');
  }

  private owned(owner: WebContents, id: unknown): Term | undefined {
    const term = typeof id === 'string' ? this.terms.get(id) : undefined;
    return term && term.owner === owner ? term : undefined;
  }

  private flush(term: Term): void {
    if (term.timer) clearTimeout(term.timer);
    term.timer = undefined;
    if (!term.pending) return;
    const chunk = term.pending;
    term.pending = '';
    if (!term.owner.isDestroyed()) term.owner.send('ccvm:term:data', term.id, chunk);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
}
