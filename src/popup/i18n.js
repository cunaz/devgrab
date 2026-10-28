/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Small helpers around browser.i18n for the popup. */

export function t(key, substitutions) {
  return browser.i18n.getMessage(key, substitutions) || key;
}

/** Fills elements carrying data-i18n / data-i18n-title attributes with localized text. */
export function applyI18n(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  for (const element of root.querySelectorAll('[data-i18n-label]')) element.setAttribute('aria-label', t(element.dataset.i18nLabel));
  document.documentElement.lang = browser.i18n.getUILanguage();
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
