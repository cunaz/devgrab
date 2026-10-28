/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Background event page: runs download jobs started from the popup so they
 * survive the popup closing, and hands the result to the downloads API.
 *
 * Messages (runtime.sendMessage):
 *   { type: 'job:start', job }  → { ok, id | error }
 *   { type: 'job:status' }      → current job snapshot or null
 * Broadcasts { type: 'job:update', ...snapshot } while a job runs.
 */

import { createDump, inlineItemPath } from './lib/dump.js';
import { PathAllocator, archiveBaseName, downloadsSafePath, urlToArchivePath } from './lib/paths.js';

const KEEPALIVE_INTERVAL_MS = 20_000;

let current = null; // { id, mode, state: 'running' | 'done' | 'error', progress, startedAt, result?, error? }
let keepAliveTimer = null;
const objectUrls = new Map(); // download id → blob: URL to revoke when the download finishes

function snapshot() {
  if (!current) return null;
  const { id, mode, state, progress, startedAt, result, error } = current;
  return { id, mode, state, progress, startedAt, result, error };
}

function broadcast() {
  browser.runtime.sendMessage({ type: 'job:update', ...snapshot() }).catch(() => {
    // No popup open: nobody is listening, which is fine.
  });
}

/**
 * Firefox unloads event pages after about 30 s without extension API activity.
 * A dump can take longer, and the blob: URL handed to downloads.download() only
 * lives as long as this page. A cheap API call every 20 s resets the idle timer
 * while work is in flight; the timer stops as soon as nothing is pending.
 */
function updateKeepAlive() {
  const busy = (current && current.state === 'running') || objectUrls.size > 0;
  if (busy && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => browser.runtime.getPlatformInfo().catch(() => {}), KEEPALIVE_INTERVAL_MS);
  } else if (!busy && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function trackObjectUrl(downloadId, url) {
  objectUrls.set(downloadId, url);
  updateKeepAlive();
}

browser.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !objectUrls.has(delta.id)) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    URL.revokeObjectURL(objectUrls.get(delta.id));
    objectUrls.delete(delta.id);
    updateKeepAlive();
  }
});

async function saveArchive(job) {
  const { blob, filename, manifest } = await createDump(job, {
    generator: `DevGrab ${browser.runtime.getManifest().version}`,
    onProgress: (progress) => {
      current.progress = progress;
      broadcast();
    },
  });
  const url = URL.createObjectURL(blob);
  let downloadId;
  try {
    downloadId = await browser.downloads.download({ url, filename, conflictAction: 'uniquify' });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  trackObjectUrl(downloadId, url);
  return { filename, downloadId, ...manifest.stats };
}

/** Hands every selected URL to the download manager; needs no host permissions. */
async function saveIndividually(job) {
  const root = archiveBaseName(job.pageUrl);
  const allocator = new PathAllocator();
  const failures = [];
  let started = 0;
  for (const item of job.items) {
    let url = item.url;
    try {
      let path;
      if (item.inline) {
        url = URL.createObjectURL(new Blob([item.inline.content || ''], { type: 'text/plain' }));
        path = inlineItemPath(item, job.pageUrl);
      } else {
        path = urlToArchivePath(item.url, { category: item.category });
      }
      const filename = downloadsSafePath(`${root}/${allocator.allocate(path)}`);
      const downloadId = await browser.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
      if (item.inline) trackObjectUrl(downloadId, url);
      started++;
    } catch (error) {
      if (item.inline && url) URL.revokeObjectURL(url);
      failures.push({ url: item.url || `inline ${item.inline.kind}`, error: String(error && error.message || error) });
    }
    current.progress = { done: started + failures.length, total: job.items.length };
    broadcast();
  }
  return { root, started, failed: failures.length, failures: failures.slice(0, 20) };
}

async function run(job) {
  const me = current;
  try {
    me.result = job.mode === 'individual' ? await saveIndividually(job) : await saveArchive(job);
    me.state = 'done';
  } catch (error) {
    me.state = 'error';
    me.error = String(error && error.message || error);
  } finally {
    updateKeepAlive();
    broadcast();
  }
}

function startJob(job) {
  if (!job || !Array.isArray(job.items) || !job.pageUrl) return { ok: false, error: 'invalid job' };
  if (current && current.state === 'running') return { ok: false, error: 'busy' };
  current = {
    id: Date.now(),
    mode: job.mode === 'individual' ? 'individual' : 'zip',
    state: 'running',
    progress: { done: 0, total: job.items.length },
    startedAt: Date.now(),
  };
  updateKeepAlive();
  run(job);
  return { ok: true, id: current.id };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!sender || sender.id !== browser.runtime.id) return undefined;
  if (!message || typeof message.type !== 'string') return undefined;
  switch (message.type) {
    case 'job:start':
      return Promise.resolve(startJob(message.job));
    case 'job:status':
      return Promise.resolve(snapshot());
    default:
      return undefined;
  }
});
