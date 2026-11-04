// 解析脚本的 NDJSON 事件，并按 docs/events.md 给出结论。
// 原则：不确定就当失败。读不懂的行、缺少 end、退出码非 0、任何失败项，都不是「通过」。
import { StringDecoder } from 'node:string_decoder';
import type { CheckEvent, ClaudeEvent, ProjectItem, RunResult, ScriptEvent, SessionItem } from './types';

const ID = /^[a-z0-9_.]+$/;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 一行 → 事件；格式不对返回 null（调用方计为解析错误） */
export function parseEventLine(line: string): ScriptEvent | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (e.v !== 1 || !isStr(e.type)) return null;
  switch (e.type) {
    case 'start':
      return isStr(e.script) && isStr(e.kit) ? { v: 1, type: 'start', script: e.script, kit: e.kit } : null;
    case 'step':
      return isStr(e.id) && ID.test(e.id) && isStr(e.msg) ? { v: 1, type: 'step', id: e.id, msg: e.msg } : null;
    case 'check':
      return isStr(e.id) && ID.test(e.id) && typeof e.ok === 'boolean' && isStr(e.msg)
        ? { v: 1, type: 'check', id: e.id, ok: e.ok, msg: e.msg }
        : null;
    case 'value':
      return isStr(e.key) && isStr(e.value) ? { v: 1, type: 'value', key: e.key, value: e.value } : null;
    case 'item': {
      if (e.kind === 'session') {
        if (!isStr(e.name) || !/^[A-Za-z0-9_-]{1,64}$/.test(e.name)) return null;
        return { v: 1, type: 'item', kind: 'session', name: e.name, created: isNum(e.created) ? e.created : 0, attached: isNum(e.attached) ? e.attached : 0, project: isStr(e.project) ? e.project : '' };
      }
      if (e.kind === 'claude_event') {
        if (e.event !== 'Stop' && e.event !== 'Notification') return null;
        return {
          v: 1, type: 'item', kind: 'claude_event', t: isNum(e.t) ? e.t : 0, event: e.event,
          project: isStr(e.project) ? e.project : '', notification: isStr(e.notification) ? e.notification : '', message: isStr(e.message) ? e.message.slice(0, 160) : '',
        };
      }
      if (e.kind !== 'project' || !isStr(e.name)) return null;
      const item: ProjectItem = {
        name: e.name,
        branch: isStr(e.branch) ? e.branch : '',
        dirty: isNum(e.dirty) ? e.dirty : 0,
        ahead: isNum(e.ahead) ? e.ahead : 0,
        behind: isNum(e.behind) ? e.behind : 0,
        updated: isNum(e.updated) ? e.updated : 0,
        subject: isStr(e.subject) ? e.subject : '',
        remote: isStr(e.remote) ? e.remote : '',
        claude_sessions: isNum(e.claude_sessions) ? e.claude_sessions : 0,
        claude_since: isNum(e.claude_since) ? e.claude_since : 0,
      };
      return { v: 1, type: 'item', kind: 'project', ...item };
    }
    case 'log': {
      const level = e.level === 'warn' || e.level === 'detail' ? e.level : 'info';
      return isStr(e.msg) ? { v: 1, type: 'log', level, msg: e.msg } : null;
    }
    case 'error':
      return isStr(e.msg) ? { v: 1, type: 'error', msg: e.msg } : null;
    case 'end':
      return typeof e.ok === 'boolean' && isNum(e.code) ? { v: 1, type: 'end', ok: e.ok, code: e.code } : null;
    default:
      return null;
  }
}

/** 把字节流切成行并解析；能处理被拆开的 UTF-8 字符和半行 */
export class EventStream {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  readonly events: ScriptEvent[] = [];
  parseErrors = 0;

  constructor(private onEvent?: (e: ScriptEvent) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.line(line);
    }
  }

  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = '';
  }

  private line(line: string): void {
    if (!line.trim()) return;
    const event = parseEventLine(line);
    if (!event) {
      this.parseErrors += 1;
      return;
    }
    this.events.push(event);
    this.onEvent?.(event);
  }
}

export interface VerdictOptions {
  /** 这些检查必须出现且通过，否则不算通过（例如断流测试的抓包对照与旁路） */
  required?: string[];
}

/** 汇总一次运行 */
export function summarize(
  script: string,
  args: string[],
  events: ScriptEvent[],
  exitCode: number | null,
  parseErrors: number,
  stderrTail: string,
  startedAt: number,
  finishedAt: number,
  opts: VerdictOptions = {},
): RunResult {
  const checks: CheckEvent[] = [];
  const values: Record<string, string> = {};
  const items: ProjectItem[] = [];
  const sessions: SessionItem[] = [];
  const claudeEvents: ClaudeEvent[] = [];
  const steps: { id: string; msg: string }[] = [];
  const errors: string[] = [];
  const logs: { level: string; msg: string }[] = [];
  let end: { ok: boolean; code: number } | undefined;
  let sawStart = false;
  for (const e of events) {
    switch (e.type) {
      case 'start':
        sawStart = true;
        break;
      case 'check':
        checks.push({ id: e.id, ok: e.ok, msg: e.msg });
        break;
      case 'value':
        values[e.key] = e.value;
        break;
      case 'item': {
        if (e.kind === 'session') {
          const { v: _v, type: _t, kind: _k, ...s } = e;
          sessions.push(s);
        } else if (e.kind === 'claude_event') {
          const { v: _v, type: _t, kind: _k, ...c } = e;
          claudeEvents.push(c);
        } else {
          const { v: _v, type: _t, kind: _k, ...item } = e;
          items.push(item);
        }
        break;
      }
      case 'step':
        steps.push({ id: e.id, msg: e.msg });
        break;
      case 'log':
        logs.push({ level: e.level, msg: e.msg });
        break;
      case 'error':
        errors.push(e.msg);
        break;
      case 'end':
        end = { ok: e.ok, code: e.code };
        break;
    }
  }

  const failed = checks.filter((c) => !c.ok);
  const last = events[events.length - 1];
  let reason: string | undefined;
  if (failed.length) reason = failed[failed.length - 1].msg;
  else if (errors.length) reason = errors[errors.length - 1];
  else if (!sawStart) reason = '脚本没有输出事件' + (stderrTail.trim() ? '：' + lastLine(stderrTail) : '');
  else if (!end || last?.type !== 'end') reason = '脚本没有正常结束（缺少 end 事件）';
  else if (!end.ok) reason = `脚本以退出码 ${end.code} 结束`;
  else if (exitCode !== 0) reason = `进程退出码 ${exitCode ?? '未知'}`;
  else if (parseErrors > 0) reason = `有 ${parseErrors} 行输出不是有效事件`;
  else {
    const missing = (opts.required ?? []).filter((id) => !checks.some((c) => c.id === id && c.ok));
    if (missing.length) reason = `缺少必需的检查结论：${missing.join('、')}`;
  }
  if (!reason && end && end.code !== exitCode) reason = '事件里的退出码与进程不一致';

  return {
    script,
    args,
    startedAt,
    finishedAt,
    exitCode,
    ok: reason === undefined,
    reason,
    checks,
    values,
    items,
    sessions,
    claudeEvents,
    steps,
    errors,
    logs,
    parseErrors,
    stderrTail,
  };
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1].slice(0, 300);
}

export { lastPercent, latestChecks } from './checks';
