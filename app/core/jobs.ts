// 后台任务：一个任务就是一次脚本运行。脱离 App 进程运行，App 退出后继续；重新打开时接回。
// 每个任务一个目录：meta.json、events.ndjson（stdout）、log.txt（stderr）、exit（退出码，结束时原子写入）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStream, lastPercent, summarize, type VerdictOptions } from './events';
import { killGroup, scriptPath } from './runner';
import type { JobKind, JobState, JobSummary, RunResult } from './types';

interface Meta {
  id: string;
  kind: JobKind;
  title: string;
  script: string;
  args: string[];
  startedAt: number;
  pid?: number;
  cancelled?: boolean;
  finishedAt?: number;
  state: JobState;
  reason?: string;
  required?: string[];
}

const KEEP = 60;
// 子 shell 把脚本的 stdout/stderr 写进文件，结束后写退出码。脚本路径与参数作为位置参数传入，不拼接进命令字符串。
const WRAPPER =
  'd="$CCVM_JOB_DIR"; /bin/bash "$0" "$@" >"$d/events.ndjson" 2>"$d/log.txt"; rc=$?; ' +
  'printf "%s" "$rc" >"$d/exit.tmp" && mv "$d/exit.tmp" "$d/exit"';

export class JobStore {
  private metas = new Map<string, Meta>();
  private results = new Map<string, RunResult>();

  constructor(
    private dir: string,
    private kitDir: string,
    private now: () => number = Date.now,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  private load(): void {
    for (const name of safeReaddir(this.dir)) {
      const meta = readJson<Meta>(path.join(this.dir, name, 'meta.json'));
      if (meta && meta.id === name) this.metas.set(name, meta);
    }
    // 机器重启过的任务不可能还在跑（PID 可能被复用），直接按中断处理
    const bootedAt = this.now() - os.uptime() * 1000;
    for (const meta of this.metas.values()) {
      if (meta.state === 'running' && meta.startedAt < bootedAt) meta.pid = undefined;
    }
    this.poll();
  }

  start(kind: JobKind, title: string, script: string, args: string[], env: Record<string, string>, opts: VerdictOptions = {}): string {
    const file = scriptPath(this.kitDir, script);
    const id = `${new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const jobDir = path.join(this.dir, id);
    fs.mkdirSync(jobDir, { recursive: true });
    const fullArgs = [...args, '--json'];
    const child = spawn('/bin/bash', ['-c', WRAPPER, file, ...fullArgs], {
      env: { ...env, CCVM_JOB_DIR: jobDir },
      cwd: '/',
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const meta: Meta = {
      id,
      kind,
      title,
      script,
      args: fullArgs,
      startedAt: this.now(),
      pid: child.pid,
      state: 'running',
      required: opts.required,
    };
    this.metas.set(id, meta);
    this.save(meta);
    this.prune();
    return id;
  }

  cancel(id: string): void {
    const meta = this.metas.get(id);
    if (!meta || meta.state !== 'running') return;
    meta.cancelled = true;
    this.save(meta);
    killGroup(meta.pid, 'SIGTERM');
  }

  /** 读取最新进度；返回本次刚结束的任务 */
  poll(): JobSummary[] {
    const finished: JobSummary[] = [];
    for (const meta of this.metas.values()) {
      if (meta.state !== 'running') continue;
      const jobDir = path.join(this.dir, meta.id);
      const exitText = readText(path.join(jobDir, 'exit'));
      const alive = meta.pid !== undefined && isAlive(meta.pid);
      if (exitText === undefined && alive) continue;
      const code = exitText === undefined ? null : Number(exitText.trim());
      const result = this.collect(meta, Number.isFinite(code) ? code : null);
      meta.finishedAt = this.now();
      if (meta.cancelled) {
        meta.state = 'cancelled';
        meta.reason = '已取消';
      } else if (exitText === undefined) {
        meta.state = 'failed';
        meta.reason = '任务被中断（App 或系统重启时它不在运行）';
        result.ok = false;
        result.reason = meta.reason;
      } else {
        meta.state = result.ok ? 'done' : 'failed';
        meta.reason = result.reason;
      }
      this.results.set(meta.id, result);
      this.save(meta);
      finished.push(this.summary(meta));
    }
    return finished;
  }

  list(): JobSummary[] {
    return [...this.metas.values()].sort((a, b) => b.startedAt - a.startedAt).map((m) => this.summary(m));
  }

  get(id: string): JobSummary | undefined {
    const meta = this.metas.get(id);
    return meta && this.summary(meta);
  }

  log(id: string, maxBytes = 64 * 1024): string {
    if (!this.metas.has(id)) return '';
    const text = readText(path.join(this.dir, id, 'log.txt')) ?? '';
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  }

  runningOf(kinds: JobKind[]): JobSummary | undefined {
    return this.list().find((j) => j.state === 'running' && kinds.includes(j.kind));
  }

  private summary(meta: Meta): JobSummary {
    const summary: JobSummary = {
      id: meta.id,
      kind: meta.kind,
      title: meta.title,
      args: meta.args,
      state: meta.state,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      reason: meta.reason,
    };
    if (meta.state === 'running') {
      const partial = this.collect(meta, null);
      const step = partial.steps[partial.steps.length - 1];
      summary.step = step?.msg;
      summary.stepId = step?.id;
      if (meta.kind === 'clone') summary.percent = lastPercent(this.log(meta.id, 4096));
    } else {
      summary.result = this.results.get(meta.id) ?? this.collect(meta, readExit(path.join(this.dir, meta.id)));
    }
    return summary;
  }

  private collect(meta: Meta, code: number | null): RunResult {
    const jobDir = path.join(this.dir, meta.id);
    const stream = new EventStream();
    stream.push(readText(path.join(jobDir, 'events.ndjson')) ?? '');
    if (meta.state !== 'running' || code !== null) stream.end();
    const stderr = (readText(path.join(jobDir, 'log.txt')) ?? '').slice(-16 * 1024);
    return summarize(meta.script, meta.args, stream.events, code, stream.parseErrors, stderr, meta.startedAt, meta.finishedAt ?? this.now(), {
      required: meta.required,
    });
  }

  private save(meta: Meta): void {
    const file = path.join(this.dir, meta.id, 'meta.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(meta, null, 2));
    fs.renameSync(file + '.tmp', file);
  }

  private prune(): void {
    const done = [...this.metas.values()].filter((m) => m.state !== 'running').sort((a, b) => b.startedAt - a.startedAt);
    for (const meta of done.slice(KEEP)) {
      fs.rmSync(path.join(this.dir, meta.id), { recursive: true, force: true });
      this.metas.delete(meta.id);
      this.results.delete(meta.id);
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
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
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function readExit(jobDir: string): number | null {
  const text = readText(path.join(jobDir, 'exit'));
  const n = text === undefined ? NaN : Number(text.trim());
  return Number.isFinite(n) ? n : null;
}
