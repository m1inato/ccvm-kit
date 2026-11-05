import { describe, expect, it } from 'vitest';
import { AlertTracker, deriveLevel, issuesFromCheck, issuesFromLeak, Throttle } from '../core/status';
import type { CheckRecord, VmInfo } from '../core/types';

const vm: VmInfo = { name: 'ccvm', status: 'Running' };
const rec = (checks: [string, boolean][], values: Record<string, string> = {}, ok?: boolean, reason?: string): CheckRecord => ({
  kind: 'quick',
  at: 1000,
  ok: ok ?? checks.every(([, o]) => o),
  reason,
  checks: checks.map(([id, o]) => ({ id, ok: o, msg: `${id} msg` })),
  values,
});

describe('issues', () => {
  it('turns an egress mismatch into one "出口变了" issue keyed by the new IP', () => {
    const issues = issuesFromCheck(rec([['egress.host_matches_baseline', false], ['egress.vm_matches_baseline', false]], { baseline: '203.0.113.7', host_egress: '198.51.100.9', vm_egress: '198.51.100.9' }));
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('egress_changed');
    expect(issues[0].key).toBe('egress_changed:198.51.100.9');
    expect(issues[0].detail).toContain('203.0.113.7');
  });
  it('reports an unreachable listener rather than an egress change', () => {
    const issues = issuesFromCheck(rec([['egress.host_matches_baseline', false]], { baseline: '203.0.113.7', host_egress: '' }));
    expect(issues[0].kind).toBe('listener_down');
  });
  it('TUN down hides the derived egress failures', () => {
    const issues = issuesFromCheck(rec([['vm.tun_up', false], ['vm.egress_reachable', false], ['egress.vm_matches_baseline', false]], { baseline: '203.0.113.7', host_egress: '203.0.113.7' }));
    expect(issues.map((i) => i.kind)).toEqual(['tun_down']);
  });
  it('an incomplete run with no failed check is still an error', () => {
    const issues = issuesFromCheck(rec([['vm.tun_up', true]], {}, false, '脚本没有正常结束'));
    expect(issues.map((i) => i.kind)).toEqual(['check_incomplete']);
  });
  it('not-ready states are not errors', () => {
    expect(issuesFromCheck(rec([['vm.running', false]], {}, false))).toEqual([]);
    expect(issuesFromCheck(rec([['baseline.present', false]], {}, false))).toEqual([]);
  });
  it('unknown failed checks surface with their own id', () => {
    const issues = issuesFromCheck(rec([['cc.no_sudo', false]]));
    expect(issues[0]).toMatchObject({ kind: 'check_failed', checkId: 'cc.no_sudo' });
  });
});

describe('level', () => {
  const base = { issues: [], vm, jobs: [], intervalMin: 10, now: 2000 };
  it('green only with a fresh passing check', () => {
    expect(deriveLevel({ ...base, lastCheck: rec([['vm.tun_up', true]], { vm_egress: '203.0.113.7' }) }).level).toBe('ok');
    expect(deriveLevel({ ...base }).level).toBe('idle');
    expect(deriveLevel({ ...base, lastCheck: rec([['vm.tun_up', true]]), now: 1000 + 26 * 60_000 }).level).toBe('idle');
  });
  it('a failed check with no mapped issue is never green', () => {
    expect(deriveLevel({ ...base, lastCheck: rec([], {}, false, 'x') }).level).toBe('error');
  });
  it('stopped or missing VM is gray', () => {
    expect(deriveLevel({ ...base, vm: { name: 'ccvm', status: 'Stopped' } }).level).toBe('idle');
    expect(deriveLevel({ ...base, vm: { name: 'ccvm', status: 'Missing' } }).headline).toBe('还没部署');
  });
  it('long jobs are busy; errors win over busy', () => {
    const jobs = [{ id: '1', kind: 'leaktest' as const, title: '断流测试', args: [], state: 'running' as const, startedAt: 0 }];
    expect(deriveLevel({ ...base, jobs }).level).toBe('busy');
    const issues = issuesFromCheck(rec([['vm.tun_up', false]]));
    expect(deriveLevel({ ...base, jobs, issues }).level).toBe('error');
  });
});

describe('alerts', () => {
  it('notifies once per issue and again after it recovers', () => {
    const t = new AlertTracker();
    const a = { key: 'tun_down', kind: 'tun_down' as const, title: '', detail: '' };
    expect(t.update([a])).toHaveLength(1);
    expect(t.update([a])).toHaveLength(0);
    expect(t.update([])).toHaveLength(0);
    expect(t.update([a])).toHaveLength(1);
  });
  it('a different new exit IP is a new alert', () => {
    const t = new AlertTracker();
    t.update([{ key: 'egress_changed:1.1.1.1', kind: 'egress_changed', title: '', detail: '' }]);
    expect(t.update([{ key: 'egress_changed:2.2.2.2', kind: 'egress_changed', title: '', detail: '' }])).toHaveLength(1);
  });
  it('throttle allows one per window', () => {
    const th = new Throttle(5 * 60_000);
    expect(th.allow('my-api', 0)).toBe(true);
    expect(th.allow('my-api', 60_000)).toBe(false);
    expect(th.allow('web-app', 60_000)).toBe(true);
    expect(th.allow('my-api', 5 * 60_000)).toBe(true);
  });
});

describe('failed leak test', () => {
  it('blocks until a new leak test passes, and says so', () => {
    const failed = { kind: 'leak' as const, at: 1, ok: false, reason: '旁路有 3 个包', checks: [], values: {} };
    const [issue] = issuesFromLeak(failed);
    expect(issue.kind).toBe('leak_failed');
    expect(issue.detail).toContain('旁路有 3 个包');
    expect(issue.detail).toMatch(/重新做一次断流测试/);
    expect(issuesFromLeak({ ...failed, ok: true, reason: undefined })).toEqual([]);
  });
});

describe('TUN policy routes', () => {
  it('reports lost routes as their own issue, not a generic egress change', () => {
    const rec: CheckRecord = {
      kind: 'quick', at: 1, ok: false,
      checks: [
        { id: 'vm.tun_up', ok: true, msg: 'TUN 运行中' },
        { id: 'vm.tun_routes', ok: false, msg: '策略路由没了' },
        { id: 'vm.egress_reachable', ok: false, msg: '出不去' },
        { id: 'egress.vm_matches_baseline', ok: false, msg: 'VM 出口 无 ≠ 基线' },
      ],
      values: { baseline: '203.0.113.7' },
    };
    const issues = issuesFromCheck(rec);
    expect(issues.map((i) => i.key)).toEqual(['tun_down:routes']);
    expect(issues[0].title).toBe('TUN 的路由丢了');
  });
});
