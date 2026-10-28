/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Page inventory collector.
 *
 * Injected into every frame of the active tab with
 * scripting.executeScript({ func: collectPageResources }), so the function is
 * serialised from source: it MUST be self-contained (no imports, no references
 * to module scope). The return value is structured-cloned back to the popup.
 */
export function collectPageResources(options) {
  const maxResources = (options && options.maxResources) || 5000;
  const maxInlineChars = (options && options.maxInlineChars) || 20 * 1024 * 1024;
  const resources = new Map();
  const inline = [];
  const warnings = [];

  function normalizeUrl(raw, base) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let url;
    try {
      url = new URL(raw.trim(), base || document.baseURI);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  }

  function addResource(raw, initiatorType, extra) {
    const url = normalizeUrl(raw, extra && extra.base);
    if (!url) return;
    const existing = resources.get(url);
    if (existing) {
      if ((existing.initiatorType === 'other' || existing.initiatorType === 'link') && initiatorType) existing.initiatorType = initiatorType;
      if (extra && extra.size > existing.size) existing.size = extra.size;
      return;
    }
    if (resources.size >= maxResources) {
      if (!warnings.includes('too-many-resources')) warnings.push('too-many-resources');
      return;
    }
    resources.set(url, { url, initiatorType: initiatorType || 'other', size: (extra && extra.size) || 0, foundBy: (extra && extra.foundBy) || 'dom' });
  }

  // 1. The frame's own document.
  addResource(location.href, 'navigation');

  // 2. Resource Timing: everything the frame loaded so far, including dynamic
  //    imports, fetch/XHR calls and workers. The default buffer holds 250 entries.
  let timingEntries = [];
  try {
    timingEntries = performance.getEntriesByType('resource');
  } catch {
    warnings.push('no-resource-timing');
  }
  for (const entry of timingEntries) {
    addResource(entry.name, entry.initiatorType, { size: entry.decodedBodySize || entry.transferSize || 0, foundBy: 'timing' });
  }
  if (timingEntries.length >= 250) warnings.push('timing-buffer-full');

  // 3. References in the DOM (catches resources that fell out of the timing buffer).
  const preloadInitiators = { script: 'script', style: 'link', font: 'font', image: 'img', fetch: 'fetch', video: 'video', audio: 'audio', track: 'track', document: 'iframe' };
  const attributeSelectors = [
    ['script[src]', 'src', 'script'],
    ['link[rel~="stylesheet"][href]', 'href', 'link'],
    ['link[rel~="modulepreload"][href]', 'href', 'script'],
    ['link[rel~="manifest"][href]', 'href', 'link'],
    ['link[rel~="icon"][href], link[rel~="apple-touch-icon"][href]', 'href', 'img'],
    ['img[src]', 'src', 'img'],
    ['video[poster]', 'poster', 'img'],
    ['iframe[src]', 'src', 'iframe'],
    ['video[src]', 'src', 'video'],
    ['audio[src]', 'src', 'audio'],
    ['source[src]', 'src', 'other'],
    ['track[src]', 'src', 'track'],
    ['embed[src]', 'src', 'embed'],
    ['object[data]', 'data', 'object'],
  ];
  for (const [selector, attribute, initiator] of attributeSelectors) {
    for (const node of document.querySelectorAll(selector)) addResource(node.getAttribute(attribute), initiator);
  }
  for (const node of document.querySelectorAll('link[rel~="preload"][href], link[rel~="prefetch"][href]')) {
    addResource(node.getAttribute('href'), preloadInitiators[(node.getAttribute('as') || '').toLowerCase()] || 'link');
  }
  for (const node of document.querySelectorAll('img[srcset], source[srcset]')) {
    for (const candidate of node.getAttribute('srcset').split(',')) addResource(candidate.trim().split(/\s+/)[0], 'img');
  }
  for (const node of document.querySelectorAll('use')) {
    addResource(node.getAttribute('href') || node.getAttribute('xlink:href'), 'other');
  }

  // 4. Stylesheets: @import and url() references in sheets we are allowed to read.
  const cssUrl = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s]+))\s*\)/g;
  let rulesScanned = 0;
  function scanRules(rules, base, depth) {
    if (!rules || depth > 8) return;
    for (const rule of rules) {
      if (++rulesScanned > 50000) return;
      if (rule.href) {
        addResource(rule.href, 'link', { base, foundBy: 'css' });
        scanSheet(rule.styleSheet, depth + 1);
      } else if (rule.cssRules && rule.cssRules.length) {
        scanRules(rule.cssRules, base, depth + 1);
      } else if (rule.cssText && rule.cssText.includes('url(')) {
        for (const match of rule.cssText.matchAll(cssUrl)) addResource(match[1] ?? match[2] ?? match[3], 'css', { base, foundBy: 'css' });
      }
    }
  }
  function scanSheet(sheet, depth) {
    if (!sheet) return;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // cross-origin sheet without CORS: not readable
    }
    scanRules(rules, sheet.href || document.baseURI, depth);
  }
  for (const sheet of document.styleSheets) scanSheet(sheet, 0);

  // 5. The service worker controlling this frame. Firefox content scripts see
  //    the page's own navigator through wrappedJSObject.
  try {
    const pageNavigator = (window.wrappedJSObject && window.wrappedJSObject.navigator) || navigator;
    const controller = pageNavigator.serviceWorker && pageNavigator.serviceWorker.controller;
    if (controller && controller.scriptURL) addResource(controller.scriptURL, 'serviceworker', { foundBy: 'sw' });
  } catch {
    // not accessible from this context
  }

  // 6. Inline scripts, inline styles and a snapshot of the live DOM.
  function pushInline(kind, index, type, id, content) {
    if (content.length > maxInlineChars) {
      warnings.push(`inline-too-large:${kind}-${index}`);
      return;
    }
    inline.push({ kind, index, type, id, content, size: content.length, preview: content.trim().replace(/\s+/g, ' ').slice(0, 120) });
  }
  let scriptIndex = 0;
  for (const script of document.querySelectorAll('script:not([src])')) {
    const content = script.textContent || '';
    if (!content.trim()) continue;
    pushInline('script', ++scriptIndex, (script.getAttribute('type') || '').trim().toLowerCase(), script.id || '', content);
  }
  let styleIndex = 0;
  for (const style of document.querySelectorAll('style')) {
    const content = style.textContent || '';
    if (!content.trim()) continue;
    pushInline('style', ++styleIndex, 'text/css', style.id || '', content);
  }
  const doctype = document.doctype
    ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}${document.doctype.systemId ? ` "${document.doctype.systemId}"` : ''}>\n`
    : '';
  pushInline('document', 0, 'text/html', '', doctype + (document.documentElement ? document.documentElement.outerHTML : ''));

  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {
    isTop = false;
  }
  return {
    frameUrl: location.href,
    title: document.title || '',
    isTop,
    resources: Array.from(resources.values()),
    inline,
    warnings,
    timingEntries: timingEntries.length,
  };
}
