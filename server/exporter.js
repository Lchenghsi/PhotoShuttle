import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * 导出器：把选中的素材按 AFC 流式拷到本地目录，最后在资源管理器里定位。
 *
 * - 单个日期的导出落在 `<导出目录>/<YYYY-MM-DD>`；跨日期的选择落在
 *   `<导出目录>/选中_时间戳`。
 * - Live Photo 导出静图时自动带上同名的 .MOV 动态部分。
 * - 每个文件导出后把 mtime 改成拍摄时间，资源管理器按日期排序就是对的。
 */

export class Exporter extends EventEmitter {
  constructor(library) {
    super();
    this.library = library;
    this.running = false;
  }

  async exportItems(ids, exportDir, options = {}) {
    if (this.running) {
      const err = new Error('已有一个导出任务在进行中');
      err.code = 'busy';
      throw err;
    }
    this.running = true;
    const signal = new AbortController().signal;
    try {
      // 组单元：Live Photo 的静图 + 同名 MOV 永远在同一单元里顺序处理。
      const byId = new Map();
      const push = (asset) => {
        if (!asset || byId.has(asset.id)) return;
        byId.set(asset.id, asset);
      };
      for (const id of ids) {
        const asset = this.library.getAsset(id);
        push(asset);
        if (asset?.live) {
          const dot = asset.name.lastIndexOf('.');
          const motionId = asset.folder + '/' + asset.name.slice(0, dot) + '.MOV';
          push(this.library.getAsset(motionId));
        }
      }
      const valid = [...byId.values()];
      if (valid.length === 0) {
        throw new Error('没有可导出的项目（请刷新索引后再试）');
      }

      const used = new Set();
      const units = [];
      for (const asset of valid) {
        if (used.has(asset.id)) continue;
        used.add(asset.id);
        const group = [asset];
        if (asset.live) {
          const dot = asset.name.lastIndexOf('.');
          const motionId = asset.folder + '/' + asset.name.slice(0, dot) + '.MOV';
          const motion = byId.get(motionId);
          if (motion) {
            group.push(motion);
            used.add(motion.id);
          }
        }
        units.push(group);
      }

      const days = new Set(valid.map((a) => a.day).filter(Boolean));
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const subdir = days.size === 1 ? [...days][0] : `选中_${stamp}`;
      const target = path.join(exportDir, subdir);
      fs.mkdirSync(target, { recursive: true });

      const total = valid.length;
      const job = { done: 0, bytes: 0, failed: [], suspicious: [], target };
      this.emit('start', { total, target });

      let firstFile = null;
      let cursor = 0;

      const exportOne = async (asset) => {
        // 'wx' 独占创建：并发 worker 下也不会互相覆盖，撞名自动加序号。
        let dest = null;
        let handle = null;
        for (let i = 0; handle === null; i++) {
          const dot = asset.name.lastIndexOf('.');
          const base = dot === -1 ? asset.name : asset.name.slice(0, dot);
          const ext = dot === -1 ? '' : asset.name.slice(dot);
          const candidate = i === 0 ? path.join(target, asset.name) : path.join(target, `${base} (${i})${ext}`);
          try {
            handle = await fs.promises.open(candidate, 'wx');
            dest = candidate;
          } catch (err) {
            if (err.code !== 'EEXIST') throw err;
          }
        }
        try {
          const got = await this.library.streamFile(asset.id, async (chunk) => {
            await handle.write(chunk);
          });
          await handle.close();
          if (asset.mtime > 0) {
            const when = new Date(asset.mtime);
            await fs.promises.utimes(dest, when, when).catch(() => undefined);
          }
          job.done++;
          job.bytes += got;
          firstFile ||= dest;
          // 字节校验：实际拿到的大小远小于设备标称，基本是 iCloud 占位图。
          if (asset.size >= 500_000 && got < asset.size * 0.6 && asset.size - got > 200_000) {
            job.suspicious.push({ id: asset.id, name: asset.name, expected: asset.size, got });
          }
          this.emit('progress', { done: job.done, total, name: asset.name, bytes: job.bytes });
        } catch (err) {
          await handle.close().catch(() => undefined);
          fs.rmSync(dest, { force: true });
          job.failed.push({ id: asset.id, message: err.message });
          this.emit('progress', { done: job.done, total, name: asset.name + '（失败）', bytes: job.bytes });
        }
      };

      const CONCURRENCY = 4;
      const aborted = () => signal.aborted || options.signal?.aborted;
      const worker = async () => {
        while (!aborted()) {
          const index = cursor++;
          if (index >= units.length) return;
          for (const asset of units[index]) {
            if (aborted()) return;
            await exportOne(asset);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, units.length) }, worker));

      this.emit('done', { target, count: job.done, bytes: job.bytes, failed: job.failed, suspicious: job.suspicious });

      // 在资源管理器中定位导出结果。
      if (firstFile && process.platform === 'win32') {
        try {
          spawn('explorer.exe', ['/select,' + firstFile], { detached: true, stdio: 'ignore' }).unref();
        } catch {
          spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
        }
      }

      return { target, count: job.done, bytes: job.bytes, failed: job.failed, suspicious: job.suspicious };
    } finally {
      this.running = false;
    }
  }
}
