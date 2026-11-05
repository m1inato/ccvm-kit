// electron-builder 的 afterPack：解包 node-pty 时 spawn-helper 可能丢了执行权限，
// 内嵌终端就会报 posix_spawnp failed。这里把 App 包里所有 spawn-helper 补回 0755。
const fs = require('node:fs');
const path = require('node:path');

function walk(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, found);
    else if (entry.name === 'spawn-helper') found.push(p);
  }
  return found;
}

exports.default = async function afterPack(context) {
  const helpers = walk(context.appOutDir, []);
  for (const p of helpers) fs.chmodSync(p, 0o755);
  console.log(`after-pack: spawn-helper ×${helpers.length} → 0755`);
};
