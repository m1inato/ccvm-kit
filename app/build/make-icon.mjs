// App 图标：构建时用代码画出来（仓库里不放二进制图片，发布检查会拒绝）。
// 深色圆角方块，中间一面盾牌，颜色和菜单栏的「受保护」状态点一致。
// 输出 build/icon.iconset/*.png；macOS 上再用 iconutil 转成 build/icon.icns，没有 iconutil 时只生成 PNG。
// PNG 编码只用 Node 自带的 zlib：deflate 压缩，加上 PNG 格式本身规定的 CRC32 块校验。
// 用法：node build/make-icon.mjs [--out 目录] [--no-icns]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// iconutil 要求的文件名与像素尺寸
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

// ---------------------------------------------------------------- PNG
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** PNG 块校验（格式规定的 CRC32）。Node 22.2+ 自带 zlib.crc32，老版本用查表 */
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA（每像素 4 字节，非预乘）→ PNG */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // 每行的过滤方式：不过滤
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 画图
// 坐标归一到 [0,1]。底板按 macOS 图标网格：四周留白约 10%，圆角约为边长的 22%
const PLATE = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9, r: 0.18 };

function inRoundRect(x, y, { x0, y0, x1, y1, r }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 盾牌：上沿略带弧度，两侧竖直，下半部收成圆润的尖。scale 用来画内层高光 */
function inShield(x, y, scale = 1) {
  const cx = 0.5;
  const top = 0.27;
  const mid = 0.52;
  const bottom = 0.8;
  const w = 0.215;
  const u = (x - cx) / scale;
  const v = (y - (top + bottom) / 2) / scale + (top + bottom) / 2;
  const half = w;
  if (Math.abs(u) > half) return false;
  const topEdge = top + 0.035 * (u / half) ** 2 - 0.012; // 两角略低、中间略高
  if (v < topEdge) return false;
  if (v <= mid) return true;
  if (v > bottom) return false;
  const t = (v - mid) / (bottom - mid);
  return Math.abs(u) <= half * Math.sqrt(1 - t * t) * (1 - 0.25 * t);
}

const OK = [63, 185, 80]; // 菜单栏「受保护」状态点的颜色（electron/trayIcon.ts）
const lerp = (a, b, t) => a + (b - a) * t;

/** 一个采样点的颜色（预乘之前的 RGBA，0–255） */
function sample(x, y) {
  if (!inRoundRect(x, y, PLATE)) return [0, 0, 0, 0];
  // 底板：自上而下 #1b222c → #0d1117
  const g = (y - PLATE.y0) / (PLATE.y1 - PLATE.y0);
  let c = [lerp(27, 13, g), lerp(34, 17, g), lerp(44, 23, g)];
  if (inShield(x, y)) {
    // 盾牌：状态点的绿，上亮下暗；左半边加一点高光
    const s = (y - 0.27) / 0.53;
    c = [lerp(OK[0] + 18, OK[0] - 20, s), lerp(OK[1] + 18, OK[1] - 25, s), lerp(OK[2] + 12, OK[2] - 15, s)];
    if (x < 0.5 && inShield(x, y, 0.82)) c = c.map((v) => Math.min(255, v + 14));
    // 盾牌中间一个深色圆点：「受保护」的那个点
    if ((x - 0.5) ** 2 + (y - 0.47) ** 2 <= 0.062 ** 2) c = [13, 17, 23];
  }
  return [c[0], c[1], c[2], 255];
}

/** 画一张 size×size 的图：每个像素 n×n 次采样抗锯齿 */
export function drawIcon(size) {
  const n = size <= 64 ? 6 : size <= 256 ? 4 : 3;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const [cr, cg, cb, ca] = sample((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round(a / (n * n));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 命令行
function main(argv) {
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(HERE, 'icon.iconset');
  fs.mkdirSync(outDir, { recursive: true });
  const cache = new Map();
  for (const [name, size] of ICONSET) {
    if (!cache.has(size)) cache.set(size, encodePng(size, size, drawIcon(size)));
    fs.writeFileSync(path.join(outDir, name), cache.get(size));
  }
  console.log(`icon: ${ICONSET.length} 张 PNG → ${outDir}`);
  if (argv.includes('--no-icns')) return;
  const icns = path.join(path.dirname(outDir), 'icon.icns');
  const probe = spawnSync('iconutil', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    console.log('icon: 没有 iconutil（不是 macOS），跳过 .icns');
    return;
  }
  const r = spawnSync('iconutil', ['-c', 'icns', outDir, '-o', icns], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`iconutil 转换失败（退出码 ${r.status}）`);
  console.log(`icon: ${icns}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
