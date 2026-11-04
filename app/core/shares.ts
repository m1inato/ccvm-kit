// 共享文件夹与 VM 路径的即时提示。和 scripts/lib.sh 的 share_path_problem、files.sh 的路径校验同一套规则，
// 只用来在界面上马上给出原因、避免白白重启 VM；最终结论以脚本为准（share.sh status / apply、files.sh）。
import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from './types';

const SYSTEM_DIRS = new Set([
  '/', '/Users', '/Volumes', '/System', '/Library', '/Applications', '/private', '/etc', '/var', '/usr', '/opt', '/tmp',
  '/private/etc', '/private/var', '/private/tmp',
]);

export interface ShareContext {
  home: string;
  limaHome: string;
  stateDir: string;
  kitDir: string;
}

function realDir(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

function within(a: string, b: string): boolean {
  return a === b || a.startsWith(b.replace(/\/+$/, '') + '/');
}

/** 可以共享返回空字符串，不可以返回原因 */
export function sharePathProblem(p: string, ctx: ShareContext): string {
  if (!p.startsWith('/')) return `不是绝对路径：${p}`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return `路径里有控制字符：${p}`;
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return `不存在：${p}`;
  }
  if (!st.isDirectory()) return `不是文件夹：${p}`;
  const real = realDir(p);
  if (!real) return `进不去这个文件夹：${p}`;
  const home = realDir(ctx.home) ?? ctx.home;
  if (SYSTEM_DIRS.has(real)) return `不能共享系统目录：${real}`;
  if (real === home) return `不能共享整个家目录：${real}`;
  if (real.startsWith(home + '/.')) return `不能共享家目录下的隐藏目录：${real}`;
  const sensitive = [
    ...['Library', '.ssh', '.gnupg', '.aws', '.config', '.kube', '.docker'].map((d) => path.join(home, d)),
    ctx.limaHome,
    ctx.stateDir,
    ctx.kitDir,
  ];
  for (const s of sensitive) {
    const sreal = realDir(s) ?? s.replace(/(.)\/+$/, '$1');
    if (within(real, sreal)) return `在敏感位置里面：${real}（${sreal}）`;
    if (within(sreal, real)) return `包含敏感位置 ${sreal}：${real}`;
  }
  return '';
}

/** 应用时写进 shares.txt 的内容：总开关关着就是空文件 */
export function sharesFileContent(settings: Pick<Settings, 'sharedFolders' | 'sharesEnabled'>): string {
  return settings.sharesEnabled ? settings.sharedFolders.map((p) => p + '\n').join('') : '';
}

/** shares.txt 的有效行（和 lib.sh 的 share_list 一样：去掉 \r 和空行） */
export function shareLines(text: string | undefined): string[] {
  return (text ?? '').replace(/\r/g, '').split('\n').filter((l) => l.length > 0);
}

export { isMacPath, vmPathProblem } from './vmpath';
