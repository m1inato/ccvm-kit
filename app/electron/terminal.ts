// 用外部终端打开 cc（M4 之前没有内嵌终端）。生成一个 .command 文件交给 Terminal / iTerm 运行：
// 它清掉代理变量，只带 CCVM_* 和 PATH，然后执行 enter.sh——检查不过就不进入。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shQuote } from '../core/env';
import { PROJECT_NAME } from '../core/parsers';
import type { Settings } from '../core/types';

const UNSET = 'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy';

export function ccCommandFile(kitDir: string, settings: Settings, pathEnv: string, project?: string): string {
  if (project !== undefined && !PROJECT_NAME.test(project)) throw new Error(`无效的项目名：${project}`);
  const args = project ? ` --project ${shQuote(project)}` : '';
  return [
    '#!/bin/bash',
    '# 由 CCVM 生成：先经 enter.sh 检查，再以 cc 身份进入 VM。可以删除，下次打开会重新生成。',
    UNSET,
    `export PATH=${shQuote(pathEnv)}`,
    `export CCVM_NAME=${shQuote(settings.vmName)} CCVM_LIMA_HOME=${shQuote(settings.limaHome)} CCVM_STATE_DIR=${shQuote(settings.stateDir)}`,
    `printf '\\033]0;%s\\007' ${shQuote(`CCVM · cc${project ? ` · ${project}` : ''}`)}`,
    `exec /bin/bash ${shQuote(path.join(kitDir, 'scripts', 'enter.sh'))}${args}`,
    '',
  ].join('\n');
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
