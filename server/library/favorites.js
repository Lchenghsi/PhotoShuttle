import fs from 'node:fs';
import path from 'node:path';
import { baseName } from './scanner.js';

/**
 * 收藏标志提取：读取 iOS 相册库 /PhotoData/Photos.sqlite 的 ZASSET.ZFAVORITE，
 * 生成「文件夹/基名」（大写归一）的收藏集合，供索引合并出 ❤ 角标。
 *
 * Photos.sqlite 处于 WAL 模式且 schema 未文档化，全程防御式：
 * - 指纹用主库与 -wal 的 size+mtime（只写 WAL 时主库 mtime 可能不变，必须一起比对）
 * - 指纹命中缓存则零下载；未命中才把库文件拉到本地副本再解，查完即删
 * - 列缺失（iOS 版本漂移）/Node 无 node:sqlite/文件读不动 → 一律降级为空集
 *   （或回退上次缓存），只留日志，绝不影响浏览与导出主流程。
 */

const DB_PATH = '/PhotoData/Photos.sqlite';
const SIDE_SUFFIXES = ['-wal', '-shm'];
const CACHE_VERSION = 2; // 键格式变更时递增，旧缓存自动作废

function normalizeKey(folder, filename) {
  // ZDIRECTORY 形如 "DCIM/106APPLE"（新 iOS 带 DCIM/ 前缀）或 "106APPLE"，统一剥前缀。
  const dir = String(folder).replace(/^DCIM\//i, '');
  return (dir + '/' + baseName(filename)).toUpperCase();
}

/** 流式下载远端文件到本地（1MB 分块，onChunk 背压写盘）。 */
async function downloadTo(afc, remotePath, localPath, expectedSize) {
  const tmp = localPath + '.part';
  const out = fs.createWriteStream(tmp);
  let written = 0;
  let drain = Promise.resolve();
  const total = await afc.streamFile(remotePath, (chunk) => {
    written += chunk.length;
    drain = drain.then(() => new Promise((resolve, reject) => {
      out.write(chunk, (err) => (err ? reject(err) : resolve()));
    }));
    return drain;
  }, { chunkSize: 1024 * 1024 });
  await drain;
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });
  if (expectedSize > 0 && written !== expectedSize) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`下载不完整：${remotePath} 期望 ${expectedSize} 字节，实得 ${written}`);
  }
  fs.renameSync(tmp, localPath);
  return written;
}

async function fingerprint(session, log) {
  const fp = await session.run(async (afc) => {
    const main = await afc.stat(DB_PATH);
    const parts = [main.size, main.mtime];
    for (const suffix of SIDE_SUFFIXES) {
      try {
        const info = await afc.stat(DB_PATH + suffix);
        parts.push(info.size, info.mtime);
      } catch {
        parts.push(0, 0); // 伴生文件不存在是常态（已 checkpoint）
      }
    }
    return parts;
  }).catch((err) => {
    log('无法读取设备相册库（收藏标志不可用）: ' + err.message);
    return null;
  });
  return fp;
}

async function queryFavorites(dbPath, log) {
  // 动态导入：源码运行支持 Node ≥18，node:sqlite 要 Node 22.5+（23.4 起免旗标）。
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    log('当前 Node 版本无内置 node:sqlite，收藏标志不可用（升级到 Node 22+ 可启用）');
    return null;
  }
  // WAL 回放需要可写打开本地副本，readonly 会因热 WAL 直接失败。
  const db = new DatabaseSync(dbPath);
  try {
    const cols = db.prepare('PRAGMA table_info(ZASSET)').all().map((c) => c.name);
    for (const need of ['ZFAVORITE', 'ZDIRECTORY', 'ZFILENAME']) {
      if (!cols.includes(need)) {
        log(`相册库缺列 ${need}（iOS schema 变动），收藏标志降级为不可用`);
        return null;
      }
    }
    const rows = db
      .prepare('SELECT ZDIRECTORY, ZFILENAME FROM ZASSET WHERE ZFAVORITE = 1')
      .all();
    return new Set(
      rows
        .filter((r) => r.ZDIRECTORY && r.ZFILENAME)
        .map((r) => normalizeKey(String(r.ZDIRECTORY), String(r.ZFILENAME))),
    );
  } finally {
    db.close();
  }
}

/**
 * 取指定设备的收藏集合。
 * @returns {Promise<Set<string>>} 「文件夹/基名」大写键集合；失败时返回尽量新的缓存或空集。
 */
export async function loadFavorites(session, dataDir, udid, log = console.log) {
  const dir = path.join(dataDir, 'photolibrary');
  const cacheFile = path.join(dir, `favorites-${udid}.json`);
  const readCache = () => {
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (j.v !== CACHE_VERSION) return null; // 旧格式键作废
      return { fp: j.fp, favs: new Set(j.favs) };
    } catch {
      return null;
    }
  };

  const fp = await fingerprint(session, log);
  if (!fp) return new Set();
  const cached = readCache();
  if (cached && Array.isArray(cached.fp) && cached.fp.every((v, i) => v === fp[i])) {
    return cached.favs;
  }

  fs.mkdirSync(dir, { recursive: true });
  const localDb = path.join(dir, 'Photos.sqlite');
  try {
    await session.run(async (afc) => {
      const main = await afc.stat(DB_PATH);
      const files = [[DB_PATH, main.size]];
      for (const suffix of SIDE_SUFFIXES) {
        try {
          const info = await afc.stat(DB_PATH + suffix);
          if (info.size > 0) files.push([DB_PATH + suffix, info.size]);
        } catch { /* 无伴生文件 */ }
      }
      for (const [remote, size] of files) {
        const local = path.join(dir, path.basename(remote));
        const mb = (size / 1048576).toFixed(1);
        log(`正在读取收藏信息：${path.basename(remote)}（${mb} MB）…`);
        await downloadTo(afc, remote, local, size);
      }
    });
    const favs = await queryFavorites(localDb, log);
    if (favs) {
      try {
        fs.writeFileSync(cacheFile, JSON.stringify({ v: CACHE_VERSION, fp, favs: [...favs] }));
      } catch { /* 缓存写失败不影响本次结果 */ }
      return favs;
    }
    return cached?.favs ?? new Set();
  } catch (err) {
    log('收藏信息读取失败（不影响其他功能）: ' + err.message);
    return cached?.favs ?? new Set();
  } finally {
    // 本地副本只是查询用的临时文件，查完即删，不占磁盘。
    for (const f of [localDb, ...SIDE_SUFFIXES.map((s) => localDb + s), localDb + '.part']) {
      try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
    }
  }
}
