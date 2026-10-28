/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, DEFAULT_SELECTED, classify, getExtension } from '../src/lib/classify.js';

test('categories are well-formed', () => {
  assert.equal(CATEGORIES.length, 10);
  for (const category of DEFAULT_SELECTED) assert.ok(CATEGORIES.includes(category));
});

test('getExtension', () => {
  assert.equal(getExtension('https://x.test/a/b.min.JS?x=1#y'), 'js');
  assert.equal(getExtension('https://x.test/a/b'), '');
  assert.equal(getExtension('https://x.test/a.b/c'), '');
  assert.equal(getExtension('not a url'), '');
});

test('classify by extension', () => {
  assert.equal(classify('https://x.test/app.js'), 'script');
  assert.equal(classify('https://x.test/app.mjs?v=2'), 'script');
  assert.equal(classify('https://x.test/style.css'), 'style');
  assert.equal(classify('https://x.test/app.js.map'), 'sourcemap');
  assert.equal(classify('https://x.test/page.html'), 'document');
  assert.equal(classify('https://x.test/data.json'), 'data');
  assert.equal(classify('https://x.test/module.wasm'), 'data');
  assert.equal(classify('https://x.test/site.webmanifest', { initiatorType: 'link' }), 'data');
  assert.equal(classify('https://x.test/f.woff2'), 'font');
  assert.equal(classify('https://x.test/i.svg'), 'image');
  assert.equal(classify('https://x.test/v.mp4'), 'media');
  assert.equal(classify('https://x.test/src/main.ts', { initiatorType: 'script' }), 'script');
  assert.equal(classify('https://x.test/seg-1.ts', { initiatorType: 'fetch' }), 'media');
});

test('classify by content type', () => {
  assert.equal(classify('https://x.test/bundle', { contentType: 'application/javascript; charset=utf-8' }), 'script');
  assert.equal(classify('https://x.test/bundle.php', { contentType: 'text/javascript' }), 'script');
  assert.equal(classify('https://x.test/a.js', { contentType: 'text/plain' }), 'script', 'generic types do not override');
  assert.equal(classify('https://x.test/a.map', { contentType: 'application/json' }), 'sourcemap');
  assert.equal(classify('https://x.test/api', { contentType: 'application/json' }), 'data');
  assert.equal(classify('https://x.test/x', { contentType: 'application/ld+json' }), 'data');
  assert.equal(classify('https://x.test/x', { contentType: 'image/svg+xml' }), 'image');
  assert.equal(classify('https://x.test/x', { contentType: 'application/vnd.apple.mpegurl' }), 'media');
  assert.equal(classify('https://x.test/x', { contentType: 'text/plain' }), 'data');
});

test('classify by initiator', () => {
  assert.equal(classify('https://x.test/api/users', { initiatorType: 'fetch' }), 'xhr');
  assert.equal(classify('https://x.test/api/users', { initiatorType: 'xmlhttprequest' }), 'xhr');
  assert.equal(classify('https://x.test/collect', { initiatorType: 'beacon' }), 'other');
  assert.equal(classify('https://x.test/chunk', { initiatorType: 'script' }), 'script');
  assert.equal(classify('https://x.test/', { initiatorType: 'navigation' }), 'document');
  assert.equal(classify('https://x.test/embed', { initiatorType: 'iframe' }), 'document');
  assert.equal(classify('https://x.test/sw', { initiatorType: 'serviceworker' }), 'script');
  assert.equal(classify('https://x.test/unknown'), 'other');
});
