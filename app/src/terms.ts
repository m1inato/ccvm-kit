// 内嵌终端的界面端：xterm 实例按会话名登记。切换页面或标签不会断开，只有关标签才断开（VM 里的 tmux 会话继续）。
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { getBridge, type TermBridge } from './api';

export interface TermEntry {
  session: string;
  project: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ptyId?: string;
  state: 'connecting' | 'open' | 'closed';
}

const entries = new Map<string, TermEntry>();
const listeners = new Set<() => void>();
let wired = false;

function changed(): void {
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function termsOf(project: string): TermEntry[] {
  return [...entries.values()].filter((e) => e.project === project);
}

export function getTerm(session: string): TermEntry | undefined {
  return entries.get(session);
}

function wire(b: TermBridge): void {
  if (wired) return;
  wired = true;
  b.onData((id, data) => {
    for (const e of entries.values()) if (e.ptyId === id) e.term.write(data);
  });
  b.onExit((id) => {
    for (const e of entries.values()) {
      if (e.ptyId !== id) continue;
      e.state = 'closed';
      e.term.write('\r\n\x1b[2m[已断开。会话还在 VM 里时，可以重新接入。]\x1b[0m\r\n');
      changed();
    }
  });
}

function create(project: string, session: string): TermEntry {
  const el = document.createElement('div');
  el.className = 'xterm-host';
  const term = new Terminal({
    fontFamily: "'SF Mono', ui-monospace, Menlo, monospace",
    fontSize: 12.5,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0a0d12', foreground: '#e6edf3', cursor: '#7aa5e6', selectionBackground: '#2a3a55' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { session, project, term, fit, el, state: 'connecting' };
}

/** 新开（mode=new，由主进程起名并先做检查）或接入已有会话（mode=attach）。container 用来先量出终端大小。 */
export async function openTerm(project: string, mode: 'new' | 'attach', session: string | undefined, container: HTMLElement): Promise<TermEntry> {
  const bridge = await getBridge();
  if (!bridge.term) throw new Error('这个环境没有内嵌终端');
  wire(bridge.term);
  if (session && entries.get(session)?.state !== 'closed' && entries.has(session)) return entries.get(session)!;
  const entry = create(project, session ?? '…');
  container.appendChild(entry.el);
  entry.term.open(entry.el);
  try {
    entry.fit.fit();
  } catch {
    /* 容器还没有尺寸 */
  }
  const opened = await bridge.term.open({ mode, project, session, cols: entry.term.cols, rows: entry.term.rows }).catch((err: unknown) => {
    entry.el.remove();
    entry.term.dispose();
    throw err;
  });
  entry.ptyId = opened.id;
  entry.session = opened.session;
  entry.state = 'open';
  const old = entries.get(opened.session);
  if (old && old !== entry) dispose(old);
  entries.set(opened.session, entry);
  entry.term.onData((d) => entry.ptyId && entry.state === 'open' && bridge.term!.write(entry.ptyId, d));
  entry.term.onResize(({ cols, rows }) => entry.ptyId && entry.state === 'open' && bridge.term!.resize(entry.ptyId, cols, rows));
  changed();
  return entry;
}

/** 断开这个标签：本机这一端结束，VM 里的会话继续 */
export async function detachTerm(session: string): Promise<void> {
  const entry = entries.get(session);
  if (!entry) return;
  const bridge = await getBridge();
  if (entry.ptyId && entry.state === 'open') await bridge.term?.close(entry.ptyId);
  dispose(entry);
  entries.delete(session);
  changed();
}

function dispose(entry: TermEntry): void {
  entry.el.remove();
  entry.term.dispose();
}
