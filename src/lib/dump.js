/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dump job: fetches the selected resources, follows source map references,
 * extracts original sources and writes everything into one ZIP archive together
 * with a manifest. Only standard web APIs are used (fetch, Blob,
 * CompressionStream), so this module runs unchanged in the extension's
 * background page and in Node tests.
 */

import { normalizeContentType } from './classify.js';
import { PathAllocator, archiveBaseName, inlineArchivePath, sourcePathToArchivePath, urlToArchivePath } from './paths.js';
import { findSourceMappingURL, iterateSources, parseDataURL, parseSourceMap, resolveSourceMapURL } from './sourcemap.js';
import { ZipWriter } from './zip.js';

export const DEFAULT_OPTIONS = Object.freeze({
  fetchSourceMaps: true,
  extractSources: true,
  concurrency: 6,
  timeoutMs: 30_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
});

/** Scripts larger than this are not scanned for a sourceMappingURL comment. */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

const INLINE_SCRIPT_EXTENSIONS = [
  [/^(?:|module|(?:text|application)\/(?:x-)?(?:javascript|ecmascript|jscript))$/, '.js'],
  [/json|importmap|speculationrules/, '.json'],
  [/html|template|handlebars|mustache/, '.html'],
  [/xml/, '.xml'],
  [/css/, '.css'],
];

export function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** File extension for inline content, derived from the <script type> attribute. */
export function inlineExtension(kind, type = '') {
  if (kind === 'style') return '.css';
  if (kind === 'document') return '.html';
  const normalized = String(type).trim().toLowerCase();
  const rule = INLINE_SCRIPT_EXTENSIONS.find(([pattern]) => pattern.test(normalized));
  return rule ? rule[1] : '.txt';
}

/** Archive path (relative to the archive root) of an inline item. */
export function inlineItemPath(item, pageUrl) {
  const { inline } = item;
  const base = isHttpUrl(inline.frameUrl) ? inline.frameUrl : pageUrl;
  return inlineArchivePath(base, {
    frameIndex: inline.frameIndex || 0,
    kind: inline.kind,
    index: inline.index || 0,
    ext: inlineExtension(inline.kind, inline.type),
  });
}

function errorMessage(error) {
  return error && typeof error.message === 'string' && error.message ? error.message : String(error);
}

/** Date from an HTTP date header, or undefined when missing or unparsable. */
function parseHttpDate(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? undefined : new Date(time);
}

function decodeText(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

async function readBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw new Error(`file too large (${declared} bytes)`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`file too large (${bytes.length} bytes)`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`file too large (> ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Runs a dump job.
 *
 * job: { pageUrl, pageTitle, items: [{ url, category, initiatorType } | { inline: {...}, category }], options }
 * Returns { blob, filename, root, manifest }.
 */
export async function createDump(job, { fetchImpl = globalThis.fetch, onProgress = () => {}, now = () => new Date(), generator = 'DevGrab' } = {}) {
  const options = { ...DEFAULT_OPTIONS, ...(job.options || {}) };
  const { pageUrl } = job;
  const root = archiveBaseName(pageUrl, now());
  const zip = new ZipWriter();
  const allocator = new PathAllocator();
  const files = [];
  const skipped = [];
  const sources = [];
  const seenUrls = new Set();
  const sourceContents = new Map(); // archive path → content; a source shared by several maps is stored once
  const queue = [];
  let totalBytes = 0;
  let done = 0;
  let total = 0;

  const report = (url) => onProgress({ done, total, url });

  async function store(path, data, mtime) {
    const entry = await zip.add(`${root}/${path}`, data, mtime ? { mtime } : {});
    totalBytes += entry.size;
    return entry;
  }

  function enqueue(item) {
    if (!isHttpUrl(item.url)) {
      skipped.push({ url: item.url, category: item.category, error: 'unsupported URL scheme' });
      return;
    }
    if (seenUrls.has(item.url)) return;
    seenUrls.add(item.url);
    queue.push(item);
    total++;
  }

  async function extractSources(bytes, mapRecord) {
    let map;
    try {
      map = parseSourceMap(decodeText(bytes));
    } catch (error) {
      mapRecord.sourcesError = errorMessage(error);
      return;
    }
    let extracted = 0;
    let duplicates = 0;
    let withoutContent = 0;
    for (const { source, content, sourceRoot } of iterateSources(map)) {
      if (content === null) {
        withoutContent++;
        continue;
      }
      const desired = sourcePathToArchivePath(source, sourceRoot);
      const known = sourceContents.get(desired);
      if (known === content) {
        duplicates++;
        continue;
      }
      const data = new TextEncoder().encode(content);
      if (totalBytes + data.length > options.maxTotalBytes) {
        mapRecord.sourcesError = 'total size limit reached';
        break;
      }
      // Claim the path before the first await: another worker may be extracting the same shared source right now.
      if (known === undefined) sourceContents.set(desired, content);
      const path = allocator.allocate(desired);
      await store(path, data);
      sources.push({ path, source, map: mapRecord.path });
      extracted++;
    }
    Object.assign(mapRecord, { sourcesExtracted: extracted, sourcesDuplicate: duplicates, sourcesWithoutContent: withoutContent });
  }

  async function handleSourceMapReference(reference, baseUrl, ownerRecord) {
    const resolved = resolveSourceMapURL(reference, baseUrl);
    if (!resolved) return;
    if (!resolved.startsWith('data:')) {
      ownerRecord.sourceMapUrl = resolved;
      enqueue({ url: resolved, category: 'sourcemap', derivedFrom: ownerRecord.url });
      return;
    }
    ownerRecord.sourceMapUrl = 'data:…';
    const record = { url: null, inlineSourceMapOf: ownerRecord.url, category: 'sourcemap', derivedFrom: ownerRecord.url };
    try {
      const { bytes } = parseDataURL(resolved);
      record.path = allocator.allocate(`${ownerRecord.path}.map`);
      record.size = bytes.length;
      await store(record.path, bytes);
      files.push(record);
      if (options.extractSources) await extractSources(bytes, record);
    } catch (error) {
      skipped.push({ ...record, error: errorMessage(error) });
    }
  }

  async function processRemote(item) {
    const record = { url: item.url, path: null, category: item.category };
    if (item.initiatorType) record.initiatorType = item.initiatorType;
    if (item.derivedFrom) record.derivedFrom = item.derivedFrom;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${options.timeoutMs} ms`)), options.timeoutMs);
    try {
      const response = await fetchImpl(item.url, { credentials: 'include', redirect: 'follow', signal: controller.signal });
      record.status = response.status;
      if (response.url && response.url !== item.url) record.finalUrl = response.url;
      const contentType = normalizeContentType(response.headers.get('content-type'));
      if (contentType) record.contentType = contentType;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await readBody(response, options.maxFileBytes);
      if (totalBytes + bytes.length > options.maxTotalBytes) throw new Error('total size limit reached');
      record.size = bytes.length;
      record.path = allocator.allocate(urlToArchivePath(item.url, { contentType, category: item.category }));
      await store(record.path, bytes, parseHttpDate(response.headers.get('last-modified')));
      files.push(record);

      if (options.fetchSourceMaps && (item.category === 'script' || item.category === 'style')) {
        const reference = response.headers.get('sourcemap')
          || response.headers.get('x-sourcemap')
          || (bytes.length <= MAX_SCAN_BYTES ? findSourceMappingURL(decodeText(bytes)) : null);
        if (reference) await handleSourceMapReference(reference, response.url || item.url, record);
      }
      if (item.category === 'sourcemap' && options.extractSources) await extractSources(bytes, record);
    } catch (error) {
      skipped.push({ ...record, error: errorMessage(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      await processRemote(item);
      done++;
      report(item.url);
    }
  }

  for (const item of job.items) {
    if (!item.inline) {
      enqueue(item);
      continue;
    }
    const path = allocator.allocate(inlineItemPath(item, pageUrl));
    const data = new TextEncoder().encode(item.inline.content || '');
    await store(path, data);
    const { kind, type = '', frameUrl = '', frameIndex = 0, index = 0, id = '' } = item.inline;
    files.push({ url: null, path, category: item.category, size: data.length, inline: { kind, type, frameUrl, frameIndex, index, id } });
  }
  report();
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    generator,
    createdAt: now().toISOString(),
    page: { url: pageUrl, title: job.pageTitle || '' },
    options: { fetchSourceMaps: options.fetchSourceMaps, extractSources: options.extractSources },
    stats: { files: files.length, skipped: skipped.length, sources: sources.length, bytes: totalBytes },
    files,
    skipped,
    sources,
  };
  await store('_devgrab/manifest.json', JSON.stringify(manifest, null, 2));
  const blob = await zip.finish();
  return { blob, filename: `${root}.zip`, root, manifest };
}
