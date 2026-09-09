import fs from 'node:fs';
import path from 'node:path';
import { DeviceSession } from './device/session.js';
import { ThumbnailService } from './library/thumbs.js';
import { probeDuration } from './library/duration.js';
import { dcimPath, listAssets, sweepMetadata, cutoffFor, decorate, baseName } from './library/scanner.js';
import { loadFavorites } from './library/favorites.js';

/**
 * 真实设备侧的统一门面：连接管理 + 索引缓存 + 缩略图 + 文件流。
 * index.js 只跟这个接口打交道（mock.js 提供同款接口的模拟实现）。
 */

export class RealLibrary {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.session = null;
    this.thumbs = null;
    this.assets = [];
    this.assetsById = new Map();
    this.scanned = false;
    this.preferredUdid = null;   // 多设备时用户选择的设备
    this.durationFailed = new Set(); // 时长解析失败的素材，本次会话不再重试
    this.favorites = new Set();  // 收藏资产键（「文件夹/基名」大写），由后台任务填充
    this.favoritesJob = null;    // 收藏提取只跑一次；断线换设备后重置
    this.collectFavorites = options.collectFavorites !== false; // CLI 导出等场景可关
    this.onUpdate = null;        // 收藏等后台数据就绪时回调（server 接到 SSE 广播）
    this.status = { state: 'disconnected', device: null, mock: false, error: null };
  }

  async ensureConnected(udid) {
    if (this.session) {
      if (!udid || this.session.info.udid === udid) return;
      // 用户切换了目标设备：关掉旧会话重开，收藏归属随设备作废。
      this.close();
      this.favorites = new Set();
      this.favoritesJob = null;
    }
    if (udid) this.preferredUdid = udid;
    this.status = { state: 'connecting', device: null, mock: false, error: null };
    try {
      this.session = await DeviceSession.open(this.preferredUdid);
      this.thumbs = new ThumbnailService(this.session, path.join(this.dataDir, 'thumbs'));
      this.status = { state: 'connected', device: this.session.info, mock: false, error: null };
    } catch (err) {
      this.session = null;
      this.thumbs = null;
      this.status = {
        state: 'disconnected',
        device: null,
        mock: false,
        error: { code: err.code || 'error', message: err.message },
      };
      throw err;
    }
  }

  handleLost(err) {
    try {
      this.session?.close();
    } catch {
      /* 忽略 */
    }
    this.session = null;
    this.thumbs = null;
    this.scanned = false;
    this.favorites = new Set();
    this.favoritesJob = null;
    this.status = {
      state: 'disconnected',
      device: null,
      mock: false,
      error: { code: err?.code || 'device-lost', message: err?.message || '设备连接已断开' },
    };
  }

  // ---- 索引快照：按设备 udid 存统计结果，重启后免重新扫描 ----

  snapshotPath(udid) {
    return path.join(this.dataDir, `index-${udid}.json`);
  }

  loadSnapshot(udid) {
    try {
      const j = JSON.parse(fs.readFileSync(this.snapshotPath(udid), 'utf8'));
      return Array.isArray(j.assets) ? j : null;
    } catch {
      return null;
    }
  }

  saveSnapshot(udid) {
    try {
      const assets = this.assets.map((a) => ({
        id: a.id,
        size: a.size,
        mtime: a.mtime,
        durationSec: a.durationSec ?? null,
      }));
      fs.writeFileSync(this.snapshotPath(udid), JSON.stringify({ savedAt: Date.now(), assets }));
    } catch {
      /* 快照写失败不影响功能，下次重扫 */
    }
  }

  async ensureIndex() {
    if (this.scanned) return;
    const { assets } = await listAssets(this.session);
    // 命中快照的资产直接恢复统计（size/mtime/时长），未知的交给 sweep。
    const udid = this.session.info.udid;
    const snap = this.loadSnapshot(udid);
    if (snap) {
      const byId = new Map(snap.assets.map((s) => [s.id, s]));
      for (const a of assets) {
        const s = byId.get(a.id);
        if (s && s.size > 0) {
          a.size = s.size;
          a.mtime = s.mtime;
          if (s.durationSec) a.durationSec = s.durationSec;
        }
      }
    }
    this.assets = assets;
    this.assetsById = new Map(assets.map((a) => [a.id, a]));
    this.scanned = true;
    // 收藏提取可能要下载数十 MB 的相册库，放后台跑，不拖慢首屏；
    // 完成后经 onUpdate 通知前端刷新一次即可补上 ❤。
    if (this.collectFavorites && !this.favoritesJob) {
      this.favoritesJob = this.refreshFavorites();
    }
  }

  /** 后台提取收藏集合（Photos.sqlite），失败只留日志，不影响主流程。 */
  async refreshFavorites() {
    try {
      const udid = this.session?.info?.udid;
      if (!udid) return;
      const favs = await loadFavorites(this.session, this.dataDir, udid, (msg) =>
        console.log('[收藏] ' + msg),
      );
      this.favorites = favs;
      console.log(`[收藏] 设备收藏资产 ${favs.size} 项`);
      this.onUpdate?.({ reason: 'favorites', count: favs.size });
    } catch (err) {
      console.log('[收藏] 读取失败（不影响其他功能）: ' + err.message);
    }
  }

  /** 给视频补时长（moov 解析），结果随快照持久化，只算一次。 */
  async collectDurations() {
    const pending = this.assets.filter(
      (a) => a.kind === 'video' && !a.motionPart && a.size > 0 && a.durationSec === undefined && !this.durationFailed.has(a.id),
    );
    if (pending.length === 0) return 0;
    let got = 0;
    await this.session.mapJobs(
      pending,
      async (afc, asset) => {
        const d = await probeDuration(afc, asset);
        if (d > 0) {
          asset.durationSec = d;
          got++;
        } else {
          this.durationFailed.add(asset.id);
        }
      },
      { concurrency: 4, onError: (asset) => this.durationFailed.add(asset.id) },
    );
    return got;
  }

  async getIndex({ mode, days }) {
    const started = Date.now();
    await this.ensureConnected();
    try {
      await this.ensureIndex();
      const cutoff = cutoffFor(days);
      // 近期模式：按从新到旧的顺序 stat，扫到足够老就提前收工。
      const { statCount } = await sweepMetadata(this.session, this.assets, {
        cutoffMs: mode === 'recent' ? cutoff : 0,
        stopAfterOld: mode === 'recent' ? 500 : 0,
        concurrency: 6,
        onError: () => undefined,
      });
      await this.collectDurations();
      decorate(this.assets);
      // 收藏键与素材对上号（静图/视频/RAW 同基名同标）；集合未就绪时全 false。
      for (const a of this.assets) {
        a.favorite = this.favorites.has((a.folder + '/' + baseName(a.name)).toUpperCase());
      }
      if (this.session?.info?.udid) this.saveSnapshot(this.session.info.udid);
      const items =
        mode === 'recent'
          ? this.assets.filter((a) => a.mtime >= cutoff && a.size > 0)
          : this.assets;
      return {
        items: items.map(publicItem),
        total: this.assets.length,
        statCount,
        ms: Date.now() - started,
        device: this.session.info,
        mock: false,
      };
    } catch (err) {
      this.handleLost(err);
      throw err;
    }
  }

  async thumb(assetId) {
    await this.ensureConnected();
    try {
      await this.ensureIndex();
      const asset = this.assetsById.get(assetId);
      if (!asset) return null;
      const data = await this.thumbs.get(asset);
      return data ? { data, contentType: 'image/jpeg' } : null;
    } catch (err) {
      this.handleLost(err);
      throw err;
    }
  }

  async streamFile(assetId, onChunk, options = {}) {
    await this.ensureConnected();
    try {
      return await this.session.run((afc) =>
        afc.streamFile(dcimPath(assetId), onChunk, { chunkSize: 1024 * 1024, signal: options.signal }),
      );
    } catch (err) {
      this.handleLost(err);
      throw err;
    }
  }

  getAsset(assetId) {
    return this.assetsById.get(assetId) ?? null;
  }

  close() {
    this.session?.close();
  }
}

export function publicItem(a) {
  return {
    id: a.id,
    name: a.name,
    ext: a.ext,
    kind: a.kind,
    live: a.live,
    motionPart: a.motionPart,
    size: a.size,
    mtime: a.mtime,
    day: a.day,
    durationSec: a.durationSec ?? null,
    favorite: !!a.favorite,
  };
}
