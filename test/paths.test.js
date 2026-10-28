/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PathAllocator, archiveBaseName, chooseExtension, downloadsSafePath, hostDirectory, inlineArchivePath,
  sanitizeSegment, sourcePathToArchivePath, splitExtension, urlToArchivePath,
} from '../src/lib/paths.js';

test('sanitizeSegment makes components file-system safe', () => {
  assert.equal(sanitizeSegment('app.js'), 'app.js');
  assert.equal(sanitizeSegment('a%20b.js'), 'a b.js');
  assert.equal(sanitizeSegment('bad:name?x*y|z<1>"2"'), 'bad_name_x_y_z_1__2_');
  assert.equal(sanitizeSegment('..'), '_');
  assert.equal(sanitizeSegment('.'), '_');
  assert.equal(sanitizeSegment('trailing. '), 'trailing');
  assert.equal(sanitizeSegment('.htaccess'), '.htaccess');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('com1.txt'), '_com1.txt');
  assert.equal(sanitizeSegment('%E0%A4%A'), '%E0%A4%A', 'invalid percent-encoding is kept');
  const long = sanitizeSegment(`${'x'.repeat(300)}.js`);
  assert.ok(new TextEncoder().encode(long).length <= 200);
  assert.match(long, /^x+~[0-9a-z]{6}\.js$/);
});

test('splitExtension', () => {
  assert.deepEqual(splitExtension('app.min.js'), { base: 'app.min', ext: '.js' });
  assert.deepEqual(splitExtension('index'), { base: 'index', ext: '' });
  assert.deepEqual(splitExtension('.htaccess'), { base: '.htaccess', ext: '' });
  assert.deepEqual(splitExtension('archive.tar.gz'), { base: 'archive.tar', ext: '.gz' });
  assert.deepEqual(splitExtension('site.webmanifest'), { base: 'site', ext: '.webmanifest' });
});

test('hostDirectory', () => {
  assert.equal(hostDirectory('https://Example.com/a'), 'example.com');
  assert.equal(hostDirectory('http://localhost:8080/'), 'localhost_8080');
  assert.equal(hostDirectory('http://[::1]:3000/'), '__1_3000');
  assert.equal(hostDirectory('file:///tmp/x.html'), 'file');
  assert.equal(hostDirectory('https://münchen.example/'), 'xn--mnchen-3ya.example');
});

test('urlToArchivePath mirrors the URL structure', () => {
  assert.equal(urlToArchivePath('https://cdn.example.com/js/app.js'), 'cdn.example.com/js/app.js');
  assert.equal(urlToArchivePath('https://example.com/'), 'example.com/index');
  assert.equal(urlToArchivePath('https://example.com/', { contentType: 'text/html; charset=utf-8' }), 'example.com/index.html');
  assert.equal(urlToArchivePath('https://example.com/docs/', { category: 'document' }), 'example.com/docs/index.html');
  assert.equal(urlToArchivePath('https://example.com/js/app.js?v=1.2.3'), 'example.com/js/app~v=1.2.3.js');
  assert.equal(urlToArchivePath('https://example.com/api/users?page=2&sort=name', { contentType: 'application/json' }), 'example.com/api/users~page=2&sort=name.json');
  assert.equal(urlToArchivePath('https://example.com/bundle.php', { contentType: 'application/javascript' }), 'example.com/bundle.php.js');
  assert.equal(urlToArchivePath('https://example.com/static/chunk', { contentType: 'text/javascript' }), 'example.com/static/chunk.js');
  assert.equal(urlToArchivePath('https://example.com/a/b/c.map', { contentType: 'application/json' }), 'example.com/a/b/c.map');
  assert.equal(urlToArchivePath('https://example.com/map', { contentType: 'application/json', category: 'sourcemap' }), 'example.com/map.map');
  assert.equal(urlToArchivePath('https://example.com/raw', { contentType: 'text/plain' }), 'example.com/raw.txt');
  assert.equal(urlToArchivePath('https://example.com/file.txt', { contentType: 'text/plain' }), 'example.com/file.txt');
  assert.equal(urlToArchivePath('https://example.com/caf%C3%A9/na%C3%AFve.css'), 'example.com/café/naïve.css');
  assert.equal(urlToArchivePath('https://example.com/x/..%2F..%2Fetc/passwd'), 'example.com/x/.._.._etc/passwd');
  assert.equal(urlToArchivePath('https://example.com/noext', { category: 'script' }), 'example.com/noext.js');
  const longQuery = urlToArchivePath(`https://example.com/a.js?${'q'.repeat(100)}`);
  assert.match(longQuery, /^example\.com\/a~q{41}~[0-9a-z]{6}\.js$/);
});

test('chooseExtension', () => {
  assert.equal(chooseExtension('', { contentType: 'text/css' }), '.css');
  assert.equal(chooseExtension('.css', { contentType: 'text/css' }), '.css');
  assert.equal(chooseExtension('.txt', { contentType: 'text/css' }), '.txt.css');
  assert.equal(chooseExtension('.php', { contentType: 'text/html' }), '.php');
  assert.equal(chooseExtension('', { contentType: '' }), '');
  assert.equal(chooseExtension('', { category: 'style' }), '.css');
  assert.equal(chooseExtension('.JS', { contentType: 'application/javascript' }), '.JS');
});

test('sourcePathToArchivePath', () => {
  assert.equal(sourcePathToArchivePath('webpack:///./src/App.tsx'), '_sources/src/App.tsx');
  assert.equal(sourcePathToArchivePath('webpack://my-app/./src/a.js'), '_sources/my-app/src/a.js');
  assert.equal(sourcePathToArchivePath('../../src/main.ts'), '_sources/src/main.ts');
  assert.equal(sourcePathToArchivePath('src/a.js', 'webpack:///'), '_sources/src/a.js');
  assert.equal(sourcePathToArchivePath('/src/a.js', 'https://example.com/root/'), '_sources/example.com/root/src/a.js');
  assert.equal(sourcePathToArchivePath('C:\\dev\\app\\src\\a.js'), '_sources/dev/app/src/a.js');
  assert.equal(sourcePathToArchivePath(''), '_sources/unnamed');
  assert.equal(sourcePathToArchivePath('./src/App.vue?vue&type=template'), '_sources/src/App.vue_vue&type=template');
});

test('inlineArchivePath and archiveBaseName', () => {
  assert.equal(inlineArchivePath('https://example.com/x', { kind: 'script', index: 3, ext: '.js' }), 'example.com/_inline/script-003.js');
  assert.equal(inlineArchivePath('https://example.com/x', { frameIndex: 2, kind: 'document' }), 'example.com/_inline/frame-2/dom-snapshot.html');
  assert.equal(archiveBaseName('https://example.com/x', new Date(2026, 0, 31, 14, 25, 1)), 'devgrab_example.com_20260131-142501');
});

test('downloadsSafePath avoids leading dots', () => {
  assert.equal(downloadsSafePath('example.com/.well-known/x.json'), 'example.com/_well-known/x.json');
});

test('PathAllocator resolves collisions', () => {
  const allocator = new PathAllocator();
  assert.equal(allocator.allocate('example.com/a.js'), 'example.com/a.js');
  assert.equal(allocator.allocate('example.com/A.JS'), 'example.com/A~2.JS', 'case-insensitive');
  assert.equal(allocator.allocate('example.com/a.js'), 'example.com/a~3.js');
  assert.equal(allocator.allocate('example.com/api/users'), 'example.com/api/users');
  assert.equal(allocator.allocate('example.com/api/users/1.json'), 'example.com/api/users~dir/1.json', 'file blocks directory');
  assert.equal(allocator.allocate('example.com/api'), 'example.com/api~2', 'directory blocks file');
  assert.ok(allocator.has('example.com/a.js'));
});
