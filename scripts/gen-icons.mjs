#!/usr/bin/env node
/**
 * 生成 PWA 应用图标（public/icons/icon-192.png / icon-512.png）。
 * 纯 JS 实现 PNG 编码（zlib + CRC32），无任何图像库依赖。
 * 图形：圆角蓝底 + 白色相机图形（机身 + 镜头环 + 取景器凸起），3x3 超采样抗锯齿。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'public', 'icons');

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
function lerp(a, b, t) { return a + (b - a) * t; }

function bgColor(x, y, S) {
  // 垂直渐变 #3AA0FF -> #0060DF
  const t = Math.min(1, Math.max(0, y / S));
  return [lerp(0x3a, 0x00, t), lerp(0xa0, 0x60, t), lerp(0xff, 0xdf, t)];
}

function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.max(x0 + r, Math.min(px, x1 - r));
  const cy = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点是否属于相机图形（白色部分） */
function inGlyph(px, py, S) {
  // 机身
  if (inRoundRect(px, py, S * 0.24, S * 0.34, S * 0.76, S * 0.68, S * 0.07)) return true;
  // 取景器凸起
  if (inRoundRect(px, py, S * 0.38, S * 0.27, S * 0.62, S * 0.40, S * 0.04)) return true;
  // 镜头外环
  if (inCircle(px, py, S * 0.5, S * 0.51, S * 0.115)) return true;
  return false;
}

/** 点是否属于镜头内孔（透出背景色） */
function inLensHole(px, py, S) {
  return inCircle(px, py, S * 0.5, S * 0.51, S * 0.062);
}

function inBackground(px, py, S) {
  const m = S * 0.02;
  return inRoundRect(px, py, m, m, S - m, S - m, S * 0.185);
}

function render(S) {
  const rgba = Buffer.alloc(S * S * 4);
  const SS = 3; // 3x3 超采样
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let bgHits = 0, glyphHits = 0, holeHits = 0, total = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          total++;
          if (inBackground(px, py, S)) {
            bgHits++;
            if (inGlyph(px, py, S)) {
              glyphHits++;
              if (inLensHole(px, py, S)) holeHits++;
            }
          }
        }
      }
      const o = (y * S + x) * 4;
      if (bgHits === 0) { rgba[o + 3] = 0; continue; } // 全透明
      const [r, g, b] = bgColor(x + 0.5, y + 0.5, S);
      const alphaBg = bgHits / total;
      let cr, cg, cb, ca;
      if (glyphHits > 0 && holeHits < glyphHits) {
        // 白色图形与镜头孔（透出背景）按覆盖率混合
        const w = (glyphHits - holeHits) / total;
        const hole = holeHits / total;
        cr = Math.round((255 * w + r * hole) / (w + hole));
        cg = Math.round((255 * w + g * hole) / (w + hole));
        cb = Math.round((255 * w + b * hole) / (w + hole));
        ca = Math.round(255 * alphaBg);
      } else {
        cr = r; cg = g; cb = b;
        ca = Math.round(255 * alphaBg);
      }
      rgba[o] = cr; rgba[o + 1] = cg; rgba[o + 2] = cb; rgba[o + 3] = ca;
    }
  }
  return rgba;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 256, 512]) {
  const png = encodePNG(size, render(size));
  const out = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`OK ${out} (${png.length} bytes)`);
}
