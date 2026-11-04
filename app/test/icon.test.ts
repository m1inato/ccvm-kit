import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const APP = path.resolve(__dirname, '..');
let out: string;

beforeAll(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-icon-'));
  const r = spawnSync(process.execPath, [path.join(APP, 'build', 'make-icon.mjs'), '--out', path.join(out, 'icon.iconset'), '--no-icns'], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
});
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

/** 自己把 PNG 读回来：签名、每个块的校验、IHDR、解压后的像素 */
function readPng(file: string) {
  const buf = fs.readFileSync(file);
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8;
  const chunks: { type: string; data: Buffer }[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    expect(buf.readUInt32BE(off + 8 + len), `${type} 块校验`).toBe(zlib.crc32(buf.subarray(off + 4, off + 8 + len)));
    chunks.push({ type, data });
    off += 12 + len;
  }
  expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  expect([ihdr[8], ihdr[9]]).toEqual([8, 6]); // 8 位 RGBA
  const raw = zlib.inflateSync(chunks[1].data);
  expect(raw.length).toBe(height * (1 + width * 4));
  const px = (x: number, y: number) => raw.subarray(y * (1 + width * 4) + 1 + x * 4, y * (1 + width * 4) + 1 + x * 4 + 4);
  return { width, height, px, filters: Array.from({ length: height }, (_, y) => raw[y * (1 + width * 4)]) };
}

describe('generated app icon', () => {
  const sizes: Record<string, number> = {
    'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64, 'icon_128x128.png': 128,
    'icon_128x128@2x.png': 256, 'icon_256x256.png': 256, 'icon_256x256@2x.png': 512, 'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
  };
  it('writes every iconset file with the right size, and they read back', () => {
    expect(fs.readdirSync(path.join(out, 'icon.iconset')).sort()).toEqual(Object.keys(sizes).sort());
    for (const [name, size] of Object.entries(sizes)) {
      const png = readPng(path.join(out, 'icon.iconset', name));
      expect([png.width, png.height], name).toEqual([size, size]);
      expect(new Set(png.filters)).toEqual(new Set([0]));
      expect(png.px(0, 0)[3], `${name} 角落透明`).toBe(0);
      expect(png.px(size >> 1, Math.round(size * 0.35))[3], `${name} 盾牌不透明`).toBe(255);
    }
  });
  it('draws the shield in the status-dot green on a dark plate', () => {
    const png = readPng(path.join(out, 'icon.iconset', 'icon_512x512.png'));
    const [r, g, b] = png.px(300, 320); // 盾牌右半边
    expect(g).toBeGreaterThan(r + 60);
    expect(g).toBeGreaterThan(b + 60);
    const plate = png.px(80, 256); // 底板
    expect(Math.max(plate[0], plate[1], plate[2])).toBeLessThan(50);
    expect(plate[3]).toBe(255);
  });
});
