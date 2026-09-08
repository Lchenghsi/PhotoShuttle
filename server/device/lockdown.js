import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { ByteReader, writeAsync } from './netutil.js';
import { buildPlist, parsePlistDict } from './plist.js';
import { connectToDevice, readBuid, readPairRecord } from './usbmux.js';

/**
 * lockdownd —— 设备上的"服务中介"，监听 62078 端口。
 *
 * 流程：usbmux 裸流 → 明文 StartSession → 用配对证书升级 TLS →
 * StartService("com.apple.afc") 拿到端口号 → 再开一条 usbmux 裸流直连该端口。
 */

const LOCKDOWN_PORT = 62078;
const LABEL = 'jiandanchuan';

export class LockdownError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'LockdownError';
    this.kind = kind;
  }
}

function asPem(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'string') return value;
  return '';
}

export function pairRecordDirectory() {
  if (process.platform === 'win32') {
    const base = process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
    return path.join(base, 'Apple', 'Lockdown');
  }
  return '/var/db/lockdown';
}

async function readPairRecordFromDisk(udid) {
  const file = path.join(pairRecordDirectory(), udid + '.plist');
  try {
    return parsePlistDict(await fs.promises.readFile(file));
  } catch {
    return null;
  }
}

export async function loadPairRecord(udid) {
  const fromService = await readPairRecord(udid);
  if (fromService && asPem(fromService.HostCertificate) && asPem(fromService.HostPrivateKey)) {
    return normalizePairRecord(fromService);
  }

  const fromDisk = await readPairRecordFromDisk(udid);
  if (fromDisk && asPem(fromDisk.HostCertificate) && asPem(fromDisk.HostPrivateKey)) {
    return normalizePairRecord(fromDisk);
  }

  throw new LockdownError(
    '这台 iPhone 还没有信任过本电脑。请解锁手机、保持数据线连接，并在手机弹窗中点"信任"。',
    'not-paired',
  );
}

function normalizePairRecord(dict) {
  const record = {
    hostId: String(dict.HostID ?? ''),
    systemBuid: String(dict.SystemBUID ?? ''),
    hostCertificate: asPem(dict.HostCertificate),
    hostPrivateKey: asPem(dict.HostPrivateKey),
  };
  if (!record.hostId || !record.hostCertificate || !record.hostPrivateKey) {
    throw new LockdownError('配对记录不完整，请在手机上重新"信任"一次本电脑。', 'bad-pair-record');
  }
  return record;
}

/** iOS 对 TLS 细节比较挑剔，按顺序尝试几种握手参数。 */
const TLS_VARIANTS = [
  { minVersion: 'TLSv1' },
  { minVersion: 'TLSv1', ciphers: 'ALL:@SECLEVEL=0' },
  {},
];

export class LockdownClient {
  constructor(stream, deviceId, pairRecord) {
    this.stream = stream;
    this.reader = new ByteReader(stream);
    this.deviceId = deviceId;
    this.pairRecord = pairRecord;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  static async create(deviceId, pairRecord) {
    const client = new LockdownClient(await connectToDevice(deviceId, LOCKDOWN_PORT), deviceId, pairRecord);
    try {
      await client.startSession();
      return client;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  async startSession() {
    if (!this.pairRecord.systemBuid) {
      try {
        this.pairRecord.systemBuid = await readBuid();
      } catch {
        this.pairRecord.systemBuid = '';
      }
    }
    const reply = await this.request({
      Request: 'StartSession',
      HostID: this.pairRecord.hostId,
      SystemBUID: this.pairRecord.systemBuid || 'jiandanchuan',
    });
    if (reply.EnableSessionSSL) {
      await this.upgradeTls();
    }
  }

  async upgradeTls() {
    let lastErr;
    for (const options of TLS_VARIANTS) {
      try {
        await this.tlsConnect(options);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new LockdownError('TLS 握手失败：' + (lastErr?.message ?? lastErr), 'tls');
  }

  tlsConnect(options) {
    return new Promise((resolve, reject) => {
      this.reader.dispose();
      this.reader = null;
      const plain = this.stream;
      const tlsSocket = tls.connect({
        socket: plain,
        key: this.pairRecord.hostPrivateKey,
        cert: this.pairRecord.hostCertificate,
        rejectUnauthorized: false,
        ...options,
      });
      const onError = (err) => {
        tlsSocket.destroy();
        plain.destroy();
        reject(err);
      };
      tlsSocket.once('error', onError);
      tlsSocket.once('secureConnect', () => {
        tlsSocket.off('error', onError);
        tlsSocket.setNoDelay(true);
        this.stream = tlsSocket;
        this.reader = new ByteReader(tlsSocket);
        resolve();
      });
    });
  }

  async send(payload) {
    const body = buildPlist({ Label: LABEL, ...payload });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    await writeAsync(this.stream, Buffer.concat([header, body]));
  }

  async receive() {
    const header = await this.reader.read(4);
    const length = header.readUInt32BE(0);
    if (length === 0 || length > 32 * 1024 * 1024) {
      throw new LockdownError('lockdown 帧长度异常: ' + length, 'frame');
    }
    const reply = parsePlistDict(await this.reader.read(length));
    if (reply.Error) {
      throw new LockdownError('lockdown 拒绝请求: ' + String(reply.Error), String(reply.Error));
    }
    return reply;
  }

  async request(payload) {
    // lockdown 没有请求 ID，应答按到达顺序匹配；连接池会并发地
    // 在同一条连接上请求 StartService，必须在这里串行化。
    const run = this.queue.then(() => this.doRequest(payload), () => this.doRequest(payload));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async doRequest(payload) {
    await this.send(payload);
    return this.receive();
  }

  async getValue(domain, key) {
    const req = { Request: 'GetValue' };
    if (domain) req.Domain = domain;
    if (key) req.Key = key;
    const reply = await this.request(req);
    return reply.Value;
  }

  /** 启动设备上的服务，并返回一条直连该服务端口的裸流。 */
  async openServiceStream(serviceName) {
    const reply = await this.request({ Request: 'StartService', Service: serviceName });
    const port = Number(reply.Port ?? reply.PortNumber ?? 0);
    if (!port) {
      throw new LockdownError(
        '启动服务 ' + serviceName + ' 失败' + (reply.Error ? ': ' + reply.Error : ''),
        String(reply.Error ?? 'no-port'),
      );
    }
    return connectToDevice(this.deviceId, port);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.reader?.dispose();
    this.stream?.destroy();
  }
}
