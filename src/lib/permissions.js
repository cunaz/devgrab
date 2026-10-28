/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host permission patterns for a set of URLs.
 *
 * Firefox match patterns do not support port numbers (Firefox bug 1362809):
 * "http://localhost:3000/*" is accepted by permissions.request() but never
 * matches anything, while "http://localhost/*" matches every port. So the
 * patterns are built from scheme and host name only.
 */
export function originPatterns(urls) {
  const patterns = new Set();
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') patterns.add(`${parsed.protocol}//${parsed.hostname}/*`);
  }
  return [...patterns];
}
