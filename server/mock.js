import { cutoffFor, dayString } from './library/scanner.js';
import { publicItem } from './library.js';

/**
 * 模拟设备：没有 iPhone 也能开发和预览整套 UI（npm run mock）。
 * 数据确定性生成，覆盖最近 60 天；缩略图输出 SVG，导出生成小体积假文件。
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86400_000;

export class MockLibrary {
  constructor() {
    this.status = { state: 'connected', mock: true, device: null, error: null };
    this.assets = [];
    this.assetsById = new Map();
    this.buildLibrary();
  }

  buildLibrary() {
    const rand = mulberry32(20260905);
    let seq = 10000;
    const now = Date.now();
    for (let daysAgo = 0; daysAgo < 60; daysAgo++) {
      const count = Math.max(3, Math.round(26 * Math.exp(-daysAgo / 12) + rand() * 10));
      for (let i = 0; i < count; i++) {
        seq++;
        const roll = rand();
        const kind = roll < 0.68 ? 'photo' : roll < 0.9 ? 'video' : 'raw';
        const ext = kind === 'photo' ? 'HEIC' : kind === 'video' ? 'MOV' : 'DNG';
        const live = kind === 'photo' && rand() < 0.15;
        const base = `IMG_${String(seq).padStart(4, '0')}`;
        const mtime = now - daysAgo * DAY_MS - Math.floor(rand() * DAY_MS);
        const size =
          kind === 'video'
            ? 40_000_000 + Math.floor(rand() * 300_000_000)
            : kind === 'raw'
              ? 25_000_000 + Math.floor(rand() * 20_000_000)
              : 1_200_000 + Math.floor(rand() * 3_500_000);

        const asset = {
          id: `100APPLE/${base}.${ext}`,
          folder: '100APPLE',
          name: `${base}.${ext}`,
          ext,
          kind,
          live,
          motionPart: false,
          favorite: kind !== 'video' && rand() < 0.08,
          size,
          mtime,
          day: dayString(mtime),
          durationSec: kind === 'video' ? 5 + Math.round(rand() * 295) : null,
        };
        this.assets.push(asset);
        if (live) {
          const motion = {
            id: `100APPLE/${base}.MOV`,
            folder: '100APPLE',
            name: `${base}.MOV`,
            ext: 'MOV',
            kind: 'video',
            live: false,
            motionPart: true,
            size: Math.floor(size * 0.3),
            mtime,
            day: asset.day,
          };
          this.assets.push(motion);
        }
      }
    }
    this.assets.sort((a, b) => b.mtime - a.mtime);
    this.assetsById = new Map(this.assets.map((a) => [a.id, a]));
  }

  async ensureConnected() {
    this.status = {
      state: 'connected',
      mock: true,
      device: { udid: 'MOCK-UDID', name: '模拟 iPhone', iosVersion: '26.0', connectionType: 'USB' },
      error: null,
    };
  }

  async getIndex({ mode, days }) {
    await this.ensureConnected();
    const cutoff = cutoffFor(days);
    const items =
      mode === 'recent' ? this.assets.filter((a) => a.mtime >= cutoff && a.size > 0) : this.assets;
    return {
      items: items.map(publicItem),
      total: this.assets.length,
      statCount: items.length,
      ms: 1,
      device: this.status.device,
      mock: true,
    };
  }

  async thumb(assetId) {
    const asset = this.assetsById.get(assetId);
    if (!asset) return null;
    const daysAgo = Math.round((Date.now() - asset.mtime) / DAY_MS);
    const hue = (parseInt(asset.id.replace(/\D/g, '').slice(-3), 10) * 37) % 360;
    const icon = asset.kind === 'video' ? '▶' : asset.kind === 'raw' ? 'RAW' : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},70%,72%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},65%,45%)"/>
</linearGradient></defs>
<rect width="360" height="480" fill="url(#g)"/>
<text x="24" y="70" font-size="30" fill="rgba(255,255,255,.92)" font-family="sans-serif">-${daysAgo}天</text>
${icon ? `<text x="180" y="270" font-size="84" fill="rgba(255,255,255,.95)" text-anchor="middle" font-family="sans-serif">${icon}</text>` : ''}
</svg>`;
    return { data: Buffer.from(svg, 'utf8'), contentType: 'image/svg+xml' };
  }

  /** 假文件：真实写出很小的一段随机数据（含假头），方便验证导出流程。 */
  async streamFile(assetId, onChunk) {
    const asset = this.assetsById.get(assetId);
    if (!asset) throw new Error('mock: 未找到 ' + assetId);
    const total = Math.min(asset.size, 128 * 1024);
    const chunkSize = 16 * 1024;
    let left = total;
    while (left > 0) {
      const n = Math.min(chunkSize, left);
      onChunk(Buffer.alloc(n, 0x61));
      left -= n;
    }
    return total;
  }

  getAsset(assetId) {
    return this.assetsById.get(assetId) ?? null;
  }

  close() {}
}
