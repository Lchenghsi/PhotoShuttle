// CLI 导出子命令：给 agent / 脚本用的无界面导出。
// 用法：简单传.exe export [--today | --days N | --date YYYY-MM-DD] [--dest DIR] [--kind all|photo|video] [--json]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RealLibrary } from './library.js';
import { Exporter } from './exporter.js';
import { cutoffFor, dayString } from './library/scanner.js';

export async function runExportCli(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const has = (name) => argv.includes(name);
  const json = has('--json');

  let days = 1;
  if (get('--days')) days = Math.min(3650, Math.max(1, Number(get('--days')) || 1));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(get('--date') || '') ? get('--date') : null;
  const kindArg = get('--kind');
  const kind = ['photo', 'video'].includes(kindArg) ? kindArg : 'all';
  const dest = get('--dest');

  const dataDir = process.env.AUTO_PP_DATA || path.join(os.homedir(), '.jiandanchuan');
  fs.mkdirSync(dataDir, { recursive: true });
  let settings = { exportDir: path.join(os.homedir(), 'Pictures', 'iPhone照片导出') };
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) };
  } catch { /* 没有设置文件就用默认值 */ }
  const exportDir = dest || settings.exportDir;

  // CLI 只要日期/类型导出，不需要收藏标志（避免首次连接白下载几百 MB 相册库）。
  const library = new RealLibrary(dataDir, { collectFavorites: false });
  const exporter = new Exporter(library);
  try {
    await library.ensureConnected();
    const { items } = await library.getIndex({ mode: 'all', days: 3650 });

    let picked = items.filter((i) => !i.motionPart && i.size > 0);
    if (date) {
      picked = picked.filter((i) => i.day === date);
    } else if (has('--days')) {
      const cutoff = cutoffFor(days);
      picked = picked.filter((i) => i.mtime >= cutoff);
    } else {
      // 默认 --today：本地时区的"今天"
      const today = dayString(Date.now());
      picked = picked.filter((i) => i.day === today);
    }
    if (kind === 'photo') picked = picked.filter((i) => i.kind === 'photo' || i.kind === 'raw');
    if (kind === 'video') picked = picked.filter((i) => i.kind === 'video');

    if (picked.length === 0) {
      const out = { ok: true, count: 0, bytes: 0, target: exportDir, failed: [], suspicious: [], message: '指定范围内没有可导出的项目' };
      if (json) console.log(JSON.stringify(out));
      else console.log('指定范围内没有可导出的项目');
      return 0;
    }

    const r = await exporter.exportItems(picked.map((i) => i.id), exportDir);
    const out = {
      ok: true,
      count: r.count,
      bytes: r.bytes,
      target: r.target,
      failed: r.failed,
      suspicious: r.suspicious,
    };
    if (json) {
      console.log(JSON.stringify(out));
    } else {
      console.log(`已导出 ${r.count} 个文件（${(r.bytes / 1048576).toFixed(1)} MB）→ ${r.target}`);
      if (r.failed.length) console.log(`失败 ${r.failed.length} 个`);
      if (r.suspicious.length) console.log(`疑似 iCloud 未下载原图 ${r.suspicious.length} 个`);
    }
    return r.failed.length ? 1 : 0;
  } catch (err) {
    const out = { ok: false, error: err.message };
    if (json) console.log(JSON.stringify(out));
    else console.error('导出失败: ' + err.message);
    return 1;
  } finally {
    library.close();
  }
}
