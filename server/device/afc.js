import { ByteReader, writeAsync } from './netutil.js';

/**
 * AFC — Apple File Conduit。
 *
 * 一个简单的二进制请求/应答协议，暴露设备的媒体分区（根目录是
 * /var/mobile/Media，所以 DCIM、PhotoData 都在顶层）。
 * 每条连接同时只能有一个在途请求，速度靠多条连接并发——见 session.js 的连接池。
 */

const MAGIC = Buffer.from('CFA6LPAA', 'ascii');
const HEADER_SIZE = 40;

export const AfcOp = {
  Status: 1,
  Data: 2,
  ReadDir: 3,
  RemovePath: 8,
  MakeDir: 9,
  GetFileInfo: 10,
  GetDeviceInfo: 11,
  FileOpen: 13,
  FileOpenResult: 14,
  FileRead: 15,
  FileWrite: 16,
  FileSeek: 17,
  FileClose: 20,
};

export const AfcMode = {
  ReadOnly: 1,
  ReadWrite: 2,
  WriteOnly: 3,
};

const AFC_ERRORS = {
  1: '未知错误',
  2: '无效包头',
  3: '资源不足',
  4: '读错误',
  5: '写错误',
  6: '未知包类型',
  7: '无效参数',
  8: '文件或目录不存在',
  9: '是一个目录',
  10: '没有权限',
  11: '服务未连接',
  12: '超时',
  13: '数据过多',
  14: '数据结束',
  15: '操作不支持',
  16: '已存在',
  17: '忙',
  18: '设备空间不足',
  19: '会阻塞',
  20: 'I/O 错误',
  21: '被中断',
  22: '进行中',
  23: '内部错误',
};

export class AfcError extends Error {
  constructor(code, operation, path) {
    super('AFC ' + operation + (path ? ' (' + path + ')' : '') + ': ' + (AFC_ERRORS[code] ?? 'error ' + code));
    this.name = 'AfcError';
    this.code = code;
  }

  get notFound() {
    return this.code === 8;
  }
}

export function isConnectionDead(err) {
  return (
    err instanceof AfcError === false &&
    (err?.code === 'EPIPE' ||
      err?.code === 'ECONNRESET' ||
      err?.code === 'ECONNABORTED' ||
      err?.message?.includes('out of sync') ||
      err?.message?.includes('connection closed'))
  );
}

export class AfcClient {
  constructor(stream) {
    this.stream = stream;
    this.reader = new ByteReader(stream);
    this.packetNumber = 0;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  get isClosed() {
    return this.closed;
  }

  /** AFC 没有请求 ID，应答按顺序匹配，必须串行化。 */
  enqueue(job) {
    const run = this.queue.then(job, job);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async exchange(operation, header, body) {
    if (this.closed) throw new Error('AFC 连接已关闭');

    const thisLength = HEADER_SIZE + header.length;
    const entireLength = thisLength + (body?.length ?? 0);

    const packet = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(packet, 0);
    packet.writeBigUInt64LE(BigInt(entireLength), 8);
    packet.writeBigUInt64LE(BigInt(thisLength), 16);
    packet.writeBigUInt64LE(BigInt(++this.packetNumber), 24);
    packet.writeBigUInt64LE(BigInt(operation), 32);

    const parts = body ? [packet, header, body] : [packet, header];
    await writeAsync(this.stream, Buffer.concat(parts));

    const replyHeader = await this.reader.read(HEADER_SIZE);
    if (!replyHeader.subarray(0, 8).equals(MAGIC)) {
      this.closed = true;
      throw new Error('AFC: 应答包头错误 —— 连接已失步');
    }
    const replyEntire = Number(replyHeader.readBigUInt64LE(8));
    const replyOp = Number(replyHeader.readBigUInt64LE(32));
    const payloadLength = replyEntire - HEADER_SIZE;
    if (payloadLength < 0 || payloadLength > 512 * 1024 * 1024) {
      this.closed = true;
      throw new Error('AFC: 应答长度异常 ' + payloadLength);
    }
    const payload = payloadLength > 0 ? await this.reader.read(payloadLength) : Buffer.alloc(0);
    return { operation: replyOp, payload };
  }

  /** 执行一个操作；设备应答 Status 时校验错误码。 */
  async call(operation, header, label, subject, body) {
    const reply = await this.exchange(operation, header, body);
    if (reply.operation === AfcOp.Status) {
      const code = reply.payload.length >= 8 ? Number(reply.payload.readBigUInt64LE(0)) : 1;
      if (code !== 0) throw new AfcError(code, label, subject);
      return Buffer.alloc(0);
    }
    return reply.payload;
  }

  static pathHeader(remotePath) {
    return Buffer.concat([Buffer.from(remotePath, 'utf8'), Buffer.from([0])]);
  }

  readDirectory(remotePath) {
    return this.enqueue(async () => {
      const payload = await this.call(
        AfcOp.ReadDir,
        AfcClient.pathHeader(remotePath),
        'read directory',
        remotePath,
      );
      const out = [];
      let start = 0;
      for (let i = 0; i <= payload.length; i++) {
        if (i === payload.length || payload[i] === 0) {
          if (i > start) out.push(payload.toString('utf8', start, i));
          start = i + 1;
        }
      }
      return out.filter((name) => name !== '.' && name !== '..');
    });
  }

  stat(remotePath) {
    return this.enqueue(async () => {
      const payload = await this.call(
        AfcOp.GetFileInfo,
        AfcClient.pathHeader(remotePath),
        'stat',
        remotePath,
      );
      const entries = [];
      let start = 0;
      for (let i = 0; i <= payload.length; i++) {
        if (i === payload.length || payload[i] === 0) {
          if (i > start) entries.push(payload.toString('utf8', start, i));
          start = i + 1;
        }
      }
      const info = new Map();
      for (let i = 0; i + 1 < entries.length; i += 2) info.set(entries[i], entries[i + 1]);
      const kind = info.get('st_ifmt') ?? '';
      const nanosToMillis = (v) => {
        if (!v) return 0;
        const n = Number(v);
        return Number.isFinite(n) ? Math.round(n / 1e6) : 0;
      };
      return {
        size: Number(info.get('st_size') ?? 0),
        isDirectory: kind === 'S_IFDIR',
        isSymlink: kind === 'S_IFLNK',
        mtime: nanosToMillis(info.get('st_mtime')),
        birthtime: nanosToMillis(info.get('st_birthtime')),
      };
    });
  }

  async openHandle(remotePath, mode) {
    const header = Buffer.alloc(8);
    header.writeBigUInt64LE(BigInt(mode), 0);
    const payload = await this.call(
      AfcOp.FileOpen,
      Buffer.concat([header, AfcClient.pathHeader(remotePath)]),
      'open',
      remotePath,
    );
    if (payload.length < 8) throw new Error('AFC: open 未返回句柄 ' + remotePath);
    return payload.readBigUInt64LE(0);
  }

  async closeHandle(handle) {
    const header = Buffer.alloc(8);
    header.writeBigUInt64LE(handle, 0);
    await this.call(AfcOp.FileClose, header, 'close').catch(() => undefined);
  }

  async seekHandle(handle, offset) {
    const header = Buffer.alloc(24);
    header.writeBigUInt64LE(handle, 0);
    header.writeBigUInt64LE(0n, 8); // whence: SEEK_SET
    header.writeBigInt64LE(BigInt(Math.round(offset)), 16);
    await this.call(AfcOp.FileSeek, header, 'seek');
  }

  async readChunk(handle, length) {
    const header = Buffer.alloc(16);
    header.writeBigUInt64LE(handle, 0);
    header.writeBigUInt64LE(BigInt(length), 8);
    const reply = await this.exchange(AfcOp.FileRead, header);
    if (reply.operation === AfcOp.Status) {
      const code = reply.payload.length >= 8 ? Number(reply.payload.readBigUInt64LE(0)) : 1;
      if (code === 0 || code === 14) return Buffer.alloc(0); // 成功但无数据 / EOF
      throw new AfcError(code, 'read');
    }
    return reply.payload;
  }

  /** 读整个文件进内存；适合缩略图。 */
  readFile(remotePath, chunkSize = 256 * 1024) {
    return this.enqueue(async () => {
      const handle = await this.openHandle(remotePath, AfcMode.ReadOnly);
      try {
        const parts = [];
        let total = 0;
        for (;;) {
          const chunk = await this.readChunk(handle, chunkSize);
          if (chunk.length === 0) break;
          parts.push(chunk);
          total += chunk.length;
          if (chunk.length < chunkSize) break;
        }
        return Buffer.concat(parts, total);
      } finally {
        await this.closeHandle(handle);
      }
    });
  }

  /** 随机读一段：打开→定位→读→关闭，整体串行。 */
  readAt(remotePath, offset, length) {
    return this.enqueue(async () => {
      const handle = await this.openHandle(remotePath, AfcMode.ReadOnly);
      try {
        await this.seekHandle(handle, offset);
        const parts = [];
        let got = 0;
        while (got < length) {
          const chunk = await this.readChunk(handle, length - got);
          if (chunk.length === 0) break;
          parts.push(chunk);
          got += chunk.length;
        }
        return Buffer.concat(parts, got);
      } finally {
        await this.closeHandle(handle);
      }
    });
  }

  /** 分块流式读出文件；onChunk 返回 Promise 以形成背压。 */
  streamFile(remotePath, onChunk, options = {}) {
    const chunkSize = options.chunkSize ?? 1024 * 1024;
    return this.enqueue(async () => {
      const handle = await this.openHandle(remotePath, AfcMode.ReadOnly);
      let total = 0;
      try {
        for (;;) {
          if (options.signal?.aborted) throw new Error('已取消');
          const chunk = await this.readChunk(handle, chunkSize);
          if (chunk.length === 0) break;
          total += chunk.length;
          await onChunk(chunk);
          if (chunk.length < chunkSize) break;
        }
        return total;
      } finally {
        await this.closeHandle(handle);
      }
    });
  }

  close() {
    this.closed = true;
    this.reader?.dispose();
    this.stream?.destroy();
  }
}
