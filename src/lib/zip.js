/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal ZIP writer (PKWARE APPNOTE 6.3): "stored" and "deflate" entries,
 * UTF-8 names, Unix file modes, no ZIP64. Small enough that the extension
 * needs no third-party code. Deflate uses the platform's CompressionStream.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0: deflate
const VERSION_MADE_BY = 0x0314; // host 3 = Unix, spec 2.0
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const UNIX_REGULAR_FILE = (0o100644 << 16) >>> 0;
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

export async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('ZipWriter.add: data must be a string, ArrayBuffer or typed array');
}

function toDosDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  };
}

export class ZipWriter {
  #parts = [];
  #central = [];
  #offset = 0;
  #count = 0;
  #chain = Promise.resolve();
  #finished = false;

  constructor({ compress = true } = {}) {
    this.compress = compress;
  }

  get entryCount() {
    return this.#count;
  }

  /**
   * Adds one entry. Calls may overlap (compression runs concurrently); the
   * entries are written in call order. Resolves with {name, size, compressedSize, method}.
   */
  add(name, data, { mtime = new Date(), compress = this.compress } = {}) {
    const prepared = this.#prepare(name, toBytes(data), mtime, compress);
    const written = this.#chain.then(() => prepared).then((entry) => this.#write(name, entry));
    this.#chain = written.catch(() => {});
    return written;
  }

  async #prepare(name, bytes, mtime, compress) {
    if (this.#finished) throw new Error('ZipWriter: archive already finished');
    const nameBytes = new TextEncoder().encode(name);
    if (nameBytes.length === 0 || nameBytes.length > 0xffff) throw new RangeError(`ZipWriter: invalid entry name "${name}"`);
    let method = METHOD_STORE;
    let payload = bytes;
    if (compress && bytes.length > 0) {
      const deflated = await deflateRaw(bytes);
      if (deflated && deflated.length < bytes.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }
    return { nameBytes, size: bytes.length, payload, method, crc: crc32(bytes), ...toDosDateTime(mtime) };
  }

  #write(name, { nameBytes, size, payload, method, crc, date, time }) {
    const localSize = 30 + nameBytes.length + payload.length;
    if (this.#count >= MAX_ENTRIES || size > MAX_UINT32 || this.#offset + localSize > MAX_UINT32) {
      throw new RangeError('ZipWriter: archive exceeds the 4 GiB / 65535-entry limit of plain ZIP (ZIP64 is not supported)');
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, VERSION_NEEDED, true);
    local.setUint16(6, FLAG_UTF8, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, payload.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, SIG_CENTRAL, true);
    central.setUint16(4, VERSION_MADE_BY, true);
    central.setUint16(6, VERSION_NEEDED, true);
    central.setUint16(8, FLAG_UTF8, true);
    central.setUint16(10, method, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, payload.length, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true); // extra field length
    central.setUint16(32, 0, true); // comment length
    central.setUint16(34, 0, true); // disk number start
    central.setUint16(36, 0, true); // internal attributes
    central.setUint32(38, UNIX_REGULAR_FILE, true);
    central.setUint32(42, this.#offset, true);

    this.#parts.push(new Uint8Array(local.buffer), nameBytes, payload);
    this.#central.push(new Uint8Array(central.buffer), nameBytes);
    this.#offset += localSize;
    this.#count++;
    return { name, size, compressedSize: payload.length, method };
  }

  /** Waits for pending entries and returns the finished archive as a Blob. */
  async finish() {
    await this.#chain;
    this.#finished = true;
    const centralSize = this.#central.reduce((sum, part) => sum + part.length, 0);
    if (this.#offset + centralSize + 22 > MAX_UINT32) {
      throw new RangeError('ZipWriter: archive exceeds 4 GiB (ZIP64 is not supported)');
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, SIG_EOCD, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, this.#count, true);
    eocd.setUint16(10, this.#count, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, this.#offset, true);
    eocd.setUint16(20, 0, true);
    return new Blob([...this.#parts, ...this.#central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
  }
}
