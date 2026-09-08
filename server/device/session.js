import { AfcClient, isConnectionDead } from './afc.js';
import { LockdownClient, loadPairRecord } from './lockdown.js';
import { listDevices } from './usbmux.js';

/**
 * 一台在线设备 = 一个 lockdown 会话 + 一池 AFC 连接。
 *
 * AFC 每条连接同时只允许一个在途请求，速度全部来自并发池：
 * 实测量级（USB 3）：元数据 stat 约 4~6k 条/秒，缩略图约 1k 张/秒。
 */

const POOL_SIZE = 16;

export class DeviceSession {
  constructor(lockdown, info) {
    this.lockdown = lockdown;
    this.info = info;
    this.pool = [];
    this.idle = [];
    this.waiters = [];
    this.opening = 0;
    this.closed = false;
  }

  static async open(preferredUdid) {
    const devices = await listDevices();
    if (devices.length === 0) {
      const err = new Error('未检测到 iPhone。请用数据线连接、解锁手机，并点"信任此电脑"。');
      err.code = 'no-device';
      throw err;
    }
    // 指定了设备就只在候选里找（找不到时报设备已断开）；否则全部候选，USB 优先。
    const pool = preferredUdid ? devices.filter((d) => d.udid === preferredUdid) : devices;
    if (pool.length === 0) {
      const err = new Error('之前连接的设备现在不在线了。');
      err.code = 'device-missing';
      throw err;
    }
    // USB 优先：Wi-Fi 同步通道比数据线慢一个数量级。
    const device = pool.find((d) => d.connectionType === 'USB') ?? pool[0];
    const pairRecord = await loadPairRecord(device.udid);
    const lockdown = await LockdownClient.create(device.deviceId, pairRecord);
    try {
      let name = 'iPhone';
      let iosVersion = '';
      try {
        const values = await lockdown.getValue();
        if (values && typeof values === 'object') {
          name = String(values.DeviceName || name);
          iosVersion = String(values.ProductVersion || '');
        }
      } catch {
        /* 设备信息拿不到不影响主功能 */
      }
      const session = new DeviceSession(lockdown, {
        deviceId: device.deviceId,
        udid: device.udid,
        name,
        iosVersion,
        connectionType: device.connectionType,
      });
      return session;
    } catch (err) {
      lockdown.close();
      throw err;
    }
  }

  async acquire() {
    if (this.closed) throw new Error('设备会话已关闭');
    const ready = this.idle.pop();
    if (ready && !ready.isClosed) return ready;
    if (this.pool.length + this.opening < POOL_SIZE) {
      this.opening++;
      try {
        const stream = await this.lockdown.openServiceStream('com.apple.afc');
        const client = new AfcClient(stream);
        this.pool.push(client);
        return client;
      } finally {
        this.opening--;
      }
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(client) {
    if (client.isClosed) {
      this.pool = this.pool.filter((c) => c !== client);
      return;
    }
    if (this.closed) {
      client.close();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(client);
    else this.idle.push(client);
  }

  /** 在池里跑一个任务。 */
  async run(job) {
    const client = await this.acquire();
    try {
      const result = await job(client);
      this.release(client);
      return result;
    } catch (err) {
      if (client.isClosed || isConnectionDead(err)) client.close();
      this.release(client);
      throw err;
    }
  }

  /**
   * 并发跑完一批任务，返回与输入同序的结果数组。
   * onError 存在时吞掉单项错误（对应结果为 undefined）继续，否则第一个错误直接抛出。
   */
  async mapJobs(items, job, options = {}) {
    if (items.length === 0) return [];
    const results = new Array(items.length);
    const lanes = Math.max(1, Math.min(options.concurrency ?? POOL_SIZE, items.length));
    let cursor = 0;
    let done = 0;
    const worker = async () => {
      const client = await this.acquire();
      try {
        for (;;) {
          if (options.signal?.aborted) return;
          const index = cursor++;
          if (index >= items.length) return;
          try {
            results[index] = await job(client, items[index], index);
          } catch (err) {
            if (client.isClosed || isConnectionDead(err)) {
              client.close();
              throw err; // 连接级故障直接终止整批
            }
            if (!options.onError) throw err;
            options.onError(items[index], index, err);
          }
          done++;
          options.onProgress?.(done, items.length);
        }
      } finally {
        this.release(client);
      }
    };
    await Promise.all(Array.from({ length: lanes }, worker));
    return results;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.pool) client.close();
    for (const client of this.idle) client.close();
    for (const resolve of this.waiters) resolve(this.pool[0] ?? new AfcClientStub());
    this.waiters = [];
    this.lockdown.close();
  }
}

/** 关闭时唤醒等待者用的小占位，后续 acquire/run 会立即失败并清理。 */
class AfcClientStub extends AfcClient {
  constructor() {
    super({ destroy() {}, write() {} });
    this.closed = true;
  }
}
