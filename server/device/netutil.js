import net from 'node:net';

/**
 * Small network helpers shared by the usbmux / lockdown / AFC clients.
 *
 * Every protocol in this stack is length-prefixed and strictly
 * request/response, so a single pending "read exactly N bytes" reader per
 * socket is enough.
 */

export function writeAsync(stream, buf) {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

export function connectTcp(options) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    const onError = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

export class ByteReader {
  constructor(socket) {
    this.socket = socket;
    this.chunks = [];
    this.buffered = 0;
    this.failure = null;
    this.waiter = null;
    this.onData = (chunk) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      this.pump();
    };
    this.onError = (err) => this.fail(err);
    this.onClose = () => this.fail(new Error('connection closed by peer'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('end', this.onClose);
  }

  dispose() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.socket.off('end', this.onClose);
    this.waiter = null;
  }

  read(need) {
    if (need === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      if (this.waiter) {
        reject(new Error('ByteReader: a read is already in flight'));
        return;
      }
      this.waiter = { need, resolve, reject };
      this.pump();
    });
  }

  pump() {
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.buffered >= waiter.need) {
      const merged =
        this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
      const out = merged.subarray(0, waiter.need);
      const rest = merged.subarray(waiter.need);
      this.chunks = rest.length ? [rest] : [];
      this.buffered = rest.length;
      this.waiter = null;
      waiter.resolve(out);
      return;
    }
    if (this.failure) {
      this.waiter = null;
      waiter.reject(this.failure);
    }
  }

  fail(err) {
    this.failure ||= err;
    this.pump();
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(this.failure);
    }
  }
}
