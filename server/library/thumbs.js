import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AfcError } from '../device/afc.js';
import { dcimPath } from './scanner.js';

/**
 * 网格缩略图服务 —— 本项目"快"的核心。
 *
 * iOS 自己就在设备上存好了一张 ~360×480 的 JPEG：
 *
 *   /PhotoData/Thumbnails/V2/DCIM/<文件夹>/<文件名>/5005.JPG
 *
 * 所以网格渲染是一条纯文件读取路径：不解码 HEIC、不下载原片。
 * 视频没有 V2 条目，它的关键帧在并列的 VideoKeyFrames 树里，首次命中后
 * 记住布局，之后不再试探。
 *
 * 缓存三层：内存 LRU（96MB）→ 磁盘（按 id 的 sha1 分桶）→ 设备。
 */

const V2_ROOT = '/PhotoData/Thumbnails/V2/DCIM';
const KEYFRAME_ROOT = '/PhotoData/Thumbnails/VideoKeyFrames/DCIM';
const PREFERRED_VARIANT = '5005.JPG';
const MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;

/** 简易计数信号量：限制缩略图并发，把连接留给元数据扫描之外的窗口。 */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async run(job) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export class ThumbnailService {
  constructor(session, cacheDir) {
    this.session = session;
    this.cacheDir = cacheDir;
    this.memory = new Map();
    this.memoryBytes = 0;
    this.inFlight = new Map();
    this.missing = new Set();
    this.videoLayout = null;
    this.semaphore = new Semaphore(10);
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  diskPath(assetId) {
    const hash = crypto.createHash('sha1').update(assetId).digest('hex');
    return path.join(this.cacheDir, hash.slice(0, 2), hash.slice(2) + '.jpg');
  }

  remember(assetId, data) {
    this.memory.set(assetId, data);
    this.memoryBytes += data.length;
    // Map 保持插入序，最旧的先淘汰。
    while (this.memoryBytes > MEMORY_BUDGET_BYTES) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      this.memoryBytes -= this.memory.get(oldest.value)?.length ?? 0;
      this.memory.delete(oldest.value);
    }
  }

  candidates(asset) {
    const dir = V2_ROOT + '/' + asset.id;
    if (asset.kind !== 'video') {
      return [
        { path: dir + '/' + PREFERRED_VARIANT, layout: 'v2' },
        { path: dir, layout: 'v2-any' },
      ];
    }
    const keyDir = KEYFRAME_ROOT + '/' + asset.id;
    const order =
      this.videoLayout === 'v2'
        ? ['v2', 'key-dir', 'key-file']
        : this.videoLayout === 'key-dir'
          ? ['key-dir', 'key-file', 'v2']
          : this.videoLayout === 'key-file'
            ? ['key-file', 'key-dir', 'v2']
            : ['key-dir', 'key-file', 'v2'];
    return order.map((layout) =>
      layout === 'v2'
        ? { path: dir + '/' + PREFERRED_VARIANT, layout }
        : layout === 'key-dir'
          ? { path: keyDir + '/' + PREFERRED_VARIANT, layout }
          : { path: keyDir, layout },
    );
  }

  noteLayout(layout) {
    if (layout === 'v2') this.videoLayout = 'v2';
    else if (layout === 'key-dir') this.videoLayout = 'key-dir';
    else if (layout === 'key-file') this.videoLayout = 'key-file';
  }

  /** 目录里通常有 1003/3003/5005 等多种尺寸，数字最大的最清晰。 */
  async anyVariant(afc, dir) {
    try {
      const variants = (await afc.readDirectory(dir)).filter((v) => /\.(jpg|jpeg|png)$/i.test(v));
      if (variants.length === 0) return null;
      variants.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
      return await afc.readFile(dir + '/' + variants[0], 512 * 1024);
    } catch {
      return null;
    }
  }

  async fetchFromDevice(asset) {
    const assetDir = (this.videoLayout === 'v2' || asset.kind !== 'video'
      ? V2_ROOT
      : KEYFRAME_ROOT) + '/' + asset.id;
    for (const candidate of this.candidates(asset)) {
      try {
        const data = await this.session.run((afc) => afc.readFile(candidate.path, 512 * 1024));
        this.noteLayout(candidate.layout);
        return data;
      } catch (err) {
        if (err instanceof AfcError && err.notFound) continue;
        throw err;
      }
    }
    // 首选尺寸都缺时，列出目录兜底。
    return this.session.run((afc) => this.anyVariant(afc, assetDir));
  }

  /** 返回 JPEG 字节；设备上确实没有缩略图时返回 null（前端显示占位图）。 */
  async get(asset) {
    if (this.missing.has(asset.id)) return null;

    const cached = this.memory.get(asset.id);
    if (cached) return cached;

    const disk = this.diskPath(asset.id);
    try {
      const data = await fs.promises.readFile(disk);
      if (data.length > 0) {
        this.remember(asset.id, data);
        return data;
      }
    } catch {
      /* 未命中磁盘缓存 */
    }

    let pending = this.inFlight.get(asset.id);
    if (!pending) {
      pending = this.semaphore
        .run(() => this.fetchFromDevice(asset))
        .then((data) => {
          if (!data || data.length === 0) {
            this.missing.add(asset.id);
            return null;
          }
          this.remember(asset.id, data);
          fs.promises
            .mkdir(path.dirname(disk), { recursive: true })
            .then(() => fs.promises.writeFile(disk, data))
            .catch(() => undefined);
          return data;
        })
        .catch((err) => {
          console.warn('thumbnail failed for', asset.id, err.message);
          return null;
        })
        .finally(() => this.inFlight.delete(asset.id));
      this.inFlight.set(asset.id, pending);
    }
    return pending;
  }
}
