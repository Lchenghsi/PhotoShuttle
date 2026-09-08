import { dcimPath } from './scanner.js';

/**
 * 视频时长探测：解析 MP4/MOV 的 moov→mvhd 原子。
 * 只做最多两次小读（头部 128KB，必要时尾部 256KB），避免为时长下载原片。
 * iPhone 录制的 MOV 两种布局都会出现（moov 在头 = 网络优化，在尾 = 普通录制）。
 */

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;

function u32(buf, off) {
  return buf.readUInt32BE(off);
}

/** 在 moov atom（moovStart 指向原子头，含 8 字节）里找 mvhd 并解析时长秒。 */
function parseMvhd(buf, moovStart) {
  let p = moovStart + 8;
  const limit = Math.min(buf.length, moovStart + u32(buf, moovStart));
  while (p + 8 <= limit && p + 8 <= buf.length) {
    const size = u32(buf, p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8) return null; // 非法原子，放弃
    if (type === 'mvhd') {
      const version = buf[p + 8];
      if (version === 1) {
        if (p + 40 > buf.length) return null;
        const timescale = u32(buf, p + 28);
        const duration = Number(buf.readBigUInt64BE(p + 32));
        return timescale > 0 && duration > 0 ? Math.round(duration / timescale) : null;
      }
      if (p + 28 > buf.length) return null;
      const timescale = u32(buf, p + 20);
      const duration = u32(buf, p + 24);
      return timescale > 0 && duration > 0 ? Math.round(duration / timescale) : null;
    }
    p += size;
  }
  return null;
}

function findInHead(buf) {
  let idx = 0;
  while (idx + 8 <= buf.length) {
    const size = u32(buf, idx);
    if (size < 8) return null;
    const type = buf.toString('latin1', idx + 4, idx + 8);
    if (type === 'moov') return parseMvhd(buf, idx);
    idx += size;
  }
  return null;
}

function findInTail(buf, fileSize) {
  let idx = buf.indexOf('moov');
  while (idx !== -1) {
    if (idx >= 4) {
      const size = u32(buf, idx - 4);
      if (size >= 8 && size <= fileSize) {
        const d = parseMvhd(buf, idx - 4);
        if (d > 0) return d;
      }
    }
    idx = buf.indexOf('moov', idx + 4);
  }
  return null;
}

/** 探测视频时长（秒）；解析失败返回 null。调用方需自己缓存结果。 */
export async function probeDuration(afc, asset) {
  const remote = dcimPath(asset.id);
  const head = await afc.readAt(remote, 0, HEAD_BYTES);
  let d = findInHead(head);
  if (d > 0) return d;
  if (asset.size > HEAD_BYTES) {
    const from = Math.max(0, asset.size - TAIL_BYTES);
    const tail = await afc.readAt(remote, from, Math.min(TAIL_BYTES, asset.size - from));
    d = findInTail(tail, asset.size);
    if (d > 0) return d;
  }
  return null;
}
