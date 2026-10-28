/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originPatterns } from '../src/lib/permissions.js';

test('originPatterns drops ports, paths and duplicates and ignores other schemes', () => {
  assert.deepEqual(originPatterns([
    'http://localhost:3000/js/app.js',
    'http://localhost:3000/css/a.css?v=1',
    'https://cdn.example.net/x.js',
    'https://cdn.example.net:8443/y.js',
    'blob:https://example.com/abc',
    'data:text/plain,x',
    'not a url',
  ]), ['http://localhost/*', 'https://cdn.example.net/*']);
  assert.deepEqual(originPatterns([]), []);
});
