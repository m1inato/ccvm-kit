import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreManager, portInUse, sameNode } from '../core/egress';
import { FakeMac } from './fakemac';
import { fetchSubscription } from '../core/fetch';
import { coreConfigProblems } from '../core/mihomo';

const NODE_A = { name: '🇯🇵 示例节点 · 东京 01', type: 'ss', server: 'jp1.example.com', port: 8388, cipher: 'aes-128-gcm', password: 's3cret' };
const NODE_B = { name: '示例节点 · 新加坡 01', type: 'trojan', server: '198.51.100.20', port: 443, password: 't0ken' };
const sub = (...nodes: object[]) => YAML.stringify({ proxies: nodes });
let root: string;
let mac: FakeMac;
let subscription: string;
let secret: string | undefined;
let fetches: { url: string; via: boolean }[];

function manager(): CoreManager {
  return new CoreManager({
    dataDir: path.join(root, 'data'),
    home: root,
    uid: 501,
    exec: mac.exec,
    portInUse: mac.portInUse,
    secrets: { get: () => secret, set: (v) => (secret = v) },
    fetchText: async (url, via) => {
      fetches.push({ url, via });
      return subscription;
    },
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-core-'));
  mac = new FakeMac();
  subscription = sub(NODE_A, NODE_B);
  secret = undefined;
  fetches = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('CoreManager', () => {
  it('stores the subscription as a secret, keeps only non-secret node info', async () => {
    const m = manager();
    await expect(m.setSubscription('http://sub.example.com/s?token=1')).rejects.toThrow(/https/);
    const nodes = await m.setSubscription('https://sub.example.com/s?token=abc123');
    expect(nodes.map((n) => n.name)).toEqual([NODE_A.name, NODE_B.name]);
    expect(secret).toBe('https://sub.example.com/s?token=abc123');
    const stateText = fs.readFileSync(path.join(m.dir, 'state.json'), 'utf8');
    expect(stateText).not.toContain('s3cret');
    expect(stateText).not.toContain('token=abc123');
    expect((await m.status()).subscription.masked).toBe('https://sub.example.com/s?token=••••••••');
  });

  it('selecting a node writes a private, self-checked config and loads the launch agent', async () => {
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    const pinned = await m.selectNode(NODE_A.name);
    expect(pinned).toEqual({ name: NODE_A.name, type: 'ss', server: NODE_A.server, port: NODE_A.port });
    const cfgText = fs.readFileSync(m.configFile, 'utf8');
    expect(coreConfigProblems(cfgText, NODE_A.name)).toEqual([]);
    expect(cfgText).not.toContain(NODE_B.password);
    expect(fs.statSync(m.configFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(m.dir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(m.plistPath, 'utf8')).toContain('/opt/homebrew/bin/mihomo');
    expect(mac.calls).toContain(`launchctl bootstrap gui/501 ${m.plistPath}`);
    const st = await m.status();
    expect(st.service.running).toBe(true);
    expect(st.listenerOwned).toBe(true);
    expect(st.iface).toBe('en0');
  });

  it('uses the second DHCP DNS when the first is routed through a VPN', async () => {
    mac.dnsServers = ['192.0.2.1', '192.0.2.53'];
    mac.dnsRoutes['192.0.2.1'] = 'utun4';
    const m = manager();
    await m.setSubscription('https://sub.example.com/s');
    await m.selectNode(NODE_A.name);
    expect(YAML.parse(fs.readFileSync(m.configFile, 'utf8')).dns['proxy-server-nameserver']).toEqual(['192.0.2.53#en0']);
    mac.dnsServers = ['192.0.2.54'];
    expect(await m.onNetworkChange()).toBe('rebound');
    expect(YAML.parse(fs.readFileSync(m.configFile, 'utf8')).dns.nameserver).toEqual(['192.0.2.54#en0']);
    mac.dnsRoute = 'utun4';
    expect(await m.onNetworkChange()).toBe('stopped');
    expect(mac.loaded).toBe(false);
    mac.dnsRoute = undefined;
    expect(await m.onNetworkChange()).toBe('resumed');
  });

  it('refuses startup without a usable DHCP DNS', async () => {
    mac.dnsServers = [];
    const m = manager();
    await m.setSubscription('https://sub.example.com/s');
    await expect(m.selectNode(NODE_A.name)).rejects.toThrow(/DHCP DNS/);
    expect(mac.loaded).toBe(false);
  });

  it('a changed node stops the core and waits for confirmation; never switches silently', async () => {
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    await m.selectNode(NODE_A.name);
    expect((await m.update()).changed).toBe(false);
    subscription = sub({ ...NODE_A, password: 'rotated' }, NODE_B);
    const r = await m.update();
    expect(r.changed).toBe(true);
    let st = await m.status();
    expect(st.service.loaded).toBe(false);
    expect(fs.existsSync(m.plistPath)).toBe(false); // 登录时也不会再用旧节点启动
    expect(st.pending?.kind).toBe('changed');
    expect(st.stopped?.reason).toBe('node_changed');
    expect(fs.readFileSync(m.configFile, 'utf8')).toContain('s3cret'); // 还没换
    await expect(m.start()).rejects.toThrow(/确认/);
    await m.selectNode(NODE_A.name); // 确认使用新的节点信息
    st = await m.status();
    expect(st.pending).toBeUndefined();
    expect(st.service.running).toBe(true);
    expect(fs.readFileSync(m.configFile, 'utf8')).toContain('rotated');
  });

  it('compares nodes by content, field by field', () => {
    expect(sameNode(NODE_A, { ...NODE_A })).toBe(true);
    expect(sameNode(NODE_A, Object.fromEntries(Object.entries(NODE_A).reverse()))).toBe(true); // 键顺序无关
    expect(sameNode(NODE_A, { ...NODE_A, password: 'x' })).toBe(false);
    expect(sameNode(NODE_A, { ...NODE_A, port: 8389 })).toBe(false);
    expect(sameNode(NODE_A, { ...NODE_A, extra: true })).toBe(false);
  });

  it('a hand-edited core config also counts as a change', async () => {
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    await m.selectNode(NODE_A.name);
    fs.writeFileSync(m.configFile, fs.readFileSync(m.configFile, 'utf8').replace('s3cret', 'tampered'));
    expect((await m.update()).changed).toBe(true);
    expect((await m.status()).service.loaded).toBe(false);
  });

  it('a node that disappeared stops the core', async () => {
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    await m.selectNode(NODE_A.name);
    subscription = sub(NODE_B);
    await m.update();
    const st = await m.status();
    expect(st.pending?.kind).toBe('missing');
    expect(st.service.loaded).toBe(false);
  });

  it('a failed download leaves the running core alone', async () => {
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    await m.selectNode(NODE_A.name);
    subscription = 'not: [valid';
    await expect(m.update()).rejects.toThrow();
    const st = await m.status();
    expect(st.service.running).toBe(true);
    expect(st.subscription.error).toBeTruthy();
  });

  it('rebinds on interface change, stops without a physical interface, resumes when it returns', async () => {
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    await m.selectNode(NODE_A.name);
    expect(await m.onNetworkChange()).toBe('unchanged');
    mac.iface = 'en7';
    expect(await m.onNetworkChange()).toBe('rebound');
    expect(YAML.parse(fs.readFileSync(m.configFile, 'utf8'))['interface-name']).toBe('en7');
    mac.iface = undefined;
    expect(await m.onNetworkChange()).toBe('stopped');
    expect((await m.status()).service.loaded).toBe(false);
    mac.iface = 'en0';
    expect(await m.onNetworkChange()).toBe('resumed');
    expect((await m.status()).service.running).toBe(true);
  });

  it('refuses to start when mihomo is missing or too old', async () => {
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    mac.mihomo = undefined;
    await expect(m.selectNode(NODE_A.name)).rejects.toThrow(/brew install mihomo/);
    mac.mihomo = '/opt/homebrew/bin/mihomo';
    mac.version = '1.18.9';
    await expect(m.start()).rejects.toThrow();
  });

  it('refuses to start while something else holds 127.0.0.1:17897', async () => {
    mac.otherListener = true;
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    await expect(m.selectNode(NODE_A.name)).rejects.toThrow(/Clash Verge/);
    expect(mac.loaded).toBe(false);
  });

  it('the real port probe sees a listener (on a free port, never on 17897)', async () => {
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await portInUse(port)).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await portInUse(port)).toBe(false);
  }, 15_000);

  it('remove stops the service and forgets the node but keeps the subscription', async () => {
    const m = manager();
    await m.setSubscription('https://sub.example.com/s?token=abc');
    await m.selectNode(NODE_A.name);
    await m.remove();
    const st = await m.status();
    expect(st.service.loaded).toBe(false);
    expect(st.node).toBeUndefined();
    expect(fs.existsSync(m.configFile)).toBe(false);
    expect(st.subscription.set).toBe(true);
  });

  it('flags a mihomo upgrade until a leak test accepts it', async () => {
    const m = manager();
    await m.detect();
    m.acceptVersion();
    mac.version = '1.19.40';
    await m.detect();
    expect((await m.status()).mihomo.versionChanged).toBe(true);
    m.acceptVersion();
    expect((await m.status()).mihomo.versionChanged).toBe(false);
  });

  it('passes the via-Clash-Verge option to the downloader', async () => {
    const m = manager();
    m.setOptions({ viaClashVerge: true });
    await m.setSubscription('https://sub.example.com/s?token=abc');
    expect(fetches.at(-1)?.via).toBe(true);
  });
});

describe('fetchSubscription', () => {
  let tlsDir: string;
  let key: string;
  let cert: string;
  beforeEach(() => {
    tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tlsDir}/k.pem`, '-out', `${tlsDir}/c.pem`, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    key = fs.readFileSync(`${tlsDir}/k.pem`, 'utf8');
    cert = fs.readFileSync(`${tlsDir}/c.pem`, 'utf8');
  });
  afterEach(() => fs.rmSync(tlsDir, { recursive: true, force: true }));

  async function serve(handler: http.RequestListener): Promise<{ port: number; close: () => void }> {
    const s = https.createServer({ key, cert }, handler).listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    return { port: (s.address() as net.AddressInfo).port, close: () => s.close() };
  }

  it('downloads over https with a clash user agent, directly or through a CONNECT proxy', async () => {
    let ua = '';
    const srv = await serve((req, res) => {
      ua = String(req.headers['user-agent']);
      res.end('proxies: []\n');
    });
    let tunnelled = '';
    const proxy = http.createServer().on('connect', (req, client) => {
      tunnelled = String(req.url);
      const [, port] = String(req.url).split(':');
      const up = net.connect(Number(port), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(client);
        client.pipe(up);
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => proxy.once('listening', r));
    try {
      expect(await fetchSubscription(`https://localhost:${srv.port}/s?token=1`, { ca: cert })).toBe('proxies: []\n');
      expect(ua).toContain('clash');
      const via = { host: '127.0.0.1', port: (proxy.address() as net.AddressInfo).port };
      expect(await fetchSubscription(`https://localhost:${srv.port}/s?token=1`, { ca: cert, via })).toBe('proxies: []\n');
      expect(tunnelled).toBe(`localhost:${srv.port}`);
    } finally {
      srv.close();
      proxy.close();
    }
  });

  it('rejects http, bad certificates, http redirects and errors', async () => {
    await expect(fetchSubscription('http://localhost/x')).rejects.toThrow(/https/);
    const srv = await serve((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://localhost/plain' });
        return res.end();
      }
      res.writeHead(403);
      res.end();
    });
    try {
      await expect(fetchSubscription(`https://localhost:${srv.port}/s`)).rejects.toThrow(/下载订阅失败/); // 自签证书，不在信任列表
      await expect(fetchSubscription(`https://localhost:${srv.port}/redirect`, { ca: cert })).rejects.toThrow(/https/);
      await expect(fetchSubscription(`https://localhost:${srv.port}/s`, { ca: cert })).rejects.toThrow(/403/);
    } finally {
      srv.close();
    }
  });
});
