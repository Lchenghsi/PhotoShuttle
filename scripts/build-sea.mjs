#!/usr/bin/env node
/**
 * 打包单文件 exe（Node SEA）：
 *   1. 把 public/ 的 H5 资源生成 server/embedded.gen.js（内嵌进 bundle）
 *   2. esbuild 打成单文件 CJS（dist/sea.cjs）
 *   3. node --sea-config 生成 blob，复制 node.exe，postject 注入 → dist/Auto-PP.exe
 *   4. 连同使用说明压成 release/Auto-PP-win64.zip
 *
 * 运行时零依赖不变；esbuild/postject 仅打包时需要（devDependencies）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

// 1) 生成 PWA 图标（写入 public/icons）+ 多尺寸 ICO（用于 exe 图标）
execSync('node scripts/gen-icons.mjs', { stdio: 'inherit' });
execSync('node scripts/gen-ico.mjs', { stdio: 'inherit' });

// 1.5) HEIC 解码器（可选）：随 exe 内嵌，预览 HEIC 时浏览器按需加载
const heicDist = path.join(ROOT, 'node_modules', 'heic2any', 'dist', 'heic2any.min.js');
if (fs.existsSync(heicDist)) {
  fs.mkdirSync(path.join(ROOT, 'public', 'vendor'), { recursive: true });
  fs.copyFileSync(heicDist, path.join(ROOT, 'public', 'vendor', 'heic2any.min.js'));
  console.log('OK 已内置 HEIC 解码器 public/vendor/heic2any.min.js');
} else {
  console.log('WARN 未找到 heic2any，HEIC 预览将回退为设备缩略图');
}

// 2) 收集 public/ 全部文件作为内嵌资源（文本直存，二进制 base64）
//    sw.js 里的 __BUILD__ 占位替换为构建时间戳：每次打包都换缓存名，
//    用户浏览器/应用窗口才会放弃旧版页面脚本（否则时长角标等新 UI 被 SW 钉死）。
const BUILD_STAMP = Date.now().toString(36);
const MIME_FOR_GEN = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.ico']);
const entries = {};
(function walk(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const key = prefix + '/' + e.name;
    if (e.isDirectory()) {
      walk(full, key);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    const type = MIME_FOR_GEN[ext] || 'application/octet-stream';
    if (BINARY_EXT.has(ext)) {
      entries[key] = { type, b64: fs.readFileSync(full).toString('base64') };
    } else {
      let data = fs.readFileSync(full, 'utf8');
      if (e.name === 'sw.js') data = data.replaceAll('__BUILD__', BUILD_STAMP);
      entries[key] = { type, data };
    }
  }
})(path.join(ROOT, 'public'), '');
fs.writeFileSync(
  path.join(ROOT, 'server', 'embedded.gen.js'),
  '// 由 scripts/build-sea.mjs 自动生成，请勿手改。\nexport default ' + JSON.stringify(entries) + ';\n',
);
console.log('OK 已生成内嵌资源 server/embedded.gen.js（' + Object.keys(entries).length + ' 个文件）');

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
await build({
  entryPoints: [path.join(ROOT, 'server', 'sea-entry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.join(ROOT, 'dist', 'sea.cjs'),
  logLevel: 'info',
});
console.log('✓ esbuild bundle 完成');

fs.writeFileSync(
  path.join(ROOT, 'sea-config.json'),
  JSON.stringify({ main: 'dist/sea.cjs', output: 'dist/sea-prep.blob', disableExperimentalSEAWarning: true }, null, 2),
);
// 注：当前 Node 24.x 需要 --experimental-sea-config 旗标（blob 生成机制相同）
execSync('node --experimental-sea-config sea-config.json', { stdio: 'inherit' });
console.log('✓ SEA blob 已生成');

fs.copyFileSync(process.execPath, path.join(ROOT, 'dist', 'sea-host.exe'));
execSync(
  'npx postject dist/sea-host.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  { stdio: 'inherit' },
);
// 刚写完的 exe 可能被杀软短暂锁定，rename 重试几次。
const exeTmp = path.join(ROOT, 'dist', 'sea-host.exe');
const exeOut = path.join(ROOT, 'dist', '简单传.exe');
for (let i = 0; ; i++) {
  try {
    fs.renameSync(exeTmp, exeOut);
    break;
  } catch (err) {
    if (i >= 5) throw err;
    execSync('timeout /t 1 /nobreak >nul', { stdio: 'ignore', shell: 'cmd.exe' });
  }
}

// 3) 写入自定义图标（手工构建 RT_GROUP_ICON + RT_ICON 资源，纯字节操作）
try {
  const exePath = path.join(ROOT, 'dist', '简单传.exe');
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  // node.exe 自带图标组会抢占默认图标，先清掉 RT_ICON(3) 与 RT_GROUP_ICON(14)。
  res.entries = res.entries.filter((e) => e.type !== 3 && e.type !== 14);

  // 解析我们自己的 .ico 容器（gen-ico.mjs 的布局：头 6B + N×16B 目录 + 连续 PNG）
  const icoPath = path.join(ROOT, 'assets', 'app.ico');
  const icoBin = fs.readFileSync(icoPath);
  const count = icoBin.readUInt16LE(4);
  const images = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const w = icoBin[e] === 0 ? 256 : icoBin[e];
    const h = icoBin[e + 1] === 0 ? 256 : icoBin[e + 1];
    const bytes = icoBin.readUInt32LE(e + 8);
    const off = icoBin.readUInt32LE(e + 12);
    images.push({ w, h, bin: icoBin.subarray(off, off + bytes) });
  }

  // GROUP_ICON 资源（每图 14 字节目录），RT_ICON 的数字 id 从 1 开始
  const group = Buffer.alloc(6 + 14 * images.length);
  group.writeUInt16LE(0, 0);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(images.length, 4);
  let off = 6;
  for (let i = 0; i < images.length; i++) {
    group.writeUInt8(images[i].w >= 256 ? 0 : images[i].w & 0xff, off);
    group.writeUInt8(images[i].h >= 256 ? 0 : images[i].h & 0xff, off + 1);
    group.writeUInt16LE(1, off + 4);  // planes
    group.writeUInt16LE(32, off + 6); // bpp
    group.writeUInt32LE(images[i].bin.length, off + 8);
    group.writeUInt16LE(i + 1, off + 12); // iconID
    off += 14;
    res.entries.push({ type: 3, id: i + 1, lang: 0, bin: images[i].bin });
  }
  res.entries.push({ type: 14, id: 'APPICON', lang: 0, bin: group });

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('OK 已写入图标 dist/简单传.exe');
} catch (err) {
  console.warn('WARN 图标写入失败（不影响功能）: ' + err.message);
}

// 产出发行 zip
fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
const zipTarget = path.join(ROOT, 'release', '简单传-win64.zip');
fs.rmSync(zipTarget, { force: true });
const note = fs.readFileSync(path.join(ROOT, 'release', '使用说明.txt'));
fs.writeFileSync(path.join(ROOT, 'dist', '使用说明.txt'), note);
execSync(
  'powershell -NoProfile -Command "Compress-Archive -Path \'dist/简单传.exe\',\'dist/使用说明.txt\' -DestinationPath \'release/简单传-win64.zip\'"',
  { stdio: 'inherit' },
);
console.log('✓ 发行包 release/简单传-win64.zip 已生成');
