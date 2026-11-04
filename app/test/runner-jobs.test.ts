import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../core/jobs';
import { runScript } from '../core/runner';
import { KIT, makeFixture, stubEnv, waitFor, type Fixture } from './fixture';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});
afterEach(() => f.cleanup());

describe('runScript with the real check.sh', () => {
  it('passes a healthy quick check', async () => {
    const r = await runScript({ kitDir: KIT, script: 'check.sh', args: ['--quick'], env: stubEnv(f), timeoutMs: 30_000 });
    expect(r.reason).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.values.vm_egress).toBe('203.0.113.7');
    expect(r.checks.find((c) => c.id === 'listener.loopback_only')?.ok).toBe(true);
  });
  it('fails when the VM egress changed', async () => {
    f.set('selfcheck.out', 'PASS vm.tun_up ok\nFAIL egress.vm_matches_baseline VM 出口 198.51.100.9 ≠ 基线 203.0.113.7\nEGRESS 198.51.100.9\n');
    f.set('selfcheck.rc', '1');
    const r = await runScript({ kitDir: KIT, script: 'check.sh', args: ['--quick'], env: stubEnv(f), timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.values.vm_egress).toBe('198.51.100.9');
  });
  it('a hung VM call times out as a failure', async () => {
    f.set('selfcheck.sleep', '20');
    const r = await runScript({ kitDir: KIT, script: 'check.sh', args: ['--quick'], env: stubEnv(f), timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('没有完成');
  });
  it('refuses scripts outside the allow-list', () => {
    expect(() => runScript({ kitDir: KIT, script: '../../bin/sh', args: [], env: stubEnv(f), timeoutMs: 1000 })).toThrow();
  });
});

describe('JobStore', () => {
  it('runs detached, records events and survives a new store instance', async () => {
    const dir = path.join(f.data, 'jobs');
    const store = new JobStore(dir, KIT);
    const id = store.start('check-full', '完整验收', 'check.sh', [], stubEnv(f));
    const finished = await waitFor(() => store.poll().find((j) => j.id === id));
    expect(finished.state).toBe('done');
    expect(finished.result?.ok).toBe(true);
    const again = new JobStore(dir, KIT);
    expect(again.get(id)?.state).toBe('done');
    expect(again.get(id)?.result?.checks.length).toBeGreaterThan(5);
    expect(fs.readFileSync(path.join(dir, id, 'exit'), 'utf8')).toBe('0');
  });
  it('requires the capture checks for a leak test', async () => {
    f.set('leaktest.out', 'PASS leak.precheck ok\nPASS leak.capture_control 抓包对照\n');
    const store = new JobStore(path.join(f.data, 'jobs'), KIT);
    const id = store.start('leaktest', '断流测试', 'leaktest.sh', [], stubEnv(f), { required: ['leak.capture_control', 'leak.capture_bypass'] });
    const job = await waitFor(() => store.poll().find((j) => j.id === id));
    expect(job.state).toBe('failed');
    expect(job.reason).toContain('leak.capture_bypass');
  });
  it('cancels the whole process group', async () => {
    f.set('selfcheck.sleep', '30');
    const store = new JobStore(path.join(f.data, 'jobs'), KIT);
    const id = store.start('check-full', '完整验收', 'check.sh', [], stubEnv(f));
    await waitFor(() => store.get(id)?.state === 'running' && fs.existsSync(path.join(f.stub, 'calls.log')) && f.calls().includes('shell'));
    store.cancel(id);
    const job = await waitFor(() => store.poll().find((j) => j.id === id));
    expect(job.state).toBe('cancelled');
  });
  it('a job whose process vanished without an exit code is failed, not done', async () => {
    const dir = path.join(f.data, 'jobs');
    const id = '20261104T000000-setup-dead';
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'meta.json'), JSON.stringify({ id, kind: 'setup', title: '准备 VM', script: 'setup.sh', args: ['--json'], startedAt: Date.now(), pid: 999999, state: 'running' }));
    fs.writeFileSync(path.join(dir, id, 'events.ndjson'), '{"v":1,"type":"start","script":"setup","kit":"x"}\n{"v":1,"type":"step","id":"setup.vm","msg":"2/5"}\n');
    const store = new JobStore(dir, KIT);
    const job = store.get(id)!;
    expect(job.state).toBe('failed');
    expect(job.reason).toContain('中断');
  });
});
