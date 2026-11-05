// 把命令行套件复制进 build/kit，供 electron-builder 放进 App 包的 Resources/kit。
// 只复制 Git 已跟踪的文件：本机的 config/local.env、*.local.js、state/ 永远不会进入 App。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(appDir, '..');
const out = path.join(appDir, 'build', 'kit');
const files = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--', 'VERSION', 'scripts', 'guest', 'config'])
  .toString()
  .split('\0')
  .filter(Boolean);
const forbidden = (f) => /(^|\/)local\.env$|\.local\.js$|^state\//.test(f);
fs.rmSync(out, { recursive: true, force: true });
for (const f of files) {
  if (forbidden(f)) throw new Error(`拒绝把本机文件打进 App：${f}`);
  const dest = path.join(out, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(repo, f), dest);
  fs.chmodSync(dest, fs.statSync(path.join(repo, f)).mode & 0o777);
}
// 构建追溯：这个 App 里的套件来自哪个提交、有没有未提交的改动。App 在设置页和验收记录里显示它
const git = (...args) => execFileSync('git', ['-C', repo, ...args]).toString().trim();
const dirty = git('status', '--porcelain', '--untracked-files=no', '--', 'VERSION', 'scripts', 'guest', 'config', 'app') !== '';
fs.writeFileSync(
  path.join(out, 'BUILD'),
  `commit=${git('rev-parse', '--short=12', 'HEAD')}\ndirty=${dirty ? 1 : 0}\nbuilt=${new Date().toISOString()}\n`,
);
console.log(`kit: ${files.length} files → ${path.relative(appDir, out)}${dirty ? '（有未提交的改动）' : ''}`);
