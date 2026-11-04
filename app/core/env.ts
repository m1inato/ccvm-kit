// 调用脚本的环境变量：从零构造，不继承你的终端环境。
// 安全约束第 2 条：不传 HTTP(S)_PROXY / ALL_PROXY / NO_PROXY；用登录 shell 找 limactl 时只取 PATH。
import type { Settings } from './types';

export const PATH_MARK_START = '__CCVM_PATH_START__';
export const PATH_MARK_END = '__CCVM_PATH_END__';

/** 在登录 shell 里执行的命令：只打印 PATH，用标记包起来，避免 rc 文件的输出混进来 */
export const LOGIN_PATH_COMMAND = `printf '%s%s%s' '${PATH_MARK_START}' "$PATH" '${PATH_MARK_END}'`;

const FALLBACK_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** 从登录 shell 的输出里取 PATH；只保留绝对路径，去重，再补上常见位置 */
export function parseLoginPath(output: string | undefined): string {
  let entries: string[] = [];
  if (output) {
    const start = output.lastIndexOf(PATH_MARK_START);
    const end = output.lastIndexOf(PATH_MARK_END);
    if (start >= 0 && end > start) {
      entries = output
        .slice(start + PATH_MARK_START.length, end)
        .split(':')
        .filter((p) => p.startsWith('/') && !/[\n\r\0]/.test(p));
    }
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of [...entries, ...FALLBACK_PATH]) {
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  return result.join(':');
}

export interface EnvInput {
  path: string;
  home: string;
  user: string;
  tmpdir?: string;
  settings: Pick<Settings, 'vmName' | 'limaHome' | 'stateDir'>;
}

/** 脚本的环境。只有这些键，没有任何代理变量。 */
export function scriptEnv(input: EnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.path,
    HOME: input.home,
    USER: input.user,
    LOGNAME: input.user,
    SHELL: '/bin/bash',
    LANG: 'en_US.UTF-8',
    CCVM_NAME: input.settings.vmName,
    CCVM_LIMA_HOME: input.settings.limaHome,
    CCVM_STATE_DIR: input.settings.stateDir,
  };
  if (input.tmpdir) env.TMPDIR = input.tmpdir;
  return env;
}

/** 直接调用 limactl（list）时的环境：同样干净，永远带专用 LIMA_HOME */
export function limaEnv(input: EnvInput): Record<string, string> {
  const env = scriptEnv(input);
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    USER: env.USER,
    LANG: env.LANG,
    LIMA_HOME: input.settings.limaHome,
    ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}),
  };
}

const PROXY_KEYS = /^(https?|all|no|ftp|socks)_proxy$/i;
/** 测试与自检用：环境里有没有代理变量 */
export function hasProxyVariables(env: Record<string, string | undefined>): boolean {
  return Object.keys(env).some((k) => PROXY_KEYS.test(k));
}

const VM_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export function validateSettingsPaths(s: Pick<Settings, 'vmName' | 'limaHome' | 'stateDir'>): string | null {
  if (!VM_NAME.test(s.vmName)) return `无效的 VM 名称：${s.vmName}`;
  if (!s.limaHome.startsWith('/')) return 'Lima 目录必须是绝对路径';
  if (!s.stateDir.startsWith('/')) return '状态目录必须是绝对路径';
  if (/[\n\r\0]/.test(s.limaHome + s.stateDir)) return '路径里不能有换行';
  return null;
}

/** 写进 .command 文件的 shell 单引号字面量 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
