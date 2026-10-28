/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipWriter, crc32 } from '../src/lib/zip.js';
import { readZip, extractEntry } from './helpers/zip-reader.js';

const text = (s) => new TextEncoder().encode(s);

test('crc32 matches the reference value for "123456789"', () => {
  assert.equal(crc32(text('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('writes stored and deflated entries that round-trip', async () => {
  const zip = new ZipWriter();
  const big = 'const answer = 42;\n'.repeat(5000);
  const binary = crypto.getRandomValues(new Uint8Array(4096));
  const [a, b, c, d, e] = await Promise.all([
    zip.add('readme.txt', 'hello world\n'),
    zip.add('src/big.js', big, { mtime: new Date(2024, 0, 15, 12, 30, 44) }),
    zip.add('img/noise.png', binary),
    zip.add('ünïcode/名前.js', 'export default 1;\n'),
    zip.add('empty.txt', ''),
  ]);
  assert.equal(b.method, 8, 'repetitive text is deflated');
  assert.equal(c.method, 0, 'random bytes do not shrink and are stored');
  assert.equal(e.size, 0);
  assert.equal(zip.entryCount, 5);

  const blob = await zip.finish();
  assert.equal(blob.type, 'application/zip');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const entries = readZip(bytes);
  assert.deepEqual(entries.map((x) => x.name), ['readme.txt', 'src/big.js', 'img/noise.png', 'ünïcode/名前.js', 'empty.txt']);
  for (const entry of entries) {
    const data = await extractEntry(entry);
    assert.equal(data.length, entry.size, entry.name);
    assert.equal(crc32(data), entry.crc, entry.name);
    assert.equal(entry.externalAttributes >>> 16, 0o100644, 'unix mode');
  }
  assert.equal(new TextDecoder().decode(await extractEntry(entries[1])), big);
  assert.deepEqual(await extractEntry(entries[2]), binary);
  assert.ok(entries[1].compressedSize < big.length / 10, 'deflate is effective');
  assert.deepEqual([a.name, d.name], ['readme.txt', 'ünïcode/名前.js']);

  // Cross-check with independent tools when they are available.
  const dir = mkdtempSync(join(tmpdir(), 'devgrab-zip-'));
  const file = join(dir, 'test.zip');
  writeFileSync(file, bytes);
  for (const [cmd, args] of [['python3', ['-I', '-m', 'zipfile', '-t', file]], ['unzip', ['-tqq', file]]]) {
    try {
      execFileSync(cmd, args, { stdio: 'pipe' });
    } catch (error) {
      if (error.code === 'ENOENT') continue; // tool not installed
      assert.fail(`${cmd} rejected the archive: ${error.stderr || error.stdout || error.message}`);
    }
  }
});

test('keeps call order even when a later entry compresses faster', async () => {
  const zip = new ZipWriter();
  const promises = [zip.add('a.js', 'a'.repeat(200000)), zip.add('b.txt', 'b')];
  await Promise.all(promises);
  const entries = readZip(new Uint8Array(await (await zip.finish()).arrayBuffer()));
  assert.deepEqual(entries.map((x) => x.name), ['a.js', 'b.txt']);
});

test('rejects invalid names and use after finish', async () => {
  const zip = new ZipWriter();
  await assert.rejects(() => zip.add('', 'x'), RangeError);
  await zip.add('ok.txt', 'x');
  await zip.finish();
  await assert.rejects(() => zip.add('late.txt', 'x'), /already finished/);
});
