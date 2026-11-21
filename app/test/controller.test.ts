import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PATH_MARK_END, PATH_MARK_START } from '../core/env';
import { Controller } from '../core/controller';
import { CoreManager } from '../core/egress';
import { FakeMac } from './fakemac';
import YAML from 'yaml';
import path from 'node:path';
import { KIT, makeFixture, waitFor, type Fixture } from './fixture';

let f: Fixture;
let c: Controller;
let notes: string[];

function make(core?: CoreManager): Controller {
  notes = [];
  const ctl = new Controller({
    core,
    kitDir: KIT,
    dataDir: f.data,
    appVersion: 'test',
    home: f.root,
    user: 'tester',
    loginPathOutput: async () => `${PATH_MARK_START}${f.bin}:/usr/bin:/bin${PATH_MARK_END}`,
    notify: (title, body) => notes.push(`${title}|${body}`),
  });
  ctl.updateSettings({ limaHome: `${f.root}/lima`, stateDir: f.state });
  return ctl;
}

beforeEach(() => {
  f = makeFixture();
  // Controller 只传干净环境（没有 STUB_DIR），所以把桩目录直接写进桩命令
  for (const name of ['limactl', 'curl']) {
    const p = `${f.bin}/${name}`;
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('#!/bin/bash\n', `#!/bin/bash\nSTUB_DIR='${f.stub}'\n`), { mode: 0o755 });
  }
});
afterEach(() => {
  c?.dispose();
  f.cleanup();
});

describe('Controller end to end', () => {
  it('goes green after a passing check and shows the exit IP', async () => {
    c = make();
    await c.init();
    await waitFor(() => c.snapshot().lastCheck && !c.snapshot().checking);
    const snap = c.snapshot();
    expect(snap.level, `${snap.headline}：${snap.detail}`).toBe('ok');
    expect(snap.headline).toBe('已连接');
    expect(snap.egress.vm).toBe('203.0.113.7');
    expect(notes).toEqual([]);
  });

  it('a different exit IP through the proxy is still green', async () => {
    c = make();
    await c.init();
    await waitFor(() => c.snapshot().lastCheck && !c.snapshot().checking);
    f.set('host_ip', '198.51.100.9');
    f.set('selfcheck.out', 'PASS vm.firewall ok\nPASS vm.tun ok\nPASS vm.proxy 经代理出网，出口 198.51.100.9\nEGRESS 198.51.100.9\n');
    await c.quickCheck();
    const snap = c.snapshot();
    expect(snap.level).toBe('ok');
    expect(snap.egress.vm).toBe('198.51.100.9');
    expect(notes).toEqual([]);
  });

  it('proxy down: red, notifies exactly once, recovers by itself', async () => {
    c = make();
    await c.init();
    await waitFor(() => c.snapshot().lastCheck && !c.snapshot().checking);
    f.set('host_ip', 'down');
    f.set('selfcheck.out', 'PASS vm.firewall ok\nPASS vm.tun ok\nFAIL vm.proxy 代理不通，VM 现在断网\nEGRESS \n');
    f.set('selfcheck.rc', '1');
    await c.quickCheck();
    let snap = c.snapshot();
    expect(snap.level).toBe('error');
    expect(snap.headline).toBe('代理断开');
    expect(snap.captions.some((x) => x.sticky && x.text.includes('代理断开'))).toBe(true);
    await c.quickCheck();
    expect(notes).toHaveLength(1);
    f.set('host_ip', '203.0.113.7');
    f.set('selfcheck.out', 'PASS vm.firewall ok\nPASS vm.tun ok\nPASS vm.proxy ok\nEGRESS 203.0.113.7\n');
    f.set('selfcheck.rc', '0');
    await c.quickCheck();
    snap = c.snapshot();
    expect(snap.level).toBe('ok');
    expect(snap.captions.some((x) => x.sticky)).toBe(false);
  });

  it('a stopped VM is gray and is not checked', async () => {
    f.set('vm_status', 'Stopped');
    c = make();
    await c.init();
    expect(c.snapshot().level).toBe('idle');
    expect(c.snapshot().headline).toBe('VM 已停止');
    expect(f.calls()).not.toContain('shell');
  });

  it('starting the VM runs as a job, then checks', async () => {
    f.set('vm_status', 'Stopped');
    c = make();
    await c.init();
    c.vmStart();
    await waitFor(() => c.snapshot().jobs.find((j) => j.kind === 'vm-start' && j.state === 'done'));
    await waitFor(() => c.snapshot().lastCheck, 20_000);
    expect(c.snapshot().vm.status).toBe('Running');
  });

  it('rejects unsafe clone URLs before starting a job', async () => {
    c = make();
    await c.init();
    expect(() => c.clone('https://user:token@github.com/a/b.git')).toThrow(/账号或令牌/);
    expect(c.snapshot().jobs).toHaveLength(0);
  });

  it('only allows one exclusive job at a time', async () => {
    f.set('upgrade.sleep', '5');
    c = make();
    await c.init();
    c.vmUpgrade();
    expect(() => c.setup()).toThrow(/还在进行/);
  });

  it('settings: interval clamped, mode only via setEgressMode, bad paths refused', async () => {
    c = make();
    const before = c.settings.egressMode;
    const s = c.updateSettings({ checkIntervalMin: 0, egressMode: before === 'builtin' ? 'clash-verge' : 'builtin' });
    expect(s.checkIntervalMin).toBe(1);
    expect(s.egressMode).toBe(before);
    expect(() => c.updateSettings({ stateDir: 'relative' })).toThrow();
    expect(() => c.updateSettings({ vmName: '../x' })).toThrow();
  });

  it('settings: latency test URL must be http(s) without credentials', () => {
    c = make();
    expect(c.settings.latencyTestUrl).toBe('https://www.gstatic.com/generate_204');
    expect(c.updateSettings({ latencyTestUrl: 'http://cp.cloudflare.com/generate_204' }).latencyTestUrl).toBe('http://cp.cloudflare.com/generate_204');
    expect(() => c.updateSettings({ latencyTestUrl: 'https://u:p@example.com/' })).toThrow(/账号/);
    expect(() => c.updateSettings({ latencyTestUrl: 'file:///etc/passwd' })).toThrow();
    expect(c.settings.latencyTestUrl).toBe('http://cp.cloudflare.com/generate_204');
  });

  it('settings: theme is system / dark / light, anything else falls back to system', () => {
    c = make();
    expect(c.settings.theme).toBe('system');
    expect(c.updateSettings({ theme: 'light' }).theme).toBe('light');
    expect(c.updateSettings({ theme: 'sepia' as never }).theme).toBe('system');
  });

  it('rename session: bad names never reach the script', async () => {
    c = make();
    await expect(c.renameSession('my-api-1', 'x;y')).rejects.toThrow(/会话名/);
    await expect(c.renameSession('a b', 'ok')).rejects.toThrow(/会话名/);
    expect(f.calls()).not.toContain('rename-session');
  });

  it('settings: terminal app is one of Terminal / iTerm / Ghostty', () => {
    c = make();
    expect(c.updateSettings({ terminalApp: 'Ghostty' }).terminalApp).toBe('Ghostty');
    expect(c.updateSettings({ terminalApp: 'iTerm' }).terminalApp).toBe('iTerm');
    expect(c.updateSettings({ terminalApp: 'Hyper' as never }).terminalApp).toBe('Terminal');
  });
});

describe('Controller: Claude hook events and tmux sessions', () => {
  const US = '\x1f';
  const ev = (t: number, event: string, cwd: string, type = '', msg = '') => ['CLAUDE', String(t), event, cwd, type, msg].join(US);

  it('first poll only finds the end of the file; later events become throttled captions', async () => {
    c = make();
    await c.init();
    await waitFor(() => !c.snapshot().checking);
    expect(c.snapshot().settings.hooksEnabled).toBe(false);
    await c.setHooks(true);
    expect(c.snapshot().settings.hooksEnabled).toBe(true);
    f.set('workspace.out', [ev(1, 'Stop', '/home/cc/work/my-api'), 'VALUE events_size 100', ''].join('\n'));
    await c.pollClaudeEvents();
    expect(c.snapshot().captions.filter((x) => x.project)).toEqual([]); // 旧事件不补发
    f.set('workspace.out', [ev(2, 'Stop', '/home/cc/work/my-api/src'), ev(3, 'Stop', '/home/cc/work/my-api'), ev(4, 'Notification', '/home/cc/work/web-app', 'permission_prompt', 'Claude needs your permission to use Bash'), 'VALUE events_size 300', ''].join('\n'));
    await c.pollClaudeEvents();
    const caps = c.snapshot().captions.filter((x) => x.project);
    expect(caps.map((x) => x.text)).toEqual(['my-api：Claude 做完了', 'web-app：Claude 在等你批准——Claude needs your permission to use Bash']);
    expect(caps[0].project).toBe('my-api');
    expect(f.calls()).toMatch(/events 100/);
    expect(notes).toEqual([]); // 完成提醒只弹字幕，不发系统通知
  });

  it('names new sessions after the project and skips taken numbers', async () => {
    c = make();
    await c.init();
    const US2 = US;
    f.set('workspace.out', [['SESSION', 'my_api-1', '1', '0', '/home/cc/work/my.api'].join(US2), ['SESSION', 'my_api-2', '1', '1', '/home/cc/work/my.api'].join(US2), 'VALUE x 1', ''].join('\n'));
    await c.refreshProjects();
    expect(c.snapshot().sessions.map((s) => s.name)).toEqual(['my_api-1', 'my_api-2']);
    expect(c.nextSessionName('my.api')).toBe('my_api-3');
    expect(c.nextSessionName('web-app')).toBe('web-app-1');
    await expect(c.killSession('bad name')).rejects.toThrow();
  });
});

describe('Controller with the built-in egress core', () => {
  const NODE = { name: '示例节点 · 东京 01', type: 'ss', server: 'jp1.example.com', port: 8388, cipher: 'aes-128-gcm', password: 'p1' };
  let mac: FakeMac;
  let subscription: string;
  let secret: string | undefined;
  const core = () =>
    new CoreManager({
      dataDir: f.data,
      home: f.root,
      uid: 501,
      exec: mac.exec,
      portInUse: mac.portInUse,
      secrets: { get: () => secret, set: (v) => (secret = v) },
      fetchText: async () => subscription,
    });
  // init() 会自动发起一次检查；等它结束再查，否则 quickCheck 会直接返回
  const check = async () => {
    await waitFor(() => !c.snapshot().checking);
    await c.quickCheck();
  };
  beforeEach(() => {
    mac = new FakeMac();
    subscription = YAML.stringify({ proxies: [NODE] });
    secret = undefined;
  });

  it('missing mihomo is an error that names the install command', async () => {
    mac.mihomo = undefined;
    c = make(core());
    fs.writeFileSync(path.join(f.data, 'settings.json'), JSON.stringify({ ...c.settings, egressMode: 'builtin' }));
    c.dispose();
    c = make(core());
    await c.init();
    const snap = c.snapshot();
    expect(snap.issues[0]).toMatchObject({ kind: 'core_missing' });
    expect(snap.issues[0].detail).toContain('brew install mihomo');
    expect(snap.level).toBe('error');
  });

  it('a changed node in the subscription is applied without going red', async () => {
    const m = core();
    c = make(m);
    await c.init();
    await c.setSubscription('https://sub.example.com/s?token=abc');
    await c.selectNode(NODE.name);
    await check();
    expect(c.snapshot().level).toBe('ok');
    subscription = YAML.stringify({ proxies: [{ ...NODE, password: 'p2' }] });
    const r = await c.updateSubscription();
    expect(r.changed).toBe(true);
    await check();
    const snap = c.snapshot();
    expect(snap.issues).toEqual([]);
    expect(snap.level).toBe('ok');
    expect(mac.loaded).toBe(true);
    expect(notes).toEqual([]);
  });

  it('a crashed core is one clear issue, not a second "代理断开"', async () => {
    const m = core();
    c = make(m);
    await c.init();
    await c.setSubscription('https://sub.example.com/s?token=abc');
    await c.selectNode(NODE.name);
    mac.loaded = false;
    f.set('host_ip', 'down');
    f.set('selfcheck.out', 'PASS vm.firewall ok\nPASS vm.tun ok\nFAIL vm.proxy 代理不通\nEGRESS \n');
    f.set('selfcheck.rc', '1');
    await c.refreshCore();
    await check();
    expect(c.snapshot().issues.map((i) => i.kind)).toEqual(['core_down']);
  });

  it('switching to Clash Verge mode stops the core service', async () => {
    const m = core();
    c = make(m);
    await c.init();
    await c.setSubscription('https://sub.example.com/s?token=abc');
    await c.selectNode(NODE.name);
    expect(mac.loaded).toBe(true);
    await c.setEgressMode('clash-verge');
    expect(mac.loaded).toBe(false);
    expect(c.snapshot().core).toBeUndefined();
    await c.setEgressMode('builtin');
    expect(mac.loaded).toBe(true);
  });
});

describe('Controller: shared folders and file transfer', () => {
  /** 后台任务是脱离的进程：等它们写完退出码再结束测试，免得清理临时目录时还在写 */
  const settle = (ids: string[]) => waitFor(() => ids.every((id) => fs.existsSync(path.join(f.data, 'jobs', id, 'exit'))));

  function project(): string {
    const dir = path.join(f.root, 'projects', 'app');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('settings cannot change shares through updateSettings', () => {
    c = make();
    const s = c.updateSettings({ sharedFolders: ['/Volumes/x'], sharesEnabled: true } as never);
    expect(s.sharedFolders).toEqual([]);
    expect(s.sharesEnabled).toBe(false);
  });

  it('applyShares writes shares.txt, runs share.sh apply, then refreshes and checks again', async () => {
    c = make();
    await c.init();
    await waitFor(() => c.snapshot().lastCheck && !c.snapshot().checking);
    const dir = project();
    c.addSharedFolder(dir + '/');
    c.setSharesEnabled(true);
    expect(c.snapshot().shares.pendingApply).toBe(true);
    f.set('mounts', dir + '\n');
    f.set('shares.out', 'VIEW app 1\nPASS share.guest 已映射 1 个共享文件夹到 /home/cc/mac（读写）\n');
    const before = c.snapshot().lastCheck!.at;
    const id = c.applyShares();
    expect(fs.readFileSync(path.join(f.state, 'shares.txt'), 'utf8')).toBe(dir + '\n');
    expect(c.snapshot().jobs.find((j) => j.id === id)?.kind).toBe('shares');
    const job = await waitFor(() => c.snapshot().jobs.find((j) => j.id === id && j.state !== 'running'), 20_000);
    expect(job.state, job.reason).toBe('done');
    await waitFor(() => c.snapshot().shares.applied.length === 1 && c.snapshot().lastCheck!.at > before && !c.snapshot().checking, 20_000);
    const snap = c.snapshot();
    expect(snap.shares.applied[0]).toEqual({ path: dir, name: 'app', view: '/home/cc/mac/app', mounted: true });
    expect(snap.shares.pendingApply).toBe(false);
    expect(snap.shares.needsRetry).toBe(false);
    // VM 里的映射掉了：不是「有改动」，但可以重新应用
    f.set('shares.out', 'VIEW app 0\nFAIL share.guest 没有挂上：/home/cc/mac/app\n');
    await c.refreshShares();
    expect(c.snapshot().shares.applied[0].mounted).toBe(false);
    expect(c.snapshot().shares.needsRetry).toBe(true);
    expect(c.snapshot().level).toBe('ok'); // 共享的问题不影响网络状态
    expect(snap.level, `${snap.headline}：${snap.detail}`).toBe('ok'); // 共享开着仍然是绿色
    expect(JSON.parse(fs.readFileSync(path.join(f.stub, 'edit'), 'utf8').replace(/^\.mounts = /, ''))).toEqual([
      { location: dir, mountPoint: '/mnt/ccvm-raw/app', writable: true },
    ]);
  });

  it('turning shares off writes an empty shares.txt', async () => {
    c = make();
    c.addSharedFolder(project());
    const id = c.applyShares();
    expect(fs.readFileSync(path.join(f.state, 'shares.txt'), 'utf8')).toBe('');
    await settle([id]);
  });

  it('refuses to apply a folder that must not be shared, without touching shares.txt', () => {
    c = make();
    c.addSharedFolder(f.root); // 家目录本身
    c.setSharesEnabled(true);
    expect(c.snapshot().shares.problems[f.root]).toMatch(/家目录/);
    expect(() => c.applyShares()).toThrow(/家目录/);
    expect(fs.existsSync(path.join(f.state, 'shares.txt'))).toBe(false);
  });

  it('pushPaths and pullFile start background jobs', async () => {
    c = make();
    const src = project();
    const ids = c.pushPaths([src, path.join(f.root, 'projects')], '/home/cc/work');
    expect(ids).toHaveLength(2);
    const jobs = c.snapshot().jobs;
    const push = jobs.find((j) => j.id === ids[0])!;
    expect(push.kind).toBe('push');
    expect(push.args).toEqual(['push', src, '/home/cc/work', '--json']);
    const pull = c.pullFile('/home/cc/work/a.txt', path.join(f.root, 'a.txt'), true);
    expect(c.snapshot().jobs.find((j) => j.id === pull)?.args).toEqual(['pull', '/home/cc/work/a.txt', path.join(f.root, 'a.txt'), '--force', '--json']);
    expect(() => c.pushPaths([src], '/etc')).toThrow(/home\/cc/);
    expect(() => c.pullFile('/home/cc/../etc/passwd', path.join(f.root, 'p'), false)).toThrow();
    await settle([...ids, pull]);
  });
});

describe('Controller: VM package upgrade', () => {
  it('suggests an upgrade only when workspace.sh reports a missing package or a low level', async () => {
    c = make();
    await c.init();
    expect(c.snapshot().vmPackages.needsUpgrade).toBe(false); // 还没读到：不提示
    f.set('workspace.out', 'VALUE tmux_installed 0\nVALUE vm_level 0\n');
    await c.refreshProjects();
    let snap = c.snapshot();
    expect(snap.vmPackages).toEqual({ level: 0, target: 2, tmuxInstalled: false, needsUpgrade: true });
    expect(snap.issues.some((i) => /软件包|tmux/.test(i.title))).toBe(false); // 不算出错
    f.set('workspace.out', 'VALUE tmux_installed 1\nVALUE vm_level 2\n');
    await c.refreshProjects();
    snap = c.snapshot();
    expect(snap.vmPackages.needsUpgrade).toBe(false);
  });

  it('runs upgrade.sh as an exclusive background job, then checks again', async () => {
    c = make();
    await c.init();
    await waitFor(() => c.snapshot().lastCheck && !c.snapshot().checking);
    const before = c.snapshot().lastCheck!.at;
    f.set('upgrade.out', 'PASS vm.upgrade 已补装到级别 1\nVALUE vm_level 1\n');
    const id = c.vmUpgrade();
    expect(c.snapshot().jobs.find((j) => j.id === id)?.kind).toBe('vm-upgrade');
    expect(() => c.setup()).toThrow(/还在进行/);
    const job = await waitFor(() => c.snapshot().jobs.find((j) => j.id === id && j.state !== 'running'), 20_000);
    expect(job.state, job.reason).toBe('done');
    expect(job.result?.checks.some((ch) => ch.id === 'vm.upgrade' && ch.ok)).toBe(true);
    await waitFor(() => c.snapshot().lastCheck!.at > before, 20_000);
  });
});
