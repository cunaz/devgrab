/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * File types: which category a resource belongs to and which file extension
 * fits it. Decided from the response content type, the URL's extension and
 * the Resource Timing initiator. Pure functions, unit-tested in Node.
 */

export const CATEGORIES = Object.freeze([
  'script',
  'style',
  'sourcemap',
  'document',
  'data',
  'xhr',
  'font',
  'image',
  'media',
  'other',
]);

/** Categories that are checked the first time the popup opens. */
export const DEFAULT_SELECTED = Object.freeze(['script', 'style', 'sourcemap', 'document', 'data']);

const byExtension = (extensions, category) => extensions.map((ext) => [ext, category]);

const EXTENSION_CATEGORY = new Map([
  // Dev servers (Vite, webpack-dev-server, …) serve these module formats as JavaScript.
  ...byExtension(['js', 'mjs', 'cjs', 'jsx', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'es', 'es6', 'coffee'], 'script'),
  ...byExtension(['css', 'scss', 'sass', 'less', 'styl', 'pcss'], 'style'),
  ...byExtension(['map'], 'sourcemap'),
  ...byExtension(['html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp', 'cfm'], 'document'),
  ...byExtension(
    ['json', 'json5', 'jsonc', 'geojson', 'webmanifest', 'xml', 'xsl', 'xslt', 'txt', 'md', 'yaml', 'yml',
      'toml', 'ini', 'csv', 'tsv', 'graphql', 'gql', 'wasm', 'vtt', 'srt', 'properties', 'proto'],
    'data',
  ),
  ...byExtension(['woff', 'woff2', 'ttf', 'otf', 'eot'], 'font'),
  ...byExtension(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'apng', 'jxl', 'cur'], 'image'),
  ...byExtension(
    ['mp4', 'm4v', 'webm', 'mp3', 'm4a', 'ogg', 'oga', 'ogv', 'opus', 'wav', 'flac', 'aac', 'm3u8', 'mpd', 'mov'],
    'media',
  ),
]);

/** ".ts" is TypeScript on a dev server but an MPEG transport-stream segment for HLS players. */
const MEDIA_INITIATORS = new Set(['video', 'audio', 'fetch', 'xmlhttprequest', 'track']);

/** Content types that say nothing about the file (misconfigured servers, downloads). */
const GENERIC_CONTENT_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

// [content type, category, file extension]. First match wins; "" = no extension known.
const CONTENT_TYPES = [
  [/^(?:application|text)\/(?:x-)?(?:javascript|ecmascript|jscript)$/, 'script', '.js'],
  [/^text\/css$/, 'style', '.css'],
  [/^(?:text\/html|application\/xhtml\+xml)$/, 'document', '.html'],
  [/^image\/svg\+xml$/, 'image', '.svg'],
  [/^image\/png$/, 'image', '.png'],
  [/^image\/jpeg$/, 'image', '.jpg'],
  [/^image\/gif$/, 'image', '.gif'],
  [/^image\/webp$/, 'image', '.webp'],
  [/^image\/avif$/, 'image', '.avif'],
  [/^image\/(?:x-icon|vnd\.microsoft\.icon)$/, 'image', '.ico'],
  [/^image\//, 'image', ''],
  [/^font\/woff2$/, 'font', '.woff2'],
  [/^(?:font\/woff|application\/font-woff)$/, 'font', '.woff'],
  [/^font\/ttf$/, 'font', '.ttf'],
  [/^font\/otf$/, 'font', '.otf'],
  [/^(?:font\/|application\/(?:x-)?font-|application\/vnd\.ms-fontobject$)/, 'font', ''],
  [/^video\/mp4$/, 'media', '.mp4'],
  [/^video\/webm$/, 'media', '.webm'],
  [/^audio\/mpeg$/, 'media', '.mp3'],
  [/^audio\/ogg$/, 'media', '.ogg'],
  [/^audio\/wav$/, 'media', '.wav'],
  [/^(?:video|audio)\//, 'media', ''],
  [/^application\/(?:vnd\.apple\.mpegurl|x-mpegurl)$/, 'media', '.m3u8'],
  [/^application\/dash\+xml$/, 'media', '.mpd'],
  [/^application\/(?:json|[\w.-]+\+json)$/, 'data', '.json'],
  [/^application\/wasm$/, 'data', '.wasm'],
  [/^(?:application|text)\/xml$/, 'data', '.xml'],
  [/^application\/[\w.-]+\+xml$/, 'data', '.xml'],
  [/^text\/csv$/, 'data', '.csv'],
  [/^(?:application|text)\/(?:x-)?yaml$/, 'data', '.yaml'],
  [/^text\/markdown$/, 'data', '.md'],
  [/^text\/vtt$/, 'data', '.vtt'],
  [/^application\/(?:toml|graphql)$/, 'data', ''],
  [/^text\/plain$/, null, '.txt'],
];

const INITIATOR_CATEGORY = {
  script: 'script',
  serviceworker: 'script',
  worker: 'script',
  sharedworker: 'script',
  img: 'image',
  image: 'image',
  input: 'image',
  video: 'media',
  audio: 'media',
  track: 'data',
  fetch: 'xhr',
  xmlhttprequest: 'xhr',
  beacon: 'other',
  ping: 'other',
  iframe: 'document',
  frame: 'document',
  navigation: 'document',
  font: 'font',
};

/** Lower-cased file extension of a URL's path without the dot, or "" if there is none. */
export function getExtension(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(lastSegment);
  return match ? match[1].toLowerCase() : '';
}

/** Content type without parameters, lower-cased ("text/html; charset=utf-8" → "text/html"). */
export function normalizeContentType(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

function contentTypeRule(contentType) {
  const type = normalizeContentType(contentType);
  return GENERIC_CONTENT_TYPES.has(type) ? null : CONTENT_TYPES.find(([pattern]) => pattern.test(type)) || null;
}

export function categoryForContentType(contentType) {
  const rule = contentTypeRule(contentType);
  return rule ? rule[1] : null;
}

/** File extension (with dot) for a content type, or "" when none is known. */
export function extensionForContentType(contentType) {
  const rule = contentTypeRule(contentType);
  return rule ? rule[2] : '';
}

export function categoryForExtension(extension, initiatorType = '') {
  const ext = String(extension || '').toLowerCase();
  if (ext === 'ts') return MEDIA_INITIATORS.has(initiatorType) ? 'media' : 'script';
  return EXTENSION_CATEGORY.get(ext) || null;
}

/**
 * Classifies a resource. The response content type wins when it is specific,
 * then the URL's extension, then the Resource Timing initiator.
 */
export function classify(url, { initiatorType = '', contentType = '' } = {}) {
  const extension = getExtension(url);
  const fromType = categoryForContentType(contentType);
  const fromExtension = categoryForExtension(extension, initiatorType);

  // ".map" files are usually served as application/json; keep them recognisable.
  if (fromExtension === 'sourcemap' && (fromType === null || fromType === 'data')) return 'sourcemap';
  if (fromType) return fromType;
  if (fromExtension) return fromExtension;

  const fromInitiator = INITIATOR_CATEGORY[String(initiatorType || '').toLowerCase()];
  if (fromInitiator) return fromInitiator;
  if (normalizeContentType(contentType) === 'text/plain') return 'data';
  return 'other';
}
