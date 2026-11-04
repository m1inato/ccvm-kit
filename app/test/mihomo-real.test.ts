// 用真实的 mihomo 跑 App 生成的核心配置。默认跳过；在 Mac 上：MIHOMO_BIN=$(which mihomo) npm test
// 只用本机的假节点（SOCKS5）和本机的目标服务器，不碰任何真实订阅。
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unixGet } from '../core/egress';
import { buildCoreConfig } from '../core/mihomo';

const BIN = process.env.MIHOMO_BIN;
const LO = os.platform() === 'darwin' ? 'lo0' : 'lo';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** 最小的 SOCKS5 服务端：记录目标后转发，代表「选定节点」 */
function fakeNode(targets: string[]): net.Server {
  return net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (req) => {
        let host = '';
        let off = 4;
        if (req[3] === 1) {
          host = [...req.subarray(4, 8)].join('.');
          off = 8;
        } else if (req[3] === 3) {
          host = req.subarray(5, 5 + req[4]).toString();
          off = 5 + req[4];
        }
        const port = req.readUInt16BE(off);
        targets.push(`${host}:${port}`);
        const up = net.connect(port, host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          up.pipe(c);
          c.pipe(up);
        });
        up.on('error', () => c.destroy());
      });
    });
    c.on('error', () => undefined);
  });
}

function viaProxy(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `http://${target}/hello`, headers: { host: target }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(!BIN)('real mihomo with the generated core config', () => {
  let dir: string;
  let child: ChildProcess;
  let port: number;
  let node: net.Server;
  let target: http.Server;
  let targetAddr: string;
  const targets: string[] = [];
  let hits = 0;
  const sock = () => path.join(dir, 'c.sock');

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-real-'));
    target = http.createServer((_req, res) => {
      hits += 1;
      res.end('ok');
    }).listen(0, '127.0.0.1');
    await new Promise((r) => target.once('listening', r));
    targetAddr = `127.0.0.1:${(target.address() as net.AddressInfo).port}`;
    node = fakeNode(targets).listen(0, '127.0.0.1');
    await new Promise((r) => node.once('listening', r));
    port = await freePort();
    const cfg = buildCoreConfig({
      dnsServers: ['192.0.2.53'],
      node: { name: '测试节点 · 本机', type: 'socks5', server: '127.0.0.1', port: (node.address() as net.AddressInfo).port },
      iface: LO,
      socketPath: sock(),
      port,
      testLoopback: true,
    });
    fs.writeFileSync(path.join(dir, 'config.yaml'), cfg);
    child = spawn(BIN!, ['-d', dir, '-f', path.join(dir, 'config.yaml')], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: dir } });
    const until = Date.now() + 10_000;
    while (!(fs.existsSync(sock()) && (await canConnect('127.0.0.1', port)))) {
      if (Date.now() > until) throw new Error('mihomo did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 20_000);

  afterAll(() => {
    child?.kill('SIGTERM');
    node?.close();
    target?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('traffic into the listener goes through the selected node', async () => {
    expect(await viaProxy(port, targetAddr)).toBe('ok');
    expect(targets).toContain(targetAddr);
  });

  it('the listener is not reachable on non-loopback addresses', async () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (!lan) return;
    expect(await canConnect(lan.address, port)).toBe(false);
  });

  it('the controller is only on the unix socket; no TCP controller, no DNS listener', async () => {
    const v = (await unixGet(sock(), '/version', 3000)) as { version?: string };
    expect(v.version).toBeTruthy();
    expect(await canConnect('127.0.0.1', 9090)).toBe(false);
    try {
      const out = execFileSync('lsof', ['-nP', '-a', '-p', String(child.pid), '-i'], { encoding: 'utf8' });
      const listening = out.split('\n').filter((l) => /LISTEN/.test(l));
      expect(listening.every((l) => l.includes(`127.0.0.1:${port}`))).toBe(true);
      expect(out.split('\n').filter((l) => /UDP/.test(l) && /:53\b/.test(l))).toEqual([]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // 没有 lsof 就跳过这一项
    }
  });

  it('connections report the node in their chain', async () => {
    const slow = net.connect(port, '127.0.0.1');
    await new Promise((r) => slow.once('connect', r));
    slow.write(`CONNECT ${targetAddr} HTTP/1.1\r\nHost: ${targetAddr}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 300));
    const conns = (await unixGet(sock(), '/connections', 3000)) as { connections?: { chains: string[]; metadata: { inboundName?: string } }[] };
    slow.destroy();
    expect(conns.connections?.some((c) => c.chains.includes('测试节点 · 本机'))).toBe(true);
  });

  it('when the node is down nothing goes direct', async () => {
    const before = hits;
    await new Promise((r) => node.close(r));
    await expect(viaProxy(port, targetAddr)).rejects.toThrow();
    expect(hits).toBe(before);
  });

  it('nothing was downloaded at startup', () => {
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => /geo|mmdb|\.dat$|asn/i.test(f))).toEqual([]);
  });
});

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}
