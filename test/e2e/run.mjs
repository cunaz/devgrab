/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end test in a real Firefox, driven over WebDriver (geckodriver).
 *
 * Requirements: Firefox 140 or newer (set FIREFOX_BIN when it is not on PATH
 * as "firefox") and geckodriver (devDependency). Run with: npm run test:e2e
 *
 * The run starts a local test site (two origins, a service worker, a
 * cookie-protected file, and responses slowed down so that the job outlives
 * the 30 s event-page timeout), installs the extension temporarily, grants
 * access to the site's origin the way a user does in about:addons, loads the
 * popup page in a second tab, downloads the ZIP (accepting Firefox's
 * site-access prompt for the second origin), saves the files individually and
 * checks everything on disk. Set E2E_HEADED=1 to watch it.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip, extractEntry } from '../helpers/zip-reader.js';
import { crc32 } from '../../src/lib/zip.js';

const HERE = new URL('.', import.meta.url).pathname;
const EXTENSION_DIR = join(HERE, '..', '..');
const SITE_PORT = 8800;
const DRIVER_PORT = 4444;
const DRIVER_URL = `http://127.0.0.1:${DRIVER_PORT}`;
const SITE_ORIGIN = `http://127.0.0.1:${SITE_PORT}`;
const SLOW_FILES = 24;

const workDir = mkdtempSync(join(tmpdir(), 'devgrab-e2e-'));
const downloads = join(workDir, 'downloads');
const requestLog = join(workDir, 'requests.jsonl');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
function check(condition, message) {
  console.log(`${condition ? ' ok ' : 'FAIL'} ${message}`);
  if (!condition) failures.push(message);
}

const site = spawn(process.execPath, [join(HERE, 'site.mjs')], {
  env: { ...process.env, PORT: String(SITE_PORT), LOG: requestLog, SLOW_FILES: String(SLOW_FILES) },
  stdio: 'ignore',
});
const driverArgs = ['--port', String(DRIVER_PORT), '--allow-system-access'];
if (process.env.FIREFOX_BIN) driverArgs.push('--binary', process.env.FIREFOX_BIN);
const driverLog = openSync(join(workDir, 'geckodriver.log'), 'w');
const driver = spawn(process.env.GECKODRIVER_BIN || 'geckodriver', driverArgs, { stdio: ['ignore', driverLog, driverLog] });
process.on('exit', () => {
  site.kill();
  driver.kill();
});

/* ---------- WebDriver helpers ---------- */

let sessionId;
async function request(method, path, body) {
  const response = await fetch(`${DRIVER_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const json = await response.json();
  if (json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
  return json.value;
}
const session = (method, path, body) => request(method, `/session/${sessionId}${path}`, body);
const execute = (script, ...args) => session('POST', '/execute/sync', { script, args });
const executeAsync = (script, ...args) => session('POST', '/execute/async', { script, args });
const setContext = (context) => session('POST', '/moz/context', { context });
async function inChrome(run, script, ...args) {
  await setContext('chrome');
  try {
    return await run(script, ...args);
  } finally {
    await setContext('content');
  }
}
const switchTo = (handle) => session('POST', '/window', { handle });
const textOf = (selector) => execute('const el = document.querySelector(arguments[0]); return el ? el.textContent : null;', selector);
async function click(selector) {
  const element = await session('POST', '/element', { using: 'css selector', value: selector });
  await session('POST', `/element/${Object.values(element)[0]}/click`);
}
async function waitForStatus(pattern, timeoutMs) {
  const started = Date.now();
  let status = '';
  while (Date.now() - started < timeoutMs) {
    status = (await textOf('#status-text')) || '';
    if (pattern.test(status)) break;
    await sleep(1000);
  }
  return { status, seconds: Math.round((Date.now() - started) / 1000) };
}
/** Accepts the "allow this extension to access …" doorhanger if it is showing. */
const acceptPermissionPrompt = () => inChrome(execute, `
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const notification = win.PopupNotifications.getNotification("addon-webext-permissions");
  if (!notification) return false;
  const element = win.document.getElementById("addon-webext-permissions-notification");
  if (element && element.button) element.button.click(); else notification.mainAction.callback({});
  return true;
`);
const listFiles = (dir, prefix = '') => readdirSync(dir).flatMap((name) => (
  statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));

/* ---------- the run ---------- */

for (let attempt = 0; attempt < 60; attempt++) {
  try {
    await fetch(`${DRIVER_URL}/status`);
    break;
  } catch {
    await sleep(250);
  }
}
const created = await request('POST', '/session', { capabilities: { alwaysMatch: { 'moz:firefoxOptions': {
  args: process.env.E2E_HEADED ? [] : ['-headless'],
  prefs: {
    'browser.download.folderList': 2,
    'browser.download.dir': downloads,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.alwaysOpenPanel': false,
    'browser.startup.page': 0,
    'browser.startup.homepage': 'about:blank',
  },
} } } });
sessionId = created.sessionId;
console.log(`Firefox ${created.capabilities.browserVersion}, work dir ${workDir}`);

try {
  const addonId = await session('POST', '/moz/addon/install', { path: EXTENSION_DIR, temporary: true });
  const popupUrl = await inChrome(execute, 'return WebExtensionPolicy.getByID(arguments[0]).getURL("src/popup/popup.html");', addonId);
  // The user grants access to the site in about:addons; there is no toolbar click (activeTab) in this harness.
  await inChrome(executeAsync, `
    const done = arguments[arguments.length - 1];
    const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
    ExtensionPermissions.add(arguments[0], { permissions: [], origins: ["http://127.0.0.1/*"] }, WebExtensionPolicy.getByID(arguments[0]).extension)
      .then(() => done("ok"), (error) => done("error " + error));
  `, addonId);

  await session('POST', '/url', { url: `${SITE_ORIGIN}/` });
  await sleep(5000);
  const pageHandle = await session('GET', '/window');
  const controller = await execute('return navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null;');
  check(controller === `${SITE_ORIGIN}/sw.js`, 'test page is controlled by its service worker');

  // The popup page runs in a second tab; the scan must happen while the test page is the active tab.
  const { handle: popupHandle } = await session('POST', '/window/new', { type: 'tab' });
  await switchTo(popupHandle);
  await session('POST', '/url', { url: popupUrl });
  await sleep(1500);
  await execute("setTimeout(() => document.getElementById('rescan').click(), 3000);");
  await switchTo(pageHandle);
  await sleep(9000);
  await switchTo(popupHandle);

  const scan = await execute(`
    for (const button of document.querySelectorAll('.expand')) if (button.getAttribute('aria-expanded') === 'false') button.click();
    return {
      summary: document.getElementById('summary').textContent,
      message: document.getElementById('message').textContent,
      items: [...document.querySelectorAll('.category')].flatMap((section) =>
        [...section.querySelectorAll('.items li')].map((li) => section.dataset.category + ' ' + (li.querySelector('.item-host') ? li.querySelector('.item-host').textContent : 'inline') + ' ' + li.querySelector('.item-name').textContent)),
    };
  `);
  console.log(`scan: ${scan.summary}${scan.message ? ` (${scan.message})` : ''}`);
  const has = (entry) => scan.items.includes(entry);
  check(has(`script 127.0.0.1:${SITE_PORT} app.js`), 'external script listed');
  check(has(`script 127.0.0.1:${SITE_PORT} sw.js`), 'service worker script listed');
  check(has('script inline script #1'), 'inline script listed');
  check(has(`document localhost:${SITE_PORT} frame.html`), 'cross-origin iframe document listed');
  check(has('document inline dom-snapshot.html'), 'DOM snapshot listed');
  check(has(`data 127.0.0.1:${SITE_PORT} private.json`), 'cookie-protected JSON listed as data');
  check(has(`xhr 127.0.0.1:${SITE_PORT} api/items`), 'extension-less API call listed as xhr');
  check(scan.items.filter((entry) => entry.includes('slow-')).length === SLOW_FILES, `all ${SLOW_FILES} dynamically added scripts listed`);

  await click('#download-zip');
  await sleep(1500);
  check(await acceptPermissionPrompt(), 'site-access prompt shown for the second origin and accepted');
  const zipRun = await waitForStatus(/Done|Error/, 180000);
  console.log(`zip job: ${zipRun.status} (${zipRun.seconds} s)`);
  check(/^Done/.test(zipRun.status), 'zip job finished');
  check(zipRun.seconds > 30, 'job outlived the 30 s event-page idle timeout');
  await sleep(2000);

  const zipName = readdirSync(downloads).find((name) => name.endsWith('.zip'));
  check(Boolean(zipName), 'zip file was saved');
  if (zipName) {
    const entries = readZip(new Uint8Array(readFileSync(join(downloads, zipName))));
    let corrupt = 0;
    for (const entry of entries) if (crc32(await extractEntry(entry)) !== entry.crc) corrupt++;
    check(corrupt === 0, `all ${entries.length} archive entries pass their CRC check`);
    const names = entries.map((entry) => entry.name.slice(entry.name.indexOf('/') + 1));
    const manifest = JSON.parse(new TextDecoder().decode(await extractEntry(entries.find((entry) => entry.name.endsWith('_devgrab/manifest.json')))));
    check(manifest.skipped.length === 0, `nothing skipped (${JSON.stringify(manifest.skipped)})`);
    check(names.includes(`localhost_${SITE_PORT}/frame.html`), 'iframe document from the second origin fetched after the prompt');
    check(names.includes(`127.0.0.1_${SITE_PORT}/js/app.js.map`) && names.includes('_sources/src/index.ts'), 'source map followed and sources extracted');
    check(names.includes(`127.0.0.1_${SITE_PORT}/css/main.css.map`) && names.includes('_sources/main.scss'), 'CSS source map followed');
    check(manifest.files.some((file) => (file.url || '').endsWith('/api/private.json') && file.status === 200), 'cookie-protected file fetched with credentials');
    check(names.filter((name) => name.includes('/js/slow-')).length === SLOW_FILES, 'all slow scripts fetched');
    check(names.includes(`127.0.0.1_${SITE_PORT}/_inline/dom-snapshot.html`), 'DOM snapshot stored');
    check(entries.find((entry) => entry.name.endsWith('/js/app.js')).mtime.getFullYear() === 2015, 'Last-Modified kept as entry time');
  }

  await click('#save-individually');
  const individual = await waitForStatus(/downloads started|Error/, 60000);
  console.log(`individual: ${individual.status}`);
  await sleep(3000);
  const files = listFiles(downloads);
  check(files.some((file) => file.endsWith(`/localhost_${SITE_PORT}/frame.html`)), 'individual mode: subfolders created, no site access needed');
  check(files.some((file) => file.endsWith('/_inline/dom-snapshot.html')), 'individual mode: inline content saved via blob URL');
  check(/0 failed/.test(individual.status), 'individual mode: no failed downloads');
} finally {
  await session('DELETE', '').catch(() => {});
}

console.log(failures.length ? `\n${failures.length} check(s) failed; artifacts kept in ${workDir}` : `\nall checks passed`);
if (!failures.length) rmSync(workDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
