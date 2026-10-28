/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mapping of URLs (and source-map source names) to safe archive paths.
 *
 * Layout: one directory per host, the URL path below it, the query string
 * folded into the file name, and an extension added when the server's content
 * type says what a file is but the URL does not. Every path component is made
 * safe for Windows, macOS and Linux file systems, and PathAllocator resolves
 * collisions (case-insensitive, and file-vs-directory).
 */

import { categoryForContentType, categoryForExtension, extensionForContentType } from './classify.js';

const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_SEGMENT_BYTES = 200;
const MAX_QUERY_LENGTH = 48;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/*(.*)$/is;

const encoder = new TextEncoder();

/** Short, stable, non-cryptographic hash (FNV-1a, base 36) used to keep truncated names unique. */
export function hash6(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(-6);
}

export function splitExtension(name) {
  const match = /^(.+?)(\.[A-Za-z0-9]{1,12})?$/.exec(name);
  return match ? { base: match[1], ext: match[2] || '' } : { base: name, ext: '' };
}

function truncateToBytes(text, maxBytes) {
  let result = text;
  while (result.length > 0 && encoder.encode(result).length > maxBytes) result = result.slice(0, -1);
  return result;
}

/** Makes one path component safe for all common file systems. */
export function sanitizeSegment(raw, { decode = true } = {}) {
  let segment = String(raw);
  if (decode) {
    try {
      segment = decodeURIComponent(segment);
    } catch {
      // Not valid percent-encoding: keep the raw text.
    }
  }
  segment = segment.replace(FORBIDDEN_CHARS, '_').replace(/^\s+|[\s.]+$/g, '');
  if (segment === '') return '_';
  if (WINDOWS_RESERVED.test(segment)) segment = `_${segment}`;
  if (encoder.encode(segment).length > MAX_SEGMENT_BYTES) {
    const { base, ext } = splitExtension(segment);
    segment = `${truncateToBytes(base, MAX_SEGMENT_BYTES - ext.length - 7)}~${hash6(String(raw))}${ext}`;
  }
  return segment;
}

/** "example.com", "example.com_8080", "__1" for [::1]; "file" for file: URLs. */
export function hostDirectory(url) {
  const parsed = url instanceof URL ? url : new URL(url);
  let host = parsed.hostname.replace(/[[\]]/g, '').replace(/:/g, '_');
  if (!host) host = parsed.protocol.replace(/:$/, '') || 'unknown';
  return sanitizeSegment(parsed.port ? `${host}_${parsed.port}` : host, { decode: false });
}

const CATEGORY_EXTENSIONS = { script: '.js', style: '.css', sourcemap: '.map', document: '.html' };

/** Source maps are JSON; the two kinds do not contradict each other. */
const sameKind = (a, b) => a === b || [a, b].every((kind) => kind === 'data' || kind === 'sourcemap');

/**
 * Final extension of a file: a missing one is taken from the content type (or
 * the category), a misleading one gets the content type's extension appended
 * ("bundle.php" served as JavaScript becomes "bundle.php.js").
 */
export function chooseExtension(currentExt, { contentType = '', category = '' } = {}) {
  let typeExt = extensionForContentType(contentType);
  if (category === 'sourcemap' && typeExt === '.json') typeExt = '.map';
  if (!currentExt) return typeExt || CATEGORY_EXTENSIONS[category] || '';
  const typeCategory = categoryForContentType(contentType);
  const extCategory = categoryForExtension(currentExt.slice(1));
  if (typeExt && typeCategory && extCategory && !sameKind(typeCategory, extCategory)) return `${currentExt}${typeExt}`;
  return currentExt;
}

function querySuffix(search) {
  if (!search || search === '?') return '';
  let query = search.slice(1);
  try {
    query = decodeURIComponent(query);
  } catch {
    // keep raw query
  }
  query = query.replace(FORBIDDEN_CHARS, '_').replace(/\s+/g, '_');
  if (query.length > MAX_QUERY_LENGTH) query = `${query.slice(0, MAX_QUERY_LENGTH - 7)}~${hash6(search)}`;
  return query ? `~${query}` : '';
}

/** "https://cdn.example.com:8443/a/b/app.js?v=3" → "cdn.example.com_8443/a/b/app~v=3.js" */
export function urlToArchivePath(url, { contentType = '', category = '' } = {}) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const isDirectory = parsed.pathname.endsWith('/') || segments.length === 0;
  const fileName = isDirectory ? 'index' : segments.pop();
  const directories = segments.map((segment) => sanitizeSegment(segment));
  const { base, ext } = splitExtension(sanitizeSegment(fileName));
  const finalName = `${base}${querySuffix(parsed.search)}${chooseExtension(ext, { contentType, category })}`;
  return [hostDirectory(parsed), ...directories, sanitizeSegment(finalName, { decode: false })].join('/');
}

/**
 * Archive path for a source listed in a source map, below "_sources/".
 * "webpack:///./src/App.tsx" → "_sources/src/App.tsx"; "../../src/main.ts" → "_sources/src/main.ts".
 */
export function sourcePathToArchivePath(source, sourceRoot = '') {
  let path = String(source);
  if (sourceRoot && !SCHEME.test(path)) {
    path = `${sourceRoot}${sourceRoot.endsWith('/') ? '' : '/'}${path.replace(/^\/+/, '')}`;
  }
  const scheme = SCHEME.exec(path);
  if (scheme) path = scheme[2];
  const segments = path
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => sanitizeSegment(segment));
  if (segments.length === 0) segments.push('unnamed');
  return `_sources/${segments.join('/')}`;
}

/** Archive path for inline content (scripts, styles, DOM snapshot) of a frame. */
export function inlineArchivePath(baseUrl, { frameIndex = 0, kind, index = 0, ext = '' }) {
  const frameDir = frameIndex > 0 ? `frame-${frameIndex}/` : '';
  const name = kind === 'document' ? 'dom-snapshot.html' : `${kind}-${String(index).padStart(3, '0')}${ext}`;
  return `${hostDirectory(baseUrl)}/_inline/${frameDir}${name}`;
}

/** "devgrab_example.com_20260131-142501" (local time), used as archive name and root folder. */
export function archiveBaseName(pageUrl, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `devgrab_${hostDirectory(pageUrl)}_${stamp}`;
}

/** downloads.download() rejects path components that start with a dot; ZIP entries may keep them. */
export function downloadsSafePath(path) {
  return path
    .split('/')
    .map((segment) => (segment.startsWith('.') ? `_${segment.slice(1)}` : segment))
    .join('/');
}

/** Hands out unique archive paths; "a.js", "a.js" → "a.js", "a~2.js". */
export class PathAllocator {
  #files = new Set();
  #directories = new Set();

  has(path) {
    return this.#files.has(path.toLowerCase());
  }

  allocate(path) {
    const segments = path.split('/');
    // A directory of the new path may already exist as a file ("api/users" then "api/users/1").
    for (let i = 0; i < segments.length - 1; i++) {
      while (this.#files.has(segments.slice(0, i + 1).join('/').toLowerCase())) segments[i] += '~dir';
    }
    const { base, ext } = splitExtension(segments[segments.length - 1]);
    const dir = segments.slice(0, -1);
    let candidate = segments.join('/');
    for (let n = 2; this.#files.has(candidate.toLowerCase()) || this.#directories.has(candidate.toLowerCase()); n++) {
      candidate = [...dir, `${base}~${n}${ext}`].join('/');
    }
    this.#files.add(candidate.toLowerCase());
    const parts = candidate.split('/');
    for (let i = 1; i < parts.length; i++) this.#directories.add(parts.slice(0, i).join('/').toLowerCase());
    return candidate;
  }
}
