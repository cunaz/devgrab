/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Popup: scans the active tab, lets the user pick files by category and
 * starts a job in the background event page.
 *
 * Flow: init → scan (collector injected into every frame) → render →
 * "Download ZIP" (permissions.request, then job:start) → job:update messages
 * from the background drive the status line.
 */

import { collectPageResources } from '../content/collect.js';
import { CATEGORIES, DEFAULT_SELECTED, classify } from '../lib/classify.js';
import { originPatterns } from '../lib/permissions.js';
import { applyI18n, formatBytes, t } from './i18n.js';

const SETTINGS_DEFAULTS = Object.freeze({
  selectedCategories: [...DEFAULT_SELECTED],
  fetchSourceMaps: true,
  extractSources: true,
});
const QUERY_PREVIEW_LENGTH = 24;

const state = {
  tab: null,
  frames: [],
  items: [], // { id, url?, inline?, category, initiatorType?, size, host, name }
  selected: new Set(), // item ids
  settings: { ...SETTINGS_DEFAULTS },
  job: null, // last snapshot received from the background
};

const $ = (id) => document.getElementById(id);
const ui = {
  pageHost: $('page-host'),
  summary: $('summary'),
  message: $('message'),
  hintBuffer: $('hint-buffer'),
  categories: $('categories'),
  options: $('options'),
  optSourceMaps: $('opt-sourcemaps'),
  optExtract: $('opt-extract'),
  status: $('status'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  statusText: $('status-text'),
  downloadZip: $('download-zip'),
  saveIndividually: $('save-individually'),
  copyUrls: $('copy-urls'),
  rescan: $('rescan'),
};

const icon = (name) => $(`icon-${name}`).content.firstElementChild.cloneNode(true);

function showMessage(text, { error = false } = {}) {
  ui.message.textContent = text || '';
  ui.message.hidden = !text;
  ui.message.classList.toggle('error', error);
}

function setButtonsEnabled(enabled) {
  const running = state.job && state.job.state === 'running';
  for (const button of [ui.downloadZip, ui.saveIndividually, ui.copyUrls]) button.disabled = !enabled || running;
}

function safeHost(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/* ---------- scanning ---------- */

async function scan() {
  state.items = [];
  state.frames = [];
  ui.categories.replaceChildren();
  ui.options.hidden = true;
  ui.hintBuffer.hidden = true;
  setButtonsEnabled(false);
  showMessage(t('scanning'));

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  if (!tab || !/^(?:https?|file):/.test(tab.url || '')) {
    showMessage(t('unsupportedPage'), { error: true });
    return;
  }
  ui.pageHost.textContent = safeHost(tab.url);
  ui.pageHost.title = tab.url;

  let results;
  try {
    results = await browser.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: collectPageResources, args: [{}] });
  } catch (error) {
    showMessage(t('scanFailed', [errorText(error)]), { error: true });
    return;
  }
  const frames = results
    .filter((result) => result && result.result && !result.error)
    .map((result) => ({ frameId: result.frameId, ...result.result }))
    .sort((a, b) => Number(b.isTop) - Number(a.isTop) || a.frameId - b.frameId);
  if (frames.length === 0) {
    const failed = results.find((result) => result && result.error);
    showMessage(t('scanFailed', [failed ? errorText(failed.error) : '?']), { error: true });
    return;
  }
  state.frames = frames;
  state.items = buildItems(frames, tab.url);
  state.selected = new Set(state.items.filter((item) => state.settings.selectedCategories.includes(item.category)).map((item) => item.id));
  ui.hintBuffer.hidden = !frames.some((frame) => frame.warnings.includes('timing-buffer-full'));
  showMessage('');
  ui.options.hidden = false;
  render();
  setButtonsEnabled(true);
}

function buildItems(frames, pageUrl) {
  const items = [];
  const seen = new Set();
  frames.forEach((frame, frameIndex) => {
    for (const resource of frame.resources) {
      if (seen.has(resource.url)) continue;
      seen.add(resource.url);
      const url = new URL(resource.url);
      items.push({
        id: `r:${resource.url}`,
        url: resource.url,
        category: classify(resource.url, { initiatorType: resource.initiatorType }),
        initiatorType: resource.initiatorType,
        size: resource.size,
        host: url.host,
        name: displayName(url),
      });
    }
    for (const entry of frame.inline) {
      const category = entry.kind === 'script' ? 'script' : entry.kind === 'style' ? 'style' : 'document';
      items.push({
        id: `i:${frameIndex}:${entry.kind}:${entry.index}`,
        inline: { ...entry, frameUrl: frame.frameUrl, frameIndex },
        category,
        size: entry.size,
        host: safeHost(frame.frameUrl.startsWith('http') ? frame.frameUrl : pageUrl),
        name: entry.kind === 'document' ? 'dom-snapshot.html' : `${entry.kind} #${entry.index}`,
        preview: `${entry.id ? `#${entry.id} ` : ''}${entry.preview || ''}`.trim(),
      });
    }
  });
  return items.sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** "app.js", or "api/users" for extension-less paths, plus a shortened query string. */
function displayName(url) {
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments.pop() || '/';
  const parent = segments.pop();
  const name = parent && !/\.[A-Za-z0-9]{1,12}$/.test(last) ? `${parent}/${last}` : last;
  if (!url.search) return name;
  return url.search.length > QUERY_PREVIEW_LENGTH ? `${name}${url.search.slice(0, QUERY_PREVIEW_LENGTH)}…` : `${name}${url.search}`;
}

/* ---------- rendering ---------- */

function render() {
  const fragment = document.createDocumentFragment();
  for (const category of CATEGORIES) {
    const items = state.items.filter((item) => item.category === category);
    if (items.length > 0) fragment.append(createCategory(category, items));
  }
  ui.categories.replaceChildren(fragment);
  refreshSelection();
}

function createCheckbox(id) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = id;
  return box;
}

function createCategory(category, items) {
  const section = document.createElement('section');
  section.className = 'category';
  section.dataset.category = category;

  const row = document.createElement('div');
  row.className = 'category-row';
  const list = document.createElement('ul');
  list.className = 'items';
  list.id = `items-${category}`;
  list.hidden = true;
  list.append(...items.map(createItem));

  const toggle = createCheckbox(`category-${category}`);
  toggle.addEventListener('change', () => {
    for (const item of items) setSelected(item.id, toggle.checked);
    for (const box of list.querySelectorAll('input')) box.checked = toggle.checked;
    rememberCategory(category, toggle.checked);
    refreshSelection();
  });
  const label = document.createElement('label');
  label.htmlFor = toggle.id;
  label.textContent = t(`category_${category}`);
  const meta = document.createElement('span');
  meta.className = 'category-meta';
  const total = items.reduce((sum, item) => sum + (item.size || 0), 0);
  meta.textContent = total ? `${items.length} · ${formatBytes(total)}` : String(items.length);
  row.append(toggle, label, meta);
  if (category === 'xhr') {
    const hint = document.createElement('span');
    hint.className = 'hint-icon';
    hint.title = t('categoryHint_xhr');
    hint.append(icon('info'));
    row.append(hint);
  }

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'expand';
  expand.title = t('showFiles');
  expand.setAttribute('aria-expanded', 'false');
  expand.setAttribute('aria-controls', list.id);
  expand.append(icon('chevron'));
  expand.addEventListener('click', () => {
    list.hidden = !list.hidden;
    expand.classList.toggle('open', !list.hidden);
    expand.title = t(list.hidden ? 'showFiles' : 'hideFiles');
    expand.setAttribute('aria-expanded', String(!list.hidden));
  });
  row.append(expand);

  section.append(row, list);
  return section;
}

function createItem(item) {
  const li = document.createElement('li');
  const box = createCheckbox(`item-${item.id}`);
  box.checked = state.selected.has(item.id);
  box.addEventListener('change', () => {
    setSelected(item.id, box.checked);
    refreshSelection();
  });
  const label = document.createElement('label');
  label.htmlFor = box.id;
  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.name;
  label.append(name);
  if (item.inline) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t('inlineLabel');
    const preview = document.createElement('span');
    preview.className = 'item-preview';
    preview.textContent = item.preview;
    label.append(badge, preview);
    label.title = `${item.host} · ${item.name}${item.inline.type ? ` (${item.inline.type})` : ''}\n${item.inline.preview || ''}`;
  } else {
    const host = document.createElement('span');
    host.className = 'item-host';
    host.textContent = item.host;
    label.append(host);
    label.title = item.url;
  }
  const size = document.createElement('span');
  size.className = 'item-size';
  size.textContent = item.size ? formatBytes(item.size) : '';
  label.append(size);
  li.append(box, label);
  return li;
}

function setSelected(id, selected) {
  if (selected) state.selected.add(id);
  else state.selected.delete(id);
}

function selectedItems() {
  return state.items.filter((item) => state.selected.has(item.id));
}

/** Category checkboxes mirror their items (checked, unchecked or mixed); the header shows the counts. */
function refreshSelection() {
  for (const section of ui.categories.querySelectorAll('.category')) {
    const boxes = section.querySelectorAll('.items input');
    const checked = [...boxes].filter((box) => box.checked).length;
    const toggle = section.querySelector('.category-row input');
    toggle.checked = checked > 0 && checked === boxes.length;
    toggle.indeterminate = checked > 0 && checked < boxes.length;
  }
  const files = String(state.items.length);
  const summary = state.frames.length > 1 ? t('summaryFilesFrames', [files, String(state.frames.length)]) : t('summaryFiles', [files]);
  ui.summary.textContent = `${summary} · ${t('selectionSummary', [String(selectedItems().length)])}`;
}

/* ---------- settings ---------- */

async function loadSettings() {
  try {
    const stored = await browser.storage.local.get(SETTINGS_DEFAULTS);
    state.settings = { ...SETTINGS_DEFAULTS, ...stored };
  } catch {
    state.settings = { ...SETTINGS_DEFAULTS };
  }
  if (!Array.isArray(state.settings.selectedCategories)) state.settings.selectedCategories = [...DEFAULT_SELECTED];
  ui.optSourceMaps.checked = Boolean(state.settings.fetchSourceMaps);
  ui.optExtract.checked = Boolean(state.settings.extractSources);
}

function saveSettings() {
  browser.storage.local.set(state.settings).catch(() => {});
}

function rememberCategory(category, selected) {
  const categories = new Set(state.settings.selectedCategories);
  if (selected) categories.add(category);
  else categories.delete(category);
  state.settings.selectedCategories = [...categories];
  saveSettings();
}

/* ---------- jobs ---------- */

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function buildJob(mode) {
  const items = selectedItems().map((item) => (item.inline
    ? { category: item.category, inline: item.inline }
    : { url: item.url, category: item.category, initiatorType: item.initiatorType }));
  return {
    mode,
    pageUrl: state.tab.url,
    pageTitle: state.tab.title || '',
    items,
    options: { fetchSourceMaps: state.settings.fetchSourceMaps, extractSources: state.settings.extractSources },
  };
}

async function startJob(job) {
  const response = await browser.runtime.sendMessage({ type: 'job:start', job });
  if (!response || !response.ok) {
    const busy = response && response.error === 'busy';
    setStatus(busy ? t('statusBusy') : t('statusError', [response ? response.error : '?']), { error: true });
    return;
  }
  state.job = { id: response.id, mode: job.mode, state: 'running', progress: { done: 0, total: job.items.length } };
  setButtonsEnabled(true);
  setStatus(t('statusStarting'), { progress: 0 });
}

function onDownloadZip() {
  // permissions.request() has to be called synchronously from the click
  // handler: after an await Firefox no longer counts it as a user action.
  const items = selectedItems();
  if (items.length === 0) {
    setStatus(t('nothingSelected'), { error: true });
    return;
  }
  const origins = originPatterns(items.map((item) => item.url).filter(Boolean));
  const request = origins.length > 0 ? browser.permissions.request({ origins }) : Promise.resolve(true);
  request
    .then((granted) => {
      if (!granted) {
        setStatus(t('permissionDenied'), { error: true });
        return undefined;
      }
      return startJob(buildJob('zip'));
    })
    .catch((error) => setStatus(t('statusError', [errorText(error)]), { error: true }));
}

async function onSaveIndividually() {
  if (selectedItems().length === 0) {
    setStatus(t('nothingSelected'), { error: true });
    return;
  }
  await startJob(buildJob('individual'));
}

async function onCopyUrls() {
  const urls = selectedItems().filter((item) => item.url).map((item) => item.url);
  if (urls.length === 0) {
    setStatus(t('nothingSelected'), { error: true });
    return;
  }
  try {
    await navigator.clipboard.writeText(`${urls.join('\n')}\n`);
    setStatus(t('copied'));
  } catch (error) {
    setStatus(t('statusError', [errorText(error)]), { error: true });
  }
}

function setStatus(text, { error = false, progress = null, indeterminate = false } = {}) {
  ui.status.hidden = false;
  ui.statusText.textContent = text;
  ui.statusText.classList.toggle('error', error);
  ui.progress.classList.toggle('indeterminate', indeterminate);
  ui.progress.hidden = progress === null && !indeterminate;
  if (progress !== null) {
    const percent = Math.round(progress * 100);
    ui.progressBar.style.width = `${percent}%`;
    ui.progress.setAttribute('aria-valuenow', String(percent));
  }
}

function applyJobUpdate(update) {
  if (!update) return;
  state.job = update;
  const { state: jobState, progress, result, error, mode } = update;
  if (jobState === 'running') {
    const total = progress && progress.total ? progress.total : 0;
    const done = progress ? progress.done : 0;
    setStatus(total ? t('statusFetching', [String(done), String(total)]) : t('statusStarting'), {
      progress: total ? done / total : 0,
      indeterminate: total > 0 && done >= total,
    });
  } else if (jobState === 'done' && mode === 'individual') {
    setStatus(t('statusIndividualDone', [String(result.started), String(result.failed), result.root]), { progress: 1, error: result.failed > 0 });
  } else if (jobState === 'done') {
    const text = t('statusDone', [String(result.files), formatBytes(result.bytes), String(result.skipped), result.filename]);
    setStatus(result.sources ? `${text} ${t('statusDoneSources', [String(result.sources)])}` : text, { progress: 1 });
  } else if (jobState === 'error') {
    setStatus(t('statusError', [error || '?']), { error: true });
  }
  setButtonsEnabled(state.items.length > 0);
}

/* ---------- init ---------- */

async function init() {
  applyI18n();
  await loadSettings();
  ui.optSourceMaps.addEventListener('change', () => {
    state.settings.fetchSourceMaps = ui.optSourceMaps.checked;
    saveSettings();
  });
  ui.optExtract.addEventListener('change', () => {
    state.settings.extractSources = ui.optExtract.checked;
    saveSettings();
  });
  ui.downloadZip.addEventListener('click', onDownloadZip);
  ui.saveIndividually.addEventListener('click', onSaveIndividually);
  ui.copyUrls.addEventListener('click', onCopyUrls);
  ui.rescan.addEventListener('click', scan);
  browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'job:update') applyJobUpdate(message);
  });

  const running = await browser.runtime.sendMessage({ type: 'job:status' }).catch(() => null);
  await scan();
  if (running && running.state === 'running') applyJobUpdate(running);
}

init();
