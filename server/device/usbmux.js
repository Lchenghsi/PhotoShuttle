import { ByteReader, writeAsync, connectTcp } from './netutil.js';
import { buildPlist, parsePlistDict } from './plist.js';

/**
 * Apple 的 USB 多路复用器（usbmuxd）客户端。
 *
 * Windows 上它随 Apple Devices 应用 / iTunes 一起安装，监听 127.0.0.1:27015，
 * 负责与手机之间的 USB 通道；我们通过它把一个 TCP 流"接"到设备的任意端口上，
 * 无需自己写 USB 驱动。
 */

const MUX_PORT = 27015;
const MUX_UNIX_SOCKET = '/var/run/usbmuxd';
const PROTOCOL_VERSION = 1;
const MESSAGE_PLIST = 8;
const LABEL = 'jiandanchuan';

export class UsbmuxError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UsbmuxError';
    this.code = code;
  }
}

function describeResult(code) {
  switch (code) {
    case 0: return 'ok';
    case 1: return 'bad command';
    case 2: return 'device not connected';
    case 3: return 'connection refused';
    case 5: return 'bad version';
    default: return 'error ' + code;
  }
}

async function openSocket() {
  try {
    return await connectTcp(
      process.platform === 'win32'
        ? { port: MUX_PORT, host: '127.0.0.1' }
        : { path: MUX_UNIX_SOCKET },
    );
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
      throw new UsbmuxError(
        '无法连接 Apple 移动设备服务。请先安装 "Apple Devices" 应用（微软商店）或 iTunes，并保持其运行。',
        'usbmux-down',
      );
    }
    throw err;
  }
}

export class MuxConnection {
  constructor(socket) {
    this.socket = socket;
    this.reader = new ByteReader(socket);
    this.tag = 0;
  }

  static async open() {
    return new MuxConnection(await openSocket());
  }

  async send(payload) {
    const body = buildPlist({
      ClientVersionString: LABEL,
      ProgName: LABEL,
      kLibUSBMuxVersion: 3,
      ...payload,
    });
    const header = Buffer.alloc(16);
    header.writeUInt32LE(16 + body.length, 0);
    header.writeUInt32LE(PROTOCOL_VERSION, 4);
    header.writeUInt32LE(MESSAGE_PLIST, 8);
    header.writeUInt32LE(++this.tag, 12);
    await writeAsync(this.socket, Buffer.concat([header, body]));
  }

  async receive() {
    if (!this.reader) throw new UsbmuxError('connection was upgraded to a device tunnel');
    const header = await this.reader.read(16);
    const length = header.readUInt32LE(0);
    if (length < 16 || length > 8 * 1024 * 1024) {
      throw new UsbmuxError('malformed usbmux frame (length ' + length + ')');
    }
    return parsePlistDict(await this.reader.read(length - 16));
  }

  async request(payload) {
    await this.send(payload);
    return this.receive();
  }

  /** 让出底层 socket，把它变成直连设备的裸流。 */
  detach() {
    this.reader?.dispose();
    this.reader = null;
    return this.socket;
  }

  close() {
    this.reader?.dispose();
    this.reader = null;
    this.socket.destroy();
  }
}

async function oneShot(payload) {
  const conn = await MuxConnection.open();
  try {
    return await conn.request(payload);
  } finally {
    conn.close();
  }
}

export async function listDevices() {
  const reply = await oneShot({ MessageType: 'ListDevices' });
  const list = Array.isArray(reply.DeviceList) ? reply.DeviceList : [];
  const devices = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const p = entry.Properties;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) continue;
    devices.push({
      deviceId: Number(p.DeviceID ?? entry.DeviceID ?? 0),
      udid: String(p.SerialNumber ?? ''),
      connectionType: p.ConnectionType === 'Network' ? 'Network' : 'USB',
      productId: Number(p.ProductID ?? 0),
    });
  }
  return devices;
}

export async function readBuid() {
  const reply = await oneShot({ MessageType: 'ReadBUID' });
  return String(reply.BUID ?? '');
}

/** 从 usbmuxd 取配对记录；失败返回 null（调用方可以再去磁盘读）。 */
export async function readPairRecord(udid) {
  try {
    const reply = await oneShot({ MessageType: 'ReadPairRecord', PairRecordID: udid });
    const data = reply.PairRecordData;
    if (Buffer.isBuffer(data) && data.length > 0) return parsePlistDict(data);
    return null;
  } catch {
    return null;
  }
}

/**
 * 打开一条到设备 TCP 端口的裸流。
 * usbmuxd wants the port in network byte order inside a host-order integer.
 */
export async function connectToDevice(deviceId, port) {
  const conn = await MuxConnection.open();
  try {
    const swapped = ((port << 8) & 0xff00) | ((port >> 8) & 0x00ff);
    const reply = await conn.request({
      MessageType: 'Connect',
      DeviceID: deviceId,
      PortNumber: swapped,
    });
    const code = Number(reply.Number ?? -1);
    if (code !== 0) {
      throw new UsbmuxError(
        'usbmuxd 拒绝连接设备端口 ' + port + ': ' + describeResult(code),
        code,
      );
    }
    return conn.detach();
  } catch (err) {
    conn.close();
    throw err;
  }
}
