import { describe, expect, it } from 'vitest';
import { EventStream, lastPercent, parseEventLine, summarize } from '../core/events';
import type { ScriptEvent } from '../core/types';

const start: ScriptEvent = { v: 1, type: 'start', script: 'check', kit: '2.3.0' };
const end = (ok: boolean, code = ok ? 0 : 1): ScriptEvent => ({ v: 1, type: 'end', ok, code });
const check = (id: string, ok: boolean): ScriptEvent => ({ v: 1, type: 'check', id, ok, msg: id });
const run = (events: ScriptEvent[], code: number | null = 0, parseErrors = 0, required?: string[]) =>
  summarize('check.sh', [], events, code, parseErrors, '', 0, 1, { required });

describe('parseEventLine', () => {
  it('accepts documented events', () => {
    expect(parseEventLine('{"v":1,"type":"check","id":"vm.tun_up","ok":true,"msg":"TUN"}')).toEqual({
      v: 1, type: 'check', id: 'vm.tun_up', ok: true, msg: 'TUN',
    });
    expect(parseEventLine('{"v":1,"type":"value","key":"host_egress","value":"203.0.113.7"}')?.type).toBe('value');
  });
  it('rejects malformed or unknown lines', () => {
    for (const line of [
      'PASS vm.tun_up ok',
      '{"type":"check","id":"x","ok":true,"msg":""}',
      '{"v":2,"type":"end","ok":true,"code":0}',
      '{"v":1,"type":"check","id":"Bad Id","ok":true,"msg":""}',
      '{"v":1,"type":"check","id":"x","ok":"yes","msg":""}',
      '{"v":1,"type":"end","ok":true}',
      '{"v":1,"type":"surprise"}',
      '[1,2]',
    ]) expect(parseEventLine(line), line).toBeNull();
  });
});

describe('verdict: unsure means failed', () => {
  it('passes only a complete clean run', () => {
    expect(run([start, check('a', true), end(true)]).ok).toBe(true);
  });
  it('fails on a failed check even if end says ok', () => {
    const r = run([start, check('a', false), end(true)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('a');
  });
  it('fails without an end event', () => {
    expect(run([start, check('a', true)]).ok).toBe(false);
  });
  it('fails when the process exit code disagrees', () => {
    expect(run([start, end(true)], 1).ok).toBe(false);
    expect(run([start, end(true)], null).ok).toBe(false);
  });
  it('fails when stdout had unparseable lines', () => {
    expect(run([start, end(true)], 0, 1).ok).toBe(false);
  });
  it('fails with no output at all', () => {
    const r = summarize('check.sh', [], [], 127, 0, 'bash: limactl: command not found\n', 0, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('limactl');
  });
  it('fails when a required check is missing', () => {
    const r = run([start, check('leak.capture_control', true), end(true)], 0, 0, ['leak.capture_control', 'leak.capture_bypass']);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('leak.capture_bypass');
  });
  it('fails if events follow end', () => {
    expect(run([start, end(true), check('a', true)]).ok).toBe(false);
  });
});

describe('EventStream', () => {
  it('handles split lines and split UTF-8 characters', () => {
    const s = new EventStream();
    const line = Buffer.from('{"v":1,"type":"log","level":"info","msg":"中文"}\n');
    const cut = line.indexOf(Buffer.from('文')) + 1;
    s.push(line.subarray(0, cut));
    s.push(line.subarray(cut));
    s.push('{"v":1,"type":"end","ok":true,"code":0}');
    s.end();
    expect(s.events.map((e) => e.type)).toEqual(['log', 'end']);
    expect((s.events[0] as { msg: string }).msg).toBe('中文');
    expect(s.parseErrors).toBe(0);
  });
});

it('lastPercent reads git progress', () => {
  expect(lastPercent('Receiving objects:  12% (1/8)\rReceiving objects:  87% (7/8)')).toBe(87);
  expect(lastPercent('nothing')).toBeUndefined();
});
