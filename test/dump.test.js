/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDump, inlineExtension } from '../src/lib/dump.js';
import { readZip, readZipAsMap } from './helpers/zip-reader.js';

const text = (bytes) => new TextDecoder().decode(bytes);
const inlineMap = Buffer.from(JSON.stringify({ version: 3, sources: ['inline/src.ts'], sourcesContent: ['let inline = true;'], mappings: '' })).toString('base64');

const routes = {
  '/': ['text/html; charset=utf-8', '<!doctype html><title>Test</title>'],
  '/js/app.js': ['application/javascript', 'console.log(1);\n//# sourceMappingURL=app.js.map\n', { 'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }],
  '/js/app.js.map': ['application/json', JSON.stringify({
    version: 3, sources: ['webpack:///./src/a.js', 'webpack:///./src/b.js', 'webpack:///./src/missing.js'],
    sourcesContent: ['export const a = 1;\n', 'export const b = 2;\n', null], mappings: '',
  })],
  '/js/other.js': ['application/javascript', 'console.log(2);\n//# sourceMappingURL=other.js.map\n'],
  '/js/other.js.map': ['application/json', JSON.stringify({
    version: 3, sources: ['webpack:///./src/a.js', 'webpack:///./src/c.js'],
    sourcesContent: ['export const a = 1;\n', 'export const c = 3;\n'], mappings: '',
  })],
  '/js/inline.js': ['text/javascript', `var x;\n//# sourceMappingURL=data:application/json;base64,${inlineMap}\n`],
  '/js/header.js': ['text/javascript', 'var h;', { SourceMap: '/maps/header.map' }],
  '/maps/header.map': ['application/octet-stream', JSON.stringify({ version: 3, sources: ['h.ts'], sourcesContent: ['const h = 1;'], mappings: '' })],
  '/css/style.css': ['text/css', 'body{}\n/*# sourceMappingURL=style.css.map */'],
  '/css/style.css.map': ['application/json', JSON.stringify({ version: 3, sources: ['style.scss'], sourcesContent: ['body {}'], mappings: '' })],
  '/api/users': ['application/json', '[{"id":1}]'],
  '/bundle.php': ['application/javascript', 'var php;'],
  '/big.bin': ['application/octet-stream', 'x'.repeat(5000)],
  '/old.js': [302, '/js/app.js'],
};

let server;
let origin;

before(async () => {
  server = createServer((req, res) => {
    const route = routes[req.url];
    if (req.url === '/slow') return; // never answers → timeout
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (route[0] === 302) {
      res.writeHead(302, { location: route[1] });
      res.end();
      return;
    }
    const [type, body, extraHeaders] = route;
    res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...(extraHeaders || {}) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('inlineExtension', () => {
  assert.equal(inlineExtension('script', ''), '.js');
  assert.equal(inlineExtension('script', 'module'), '.js');
  assert.equal(inlineExtension('script', 'application/ld+json'), '.json');
  assert.equal(inlineExtension('script', 'importmap'), '.json');
  assert.equal(inlineExtension('script', 'text/x-template'), '.html');
  assert.equal(inlineExtension('script', 'text/weird'), '.txt');
  assert.equal(inlineExtension('style'), '.css');
  assert.equal(inlineExtension('document'), '.html');
});

test('createDump fetches, follows source maps, extracts sources and writes a manifest', async () => {
  const pageUrl = `${origin}/`;
  const item = (path, category, initiatorType) => ({ url: `${origin}${path}`, category, initiatorType });
  const job = {
    pageUrl,
    pageTitle: 'Test',
    items: [
      item('/', 'document', 'navigation'),
      item('/js/app.js', 'script', 'script'),
      item('/js/other.js', 'script', 'script'),
      item('/js/inline.js', 'script', 'script'),
      item('/js/header.js', 'script', 'script'),
      item('/css/style.css', 'style', 'link'),
      item('/api/users', 'xhr', 'fetch'),
      item('/bundle.php', 'script', 'script'),
      item('/big.bin', 'other', 'other'),
      item('/missing.js', 'script', 'script'),
      item('/slow', 'xhr', 'fetch'),
      item('/old.js', 'script', 'script'),
      item('/js/app.js', 'script', 'script'), // duplicate
      { url: 'blob:https://example.com/abc', category: 'script' },
      { category: 'script', inline: { kind: 'script', index: 1, type: 'module', frameUrl: pageUrl, frameIndex: 0, content: 'import "x";' } },
      { category: 'style', inline: { kind: 'style', index: 1, type: 'text/css', frameUrl: 'about:blank', frameIndex: 2, content: 'p{}' } },
      { category: 'document', inline: { kind: 'document', index: 0, type: 'text/html', frameUrl: pageUrl, frameIndex: 0, content: '<html></html>' } },
    ],
    options: { maxFileBytes: 4000, timeoutMs: 300, concurrency: 3 },
  };
  const progress = [];
  const now = () => new Date(2026, 0, 2, 3, 4, 5);
  const { blob, filename, root, manifest } = await createDump(job, { onProgress: (p) => progress.push(p), now, generator: 'DevGrab test' });

  assert.match(root, /^devgrab_127\.0\.0\.1_\d+_20260102-030405$/);
  assert.equal(filename, `${root}.zip`);
  const archive = new Uint8Array(await blob.arrayBuffer());
  const entries = await readZipAsMap(archive);
  const appEntry = readZip(archive).find((e) => e.name.endsWith('/js/app.js'));
  assert.equal(appEntry.mtime.getFullYear(), 2015, 'Last-Modified becomes the entry time');
  assert.equal(appEntry.mtime.getMonth(), 9);
  const names = [...entries.keys()].map((n) => n.slice(root.length + 1)).sort();
  const host = entries.keys().next().value.split('/')[1];
  assert.equal(host.startsWith('127.0.0.1_'), true, 'host directory includes the port');

  const expect = (suffix) => assert.ok(names.some((n) => n.endsWith(suffix)), `missing ${suffix} in ${names.join(', ')}`);
  expect('/index.html');
  expect('/js/app.js');
  expect('/js/app.js.map');
  expect('/js/other.js');
  expect('/js/inline.js');
  expect('/js/inline.js.map');
  expect('/js/header.js');
  expect('/maps/header.map');
  expect('/css/style.css');
  expect('/css/style.css.map');
  expect('/api/users.json');
  expect('/bundle.php.js');
  expect('/old.js');
  expect('/_inline/script-001.js');
  expect('/_inline/frame-2/style-001.css');
  expect('/_inline/dom-snapshot.html');
  expect('_sources/src/a.js');
  expect('_sources/src/b.js');
  expect('_sources/src/c.js');
  expect('_sources/inline/src.ts');
  expect('_sources/h.ts');
  expect('_sources/style.scss');
  expect('_devgrab/manifest.json');
  assert.ok(!names.some((n) => n.includes('big.bin')), 'oversized file is skipped');
  assert.ok(!names.some((n) => n.includes('missing')), '404 is skipped');
  assert.equal(names.filter((n) => n.endsWith('_sources/src/a.js')).length, 1, 'identical sources are stored once');

  assert.equal(text(entries.get(`${root}/${host}/js/app.js`)), routes['/js/app.js'][1]);
  assert.equal(text(entries.get(`${root}/_sources/src/c.js`)), 'export const c = 3;\n');

  const parsed = JSON.parse(text(entries.get(`${root}/_devgrab/manifest.json`)));
  assert.deepEqual(parsed, manifest);
  assert.equal(manifest.generator, 'DevGrab test');
  assert.equal(manifest.page.url, pageUrl);
  assert.equal(manifest.stats.sources, 6);
  assert.equal(manifest.stats.skipped, 4);
  const skippedErrors = Object.fromEntries(manifest.skipped.map((s) => [s.url, s.error]));
  assert.equal(skippedErrors[`${origin}/missing.js`], 'HTTP 404');
  assert.match(skippedErrors[`${origin}/big.bin`], /too large/);
  assert.match(skippedErrors[`${origin}/slow`], /timeout/);
  assert.equal(skippedErrors['blob:https://example.com/abc'], 'unsupported URL scheme');

  const byUrl = Object.fromEntries(manifest.files.filter((f) => f.url).map((f) => [f.url, f]));
  assert.equal(byUrl[`${origin}/old.js`].finalUrl, `${origin}/js/app.js`, 'redirect target is recorded');
  assert.equal(byUrl[`${origin}/old.js`].sourceMapUrl, `${origin}/js/app.js.map`, 'map resolved against the final URL');
  assert.equal(byUrl[`${origin}/js/app.js.map`].derivedFrom, `${origin}/js/app.js`);
  assert.equal(byUrl[`${origin}/js/app.js.map`].sourcesExtracted, 2);
  assert.equal(byUrl[`${origin}/js/app.js.map`].sourcesWithoutContent, 1);
  assert.equal(byUrl[`${origin}/js/other.js.map`].sourcesDuplicate, 1);
  assert.equal(byUrl[`${origin}/js/inline.js`].sourceMapUrl, 'data:…');
  assert.equal(byUrl[`${origin}/js/header.js`].sourceMapUrl, `${origin}/maps/header.map`);
  assert.equal(byUrl[`${origin}/api/users`].contentType, 'application/json');
  const inlineMapRecord = manifest.files.find((f) => f.inlineSourceMapOf);
  assert.equal(inlineMapRecord.sourcesExtracted, 1);
  const inlineItems = manifest.files.filter((f) => f.inline);
  assert.equal(inlineItems.length, 3);

  assert.ok(progress.length >= 2);
  const last = progress[progress.length - 1];
  assert.equal(last.done, last.total);
  assert.equal(last.total, 16, 'derived source maps are counted');
});

test('createDump without source map options', async () => {
  const job = { pageUrl: `${origin}/`, items: [{ url: `${origin}/js/app.js`, category: 'script' }], options: { fetchSourceMaps: false } };
  const { manifest } = await createDump(job);
  assert.equal(manifest.stats.files, 1);
  assert.equal(manifest.files[0].sourceMapUrl, undefined);
  const job2 = { pageUrl: `${origin}/`, items: [{ url: `${origin}/js/app.js`, category: 'script' }], options: { extractSources: false } };
  const { manifest: manifest2 } = await createDump(job2);
  assert.equal(manifest2.stats.files, 2);
  assert.equal(manifest2.stats.sources, 0);
});
