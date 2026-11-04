// 小的纯函数：limactl 输出、Git 地址、Clash 扩展脚本、项目名。
import type { Project, ProjectItem, VmInfo } from './types';

/** `limactl list --json` 每行一个实例 */
export function parseLimaList(output: string, name: string): VmInfo {
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw.name !== name) continue;
    return {
      name,
      status: typeof raw.status === 'string' && raw.status ? raw.status : 'Unknown',
      cpus: typeof raw.cpus === 'number' ? raw.cpus : undefined,
      memoryBytes: typeof raw.memory === 'number' ? raw.memory : undefined,
      diskBytes: typeof raw.disk === 'number' ? raw.disk : undefined,
      arch: typeof raw.arch === 'string' ? raw.arch : undefined,
    };
  }
  return { name, status: 'Missing' };
}

// 与 scripts/workspace.sh、guest/workspace.sh 相同的规则；脚本那边会再校验一次。
const GIT_URL = [
  /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~/-]+$/,
  /^ssh:\/\/git@[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~/-]+$/,
  /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/,
];
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function gitUrlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return '先粘贴一个 Git 地址';
  if (/^https?:\/\/[^/]*@/.test(u)) return '地址里带了账号或令牌。去掉它，凭据请在 VM 的 cc 用户里配置';
  if (!GIT_URL.some((re) => re.test(u))) {
    return '只支持 https://主机/路径、ssh://git@主机/路径 或 git@主机:路径';
  }
  const name = projectNameFromUrl(u);
  if (!name) return '从地址里取不出合法的项目名';
  return null;
}

export function projectNameFromUrl(url: string): string | null {
  let name = url.trim().replace(/\/+$/, '');
  name = name.slice(name.lastIndexOf('/') + 1);
  name = name.slice(name.lastIndexOf(':') + 1);
  name = name.replace(/\.git$/, '');
  return PROJECT_NAME.test(name) ? name : null;
}

export function toProject(item: ProjectItem): Project {
  return {
    name: item.name,
    branch: item.branch,
    dirty: item.dirty,
    ahead: item.ahead,
    behind: item.behind,
    updated: item.updated,
    subject: item.subject,
    remote: item.remote,
    claudeSessions: item.claude_sessions,
    claudeSince: item.claude_since,
  };
}

const PLACEHOLDER = 'const NODE = "REPLACE_WITH_EXACT_NODE_NAME";';
const BUILTIN = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];

/** 用套件里的模板生成填好节点名的扩展脚本（同 clash-verge-script.local.js） */
export function renderClashScript(template: string, node: string): { ok: true; script: string } | { ok: false; error: string } {
  const n = node.trim();
  if (!n) return { ok: false, error: '先填写节点的完整名称（保留 emoji 和空格）' };
  if (n.includes('`')) return { ok: false, error: '节点名包含反引号，mihomo 的 filter 无法精确匹配，请换一个节点' };
  if (BUILTIN.includes(n.toUpperCase())) return { ok: false, error: '不能填内置策略，要填一个具体节点' };
  if (/[\n\r\0]/.test(n)) return { ok: false, error: '节点名不能包含换行' };
  const count = template.split(PLACEHOLDER).length - 1;
  if (count !== 1) return { ok: false, error: '套件里的扩展脚本模板格式不对' };
  return { ok: true, script: template.replace(PLACEHOLDER, `const NODE = ${JSON.stringify(n)};`) };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function isIPv4(value: string | undefined): value is string {
  return !!value && IPV4.test(value);
}
