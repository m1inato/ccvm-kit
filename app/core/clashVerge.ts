// Clash Verge 模式的「连接」面板：只读 Clash Verge 的外部控制器。
// 只连本机回环，只发白名单里的三个 GET；没有任何写操作的代码路径。密钥只放在请求头里，不进日志、报错和导出记录。
import http from 'node:http';
import type { CoreConnection } from './mihomo';
import { parseConnections } from './mihomo';

/** 扩展脚本里的名字（config/clash-verge-script.js） */
export const VERGE_LISTENER = 'cc-vm-in';
export const VERGE_GROUP = 'CC-VM-FIXED';

/** 允许的请求，写死在这里 */
export const VERGE_PATHS = ['/version', '/connections', `/proxies/${VERGE_GROUP}`] as const;
export type VergePath = (typeof VERGE_PATHS)[number];

const MAX_BYTES = 4 * 1024 * 1024;

/** 只接受 127.0.0.1:端口 或 localhost:端口（localhost 固定按 127.0.0.1 连，不解析、不走 IPv6）。没问题返回 null */
export function controllerAddressProblem(address: unknown): string | null {
  if (typeof address !== 'string') return '地址应为字符串';
  const m = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(address.trim());
  if (!m) return '只接受 127.0.0.1:端口 或 localhost:端口（外部控制器只能是本机回环）';
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return `端口不对：${m[2]}`;
  return null;
}

function portOf(address: string): number {
  const problem = controllerAddressProblem(address);
  if (problem) throw new Error(problem);
  return Number(address.trim().split(':')[1]);
}

/** 对外部控制器发一个 GET。路径不在白名单里、地址不是回环，都不发 */
export function vergeGet(address: string, secret: string | undefined, urlPath: VergePath, timeoutMs = 3000): Promise<unknown> {
  if (!(VERGE_PATHS as readonly string[]).includes(urlPath)) return Promise.reject(new Error(`不允许的请求：${urlPath}`));
  let port: number;
  try {
    port = portOf(address);
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers, timeout: timeoutMs, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_BYTES) req.destroy(new Error('外部控制器返回的数据太大'));
        else chunks.push(d);
      });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('密钥不对：和 Clash Verge 设置里的外部控制器密钥不一致'));
        if (!res.statusCode || res.statusCode >= 300) return reject(new Error(`外部控制器返回 HTTP ${res.statusCode ?? '?'}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('外部控制器返回的不是 JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('外部控制器没有响应')));
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ECONNREFUSED' ? new Error(`连不上 ${address}：Clash Verge 的外部控制器没有打开，或者端口不对`) : err);
    });
    req.end();
  });
}

export interface VergeConnections {
  /** 来自 VM 的连接（入站是 cc-vm-in） */
  connections: CoreConnection[];
  /** CC-VM-FIXED 当前选中的节点；读不到为空（界面显示「未知」） */
  node?: string;
  /** 链路不是正好 [节点名, CC-VM-FIXED] 的连接 id */
  offPath: string[];
}

/**
 * 核对来自 VM 的每条连接：链路必须正好是 [节点名, CC-VM-FIXED]（mihomo 返回的顺序，先节点后策略组）。
 * 节点名用 CC-VM-FIXED 当前选中的；读不到时用设置里填的节点名；都没有时只核对形状。
 */
export function checkVergeConnections(json: unknown, groupJson: unknown, configuredNode: string): VergeConnections {
  const connections = parseConnections(json).filter((c) => c.inbound === VERGE_LISTENER);
  const now = (groupJson as { now?: unknown } | undefined)?.now;
  const node = typeof now === 'string' && now ? now : undefined;
  const expected = node ?? (configuredNode || undefined);
  const offPath = connections
    .filter((c) => c.chains.length !== 2 || c.chains[1] !== VERGE_GROUP || (expected !== undefined && c.chains[0] !== expected))
    .map((c) => c.id);
  return { connections, node, offPath };
}

/** 读一次连接列表和 CC-VM-FIXED 的当前节点（读不到节点不算失败） */
export async function readVergeConnections(address: string, secret: string | undefined, configuredNode: string): Promise<VergeConnections> {
  const json = await vergeGet(address, secret, '/connections');
  const group = await vergeGet(address, secret, `/proxies/${VERGE_GROUP}`).catch(() => undefined);
  return checkVergeConnections(json, group, configuredNode);
}
