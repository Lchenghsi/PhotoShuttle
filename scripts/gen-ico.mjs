#!/usr/bin/env node
/** 把 public/icons 下的 PNG 打包成多尺寸 Windows 图标 assets/简单传.ico。
 *  ICO 容器支持内嵌 PNG（Vista+），无需转 BMP。纯 JS，无依赖。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'assets', 'app.ico');
const SIZES = [192, 256, 512];

const images = SIZES.map((size) => {
  const p = path.join(ROOT, 'public', 'icons', `icon-${size}.png`);
  return { size, data: fs.readFileSync(p) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const entries = [];
const blobs = [];
let offset = 6 + 16 * images.length;
for (const { size, data } of images) {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size; // 宽（256 写 0）
  e[1] = size >= 256 ? 0 : size; // 高
  e.writeUInt16LE(1, 4);          // planes
  e.writeUInt16LE(32, 6);         // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  blobs.push(data);
  offset += data.length;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...blobs]));
console.log('OK ' + OUT + ` (${images.length} 个尺寸, ${images.reduce((n, i) => n + i.data.length, 0)} 字节)`);
