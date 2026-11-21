// App 图标：构建时用代码画出来（仓库里不放二进制图片，发布检查会拒绝）。
// 米色圆角底板，中间一个炭黑的等轴立方体（VM），左侧面上一个红色提示符「>_」。
// 和界面里的 Logo（src/components/Icon.tsx）是同一套 100×100 坐标。
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
// 坐标归一到 [0,1]。底板按 macOS 图标网格：四周留白 10%；圆角用超椭圆（n=5），比圆角矩形更接近系统图标
const PLATE = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 };

function inSquircle(x, y) {
  const cx = (PLATE.x0 + PLATE.x1) / 2;
  const cy = (PLATE.y0 + PLATE.y1) / 2;
  const r = (PLATE.x1 - PLATE.x0) / 2;
  return Math.abs((x - cx) / r) ** 5 + Math.abs((y - cy) / r) ** 5 <= 1;
}

/** Logo 的 100×100 坐标 → 图标坐标 */
const P = (u, v) => [PLATE.x0 + (PLATE.x1 - PLATE.x0) * (u / 100), PLATE.y0 + (PLATE.y1 - PLATE.y0) * (v / 100)];
const TOP = [P(50, 47), P(23, 31.4), P(50, 15.8), P(77, 31.4)];
const LEFT = [P(50, 47), P(23, 31.4), P(23, 62.6), P(50, 78.2)];
const RIGHT = [P(50, 47), P(77, 31.4), P(77, 62.6), P(50, 78.2)];
// 左侧面上的「>_」：面坐标 (s,t) → (23 + 27s, 31.4 + 15.6s + 31.2t)
const CHEVRON = [[P(28.94, 44.19), P(35.96, 53.86)], [P(35.96, 53.86), P(28.94, 55.42)]];
const UNDERSCORE = [[P(38.12, 61.35), P(45.14, 65.41)]];
const STROKE = (3.8 / 100) * (PLATE.x1 - PLATE.x0) / 2; // 半宽
const SHADOW = { c: P(50, 84), rx: 0.3 * 0.8, ry: 0.045 * 0.8 };

/** 点在凸多边形里（顶点按顺序给出，方向不限） */
function inConvex(x, y, poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

function segDist(x, y, [[ax, ay], [bx, by]]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));
const RED = [229, 83, 61];

/** 一个采样点的颜色（预乘之前的 RGBA，0–255） */
function sample(x, y) {
  if (!inSquircle(x, y)) return [0, 0, 0, 0];
  // 底板：米色，自上而下 #f6f2ea → #e9e2d4
  const g = (y - PLATE.y0) / (PLATE.y1 - PLATE.y0);
  let c = mix([246, 242, 234], [233, 226, 212], g);
  // 立方体下方的柔和阴影
  const sx = (x - SHADOW.c[0]) / SHADOW.rx;
  const sy = (y - SHADOW.c[1]) / SHADOW.ry;
  const sd = sx * sx + sy * sy;
  if (sd < 1) c = mix(c, [0, 0, 0], 0.1 * (1 - sd));
  if (inConvex(x, y, TOP)) {
    c = mix([79, 82, 93], [64, 67, 77], (y - TOP[2][1]) / (TOP[0][1] - TOP[2][1]));
  } else if (inConvex(x, y, LEFT)) {
    c = mix([48, 50, 58], [40, 42, 49], (y - LEFT[1][1]) / (LEFT[3][1] - LEFT[1][1]));
    const d = Math.min(...CHEVRON.map((s) => segDist(x, y, s)), ...UNDERSCORE.map((s) => segDist(x, y, s)));
    if (d <= STROKE) c = RED;
  } else if (inConvex(x, y, RIGHT)) {
    c = mix([31, 33, 38], [26, 27, 32], (y - RIGHT[1][1]) / (RIGHT[3][1] - RIGHT[1][1]));
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
