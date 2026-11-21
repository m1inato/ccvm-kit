import { describe, expect, it } from 'vitest';
import { AlertTracker, deriveLevel, issuesFromCheck, issuesFromCore, Throttle } from '../core/status';
import type { CheckRecord, CoreStatus, VmInfo } from '../core/types';

const vm: VmInfo = { name: 'ccvm', status: 'Running' };
const rec = (checks: [string, boolean][], values: Record<string, string> = {}, ok?: boolean, reason?: string): CheckRecord => ({
  kind: 'check',
  at: 1000,
  ok: ok ?? checks.every(([, o]) => o),
  reason,
  checks: checks.map(([id, o]) => ({ id, ok: o, msg: `${id} msg` })),
  values,
});

describe('issues', () => {
  it('a passing check has no issues, whatever the exit IP is', () => {
    expect(issuesFromCheck(rec([['host.proxy', true], ['vm.proxy', true]], { host_egress: '198.51.100.9', vm_egress: '203.0.113.7' }))).toEqual([]);
  });
  it('proxy unreachable from the Mac is one "代理断开" issue', () => {
    const issues = issuesFromCheck(rec([['host.proxy', false], ['vm.tun', true], ['vm.proxy', false]]));
    expect(issues.map((i) => i.kind)).toEqual(['proxy_down']);
    expect(issues[0].title).toBe('代理断开');
  });
  it('TUN down is reported instead of the derived VM failure', () => {
    const issues = issuesFromCheck(rec([['host.proxy', true], ['vm.tun', false], ['vm.proxy', false]]));
    expect(issues.map((i) => i.kind)).toEqual(['tun_down']);
  });
  it('VM cannot get out although the Mac can: still 代理断开', () => {
    const issues = issuesFromCheck(rec([['host.proxy', true], ['vm.tun', true], ['vm.proxy', false]]));
    expect(issues.map((i) => i.key)).toEqual(['proxy_down:vm']);
  });
  it('a missing firewall is its own issue', () => {
    expect(issuesFromCheck(rec([['host.proxy', true], ['vm.firewall', false], ['vm.proxy', true]])).map((i) => i.kind)).toEqual(['firewall']);
  });
  it('an incomplete run with no failed check is still an error', () => {
    const issues = issuesFromCheck(rec([['vm.tun', true]], {}, false, '脚本没有正常结束'));
    expect(issues.map((i) => i.kind)).toEqual(['check_incomplete']);
  });
  it('a stopped VM is not an error', () => {
    expect(issuesFromCheck(rec([['vm.running', false]], {}, false))).toEqual([]);
  });
  it('unknown failed checks surface with their message', () => {
    const issues = issuesFromCheck(rec([['lima.version', false]]));
    expect(issues[0]).toMatchObject({ kind: 'check_failed', detail: 'lima.version msg' });
  });
});

describe('core issues', () => {
  const core = (patch: Partial<CoreStatus>): CoreStatus => ({
    mihomo: { path: '/opt/homebrew/bin/mihomo', version: '1.19.33', versionOk: true },
    service: { loaded: true, running: true, pid: 1 },
    listenerOwned: true,
    node: { name: 'a', type: 'ss', server: 's', port: 1 },
    nodeMissing: false,
    nodes: [],
    subscription: { set: true, autoUpdate: true, viaClashVerge: false },
    latency: {},
    checkedAt: 0,
    ...patch,
  });
  it('a running core with a node is fine, even when the node left the subscription', () => {
    expect(issuesFromCore(core({}))).toEqual([]);
    expect(issuesFromCore(core({ nodeMissing: true }))).toEqual([]);
  });
  it('a crashed core is an error; a core you stopped is not', () => {
    expect(issuesFromCore(core({ service: { loaded: true, running: false } })).map((i) => i.kind)).toEqual(['core_down']);
    expect(issuesFromCore(core({ service: { loaded: false, running: false }, stopped: { reason: 'user', at: 1, detail: '' } }))).toEqual([]);
  });
  it('missing mihomo and port conflicts are reported', () => {
    expect(issuesFromCore(core({ mihomo: { versionOk: false } }))[0].kind).toBe('core_missing');
    expect(issuesFromCore(core({ listenerOwned: false, portBusy: true }))[0].kind).toBe('core_conflict');
  });
});

describe('level', () => {
  const base = { issues: [], vm, jobs: [], intervalMin: 3, now: 2000 };
  it('green with a fresh passing check, and shows the exit IP', () => {
    const r = deriveLevel({ ...base, lastCheck: rec([['vm.proxy', true]], { vm_egress: '203.0.113.7' }) });
    expect(r).toMatchObject({ level: 'ok', headline: '已连接', detail: '出口 203.0.113.7' });
    expect(deriveLevel({ ...base }).level).toBe('idle');
    expect(deriveLevel({ ...base, lastCheck: rec([['vm.proxy', true]]), now: 1000 + 8 * 60_000 }).level).toBe('idle');
  });
  it('stopped or missing VM is gray', () => {
    expect(deriveLevel({ ...base, vm: { name: 'ccvm', status: 'Stopped' } }).level).toBe('idle');
    expect(deriveLevel({ ...base, vm: { name: 'ccvm', status: 'Missing' } }).headline).toBe('还没部署');
  });
  it('long jobs are busy; errors win over busy', () => {
    const jobs = [{ id: '1', kind: 'vm-start' as const, title: '启动 VM', args: [], state: 'running' as const, startedAt: 0 }];
    expect(deriveLevel({ ...base, jobs }).level).toBe('busy');
    const issues = issuesFromCheck(rec([['host.proxy', false]]));
    expect(deriveLevel({ ...base, jobs, issues }).level).toBe('error');
  });
});

describe('alerts', () => {
  it('notifies once per issue and again after it recovers', () => {
    const t = new AlertTracker();
    const a = { key: 'proxy_down', kind: 'proxy_down' as const, title: '', detail: '' };
    expect(t.update([a])).toHaveLength(1);
    expect(t.update([a])).toHaveLength(0);
    expect(t.update([])).toHaveLength(0);
    expect(t.update([a])).toHaveLength(1);
  });
  it('throttle allows one per window', () => {
    const th = new Throttle(5 * 60_000);
    expect(th.allow('my-api', 0)).toBe(true);
    expect(th.allow('my-api', 60_000)).toBe(false);
    expect(th.allow('web-app', 60_000)).toBe(true);
    expect(th.allow('my-api', 5 * 60_000)).toBe(true);
  });
});
