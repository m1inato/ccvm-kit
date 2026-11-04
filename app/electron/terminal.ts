// 用外部终端打开 cc。环境设置只在 ccvm 脚本里（core/cli.ts）：
// Terminal / iTerm 运行一个只调用 ccvm 的 .command 文件，Ghostty 经 AppleScript 直接运行 ccvm。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { ghosttyAppleScript, ghosttyErrorText, isGeneratedCcvm } from '../core/cli';
import { shQuote } from '../core/env';
import { PROJECT_NAME } from '../core/parsers';
import type { Settings } from '../core/types';

const UNSET = 'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy';

/** ccvm 的参数：没有项目时进普通 shell，有项目时新建 tmux 会话 */
export function ccvmArgs(project?: string): string[] {
  if (project !== undefined && !PROJECT_NAME.test(project)) throw new Error(`无效的项目名：${project}`);
  return project ? [project] : [];
}

export function ccCommandFile(ccvmPath: string, project?: string): string {
  const args = ccvmArgs(project);
  return [
    '#!/bin/bash',
    '# 由 CCVM 生成：经 ccvm 入口先检查、再以 cc 身份进入 VM。可以删除，下次打开会重新生成。',
    `printf '\\033]0;%s\\007' ${shQuote(`CCVM · cc${project ? ` · ${project}` : ''}`)}`,
    `exec /bin/bash ${[ccvmPath, ...args].map(shQuote).join(' ')}`,
    '',
  ].join('\n');
}

/**
 * 写 ccvm 脚本：内容没变就不写；目标已存在但不是 CCVM 生成的（第二行不是标记）就拒绝，不覆盖别人的文件。
 * 返回是否写了。
 */
export function writeCcvm(file: string, content: string): boolean {
  let old: string | undefined;
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    old = undefined;
  }
  if (old !== undefined && !isGeneratedCcvm(old)) throw new Error(`${file} 已存在，而且不是 CCVM 生成的，不覆盖`);
  if (old === content) {
    fs.chmodSync(file, 0o755);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file + '.tmp', content, { mode: 0o755 });
  fs.chmodSync(file + '.tmp', 0o755);
  fs.renameSync(file + '.tmp', file);
  return true;
}

/** Ghostty 1.3.0 起支持 AppleScript；第一次会弹「自动化」权限请求，osascript 会等你点完 */
export function openGhostty(ccvmPath: string, args: string[], home: string): Promise<void> {
  const script = ghosttyAppleScript(ccvmPath, args, home);
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { env: { PATH: '/usr/bin:/bin' }, timeout: 120_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
      reject(new Error(timedOut ? '等待太久：如果弹出了「自动化」权限请求，请允许 CCVM 控制 Ghostty 后再试' : ghosttyErrorText(String(stderr || err.message))));
    });
  });
}

export function adminCommandFile(settings: Settings, pathEnv: string): string {
  return [
    '#!/bin/bash',
    '# 由 CCVM 生成：VM 管理员 shell（有 sudo），只用于系统维护。',
    UNSET,
    `export PATH=${shQuote(pathEnv)}`,
    `export LIMA_HOME=${shQuote(settings.limaHome)}`,
    `printf '\\033]0;%s\\007' 'CCVM 管理员 shell · 不要在这里运行 Claude'`,
    `printf '\\033[1;31m%s\\033[0m\\n' '管理员 shell（有 sudo）：只用于系统维护。不要在这里运行 Claude。'`,
    `exec limactl shell --workdir=/ ${shQuote(settings.vmName)}`,
    '',
  ].join('\n');
}

export function openCommandFile(runDir: string, name: string, content: string, app: 'Terminal' | 'iTerm'): void {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = path.join(runDir, name);
  fs.writeFileSync(file, content, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  const child = spawn('/usr/bin/open', ['-a', app, file], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
  child.unref();
}
