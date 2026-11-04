// 界面与主进程之间唯一的通道。在 Electron 里用 preload 暴露的 window.ccvm；
// 在普通浏览器里（vite dev、截图）退回到演示用的 mock。
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Actions, Snapshot } from '../core/types';

export interface TermBridge {
  open(spec: { mode: 'new' | 'attach'; project?: string; session?: string; cols: number; rows: number }): Promise<{ id: string; session: string }>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): Promise<void>;
  onData(cb: (id: string, data: string) => void): () => void;
  onExit(cb: (id: string, code: number) => void): () => void;
}

export interface Bridge {
  term?: TermBridge;
  snapshot(): Promise<Snapshot>;
  act(name: string, args: unknown[]): Promise<unknown>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  onNavigate(cb: (route: string) => void): () => void;
  capsuleSize?(width: number, height: number): void;
  pathsForFiles?(files: File[]): string[];
}

declare global {
  interface Window {
    ccvm?: Bridge;
  }
}

let mock: Promise<Bridge> | undefined;
export function getBridge(): Promise<Bridge> {
  if (window.ccvm) return Promise.resolve(window.ccvm);
  mock ??= import('./mock').then((m) => m.createMockBridge());
  return mock;
}

export function act<K extends keyof Actions>(name: K, ...args: Parameters<Actions[K]>): ReturnType<Actions[K]> {
  return getBridge().then((b) => b.act(name, args)) as ReturnType<Actions[K]>;
}

/** Electron 的错误前缀对人没用，去掉 */
export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------------------------------------------------------------- 路由（hash）
export function useRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    let off: (() => void) | undefined;
    void getBridge().then((b) => {
      off = b.onNavigate((r) => {
        window.location.hash = r;
      });
    });
    return () => {
      window.removeEventListener('hashchange', onHash);
      off?.();
    };
  }, []);
  const go = useCallback((to: string) => {
    window.location.hash = to;
  }, []);
  return [route, go];
}

// ---------------------------------------------------------------- 快照与提示
export interface AppCtx {
  snap: Snapshot;
  now: number;
  go: (to: string) => void;
  /** 执行一个动作；失败时弹出提示，返回 undefined */
  run: <T>(fn: () => Promise<T>, okText?: string) => Promise<T | undefined>;
}

export const Ctx = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('AppCtx missing');
  return ctx;
}

export function useSnapshot(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void getBridge().then(async (b) => {
      off = b.onSnapshot((s) => alive && setSnap(s));
      const first = await b.snapshot();
      if (alive) setSnap(first);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return snap;
}

export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** 页面可见时定期调用（例如欢迎页轮询检测） */
export function usePoll(fn: () => void, ms: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    fn();
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, enabled]);
}
