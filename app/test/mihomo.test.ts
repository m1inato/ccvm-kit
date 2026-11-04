import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  buildCoreConfig, buildProbeConfig, coreConfigProblems, launchAgentPlist, maskSubscription, nodeFromConfig,
  parseConnections, parseDhcpDns, parseLaunchctlPrint, parseMihomoVersion, parseSubscription, physicalInterface,
  subscriptionUrlProblem, versionAtLeast, type RawNode,
} from '../core/mihomo';

const SUB = `
mixed-port: 7890
proxies:
  - { name: "🇯🇵 示例节点 · 东京 01", type: ss, server: jp1.example.com, port: 8388, cipher: aes-128-gcm, password: "s3cret" }
  - { name: "示例节点 · 新加坡 01", type: trojan, server: 198.51.100.20, port: "443", password: "t0ken", sni: example.com }
  - { name: DIRECT, type: direct }
  - { name: "坏节点", type: vmess }
  - { name: "🇯🇵 示例节点 · 东京 01", type: ss, server: dup.example.com, port: 1, cipher: x, password: y }
proxy-groups:
  - { name: 自动选择, type: url-test, proxies: ["🇯🇵 示例节点 · 东京 01"] }
rules:
  - MATCH,自动选择
`;

describe('parseSubscription', () => {
  it('keeps real nodes only, with numeric ports, first name wins', () => {
    const r = parseSubscription(SUB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodes.map((n) => n.name)).toEqual(['🇯🇵 示例节点 · 东京 01', '示例节点 · 新加坡 01']);
    expect(r.nodes[1]).toEqual({ name: '示例节点 · 新加坡 01', type: 'trojan', server: '198.51.100.20', port: 443 });
    expect(r.raw[0].password).toBe('s3cret');
    expect(r.skipped).toBe(3);
  });
  it('refuses base64 / URI subscriptions and providers with a clear reason', () => {
    const b64 = Buffer.from('ss://YWVzLTEyOC1nY206cGFzcw@1.2.3.4:8388#a\nvmess://abc').toString('base64');
    for (const text of [b64, 'ss://YWVz@1.2.3.4:8388#a\ntrojan://p@h:443#b']) {
      const r = parseSubscription(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('Clash Verge');
    }
    const prov = parseSubscription('proxy-providers:\n  a: { type: http, url: "https://x" }\n');
    expect(!prov.ok && prov.error).toContain('proxy-providers');
    expect(parseSubscription('').ok).toBe(false);
    expect(parseSubscription('{{{').ok).toBe(false);
    expect(parseSubscription('proxies: []').ok).toBe(false);
  });
});

const node: RawNode = { name: '🇯🇵 示例节点 · 东京 01', type: 'ss', server: 'jp1.example.com', port: 8388, cipher: 'aes-128-gcm', password: 's3cret' };

describe('core config', () => {
  const text = buildCoreConfig({ dnsServers: ['192.0.2.53'], node, iface: 'en0', socketPath: '/Volumes/Data/CCVM/core/mihomo.sock' });
  const cfg = YAML.parse(text);
  it('has exactly one loopback TCP listener pinned to the node, and rejects everything else', () => {
    expect(cfg.listeners).toEqual([{ name: 'ccvm-in', type: 'mixed', listen: '127.0.0.1', port: 17897, udp: false, users: [], proxy: node.name }]);
    expect(cfg.rules).toEqual(['MATCH,REJECT']);
    expect(cfg.proxies).toEqual([node]);
    expect(cfg['allow-lan']).toBe(false);
  });
  it('binds the physical interface and resolves node names itself, without a DNS listener', () => {
    expect(cfg['interface-name']).toBe('en0');
    expect(cfg.dns.enable).toBe(true);
    expect(cfg.dns.listen).toBeUndefined();
    expect(cfg.dns['proxy-server-nameserver']).toEqual(['192.0.2.53#en0']);
  });
  it('controller only on a unix socket; no ports, tun, groups or downloads', () => {
    expect(cfg['external-controller']).toBeUndefined();
    expect(cfg['external-controller-unix']).toMatch(/mihomo\.sock$/);
    for (const k of ['port', 'mixed-port', 'socks-port', 'tun', 'proxy-groups', 'proxy-providers', 'rule-providers']) expect(cfg[k]).toBeUndefined();
    expect(cfg['geo-auto-update']).toBe(false);
    expect(coreConfigProblems(text, node.name)).toEqual([]);
  });
  it('refuses virtual or odd interfaces', () => {
    for (const iface of ['utun4', 'lo0', 'bridge100', 'en0; rm -rf', '']) {
      expect(() => buildCoreConfig({ dnsServers: ['192.0.2.53'], node, iface, socketPath: '/tmp/s.sock' }), iface).toThrow();
    }
    expect(() => buildCoreConfig({ dnsServers: ['192.0.2.53'], node, iface: 'lo', socketPath: '/tmp/s.sock', port: 18000, testLoopback: true })).not.toThrow();
  });
  it('the invariant checker catches weakened configs', () => {
    const bad = (mut: (c: Record<string, unknown>) => void) => {
      const c = YAML.parse(text);
      mut(c);
      return coreConfigProblems(YAML.stringify(c), node.name);
    };
    expect(bad((c) => ((c.listeners as { listen: string }[])[0].listen = '0.0.0.0'))).not.toEqual([]);
    expect(bad((c) => (c['external-controller'] = '127.0.0.1:9090'))).not.toEqual([]);
    expect(bad((c) => (c.rules = ['MATCH,DIRECT']))).not.toEqual([]);
    expect(bad((c) => (c['mixed-port'] = 7890))).not.toEqual([]);
    expect(bad((c) => ((c.dns as Record<string, unknown>).listen = '127.0.0.1:53'))).not.toEqual([]);
    expect(bad((c) => (c.tun = { enable: true }))).not.toEqual([]);
    expect(bad((c) => ((c.listeners as { udp: boolean }[])[0].udp = true))).not.toEqual([]);
    expect(bad((c) => ((c.proxies as unknown[]).push({ name: 'x' })))).not.toEqual([]);
  });
  it('node names with YAML-special characters round-trip', () => {
    const odd: RawNode = { ...node, name: 'a: b # "c" \'d\' [e] {f}' };
    const t = buildCoreConfig({ dnsServers: ['192.0.2.53'], node: odd, iface: 'en1', socketPath: '/tmp/s.sock' });
    expect(coreConfigProblems(t, odd.name)).toEqual([]);
    expect(nodeFromConfig(t)?.name).toBe(odd.name);
  });
  it('probe config has all nodes and no inbound at all', () => {
    const p = YAML.parse(buildProbeConfig({ dnsServers: ['192.0.2.53'], nodes: [node, { ...node, name: 'b' }], iface: 'en0', socketPath: '/tmp/p.sock' }));
    expect(p.proxies).toHaveLength(2);
    expect(p.listeners).toBeUndefined();
    expect(p['mixed-port']).toBeUndefined();
    expect(p['external-controller']).toBeUndefined();
  });
});

describe('system output parsers', () => {
  it('reads every DHCP DNS address and rejects invalid or fake addresses', () => {
    expect(parseDhcpDns('router (ip_mult): {192.0.2.1}\ndomain_name_server (ip_mult): {192.0.2.53, 198.18.0.1, 999.1.1.1, 192.0.2.54, 192.0.2.53}')).toEqual(['192.0.2.53', '192.0.2.54']);
    expect(parseDhcpDns('no lease')).toEqual([]);
    expect(() => buildCoreConfig({ node, iface: 'en0', dnsServers: [], socketPath: '/tmp/s.sock' })).toThrow(/DNS/);
  });

  it('picks the first physical interface even when a VPN/TUN is primary', () => {
    const nwi = `Network information

IPv4 network interface information
   utun4 : flags      : 0x5 (IPv4,DNS)
           address    : 198.18.0.1
     en0 : flags      : 0x5 (IPv4,DNS)
           address    : 192.168.1.23
           reach      : 0x00000002 (Reachable)

   REACH : flags 0x00000002 (Reachable)

IPv6 network interface information
     en1 : flags      : 0x6 (IPv6,DNS)

Network interfaces: utun4 en0
`;
    expect(physicalInterface(nwi)).toBe('en0');
    expect(physicalInterface('IPv4 network interface information\n   No IPv4 states found\n')).toBeUndefined();
    expect(physicalInterface('IPv4 network interface information\n   bridge100 : flags : 0x5\n')).toBeUndefined();
  });
  it('reads launchctl print', () => {
    const out = 'gui/501/dev.ccvm.core = {\n\tactive count = 1\n\tstate = running\n\tprogram = /opt/homebrew/bin/mihomo\n\tpid = 4242\n\tlast exit code = (never exited)\n}';
    expect(parseLaunchctlPrint(0, out)).toEqual({ loaded: true, running: true, pid: 4242, lastExit: '(never exited)' });
    expect(parseLaunchctlPrint(0, '\tstate = waiting\n\tlast exit code = 1\n')).toEqual({ loaded: true, running: false, pid: undefined, lastExit: '1' });
    expect(parseLaunchctlPrint(113, 'Could not find service')).toEqual({ loaded: false, running: false });
  });
  it('reads mihomo versions', () => {
    expect(parseMihomoVersion('Mihomo Meta v1.19.33 darwin arm64 with go1.24.4 Fri Oct 3 2026')).toBe('1.19.33');
    expect(versionAtLeast('1.19.33', '1.19.0')).toBe(true);
    expect(versionAtLeast('1.18.10', '1.19.0')).toBe(false);
    expect(versionAtLeast(undefined, '1.19.0')).toBe(false);
  });
  it('plist escapes paths and has no environment', () => {
    const p = launchAgentPlist('/opt/homebrew/bin/mihomo', '/Volumes/a&b/core', '/Volumes/a&b/core/config.yaml', '/Volumes/a&b/core/mihomo.log');
    expect(p).toContain('<string>/Volumes/a&amp;b/core</string>');
    expect(p).toContain('<key>KeepAlive</key>');
    expect(p).not.toContain('EnvironmentVariables');
  });
  it('masks subscription tokens and refuses plain http', () => {
    expect(maskSubscription('https://sub.example.com/api/v1/client/subscribe?token=abcdef123456&flag=clash')).toBe('https://sub.example.com/api/v1/client/subscribe?token=••••••••&flag=••••••••');
    expect(maskSubscription('https://sub.example.com/link/AbCdEf0123456789xyz')).toBe('https://sub.example.com/link/••••••••');
    expect(subscriptionUrlProblem('http://sub.example.com/x?token=1')).toContain('https');
    expect(subscriptionUrlProblem('https://u:p@sub.example.com/x')).not.toBeNull();
    expect(subscriptionUrlProblem('https://sub.example.com/x?token=1')).toBeNull();
  });
  it('reads mihomo connections', () => {
    const list = parseConnections({
      connections: [{ id: '1', metadata: { host: '', destinationIP: '160.79.104.10', destinationPort: '443', inboundName: 'ccvm-in' }, chains: ['🇯🇵 示例节点 · 东京 01'], upload: 10, download: 2048, start: '2026-11-04T09:00:00Z' }],
    });
    expect(list[0]).toMatchObject({ destination: '160.79.104.10:443', inbound: 'ccvm-in', chains: ['🇯🇵 示例节点 · 东京 01'], download: 2048 });
    expect(parseConnections(null)).toEqual([]);
  });
});
