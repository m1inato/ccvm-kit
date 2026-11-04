// 下载订阅（主进程）。默认直连；打开「经 Clash Verge 下载」时借 127.0.0.1:7897 的 HTTP CONNECT，只用于下载订阅文件。
// 不读任何代理环境变量；只接受 https，跟随最多 3 次跳转（也必须是 https），最大 5 MB。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const MAX = 5 * 1024 * 1024;
const UA = 'clash.meta CCVM';

export interface FetchOptions {
  via?: { host: string; port: number };
  timeoutMs?: number;
  /** 测试用：信任的 CA */
  ca?: string | Buffer;
}

export async function fetchSubscription(url: string, opts: FetchOptions = {}, redirects = 3): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('订阅只能用 https 下载');
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const socket = opts.via ? await connectTunnel(opts.via, u.hostname, Number(u.port || 443), timeoutMs) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout: timeoutMs,
        ca: opts.ca,
        agent: false,
        ...(socket ? { createConnection: () => tls.connect({ socket, servername: u.hostname, ca: opts.ca }) } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('订阅跳转次数太多'));
          const next = new URL(res.headers.location, u).toString();
          return resolve(fetchSubscription(next, opts, redirects - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`订阅服务返回 HTTP ${status}`));
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > MAX) req.destroy(new Error('订阅内容超过 5 MB'));
          else chunks.push(d);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('下载订阅超时')));
    req.on('error', (err) => reject(new Error(`下载订阅失败：${err.message}`)));
    req.end();
  });
}

function connectTunnel(via: { host: string; port: number }, host: string, port: number, timeoutMs: number): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: via.host, port: via.port, method: 'CONNECT', path: `${host}:${port}`, timeout: timeoutMs, agent: false });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`Clash Verge 拒绝了下载（HTTP ${res.statusCode}）`));
      }
    });
    req.on('timeout', () => req.destroy(new Error('连接 Clash Verge 超时')));
    req.on('error', (err) => reject(new Error(`连不上 Clash Verge 的 ${via.host}:${via.port}：${err.message}`)));
    req.end();
  });
}
