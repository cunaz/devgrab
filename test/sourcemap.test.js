/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSourceMappingURL, iterateSources, parseDataURL, parseSourceMap, resolveSourceMapURL } from '../src/lib/sourcemap.js';

test('findSourceMappingURL finds the last reference in JS and CSS', () => {
  assert.equal(findSourceMappingURL('var a=1;\n//# sourceMappingURL=app.js.map\n'), 'app.js.map');
  assert.equal(findSourceMappingURL('body{}\n/*# sourceMappingURL=style.css.map */'), 'style.css.map');
  assert.equal(findSourceMappingURL('/*# sourceMappingURL=a.map*/'), 'a.map');
  assert.equal(findSourceMappingURL('//@ sourceMappingURL=old.map'), 'old.map');
  assert.equal(findSourceMappingURL('//# sourceMappingURL=first.map\n//# sourceMappingURL=second.map'), 'second.map');
  assert.equal(findSourceMappingURL('//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ=='), 'data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==');
  assert.equal(findSourceMappingURL('no map here'), null);
});

test('resolveSourceMapURL', () => {
  assert.equal(resolveSourceMapURL('app.js.map', 'https://x.test/js/app.js?v=1'), 'https://x.test/js/app.js.map');
  assert.equal(resolveSourceMapURL('/maps/app.map', 'https://x.test/js/app.js'), 'https://x.test/maps/app.map');
  assert.equal(resolveSourceMapURL('data:application/json,{}', 'https://x.test/a.js'), 'data:application/json,{}');
  assert.equal(resolveSourceMapURL('http://[', 'https://x.test/a.js'), null);
});

test('parseDataURL', () => {
  const base64 = parseDataURL('data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==');
  assert.equal(base64.mime, 'application/json');
  assert.equal(new TextDecoder().decode(base64.bytes), '{"version":3}');
  const plain = parseDataURL('data:,%7B%22a%22%3A1%7D');
  assert.equal(plain.mime, 'text/plain');
  assert.equal(new TextDecoder().decode(plain.bytes), '{"a":1}');
  assert.throws(() => parseDataURL('https://x.test/'), /not a data: URL/);
});

test('parseSourceMap and iterateSources', () => {
  const map = parseSourceMap(')]}\'\n{"version":3,"sources":["a.js","b.js"],"sourcesContent":["A",null],"sourceRoot":"webpack:///","mappings":""}');
  assert.deepEqual([...iterateSources(map)], [
    { source: 'a.js', content: 'A', sourceRoot: 'webpack:///' },
    { source: 'b.js', content: null, sourceRoot: 'webpack:///' },
  ]);
  const indexMap = parseSourceMap(JSON.stringify({
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['x.js'], sourcesContent: ['X'], mappings: '' } },
      { offset: { line: 10, column: 0 }, map: { version: 3, sources: ['y.js'], mappings: '' } },
    ],
  }));
  assert.deepEqual([...iterateSources(indexMap)].map((s) => [s.source, s.content]), [['x.js', 'X'], ['y.js', null]]);
  assert.throws(() => parseSourceMap('{"version":3}'), /not a source map/);
  assert.throws(() => parseSourceMap('nope'), SyntaxError);
});
