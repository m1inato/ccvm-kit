import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkVergeConnections, controllerAddressProblem, readVergeConnections, vergeGet } from '../core/clashVerge';

const SECRET = 'verge-test-secret-7f3a';
const NODE = '示例节点 · 东京 01';
const seen: { method?: string; url?: string; auth?: string }[] = [];
let server: http.Server;
let address = '';

function conn(id: string, inbound: string, chains: string[]) {
  return { id, metadata: { inboundName: inbound, destinationIP: '160.79.104.10', destinationPort: '443', host: '' }, chains, upload: 10, download: 20, start: '' };
}

beforeAll(async () => {
  // 假的 Clash Verge 外部控制器：记录每个请求；密钥不对返回 401
  server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401).end('{"message":"Unauthorized"}');
      return;
    }
    const body =
      req.url === '/version'
        ? { version: 'v1.19.15' }
        : req.url === '/proxies/CC-VM-FIXED'
          ? { name: 'CC-VM-FIXED', type: 'Selector', now: NODE, all: [NODE] }
          : req.url === '/connections'
            ? {
                connections: [
                  conn('ok1', 'cc-vm-in', [NODE, 'CC-VM-FIXED']),
                  conn('direct', 'cc-vm-in', ['DIRECT']),
                  conn('wrongnode', 'cc-vm-in', ['别的节点', 'CC-VM-FIXED']),
                  conn('mac', 'mixed', ['DIRECT']), // Mac 自己的流量：不在面板里
                ],
              }
            : null;
    if (!body) return void res.writeHead(404).end('{}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Clash Verge external controller (read-only)', () => {
  it('sends the secret as a Bearer token and only GETs whitelisted paths', async () => {
    seen.length = 0;
    expect(await vergeGet(address, SECRET, '/version')).toEqual({ version: 'v1.19.15' });
    const r = await readVergeConnections(address, SECRET, NODE);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /version', 'GET /connections', 'GET /proxies/CC-VM-FIXED']);
    expect(new Set(seen.map((s) => s.auth))).toEqual(new Set([`Bearer ${SECRET}`]));
    expect(r.node).toBe(NODE);
    expect(r.connections.map((c) => c.id)).toEqual(['ok1', 'direct', 'wrongnode']);
    expect(r.offPath).toEqual(['direct', 'wrongnode']);
  });

  it('refuses other paths and non-loopback addresses without sending anything', async () => {
    seen.length = 0;
    await expect(vergeGet(address, SECRET, '/configs' as never)).rejects.toThrow(/不允许/);
    for (const bad of ['192.168.1.2:9097', 'example.com:9097', '[::1]:9097', '0.0.0.0:9097', '127.0.0.1', '127.0.0.1:70000', 'http://127.0.0.1:9097', ' localhost:9097x']) {
      expect(controllerAddressProblem(bad), bad).not.toBeNull();
      await expect(vergeGet(bad, SECRET, '/version'), bad).rejects.toThrow();
    }
    expect(controllerAddressProblem('localhost:9097')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('explains a wrong secret and a closed controller, without echoing the secret', async () => {
    const wrong = await vergeGet(address, 'nope', '/version').catch((e: Error) => e.message);
    expect(wrong).toMatch(/密钥不对/);
    expect(wrong).not.toContain('nope');
    const closed = await vergeGet('127.0.0.1:1', SECRET, '/version').catch((e: Error) => e.message);
    expect(closed).toMatch(/没有打开/);
    expect(closed).not.toContain(SECRET);
  });

  it('marks every VM connection whose chain is not exactly [node, CC-VM-FIXED]', () => {
    const json = { connections: [conn('a', 'cc-vm-in', [NODE, 'CC-VM-FIXED']), conn('b', 'cc-vm-in', ['CC-VM-FIXED', NODE]), conn('c', 'cc-vm-in', [NODE, 'CC-VM-FIXED', 'x'])] };
    expect(checkVergeConnections(json, { now: NODE }, '').offPath).toEqual(['b', 'c']);
    // 读不到当前节点：用设置里的节点名；都没有时只核对形状
    const r = checkVergeConnections({ connections: [conn('d', 'cc-vm-in', ['别的', 'CC-VM-FIXED'])] }, undefined, NODE);
    expect(r.node).toBeUndefined();
    expect(r.offPath).toEqual(['d']);
    expect(checkVergeConnections({ connections: [conn('e', 'cc-vm-in', ['别的', 'CC-VM-FIXED'])] }, undefined, '').offPath).toEqual([]);
  });
});
