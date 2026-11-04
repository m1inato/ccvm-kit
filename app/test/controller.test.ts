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
  it('goes green after a passing quick check', async () => {
    c = make();
    await c.init();
    await waitFor(() => c.snapshot().lastQuick && !c.snapshot().checking);
    const snap = c.snapshot();
    expect(snap.level, `${snap.headline}：${snap.detail}`).toBe('ok');
    expect(snap.headline).toBe('受保护');
    expect(snap.egress.vm).toBe('203.0.113.7');
    expect(snap.newSessionsBlocked).toBe(false);
    expect(notes).toEqual([]);
  });

  it('egress change: red, blocks new sessions, notifies exactly once', async () => {
    c = make();
    await c.init();
    await waitFor(() => c.snapshot().lastQuick);
    f.set('host_ip', '198.51.100.9');
    f.set('selfcheck.out', 'PASS vm.tun_up ok\nFAIL egress.vm_matches_baseline VM 出口 198.51.100.9 ≠ 基线 203.0.113.7\nEGRESS 198.51.100.9\n');
    f.set('selfcheck.rc', '1');
    await c.quickCheck();
    let snap = c.snapshot();
    expect(snap.level).toBe('error');
    expect(snap.headline).toBe('出口变了');
    expect(snap.newSessionsBlocked).toBe(true);
    expect(c.canOpenSession().ok).toBe(false);
    expect(snap.captions.some((x) => x.sticky && x.text.includes('出口变了'))).toBe(true);
    await c.quickCheck();
    expect(notes).toHaveLength(1);

    // 核实后更新基线：预览两端一致 → 接受
    const preview = await c.previewRebaseline();
    expect(preview.values.host_egress).toBe('198.51.100.9');
    f.set('selfcheck.out', 'PASS vm.tun_up ok\nPASS egress.vm_matches_baseline VM 出口 = 基线 198.51.100.9\nEGRESS 198.51.100.9\n');
    f.set('selfcheck.rc', '0');
    const accepted = await c.acceptRebaseline('198.51.100.9');
    expect(accepted.ok).toBe(true);
    snap = c.snapshot();
    expect(snap.level).toBe('ok');
    expect(snap.egress.baseline).toBe('198.51.100.9');
    expect(snap.captions.some((x) => x.sticky)).toBe(false);
  });

  it('a stopped VM is gray and is not checked', async () => {
    f.set('vm_status', 'Stopped');
    c = make();
    await c.init();
    expect(c.snapshot().level).toBe('idle');
    expect(c.snapshot().headline).toBe('VM 没有运行');
    expect(f.calls()).not.toContain('shell');
  });

  it('starting the VM runs as a job, then checks', async () => {
    f.set('vm_status', 'Stopped');
    c = make();
    await c.init();
    c.vmStart();
    await waitFor(() => c.snapshot().jobs.find((j) => j.kind === 'vm-start' && j.state === 'done'));
    await waitFor(() => c.snapshot().lastQuick, 20_000);
    expect(c.snapshot().vm.status).toBe('Running');
  });

  it('rejects unsafe clone URLs before starting a job', async () => {
    c = make();
    await c.init();
    expect(() => c.clone('https://user:token@github.com/a/b.git')).toThrow(/账号或令牌/);
    expect(c.snapshot().jobs).toHaveLength(0);
  });

  it('only allows one exclusive job at a time', async () => {
    f.set('leaktest.sleep', '5');
    c = make();
    await c.init();
    c.leaktest();
    expect(() => c.setup()).toThrow(/还在进行/);
  });

  it('settings: interval clamped, mode only via setEgressMode, bad paths refused', async () => {
    c = make();
    const before = c.settings.egressMode;
    const s = c.updateSettings({ checkIntervalMin: 0, egressMode: before === 'builtin' ? 'clash-verge' : 'builtin' });
    expect(s.checkIntervalMin).toBe(2);
    expect(s.egressMode).toBe(before);
    expect(() => c.updateSettings({ stateDir: 'relative' })).toThrow();
    expect(() => c.updateSettings({ vmName: '../x' })).toThrow();
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

  it('node change: red, one clear issue, no duplicate listener issue, sessions blocked; confirm restores', async () => {
    const m = core();
    c = make(m);
    await c.init();
    await c.setSubscription('https://sub.example.com/s?token=abc');
    await c.selectNode(NODE.name);
    await check();
    expect(c.snapshot().level).toBe('ok');
    subscription = YAML.stringify({ proxies: [{ ...NODE, password: 'p2' }] });
    // 核心停了，专用入口也就没人听了
    fs.writeFileSync(`${f.bin}/netstat`, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    await c.updateSubscription();
    await check();
    let snap = c.snapshot();
    expect(snap.level).toBe('error');
    expect(snap.issues.map((i) => i.kind)).toEqual(['node_changed']);
    expect(snap.newSessionsBlocked).toBe(true);
    expect(notes.some((n) => n.includes('选定节点变了'))).toBe(true);
    fs.writeFileSync(`${f.bin}/netstat`, "#!/bin/bash\nprintf 'tcp4 0 0 127.0.0.1.17897 *.* LISTEN\\n'\n", { mode: 0o755 });
    await c.selectNode(NODE.name);
    await check();
    snap = c.snapshot();
    expect(snap.issues).toEqual([]);
    expect(snap.level).toBe('ok');
    // 确认节点后，不会拿核心停着时的旧检查结果再报一次「专用入口不可用」
    expect(notes.filter((n) => n.includes('专用入口'))).toEqual([]);
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
