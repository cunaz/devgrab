/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Packages the extension into dist/devgrab-<version>.zip with the project's
 * own ZIP writer. Entry times are the commit time of HEAD, so building the
 * same commit twice gives the same archive.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ZipWriter } from '../src/lib/zip.js';

const root = new URL('..', import.meta.url).pathname;
const INCLUDE = ['manifest.json', 'LICENSE', 'src', '_locales', 'icons'];

async function listFiles(path) {
  if ((await stat(path)).isFile()) return [path];
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function commitTime() {
  try {
    return new Date(Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })) * 1000);
  } catch {
    return new Date();
  }
}

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const files = (await Promise.all(INCLUDE.map((name) => listFiles(join(root, name))))).flat().sort();
const mtime = commitTime();
const zip = new ZipWriter();
for (const file of files) {
  await zip.add(relative(root, file).split(sep).join('/'), await readFile(file), { mtime });
}
const archive = Buffer.from(await (await zip.finish()).arrayBuffer());
await mkdir(join(root, 'dist'), { recursive: true });
const output = join(root, 'dist', `devgrab-${manifest.version}.zip`);
await writeFile(output, archive);
console.log(`${relative(root, output)}: ${files.length} files, ${archive.length} bytes`);
