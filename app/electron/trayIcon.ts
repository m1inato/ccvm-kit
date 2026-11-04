// 菜单栏状态点：运行时画出来，不往仓库里放二进制图片（发布检查拒绝二进制源文件）。
import { nativeImage, type NativeImage } from 'electron';
import type { Level } from '../core/types';

export const LEVEL_RGB: Record<Level, [number, number, number]> = {
  ok: [63, 185, 80],
  busy: [92, 140, 204],
  idle: [139, 148, 158],
  error: [248, 81, 73],
};

/** 18×18 pt（2x 位图 36×36）的实心圆点，可选外圈 */
export function dotImage(level: Level, dim = false): NativeImage {
  const size = 36;
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = LEVEL_RGB[level];
  const cx = size / 2;
  const cy = size / 2;
  const radius = 9;
  const ring = 13;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let a = clamp(radius + 0.5 - d); // 实心点，边缘抗锯齿
      // 外圈：细线，让灰点在深色菜单栏里也看得见
      const ringA = clamp(1.2 - Math.abs(d - ring)) * 0.55;
      a = Math.max(a * (dim ? 0.35 : 1), ringA);
      const i = (y * size + x) * 4; // BGRA
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
