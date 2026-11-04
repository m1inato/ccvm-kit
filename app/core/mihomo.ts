// 自带出口核心（mihomo）的纯函数：解析订阅、生成配置、检查配置、解析系统命令输出。
// 不依赖 Node 模块，界面也可以引用其中的类型与 maskSubscription。
import YAML from 'yaml';

export const CORE_PORT = 17897;
export const CORE_LABEL = 'dev.ccvm.core';
export const MIHOMO_MIN = '1.19.0';
export const LISTENER_NAME = 'ccvm-in';
const BUILTIN_TYPES = new Set(['direct', 'reject', 'reject-drop', 'dns', 'pass', 'compatible']);
const BUILTIN_NAMES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);

export interface NodeInfo {
  name: string;
  type: string;
  server: string;
  port: number;
}

export type RawNode = Record<string, unknown> & { name: string; type: string; server: string; port: number };

export type ParsedSubscription =
  | { ok: true; nodes: NodeInfo[]; raw: RawNode[]; skipped: number }
  | { ok: false; error: string };

/** 只支持 Clash YAML：节点写在 proxies 里。base64 / 链接格式、proxy-providers 都不支持。 */
export function parseSubscription(text: string): ParsedSubscription {
  const body = text.replace(/^﻿/, '').trim();
  if (!body) return { ok: false, error: '订阅内容是空的' };
  if (/^(ss|ssr|vmess|vless|trojan|hysteria2?|tuic|hy2|anytls):\/\//m.test(body) || /^[A-Za-z0-9+/=_\-\s]{40,}$/.test(body)) {
    return { ok: false, error: '这是 base64 / 链接格式的订阅。App 只支持 Clash YAML；订阅服务没有 Clash 格式时，请改用 Clash Verge 模式' };
  }
  let doc: unknown;
  try {
    doc = YAML.parse(body, { maxAliasCount: 200, prettyErrors: false });
  } catch (err) {
    return { ok: false, error: `订阅不是有效的 YAML：${String((err as Error).message).split('\n')[0]}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: '订阅内容不是 Clash 配置' };
  const cfg = doc as Record<string, unknown>;
  const proxies = Array.isArray(cfg.proxies) ? cfg.proxies : [];
  if (!proxies.length) {
    if (cfg['proxy-providers']) return { ok: false, error: '订阅用 proxy-providers 引用外部节点；App 只支持直接写在订阅里的节点，请改用 Clash Verge 模式' };
    return { ok: false, error: '订阅里没有节点（proxies 为空）' };
  }
  const nodes: NodeInfo[] = [];
  const raw: RawNode[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const p of proxies) {
    if (!isPlainNode(p)) {
      skipped += 1;
      continue;
    }
    const type = p.type.toLowerCase();
    const port = typeof p.port === 'string' ? Number(p.port) : p.port;
    if (BUILTIN_TYPES.has(type) || BUILTIN_NAMES.has(p.name.toUpperCase()) || seen.has(p.name) || !Number.isInteger(port) || port < 1 || port > 65535) {
      skipped += 1;
      continue;
    }
    seen.add(p.name);
    nodes.push({ name: p.name, type, server: p.server, port });
    raw.push({ ...p, port });
  }
  if (!nodes.length) return { ok: false, error: '订阅里没有可用的代理节点' };
  return { ok: true, nodes, raw, skipped };
}

function isPlainNode(p: unknown): p is RawNode {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const n = p as Record<string, unknown>;
  return (
    typeof n.name === 'string' && n.name.trim() !== '' && !/[\n\r\0]/.test(n.name) &&
    typeof n.type === 'string' && typeof n.server === 'string' && n.server !== '' &&
    (typeof n.port === 'number' || (typeof n.port === 'string' && /^\d+$/.test(n.port)))
  );
}

const IFACE = /^en\d+$/;

export interface CoreConfigInput {
  node: RawNode;
  iface: string;
  socketPath: string;
  port?: number;
  /** 仅测试用：允许绑定回环网卡（lo / lo0），配合本机的假节点 */
  testLoopback?: boolean;
}

/** 核心配置：一个入口（127.0.0.1:17897，只收 TCP）、一个节点、其余一律拒绝；绑定物理网卡，自己解析节点域名。 */
export function buildCoreConfig(input: CoreConfigInput): string {
  const { node, iface, socketPath } = input;
  const port = input.port ?? CORE_PORT;
  if (!IFACE.test(iface) && !(input.testLoopback && /^lo\d*$/.test(iface))) throw new Error(`不是物理网卡：${iface}`);
  if (!socketPath.startsWith('/') || socketPath.length > 100) throw new Error('控制 socket 路径必须是绝对路径且不超过 100 个字符');
  const cfg = {
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    ipv6: false,
    mode: 'rule',
    'log-level': 'warning',
    'find-process-mode': 'off',
    'unified-delay': false,
    'tcp-concurrent': false,
    'geo-auto-update': false,
    'interface-name': iface,
    'external-controller-unix': socketPath,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    // dns.enable 为 false 时 mihomo 会改用系统 DNS（可能被 Clash Verge 接管），所以必须开启；不设 listen，不对外提供 DNS
    dns: {
      enable: true,
      ipv6: false,
      'respect-rules': false,
      nameserver: [`dhcp://${iface}`],
      'proxy-server-nameserver': [`dhcp://${iface}`],
    },
    proxies: [node],
    listeners: [{ name: LISTENER_NAME, type: 'mixed', listen: '127.0.0.1', port, udp: false, users: [], proxy: node.name }],
    rules: ['MATCH,REJECT'],
  };
  return '# 由 CCVM 生成，不要手动修改；下次写入会覆盖。\n' + YAML.stringify(cfg, { lineWidth: 0 });
}

export interface ProbeConfigInput {
  nodes: RawNode[];
  iface: string;
  socketPath: string;
}

/** 测延迟用的临时配置：全部节点，但没有任何入口，只能经本机 socket 发起测试 */
export function buildProbeConfig(input: ProbeConfigInput): string {
  if (!IFACE.test(input.iface)) throw new Error(`不是物理网卡：${input.iface}`);
  const cfg = {
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    ipv6: false,
    mode: 'rule',
    'log-level': 'error',
    'find-process-mode': 'off',
    'geo-auto-update': false,
    'interface-name': input.iface,
    'external-controller-unix': input.socketPath,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    dns: { enable: true, ipv6: false, nameserver: [`dhcp://${input.iface}`], 'proxy-server-nameserver': [`dhcp://${input.iface}`] },
    proxies: input.nodes,
    rules: ['MATCH,REJECT'],
  };
  return YAML.stringify(cfg, { lineWidth: 0 });
}

const PORT_KEYS = ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port'];

/** 写入前再核对一遍生成的配置：不满足就不写（和脚本的「不确定就当失败」同一原则） */
export function coreConfigProblems(text: string, expectNode: string, port = CORE_PORT): string[] {
  const problems: string[] = [];
  let cfg: Record<string, unknown>;
  try {
    cfg = YAML.parse(text) as Record<string, unknown>;
  } catch {
    return ['配置不是有效的 YAML'];
  }
  if (!cfg || typeof cfg !== 'object') return ['配置为空'];
  for (const key of PORT_KEYS) if (key in cfg) problems.push(`不应有 ${key}`);
  if ('tun' in cfg) problems.push('不应开虚拟网卡（tun）');
  if ('external-controller' in cfg || 'external-controller-tls' in cfg) problems.push('不应开 TCP 控制接口');
  if (cfg['allow-lan'] !== false) problems.push('allow-lan 必须为 false');
  if (typeof cfg['interface-name'] !== 'string') problems.push('必须绑定网卡');
  const dns = cfg.dns as Record<string, unknown> | undefined;
  if (!dns || dns.enable !== true || 'listen' in dns) problems.push('DNS 必须开启且不监听');
  const proxies = cfg.proxies as { name?: unknown }[] | undefined;
  if (!Array.isArray(proxies) || proxies.length !== 1 || proxies[0]?.name !== expectNode) problems.push('必须只有选定的那一个节点');
  if ('proxy-groups' in cfg || 'proxy-providers' in cfg || 'rule-providers' in cfg) problems.push('不应有策略组或外部 provider');
  const listeners = cfg.listeners as Record<string, unknown>[] | undefined;
  if (!Array.isArray(listeners) || listeners.length !== 1) problems.push('必须只有一个入口');
  else {
    const l = listeners[0];
    if (l.listen !== '127.0.0.1') problems.push('入口必须只听 127.0.0.1');
    if (l.port !== port) problems.push(`入口端口必须是 ${port}`);
    if (l.udp !== false) problems.push('入口不收 UDP');
    if (l.proxy !== expectNode) problems.push('入口必须固定走选定节点');
  }
  const rules = cfg.rules;
  if (!Array.isArray(rules) || rules.length !== 1 || rules[0] !== 'MATCH,REJECT') problems.push('规则必须只有 MATCH,REJECT');
  return problems;
}

/** 从现有配置里取回节点（换网卡时重写配置用，不用重新下载订阅） */
export function nodeFromConfig(text: string): RawNode | undefined {
  try {
    const cfg = YAML.parse(text) as { proxies?: unknown[] };
    const n = cfg?.proxies?.[0];
    return isPlainNode(n) ? (n as RawNode) : undefined;
  } catch {
    return undefined;
  }
}

/** `scutil --nwi` 的 IPv4 部分按优先级列出网卡；取第一块物理网卡（en*），跳过 utun 等虚拟网卡 */
export function physicalInterface(nwi: string): string | undefined {
  const ipv4 = nwi.split(/IPv6 network interface information/)[0];
  for (const line of ipv4.split('\n')) {
    const m = line.match(/^\s*([a-z]+\d+)\s*:\s*flags/);
    if (m && IFACE.test(m[1])) return m[1];
  }
  return undefined;
}

export interface LaunchdService {
  loaded: boolean;
  running: boolean;
  pid?: number;
  lastExit?: string;
}

export function parseLaunchctlPrint(code: number | null, out: string): LaunchdService {
  if (code !== 0) return { loaded: false, running: false };
  const state = out.match(/^\s*state = (\S+)/m)?.[1];
  const pid = out.match(/^\s*pid = (\d+)/m)?.[1];
  const lastExit = out.match(/^\s*last exit code = (.+)$/m)?.[1]?.trim();
  return { loaded: true, running: state === 'running' && !!pid, pid: pid ? Number(pid) : undefined, lastExit };
}

export function parseMihomoVersion(out: string): string | undefined {
  return out.match(/v?(\d+\.\d+\.\d+)/)?.[1];
}

export function versionAtLeast(v: string | undefined, min: string): boolean {
  if (!v) return false;
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** LaunchAgent：以你的身份运行，KeepAlive 意外退出自动拉起；没有环境变量（不继承代理设置） */
export function launchAgentPlist(program: string, configDir: string, configFile: string, logFile: string): string {
  const args = [program, '-d', configDir, '-f', configFile].map((a) => `\t\t<string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${CORE_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
\t<key>StandardOutPath</key>
\t<string>${xml(logFile)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

/** 界面上显示的订阅地址：查询参数的值和像令牌的路径段都打码 */
export function maskSubscription(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (seg.length >= 16 && /[0-9]/.test(seg) && /[a-zA-Z]/.test(seg) ? '••••••••' : seg))
      .join('/');
    const query = [...u.searchParams.keys()].map((k) => `${k}=••••••••`).join('&');
    return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return '••••••••';
  }
}

export function subscriptionUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return '不是有效的链接';
  }
  if (u.protocol !== 'https:') return '订阅链接要用 https（http 会把账号令牌明文发出去）';
  if (u.username || u.password) return '链接里不要带账号密码';
  return null;
}

export interface CoreConnection {
  id: string;
  host: string;
  destination: string;
  inbound: string;
  chains: string[];
  upload: number;
  download: number;
  start: string;
}

/** mihomo /connections 的结果 → 界面用的列表（字段参考 tunnel/statistic/tracker.go） */
export function parseConnections(json: unknown): CoreConnection[] {
  const list = (json as { connections?: unknown[] })?.connections;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) => {
    if (!c || typeof c !== 'object') return [];
    const o = c as Record<string, unknown>;
    const m = (o.metadata ?? {}) as Record<string, unknown>;
    const ip = typeof m.destinationIP === 'string' ? m.destinationIP : '';
    const port = m.destinationPort !== undefined ? String(m.destinationPort) : '';
    return [
      {
        id: String(o.id ?? ''),
        host: typeof m.host === 'string' ? m.host : '',
        destination: ip && port ? `${ip}:${port}` : ip,
        inbound: typeof m.inboundName === 'string' ? m.inboundName : '',
        chains: Array.isArray(o.chains) ? o.chains.map(String) : [],
        upload: typeof o.upload === 'number' ? o.upload : 0,
        download: typeof o.download === 'number' ? o.download : 0,
        start: typeof o.start === 'string' ? o.start : '',
      },
    ];
  });
}
