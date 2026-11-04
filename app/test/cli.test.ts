import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appleScriptString, ccvmScript, ghosttyAppleScript, ghosttyErrorText, isGeneratedCcvm, pathHas } from '../core/cli';
import { ccCommandFile, ccvmArgs, writeCcvm } from '../electron/terminal';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-cli-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** 假的套件：scripts/enter.sh 只把参数和环境打印出来 */
function fakeKit(dir: string): string {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'scripts', 'enter.sh'),
    [
      'for a in "$@"; do printf "ARG=%s\\n" "$a"; done',
      'for k in PATH CCVM_NAME CCVM_LIMA_HOME CCVM_STATE_DIR HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do',
      '  if [ -n "${!k+x}" ]; then printf "ENV %s=%s\\n" "$k" "${!k}"; fi',
      'done',
    ].join('\n'),
  );
  return dir;
}

function runCcvm(file: string, args: string[]) {
  const env = {
    PATH: '/usr/bin:/bin',
    HTTP_PROXY: 'http://127.0.0.1:7897',
    https_proxy: 'http://127.0.0.1:7897',
    ALL_PROXY: 'socks5://127.0.0.1:7897',
    no_proxy: '*',
  };
  const r = spawnSync('/bin/bash', [file, ...args], { env, encoding: 'utf8' });
  const out = r.stdout;
  return {
    code: r.status,
    stderr: r.stderr,
    args: out.split('\n').filter((l) => l.startsWith('ARG=')).map((l) => l.slice(4)),
    env: Object.fromEntries(
      out
        .split('\n')
        .filter((l) => l.startsWith('ENV '))
        .map((l) => {
          const [k, ...v] = l.slice(4).split('=');
          return [k, v.join('=')];
        }),
    ),
  };
}

describe('ccvm script', () => {
  const awkward = ["kit with space", '中文目录', "it's quoted", '$HOME `x`'];

  it('passes bash -n and exports exactly the configured values, with awkward paths', () => {
    const base = path.join(root, ...awkward);
    const kit = fakeKit(path.join(base, 'kit'));
    const settings = { vmName: 'ccvm', limaHome: path.join(base, 'lima home'), stateDir: path.join(base, "state 'dir'") };
    const pathEnv = `${path.join(base, 'bin')}:/usr/bin:/bin`;
    const file = path.join(base, 'ccvm');
    const content = ccvmScript(kit, settings, pathEnv);
    expect(content.split('\n')[1]).toBe('# 由 CCVM 生成，会被覆盖。');
    expect(isGeneratedCcvm(content)).toBe(true);
    writeCcvm(file, content);
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    execFileSync('/bin/bash', ['-n', file]);

    const r = runCcvm(file, []);
    expect(r.code, r.stderr).toBe(0);
    expect(r.args).toEqual([]);
    expect(r.env).toEqual({ PATH: pathEnv, CCVM_NAME: 'ccvm', CCVM_LIMA_HOME: settings.limaHome, CCVM_STATE_DIR: settings.stateDir });
  });

  it('maps its arguments onto enter.sh', () => {
    const kit = fakeKit(path.join(root, 'kit'));
    const file = path.join(root, 'ccvm');
    writeCcvm(file, ccvmScript(kit, { vmName: 'ccvm', limaHome: '/Volumes/x/lima', stateDir: '/Volumes/x/state' }, '/usr/bin:/bin'));
    expect(runCcvm(file, ['my-api']).args).toEqual(['--project', 'my-api', '--session', 'auto']);
    expect(runCcvm(file, ['-a', 'my-api-1']).args).toEqual(['--attach', 'my-api-1']);
    expect(runCcvm(file, ['--project', 'p', '--session', 's']).args).toEqual(['--project', 'p', '--session', 's']);
    expect(runCcvm(file, ['-a']).code).toBe(2);
    expect(runCcvm(file, ['a', 'b']).code).toBe(2);
  });

  it('never overwrites a ccvm that CCVM did not generate', () => {
    const file = path.join(root, 'bin', 'ccvm');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '#!/bin/sh\necho mine\n');
    expect(() => writeCcvm(file, ccvmScript('/Volumes/k', { vmName: 'ccvm', limaHome: '/Volumes/l', stateDir: '/Volumes/s' }, '/bin'))).toThrow(/不是 CCVM 生成的/);
    expect(fs.readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('rewrites a generated ccvm when the settings change', () => {
    const file = path.join(root, 'ccvm');
    const a = ccvmScript('/Volumes/k', { vmName: 'ccvm', limaHome: '/Volumes/l', stateDir: '/Volumes/s' }, '/bin');
    const b = ccvmScript('/Volumes/k', { vmName: 'other', limaHome: '/Volumes/l', stateDir: '/Volumes/s' }, '/bin');
    expect(writeCcvm(file, a)).toBe(true);
    expect(writeCcvm(file, a)).toBe(false);
    expect(writeCcvm(file, b)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain("CCVM_NAME='other'");
  });

  it('the .command file only calls ccvm', () => {
    const content = ccCommandFile("/Volumes/a b/it's/ccvm", 'my-api');
    expect(content).not.toMatch(/CCVM_|PROXY|enter\.sh/);
    expect(content).toContain(`exec /bin/bash '/Volumes/a b/it'\\''s/ccvm' 'my-api'`);
    expect(ccvmArgs()).toEqual([]);
    expect(() => ccvmArgs('x;rm -rf ~')).toThrow();
  });

  it('knows whether ~/.local/bin is on PATH', () => {
    expect(pathHas('/usr/bin:/Volumes/h/.local/bin/:/bin', '/Volumes/h/.local/bin')).toBe(true);
    expect(pathHas('/usr/bin:/bin', '/Volumes/h/.local/bin')).toBe(false);
  });
});

describe('Ghostty AppleScript', () => {
  it('escapes backslashes and double quotes', () => {
    expect(appleScriptString('plain')).toBe('"plain"');
    expect(appleScriptString('a "b" \\c\\')).toBe('"a \\"b\\" \\\\c\\\\"');
    expect(appleScriptString('中文 it\'s')).toBe('"中文 it\'s"');
    expect(() => appleScriptString('a\0b')).toThrow();
  });

  it('builds one quoted shell command, escaped once more for AppleScript', () => {
    const script = ghosttyAppleScript('/Volumes/a "b"/it\'s\\ccvm', ['my.api'], '/Volumes/home');
    expect(script).toContain('tell application "Ghostty"');
    expect(script).toContain('set cfg to new surface configuration');
    // shell：'/Volumes/a "b"/it'\''s\ccvm' 'my.api'  →  AppleScript：\ 与 " 再转义
    expect(script).toContain(`set command of cfg to "'/Volumes/a \\"b\\"/it'\\\\''s\\\\ccvm' 'my.api'"`);
    expect(script).toContain('set initial working directory of cfg to "/Volumes/home"');
    expect(script).toContain('new window with configuration cfg');
  });

  it('explains permission and version failures', () => {
    expect(ghosttyErrorText('execution error: Not authorized to send Apple events to Ghostty. (-1743)')).toMatch(/自动化/);
    expect(ghosttyErrorText("syntax error: Expected end of line but found identifier. (-2741)")).toMatch(/1\.3\.0/);
    expect(ghosttyErrorText("Can't get application \"Ghostty\". (-1728)")).toMatch(/没有找到 Ghostty/);
  });
});
