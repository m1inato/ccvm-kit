// 运行脚本并收集事件。一次性的短任务（快速检查、项目列表）用 runScript；
// 可以在 App 退出后继续的长任务用 jobs.ts。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { EventStream, summarize, type VerdictOptions } from './events';
import type { RunResult, ScriptEvent } from './types';

const STDERR_TAIL = 16 * 1024;

export interface RunOptions extends VerdictOptions {
  kitDir: string;
  script: string; // scripts/ 下的文件名，例如 check.sh
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  onEvent?: (e: ScriptEvent) => void;
  bash?: string;
}

export const SCRIPTS = new Set([
  'check.sh',
  'leaktest.sh',
  'setup.sh',
  'rebaseline.sh',
  'preflight.sh',
  'hooks.sh',
  'vm.sh',
  'workspace.sh',
  'share.sh',
  'files.sh',
]);

export function scriptPath(kitDir: string, script: string): string {
  if (!SCRIPTS.has(script)) throw new Error(`不允许调用的脚本：${script}`);
  return path.join(kitDir, 'scripts', script);
}

export function runScript(opts: RunOptions): Promise<RunResult> {
  const file = scriptPath(opts.kitDir, opts.script);
  const args = [...opts.args, '--json'];
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const stream = new EventStream(opts.onEvent);
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(opts.bash ?? '/bin/bash', [file, ...args], {
        env: opts.env,
        cwd: '/',
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // 自己一个进程组，超时可以整组结束（含 limactl / ssh）
      });
    } catch (err) {
      resolve(summarize(opts.script, args, [], null, 0, String(err), startedAt, Date.now(), opts));
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref();
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => stream.push(d));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => {
      stderr += `\n${String(err)}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stream.end();
      const result = summarize(
        opts.script,
        args,
        stream.events,
        timedOut ? null : code,
        stream.parseErrors,
        stderr,
        startedAt,
        Date.now(),
        opts,
      );
      if (timedOut) {
        result.ok = false;
        result.reason = `超过 ${Math.round(opts.timeoutMs / 1000)} 秒没有完成，已中止`;
      }
      resolve(result);
    });
  });
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 已经退出 */
    }
  }
}

/** 运行普通命令（limactl list、登录 shell 取 PATH），只要 stdout */
export function runCommand(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { env, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => {
      stderr += String(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
