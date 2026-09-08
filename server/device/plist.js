/**
 * Minimal Apple binary plist ("bplist00") encoder/decoder.
 *
 * Covers the value types that appear in usbmuxd / lockdown / pairing-record
 * traffic: dict, array, string, integer, real, date, data, boolean, null.
 */

const EPOCH_2001_MS = 978307200000;

// ---------------------------------------------------------------- encode ---

// 长度 ≥ 0xF 时：低半字节置 0xF，后跟一个完整的 int 对象表示长度。
function encodeLength(markerHi, len) {
  if (len < 0x0f) return Buffer.from([markerHi | len]);
  const big = BigInt(len);
  const size = big < 0x100n ? 1 : big < 0x10000n ? 2 : big < 0x100000000n ? 4 : 8;
  const head = Buffer.from([markerHi | 0x0f, 0x10 | { 1: 0, 2: 1, 4: 2, 8: 3 }[size]]);
  const body = Buffer.alloc(size);
  writeBE(body, big, size);
  return Buffer.concat([head, body]);
}

function writeBE(buf, value, size) {
  let v = BigInt(value);
  for (let i = size - 1; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function encodeInt(value) {
  const v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const norm = BigInt.asUintN(64, v);
  let size = 1;
  if (norm >= 0x100n) size = 2;
  if (norm >= 0x10000n) size = 4;
  if (norm >= 0x100000000n) size = 8;
  const buf = Buffer.alloc(1 + size);
  buf[0] = 0x10 | { 1: 0, 2: 1, 4: 2, 8: 3 }[size];
  writeBE(buf.subarray(1), norm, size);
  return buf;
}

function encodeObject(value, refOf) {
  if (value === null || value === undefined) return Buffer.from([0x00]);
  if (value === false) return Buffer.from([0x08]);
  if (value === true) return Buffer.from([0x09]);
  if (typeof value === 'number' || typeof value === 'bigint') {
    if (!Number.isFinite(value) || Number.isInteger(value) || typeof value === 'bigint') {
      return encodeInt(value);
    }
    const buf = Buffer.alloc(9);
    buf[0] = 0x23;
    buf.writeDoubleBE(value, 1);
    return buf;
  }
  if (value instanceof Date) {
    const buf = Buffer.alloc(9);
    buf[0] = 0x33;
    buf.writeDoubleBE((value.getTime() - EPOCH_2001_MS) / 1000, 1);
    return buf;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([encodeLength(0x40, data.length), data]);
  }
  if (typeof value === 'string') {
    if (/^[\x00-\x7f]*$/.test(value)) {
      return Buffer.concat([
        encodeLength(0x50, value.length),
        Buffer.from(value, 'latin1'),
      ]);
    }
    const body = Buffer.from(value, 'ucs2').swap16();
    return Buffer.concat([encodeLength(0x60, value.length), body]);
  }
  if (Array.isArray(value)) {
    const refs = value.map(refOf);
    const parts = [encodeLength(0xa0, refs.length)];
    for (const r of refs) {
      const buf = Buffer.alloc(refs.length > 0xffff ? 4 : 1);
      writeBE(buf, r, buf.length);
      parts.push(buf);
    }
    return Buffer.concat(parts);
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    // 引用表布局：先全部 key 的引用，再全部 value 的引用。
    const keyRefs = keys.map((k) => refOf(k));
    const valRefs = keys.map((k) => refOf(value[k]));
    const parts = [encodeLength(0xd0, keys.length)];
    const refSize = Math.max(keyRefs.length, valRefs.length) > 0xffff ? 4 : 1;
    for (const r of [...keyRefs, ...valRefs]) {
      const buf = Buffer.alloc(refSize);
      writeBE(buf, r, refSize);
      parts.push(buf);
    }
    return Buffer.concat(parts);
  }
  throw new TypeError('cannot encode plist value: ' + typeof value);
}

export function buildPlist(root) {
  const objects = [];
  const seen = new Map();

  const intern = (value) => {
    if (value === undefined) value = null;
    const key = typeof value === 'object' && value !== null ? value : value;
    if (seen.has(key)) return seen.get(key);
    const idx = objects.length;
    objects.push(null);
    seen.set(key, idx);
    objects[idx] = encodeObject(value, intern);
    return idx;
  };

  const top = intern(root);

  // Offset table entries must be addressable; pick the smallest width that
  // can hold the largest file offset.
  const bodyParts = [Buffer.from('bplist00', 'ascii')];
  let offset = 8;
  const offsets = new Array(objects.length);
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = offset;
    bodyParts.push(objects[i]);
    offset += objects[i].length;
  }
  const offsetSize = offset < 0x100 ? 1 : offset < 0x10000 ? 2 : offset < 0x1000000 ? 3 : 4;
  const refSize = objects.length > 0xffff ? 4 : 1;

  const offsetTable = Buffer.alloc(offsetSize * objects.length);
  for (let i = 0; i < objects.length; i++) {
    writeBE(offsetTable.subarray(i * offsetSize, (i + 1) * offsetSize), offsets[i], offsetSize);
  }
  bodyParts.push(offsetTable);

  const trailer = Buffer.alloc(32);
  trailer[5] = 0x00; // sort version
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(offset), 24);
  bodyParts.push(trailer);

  return Buffer.concat(bodyParts);
}

// ---------------------------------------------------------------- decode ---

function isBinaryPlist(buf) {
  return buf.length >= 40 && buf.toString('ascii', 0, 6) === 'bplist';
}

export function parsePlist(buf) {
  if (isBinaryPlist(buf)) {
    return parseBinaryPlist(buf);
  }
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (text.includes('<plist')) {
    return parseXmlPlist(text);
  }
  throw new Error('parsePlist: 不是二进制 plist，也无法按 XML 解析');
}

export function parsePlistDict(buf) {
  const value = parsePlist(buf);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('parsePlistDict: 顶层对象不是 dict');
  }
  return value;
}

// ------------------------------------------------------- XML plist 解码 ---
// Apple 的 Windows 服务（尤其老版本）会以 XML plist 回复，这里做个小解析器。

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseXmlPlist(text) {
  const doc = text.replace(/<!DOCTYPE[\s\S]*?>/g, '');
  const body = doc.slice(doc.indexOf('<plist'));
  let i = 0;

  function readTag() {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '<') throw new Error('XML plist: 期望标签但得到 ' + JSON.stringify(body.slice(i, i + 20)));
    const end = body.indexOf('>', i);
    if (end === -1) throw new Error('XML plist: 标签未闭合');
    const tag = body.slice(i + 1, end);
    i = end + 1;
    return {
      name: tag.replace(/^\//, '').replace(/\/$/, '').trim().split(/\s+/)[0],
      closing: tag.startsWith('/'),
      selfClosing: tag.endsWith('/'),
    };
  }

  function readText() {
    const next = body.indexOf('<', i);
    if (next === -1) throw new Error('XML plist: 文本未闭合');
    const text = body.slice(i, next);
    i = next;
    return text;
  }

  const SCALARS = { true: true, false: false };

  function parseValue(name) {
    switch (name) {
      case 'dict': {
        const out = {};
        for (;;) {
          const t = readTag();
          if (t.closing) {
            if (t.name !== 'dict') throw new Error('XML plist: dict 提前闭合');
            return out;
          }
          if (t.name !== 'key') throw new Error('XML plist: dict 内期望 <key>');
          const key = decodeEntities(readText());
          readTag(); // </key>
          const vt = readTag();
          out[key] = vt.selfClosing ? (vt.name in SCALARS ? SCALARS[vt.name] : null) : parseValue(vt.name);
        }
      }
      case 'array': {
        const out = [];
        for (;;) {
          const t = readTag();
          if (t.closing) {
            if (t.name !== 'array') throw new Error('XML plist: array 提前闭合');
            return out;
          }
          out.push(t.selfClosing ? (t.name in SCALARS ? SCALARS[t.name] : null) : parseValue(t.name));
        }
      }
      case 'string': {
        const text = decodeEntities(readText());
        readTag();
        return text;
      }
      case 'integer': {
        const raw = readText().trim();
        readTag();
        return Number(raw) || 0;
      }
      case 'real': {
        const raw = readText().trim();
        readTag();
        return Number(raw) || 0;
      }
      case 'data': {
        const raw = readText().replace(/\s+/g, '');
        readTag();
        return Buffer.from(raw, 'base64');
      }
      case 'date': {
        const raw = readText().trim();
        readTag();
        return new Date(raw);
      }
      default:
        throw new Error('XML plist: 不支持的元素 <' + name + '>');
    }
  }

  // 跳过外层 <plist ...>
  readTag();
  const first = readTag();
  const value = first.selfClosing ? null : parseValue(first.name);
  return value;
}

function parseBinaryPlist(buf) {
  const trailer = buf.subarray(buf.length - 32);
  const offsetIntSize = trailer[6];
  const objectRefSize = trailer[7];
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTableOffset = Number(trailer.readBigUInt64BE(24));
  if (numObjects > 5_000_000 || offsetTableOffset + offsetIntSize * numObjects > buf.length) {
    throw new Error('parsePlist: implausible trailer');
  }

  const readInt = (off, size) => {
    let v = 0n;
    for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(buf[off + i]);
    return Number(v);
  };

  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) {
    offsets[i] = readInt(offsetTableOffset + i * offsetIntSize, offsetIntSize);
  }

  const visit = (ref, depth) => {
    if (depth > 64) throw new Error('parsePlist: too deep');
    const off = offsets[ref];
    const marker = buf[off];
    const hi = marker & 0xf0;
    const lo = marker & 0x0f;
    let p = off + 1;

    const readLen = () => {
      let len = lo;
      if (lo === 0x0f) {
        // 后跟一个 int 对象：0x10|n，低半字节是大小指数。
        const intMarker = buf[p];
        p += 1;
        const n = 1 << (intMarker & 0x0f);
        len = readInt(p, n);
        p += n;
      }
      return len;
    };

    switch (hi) {
      case 0x00: {
        if (marker === 0x00) return null;
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        if (marker === 0x0c) return null; // url-bytes, unused here
        if (marker === 0x0f) return null; // fill byte
        throw new Error('parsePlist: bad primitive marker 0x' + marker.toString(16));
      }
      case 0x10: {
        return readInt(p, 1 << lo);
      }
      case 0x20: {
        if (marker === 0x23) return buf.readDoubleBE(p);
        if (marker === 0x22) return buf.readFloatBE(p);
        throw new Error('parsePlist: bad real marker');
      }
      case 0x30: {
        if (marker === 0x33) return new Date(EPOCH_2001_MS + buf.readDoubleBE(p) * 1000);
        throw new Error('parsePlist: bad date marker');
      }
      case 0x40: {
        const len = readLen();
        return Buffer.from(buf.subarray(p, p + len));
      }
      case 0x50: {
        const len = readLen();
        return buf.toString('latin1', p, p + len);
      }
      case 0x60: {
        const chars = readLen();
        const body = Buffer.from(buf.subarray(p, p + chars * 2));
        body.swap16();
        return body.toString('ucs2');
      }
      case 0xa0:
      case 0xc0: {
        const len = readLen();
        const out = new Array(len);
        for (let i = 0; i < len; i++) {
          out[i] = visit(readInt(p + i * objectRefSize, objectRefSize), depth + 1);
        }
        return out;
      }
      case 0xd0: {
        const len = readLen();
        const out = {};
        for (let i = 0; i < len; i++) {
          const key = visit(readInt(p + i * objectRefSize, objectRefSize), depth + 1);
          const val = visit(readInt(p + (len + i) * objectRefSize, objectRefSize), depth + 1);
          out[String(key)] = val;
        }
        return out;
      }
      default:
        throw new Error('parsePlist: unsupported marker 0x' + marker.toString(16));
    }
  };

  return visit(topObject, 0);
}
