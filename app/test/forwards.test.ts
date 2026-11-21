import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PATH_MARK_END, PATH_MARK_START } from '../core/env';
import { Controller } from '../core/controller';
import { portInUse } from '../core/egress';
import { forwardProblem } from '../core/forwards';
import { KIT, makeFixture, waitFor, type Fixture } from './fixture';

let f: Fixture;
let c: Controller;

function make(): Controller {
  const ctl = new Controller({
    kitDir: KIT,
    dataDir: f.data,
    appVersion: 'test',
    home: f.root,
    user: 'tester',
    loginPathOutput: async () => `${PATH_MARK_START}${f.bin}:/usr/bin:/bin${PATH_MARK_END}`,
    notify: () => undefined,
    forwardOptions: { retryMs: 200, openTimeoutMs: 8000 },
  });
  ctl.updateSettings({ limaHome: `${f.root}/lima`, stateDir: f.state });
  return ctl;
}

async function freePort(): Promise<number> {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

const fwd = (vm: number) => c.snapshot().ports.forwards.find((x) => x.vmPort === vm);

beforeEach(() => {
  f = makeFixture();
  for (const name of ['limactl', 'curl']) {
    const p = `${f.bin}/${name}`;
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('#!/bin/bash\n', `#!/bin/bash\nSTUB_DIR='${f.stub}'\n`), { mode: 0o755 });
  }
});
afterEach(() => {
  c?.dispose();
  f.cleanup();
});

describe('port forwards', () => {
  it('validates ports', () => {
    expect(forwardProblem(3000, 3000)).toBeNull();
    expect(forwardProblem(0, 3000)).not.toBeNull();
    expect(forwardProblem(3000, 70000)).not.toBeNull();
    expect(forwardProblem(22, 2222)).toMatch(/SSH/);
    expect(forwardProblem(3000, 17897)).toMatch(/代理/);
  });

  it('forwards a VM port to Mac loopback, remembers it, and stops it when removed', async () => {
    c = make();
    await c.init();
    const mac = await freePort();
    c.addForward(8080, mac);
    expect(c.settings.forwards).toEqual([{ vmPort: 8080, macPort: mac }]);
    await waitFor(() => fwd(8080)?.state === 'open');
    expect(await portInUse(mac)).toBe(true);
    const log = fs.readFileSync(path.join(f.stub, 'ssh.log'), 'utf8');
    expect(log).toContain(`-L 127.0.0.1:${mac}:127.0.0.1:8080 lima-ccvm`);
    expect(log).toContain('ControlMaster=no');
    expect(log).toContain(`-F ${f.root}/lima/ccvm/ssh.config`);
    expect(() => c.addForward(8080, mac + 1)).toThrow(/已经在转发/);
    expect(() => c.addForward(9090, mac)).toThrow(/另一条转发/);
    c.removeForward(8080);
    expect(c.snapshot().ports.forwards).toEqual([]);
    let free = false;
    for (let i = 0; i < 50 && !free; i++) {
      free = !(await portInUse(mac));
      if (!free) await new Promise((r) => setTimeout(r, 100));
    }
    expect(free).toBe(true);
  });

  it('reconnects after the tunnel drops', async () => {
    f.set('ssh.fail', '');
    c = make();
    await c.init();
    const mac = await freePort();
    c.addForward(3000, mac);
    await waitFor(() => fwd(3000)?.state === 'retrying' && fwd(3000)?.error?.includes('Connection refused'));
    fs.rmSync(path.join(f.stub, 'ssh.fail'));
    await waitFor(() => fwd(3000)?.state === 'open');
  });

  it('reports a busy Mac port instead of fighting over it', async () => {
    const busy = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => busy.once('listening', r));
    const mac = (busy.address() as net.AddressInfo).port;
    try {
      c = make();
      await c.init();
      c.addForward(5173, mac);
      await waitFor(() => fwd(5173)?.error?.includes('已被占用'));
      expect(fs.existsSync(path.join(f.stub, 'ssh.log'))).toBe(false);
    } finally {
      busy.close();
    }
  });

  it('keeps forwards while the VM is stopped and starts them when it runs', async () => {
    f.set('vm_status', 'Stopped');
    c = make();
    await c.init();
    const mac = await freePort();
    c.addForward(4000, mac);
    expect(fwd(4000)).toMatchObject({ state: 'retrying', error: 'VM 没有运行' });
    f.set('vm_status', 'Running');
    await c.refreshVm();
    await waitFor(() => fwd(4000)?.state === 'open');
  });

  it('lists listening ports from the VM', async () => {
    c = make();
    await c.init();
    f.set('ports.out', 'PORT\x1f3000\x1f0.0.0.0\x1fnode\x1fmy-api\nPORT\x1f5173\x1f127.0.0.1\x1fvite\x1f\nPASS ports.list ok\n');
    await c.refreshPorts();
    expect(c.snapshot().ports.items).toEqual([
      { port: 3000, address: '0.0.0.0', process: 'node', project: 'my-api' },
      { port: 5173, address: '127.0.0.1', process: 'vite', project: '' },
    ]);
  });

  it('lists the Mac ports the VM may reach, and whether the Mac is listening on them', async () => {
    const busy = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => busy.once('listening', r));
    const up = (busy.address() as net.AddressInfo).port;
    const down = await freePort();
    try {
      c = make();
      await c.init();
      f.set('macports.out', `VALUE mac_ports_ready 1\nMACPORT ${up}\nMACPORT ${down}\nPASS macports.list ok\n`);
      await c.refreshMacPorts();
      expect(c.snapshot().macPorts).toMatchObject({ ready: true, ports: [{ port: up, listening: true }, { port: down, listening: false }] });
    } finally {
      busy.close();
    }
  });

  it('allows and denies Mac ports through the VM firewall script, never 17897', async () => {
    c = make();
    await c.init();
    f.set('macports.out', 'PASS macports.allow ok\n');
    expect(await c.allowMacPort(5432)).toBe(true);
    expect(f.calls()).toContain('sudo bash -s -- allow 5432');
    expect(await c.denyMacPort(5432)).toBe(true);
    expect(f.calls()).toContain('sudo bash -s -- deny 5432');
    await expect(c.allowMacPort(17897)).rejects.toThrow(/代理入口/);
    await expect(c.allowMacPort(0)).rejects.toThrow();
    expect(f.calls()).not.toContain('allow 17897');
  });

  it('a VM that is not upgraded yet reports the feature as not ready', async () => {
    c = make();
    await c.init();
    f.set('macports.out', 'VALUE mac_ports_ready 0\nPASS macports.list ok\n');
    await c.refreshMacPorts();
    expect(c.snapshot().macPorts.ready).toBe(false);
  });
});
