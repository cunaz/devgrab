/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source map discovery and parsing (Source Map revision 3, including index
 * maps with "sections"). No browser APIs.
 */

const SOURCE_MAPPING_URL = /(?:\/\/|\/\*)[#@]\s*sourceMappingURL=([^\s*'"]+)/g;
const XSSI_PREFIX = /^\)\]\}'[^\n]*\n/;

/** Last "sourceMappingURL" comment in a script or stylesheet, or null. */
export function findSourceMappingURL(text) {
  let last = null;
  for (const match of String(text).matchAll(SOURCE_MAPPING_URL)) last = match[1];
  return last;
}

/** Absolute URL of a source map reference (data: URLs are returned unchanged); null if unresolvable. */
export function resolveSourceMapURL(reference, baseUrl) {
  if (/^data:/i.test(reference)) return reference;
  try {
    return new URL(reference, baseUrl).href;
  } catch {
    return null;
  }
}

/** Decodes a data: URL into {mime, bytes}. */
export function parseDataURL(url) {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(url);
  if (!match) throw new Error('not a data: URL');
  const [, mime, isBase64, payload] = match;
  if (isBase64) {
    const binary = atob(payload.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime: mime || 'text/plain', bytes };
  }
  return { mime: mime || 'text/plain', bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}

/** Parses source map JSON (tolerating an XSSI guard line) and checks its shape. */
export function parseSourceMap(text) {
  const map = JSON.parse(String(text).replace(XSSI_PREFIX, ''));
  if (!map || typeof map !== 'object' || (!Array.isArray(map.sources) && !Array.isArray(map.sections))) {
    throw new Error('not a source map');
  }
  return map;
}

/** Yields {source, content, sourceRoot} for every source, descending into index-map sections. */
export function* iterateSources(map) {
  if (Array.isArray(map.sections)) {
    for (const section of map.sections) {
      if (section && section.map && typeof section.map === 'object') yield* iterateSources(section.map);
    }
    return;
  }
  const sources = Array.isArray(map.sources) ? map.sources : [];
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  for (let i = 0; i < sources.length; i++) {
    yield {
      source: String(sources[i] ?? ''),
      content: typeof contents[i] === 'string' ? contents[i] : null,
      sourceRoot: typeof map.sourceRoot === 'string' ? map.sourceRoot : '',
    };
  }
}
