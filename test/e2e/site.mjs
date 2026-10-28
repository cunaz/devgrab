/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Test site for the Firefox end-to-end run. Two origins: 127.0.0.1 (top page) and localhost (iframe).
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 8800);
const SLOW_MS = Number(process.env.SLOW_MS || 9000);
const SLOW_FILES = Number(process.env.SLOW_FILES || 24);
const LOG = process.env.LOG || '';
const hits = new Map();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const slowLoaders = Array.from({ length: SLOW_FILES }, (_, i) =>
  `document.head.append(Object.assign(document.createElement('script'), { src: '/js/slow-${i}.js', async: true }));`).join('\n  ');

const page = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>DevGrab E2E</title>
<link rel="stylesheet" href="/css/main.css">
<script src="/js/app.js"></script>
<script type="application/ld+json">{"@type":"Thing"}</script>
<script>window.__inline = 1;</script>
<style>body { background: url("/img/bg.png") }</style>
</head><body>
<h1>E2E</h1>
<img src="/img/a.png" srcset="/img/a@2x.png 2x">
<iframe src="http://localhost:${PORT}/frame.html"></iframe>
<script>
  navigator.serviceWorker.register('/sw.js');
  fetch('/api/items').then((r) => r.json());
  fetch('/api/private.json', { credentials: 'include' });
  ${slowLoaders}
</script>
</body></html>`;

const routes = {
  '/': ['text/html; charset=utf-8', page, { 'Set-Cookie': 'session=secret; Path=/; SameSite=Lax' }],
  '/frame.html': ['text/html; charset=utf-8', '<!DOCTYPE html><html><head><script src="/js/frame.js"></script><style>p{}</style></head><body><p>frame</p><script>fetch("/api/frame.json")</script></body></html>'],
  '/js/app.js': ['application/javascript', 'console.log("app");\n//# sourceMappingURL=app.js.map\n', { 'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }],
  '/js/app.js.map': ['application/json', JSON.stringify({ version: 3, sources: ['webpack:///./src/index.ts', 'webpack:///./src/util.ts'], sourcesContent: ['export const x = 1;\n', 'export const y = 2;\n'], mappings: '' })],
  '/js/frame.js': ['application/javascript', 'console.log("frame")'],
  '/css/main.css': ['text/css', '@import url("/css/theme.css");\n.a { background: url("/img/css.png") }\n/*# sourceMappingURL=main.css.map */'],
  '/css/main.css.map': ['application/json', JSON.stringify({ version: 3, sources: ['main.scss'], sourcesContent: ['.a {}'], mappings: '' })],
  '/css/theme.css': ['text/css', '.t { color: red }'],
  '/sw.js': ['application/javascript', 'self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim())); self.addEventListener("fetch", () => {});'],
  '/api/items': ['application/json', '[{"id":1}]'],
  '/api/frame.json': ['application/json', '{"frame":true}'],
  '/img/a.png': ['image/png', png],
  '/img/a@2x.png': ['image/png', png],
  '/img/bg.png': ['image/png', png],
  '/img/css.png': ['image/png', png],
};

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), url, host: req.headers.host, cookie: req.headers.cookie || null, origin: req.headers.origin || null, fetchSite: req.headers['sec-fetch-site'] || null })}\n`);
  const send = (status, type, body, extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra });
    res.end(body);
  };
  if (url === '/api/private.json') {
    if ((req.headers.cookie || '').includes('session=secret')) return send(200, 'application/json', '{"private":true}');
    return send(403, 'application/json', '{"error":"no cookie"}');
  }
  const slow = /^\/js\/slow-(\d+)\.js$/.exec(url);
  if (slow) {
    const n = (hits.get(url) || 0) + 1;
    hits.set(url, n);
    const body = `console.log(${slow[1]});`;
    if (n === 1) return send(200, 'application/javascript', body);
    return void setTimeout(() => send(200, 'application/javascript', body), SLOW_MS);
  }
  const route = routes[url];
  if (!route) return send(404, 'text/plain', 'not found');
  send(200, route[0], route[1], route[2]);
});
server.listen(PORT, () => console.log(`site on ${PORT}`));
