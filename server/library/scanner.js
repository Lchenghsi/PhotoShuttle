import { AfcError } from '../device/afc.js';

/**
 * 相册索引：枚举 /DCIM 下的相机文件夹，再补齐每个文件的体积和拍摄时间。
 *
 * 目录枚举极快（几万条目 < 100ms），stat 是数量级更慢的部分，所以
 * stat 按"从新到旧"进行，近两周模式下扫够近期文件就提前收工。
 */

const DCIM = '/DCIM';
const CAMERA_FOLDER = /^\d{3}[A-Z]+$/;

const PHOTO_EXT = new Set(['JPG', 'JPEG', 'HEIC', 'HEIF', 'PNG', 'GIF', 'WEBP', 'BMP', 'TIFF']);
const VIDEO_EXT = new Set(['MOV', 'MP4', 'M4V', 'AVI']);
const RAW_EXT = new Set(['DNG', 'RAW', 'CR2', 'NEF', 'ARW']);
/** Live Photo 的编辑说明文件，不算素材。 */
const SIDECAR_EXT = new Set(['AAE']);

export function classify(ext) {
  if (PHOTO_EXT.has(ext)) return 'photo';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (RAW_EXT.has(ext)) return 'raw';
  return 'other';
}

function baseName(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toUpperCase();
}

/** Apple 按 DCIM 文件夹、IMG_ 序号递增分配，路径倒序即"从新到旧"。 */
function compareByPath(a, b) {
  if (a.folder !== b.folder) return b.folder.localeCompare(a.folder);
  return b.name.localeCompare(a.name);
}

export function dcimPath(assetId) {
  return DCIM + '/' + assetId;
}

export async function listAssets(session) {
  const started = Date.now();
  const entries = await session.run((afc) => afc.readDirectory(DCIM));
  const folders = entries.filter((e) => CAMERA_FOLDER.test(e)).sort();

  const listings = await session.mapJobs(folders, async (afc, folder) => ({
    folder,
    names: await afc.readDirectory(DCIM + '/' + folder),
  }));

  const assets = [];
  for (const listing of listings) {
    if (!listing) continue;
    const { folder, names } = listing;

    const stillBases = new Set();
    const motionBases = new Set();
    for (const name of names) {
      const ext = extensionOf(name);
      if (PHOTO_EXT.has(ext) || RAW_EXT.has(ext)) stillBases.add(baseName(name));
      else if (VIDEO_EXT.has(ext)) motionBases.add(baseName(name));
    }

    for (const name of names) {
      const ext = extensionOf(name);
      if (SIDECAR_EXT.has(ext)) continue;
      const kind = classify(ext);
      const base = baseName(name);
      assets.push({
        id: folder + '/' + name,
        folder,
        name,
        ext,
        kind,
        live: kind !== 'video' && motionBases.has(base),
        motionPart: kind === 'video' && stillBases.has(base),
        size: 0,
        mtime: 0,
      });
    }
  }

  assets.sort(compareByPath);
  return { assets, folders, listMs: Date.now() - started };
}

/**
 * 批量补齐 size / mtime。
 *
 * stopAfterOld + cutoffMs：从新到旧扫，遇到连续 N 个"老于截止时间"的文件
 * 就停止（近期模式用，避免为了几天的照片 stat 完整个相册）。
 */
export async function sweepMetadata(session, assets, options = {}) {
  const cutoffMs = options.cutoffMs ?? 0;
  const stopAfterOld = options.stopAfterOld ?? 0;
  const pending = assets.filter((a) => a.size === 0 || a.mtime === 0);
  if (pending.length === 0) return { statCount: 0 };

  let consecutiveOld = 0;
  let aborted = false;
  const batch = [];
  let statCount = 0;

  const flush = () => {
    if (batch.length === 0) return;
    options.onBatch?.(batch);
    batch.length = 0;
  };

  await session.mapJobs(
    pending,
    async (afc, asset) => {
      if (aborted) return;
      const info = await afc.stat(dcimPath(asset.id));
      // birthtime 更可靠：原机编辑会改动 mtime。
      const when = info.birthtime || info.mtime;
      asset.size = info.size;
      asset.mtime = when;
      statCount++;
      batch.push({ id: asset.id, size: info.size, mtime: when });

      if (cutoffMs && when > 0) {
        if (when < cutoffMs) {
          consecutiveOld++;
          if (stopAfterOld && consecutiveOld >= stopAfterOld) aborted = true;
        } else {
          consecutiveOld = 0;
        }
      }
      if (batch.length >= 400) flush();
    },
    {
      concurrency: options.concurrency ?? 6,
      onError: options.onError,
    },
  );

  flush();
  return { statCount, aborted };
}

export function cutoffFor(days) {
  return Date.now() - days * 86400_000;
}

/** 本地时区的 YYYY-MM-DD。 */
export function dayString(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function decorate(assets) {
  for (const a of assets) a.day = dayString(a.mtime);
  return assets;
}
