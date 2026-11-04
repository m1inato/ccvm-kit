// 命令行入口 ccvm 与 Ghostty 的 AppleScript。只生成文本，不碰文件和进程，便于测试。
// ccvm 是唯一一份「清代理变量 + 设 CCVM_* + 调 enter.sh」的代码：.command 文件和 Ghostty 都调用它。
import path from 'node:path';
import { shQuote } from './env';
import type { Settings } from './types';

/** 生成的文件第二行固定是这句：App 只覆盖带这句的文件，别人的同名脚本不动 */
export const CCVM_MARK = '# 由 CCVM 生成，会被覆盖。';

const UNSET = 'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy';

export function ccvmScript(kitDir: string, settings: Pick<Settings, 'vmName' | 'limaHome' | 'stateDir'>, pathEnv: string): string {
  return [
    '#!/bin/bash',
    CCVM_MARK,
    '# 在任意终端里进入 CCVM 的 VM（先经 enter.sh 检查，检查不过就拒绝）：',
    '#   ccvm              进入 cc 的普通 shell',
    '#   ccvm <项目>        在 ~/work/<项目> 新建一个 tmux 会话（App 的项目页能看到）',
    '#   ccvm -a <会话>     接回已有的 tmux 会话（不做检查）',
    '#   其他以 - 开头的参数原样传给 enter.sh',
    UNSET,
    `export PATH=${shQuote(pathEnv)}`,
    `export CCVM_NAME=${shQuote(settings.vmName)} CCVM_LIMA_HOME=${shQuote(settings.limaHome)} CCVM_STATE_DIR=${shQuote(settings.stateDir)}`,
    'if [ $# -gt 0 ]; then',
    '  case "$1" in',
    '    -a)',
    '      [ $# -eq 2 ] || { echo "用法：ccvm -a <会话>" >&2; exit 2; }',
    '      set -- --attach "$2" ;;',
    '    -*) ;;',
    '    *)',
    '      [ $# -eq 1 ] || { echo "用法：ccvm <项目>" >&2; exit 2; }',
    '      set -- --project "$1" --session auto ;;',
    '  esac',
    'fi',
    `exec /bin/bash ${shQuote(path.join(kitDir, 'scripts', 'enter.sh'))} "$@"`,
    '',
  ].join('\n');
}

/** 文件是不是 App 生成的（只看第二行） */
export function isGeneratedCcvm(content: string): boolean {
  return content.split('\n')[1] === CCVM_MARK;
}

/** PATH 里有没有这个目录（不展开 ~，和 shell 一样按字面比较） */
export function pathHas(pathEnv: string, dir: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  return pathEnv.split(':').some((p) => p && norm(p) === norm(dir));
}

export const PATH_HINT = 'export PATH="$HOME/.local/bin:$PATH"';

/** AppleScript 字符串字面量：只需要转义 \ 和 " */
export function appleScriptString(value: string): string {
  if (/[\0]/.test(value)) throw new Error('AppleScript 字符串里不能有 NUL');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Ghostty（1.3.0 起支持 AppleScript）：新建一个 surface configuration，command 设成 ccvm 加参数，
 * 在家目录新开一个窗口。command 带参数时 Ghostty 用 /bin/sh -c 执行，所以先按 shell 加引号，再按 AppleScript 转义。
 * wait after command：检查不过被拒绝时，窗口留着让你看到原因。
 */
export function ghosttyAppleScript(program: string, args: string[], home: string): string {
  const command = [program, ...args].map(shQuote).join(' ');
  return [
    'tell application "Ghostty"',
    '  set cfg to new surface configuration',
    `  set command of cfg to ${appleScriptString(command)}`,
    `  set initial working directory of cfg to ${appleScriptString(home)}`,
    '  set wait after command of cfg to true',
    '  set win to new window with configuration cfg',
    '  activate',
    'end tell',
  ].join('\n');
}

/** osascript 失败时给人看的话 */
export function ghosttyErrorText(stderr: string): string {
  if (/-1743|not authori[sz]ed|不允许|未获得授权/i.test(stderr)) {
    return '请在 系统设置 → 隐私与安全性 → 自动化 里允许 CCVM 控制 Ghostty，然后再试';
  }
  if (/-1728|-10814|can.t get application|Unable to find application|找不到应用程序/i.test(stderr)) {
    return '没有找到 Ghostty：请先安装 Ghostty（1.3.0 或更新），或者改用 Terminal / iTerm';
  }
  return `Ghostty 没能打开窗口：需要 Ghostty 1.3.0 或更新（支持 AppleScript）。可以升级 Ghostty，或者在任意终端里运行 ccvm。${stderr.trim() ? `（${stderr.trim().split('\n').pop()}）` : ''}`;
}
