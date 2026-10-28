/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Tiny ZIP reader for tests: parses the central directory and extracts entries. */

export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.length - 22;
  if (view.getUint32(eocdOffset, true) !== 0x06054b50) throw new Error('EOCD signature not found (comments are not supported)');
  const count = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const decoder = new TextDecoder();
  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const externalAttributes = view.getUint32(p + 38, true);
    const localOffset = view.getUint32(p + 42, true);
    const dosTime = view.getUint16(p + 12, true);
    const dosDate = view.getUint16(p + 14, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const mtime = new Date(1980 + (dosDate >> 9), ((dosDate >> 5) & 15) - 1, dosDate & 31, dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2);
    entries.push({ name, method, crc, compressedSize, size, externalAttributes, mtime, payload: bytes.subarray(dataStart, dataStart + compressedSize) });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function extractEntry(entry) {
  if (entry.method === 0) return entry.payload;
  if (entry.method !== 8) throw new Error(`unsupported method ${entry.method}`);
  const stream = new Blob([entry.payload]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipAsMap(bytes) {
  const result = new Map();
  for (const entry of readZip(bytes)) result.set(entry.name, await extractEntry(entry));
  return result;
}
