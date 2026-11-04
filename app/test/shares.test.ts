import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sharePathProblem, sharesFileContent, shareLines } from '../core/shares';
import { isMacPath, vmPathProblem } from '../core/vmpath';
import { KIT } from './fixture';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-shares-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sharePathProblem agrees with lib.sh share_path_problem', () => {
  it('gives the same verdict for every case', () => {
    const home = path.join(root, 'home');
    const state = path.join(root, 'wrap', 'state');
    const lima = path.join(home, '.lima-ccvm');
    for (const d of [path.join(home, '.ssh'), path.join(home, '.config', 'x'), path.join(home, 'projects', 'app'), path.join(home, 'Library', 'Mobile Documents'), state]) {
      fs.mkdirSync(d, { recursive: true });
    }
    fs.symlinkSync(home, path.join(root, 'to-home'));
    fs.symlinkSync(path.join(home, 'projects', 'app'), path.join(root, 'to-app'));
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    const ctx = { home, limaHome: lima, stateDir: state, kitDir: KIT };
    const config = path.join(root, 'local.env');
    fs.writeFileSync(config, '');
    const cases: [string, boolean][] = [
      [home, false],
      [path.join(home, '.ssh'), false],
      [path.join(home, '.config', 'x'), false],
      [path.join(home, 'Library', 'Mobile Documents'), false],
      [root, false],
      [path.join(root, 'wrap'), false],
      [path.dirname(KIT), false],
      [KIT, false],
      ['/', false],
      ['/usr', false],
      ['/tmp', false],
      ['relative/dir', false],
      [path.join(root, 'missing'), false],
      [path.join(root, 'to-home'), false],
      [path.join(root, 'file.txt'), false],
      [path.join(home, 'projects', 'app'), true],
      [path.join(home, 'projects', 'app') + '/', true],
      [path.join(root, 'to-app'), true],
    ];
    for (const [p, ok] of cases) {
      const ts = sharePathProblem(p, ctx);
      const sh = spawnSync('/bin/bash', ['-c', '. "$0"; share_path_problem "$1"', path.join(KIT, 'scripts', 'lib.sh'), p], {
        env: { PATH: '/usr/bin:/bin', HOME: home, CCVM_CONFIG_FILE: config, CCVM_LIMA_HOME: lima, CCVM_STATE_DIR: state },
        encoding: 'utf8',
      });
      expect(sh.status, sh.stderr).toBe(0);
      expect(ts === '', `TS ${p}: ${ts}`).toBe(ok);
      expect(sh.stdout.trim() === '', `bash ${p}: ${sh.stdout}`).toBe(ok);
    }
  });
});

describe('shares.txt and VM paths', () => {
  it('writes the folders only when shares are enabled', () => {
    expect(sharesFileContent({ sharesEnabled: true, sharedFolders: ['/Volumes/a b', '/Volumes/中文'] })).toBe('/Volumes/a b\n/Volumes/中文\n');
    expect(sharesFileContent({ sharesEnabled: false, sharedFolders: ['/Volumes/a'] })).toBe('');
    expect(shareLines('/Volumes/a\r\n\n/Volumes/b\n')).toEqual(['/Volumes/a', '/Volumes/b']);
  });

  it('checks VM paths like files.sh', () => {
    expect(vmPathProblem('/home/cc')).toBe('');
    expect(vmPathProblem('/home/cc/work/my api')).toBe('');
    for (const bad of ['/etc', '/home/cc/../etc', '/home/cc/a\nb', 'home/cc']) expect(vmPathProblem(bad)).not.toBe('');
    expect(isMacPath('/home/cc/mac/app/x')).toBe(true);
    expect(isMacPath('/home/cc/machine')).toBe(false);
  });
});
