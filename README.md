# DevGrab

> Most of this code was written by an AI assistant (Claude). A human set the
> requirements, made the design decisions, reviewed the code and tested the
> extension in Firefox. Read it like any other code before you trust it.

[![CI](https://github.com/cunaz/devgrab/actions/workflows/ci.yml/badge.svg)](https://github.com/cunaz/devgrab/actions/workflows/ci.yml)

A small, dependency-free Firefox extension that downloads the files a developer
cares about on the page you are looking at: scripts (external and inline),
stylesheets, source maps, the original sources embedded in those maps, the
documents of all frames, JSON/XML/WASM data and, on request, API responses,
fonts, images and media. Everything lands in one ZIP archive that mirrors the
URL structure, together with a manifest that maps every file back to its URL.

- Manifest V3, event page, no bundler, no build step, no third-party code.
- Minimal permissions. Site access is requested only when you download, and
  only for the origins of the files you selected.
- No telemetry, no remote code, no network traffic besides fetching the files
  you asked for (`data_collection_permissions: none`).
- Localised (English, German). Licensed under the MPL 2.0.

## Install

Development build (temporary add-on):

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` from this folder.

Or with [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):

```sh
git clone https://github.com/cunaz/devgrab.git
cd devgrab
npm install
npm start          # launches Firefox with the extension loaded
npm run build      # web-ext-artifacts/devgrab-<version>.zip, ready for addons.mozilla.org
```

Requires Firefox 140 or newer (142 on Android). Release builds of Firefox
only keep signed extensions installed; for permanent use, sign the package
through addons.mozilla.org (listed or self-distributed).

## Usage

1. Open the page, let it finish loading, then click the DevGrab toolbar button.
2. The popup lists what the page has loaded, grouped by category. Scripts,
   stylesheets, source maps, documents and data files are checked by default;
   expand a category to pick single files.
3. **Download ZIP** fetches the selected files and saves one archive. Firefox
   asks once for access to the sites involved; the request is limited to the
   origins of the selected files. If the popup closes while Firefox shows that
   prompt, open it again and click **Download ZIP** once more.
4. **Save files individually** hands every URL to Firefox's download manager
   instead. This needs no site access but creates one download per file,
   cannot follow source maps, and skips the "where to save" dialog so that
   you are not asked once per file.
5. **Copy URL list** puts the selected URLs on the clipboard, one per line.

Options (remembered across sessions):

- *Also fetch referenced source maps* – follows `sourceMappingURL` comments,
  `SourceMap` response headers and inline `data:` maps.
- *Extract original sources from source maps* – writes every `sourcesContent`
  entry to `_sources/` so you get the original, unminified project tree.

## Archive layout

```
devgrab_www.example.com_20261027-154500/
├── www.example.com/
│   ├── index.html                       the document as served
│   ├── assets/app.3f9a1c.js
│   ├── assets/app.3f9a1c.js.map
│   ├── api/article/42.json              extension added from the content type
│   └── _inline/
│       ├── script-001.js                inline <script> blocks, in document order
│       ├── style-001.css
│       └── dom-snapshot.html            snapshot of the live DOM
├── cdn.example.net/vendor/react.production.min.js
├── _sources/src/App.tsx                 original sources from source maps
└── _devgrab/manifest.json               URL ↔ path mapping, sizes, content types, errors
```

Rules for file names: one directory per host (port appended as `_8080`), the
URL path below it, the query string folded into the name (`app~v=3.js`), an
extension added when the content type knows better than the URL
(`bundle.php` served as JavaScript becomes `bundle.php.js`). Names are made
safe for Windows, macOS and Linux, and collisions get a `~2` suffix. The
manifest's `skipped` list records every file that could not be fetched and why.

## Permissions

| Permission | Used for |
| --- | --- |
| `activeTab` | reading the URL of the tab you clicked on and running the collector in it |
| `scripting` | injecting the collector function (`src/content/collect.js`) into the tab's frames |
| `downloads` | saving the archive or the individual files |
| `storage` | remembering your category selection and options |
| optional host permissions (`http://*/*`, `https://*/*`) | fetching the selected files; requested on demand for the exact origins involved and revocable at any time in `about:addons` |

## Privacy

Nothing is collected, stored outside your browser or sent anywhere. The only
network requests the extension makes are the GET requests for the files you
selected, sent to the servers that host them, with the cookies your browser
holds for those sites (so that files behind a login work). The archive is
written to your downloads folder and nowhere else. The manifest declares
`data_collection_permissions: none`, and there is no remote code, analytics or
update channel beyond Firefox's own add-on updates.

The archive contains whatever the page served, including scripts and HTML.
Treat it like any downloaded file: look at it in an editor rather than opening
`dom-snapshot.html` from disk in a browser.

## How it works

- **Popup** (`src/popup/`) runs `collectPageResources` in every frame of the
  active tab via `scripting.executeScript`. The collector combines the
  Resource Timing API (everything the page loaded, including dynamic imports
  and fetch/XHR), references in the DOM, `@import`/`url()` references in
  readable stylesheets, the controlling service worker, inline scripts and
  styles, and a snapshot of the live DOM.
- **Background event page** (`src/background.js`) runs the job so it survives
  the popup closing. `src/lib/dump.js` fetches with cookies, six requests at a
  time, a 30 s timeout, 64 MiB per file and 512 MiB in total; discovers source
  maps; extracts sources; writes the ZIP; and hands a `blob:` URL to
  `downloads.download()`. While a job runs, a cheap API call every 20 s keeps
  the event page from being unloaded.
- **ZIP writer** (`src/lib/zip.js`) is under 200 lines: stored and deflated
  entries (via `CompressionStream`), UTF-8 names, Unix file modes, entry
  times from the server's `Last-Modified` header, no ZIP64.

## Limitations

- The Resource Timing buffer of a page holds 250 entries by default. On pages
  with more resources, files that scripts loaded early can be missing from the
  timing data; the DOM and stylesheet scan still finds everything referenced
  there, and the popup shows a hint. Raising the buffer at document start would
  require persistent site access, which this extension deliberately avoids.
- Files are requested again rather than copied out of the page; Firefox's
  HTTP cache may answer, but a server can also return something different
  from what the page got. Endpoints that were called with POST or that have
  side effects on GET are listed under *API calls* and unchecked by default.
- Everything is held in memory until the archive is written, so dumps are
  capped at 512 MiB (64 MiB per file). The caps live in `src/lib/dump.js`.
- `blob:` and `data:` URLs, and requests made inside workers, are not captured.
- Frames the extension is not allowed to access are skipped silently.
- Plain ZIP only: archives are limited to 4 GiB and 65 535 entries.

## Development

```sh
npm test            # unit and integration tests, Node's built-in runner, no dependencies
npm run lint        # addons-linter via web-ext
npm run test:e2e    # the real extension in a real Firefox, see below
```

The end-to-end test (`test/e2e/`) drives a headless Firefox over WebDriver:
it installs the extension, scans a local test site with two origins, a
service worker and a cookie-protected file, downloads the ZIP through the
site-access prompt, saves files individually and checks the results on disk.
It needs Firefox 140 or newer on `PATH` as `firefox` (or `FIREFOX_BIN` pointing
to the binary) and `geckodriver`, which `npm install` provides. Set
`E2E_HEADED=1` to watch it run.

```
manifest.json
src/background.js        job runner, downloads, keep-alive
src/content/collect.js   page inventory (injected, self-contained)
src/lib/classify.js      file types: category and extension
src/lib/paths.js         URL → safe archive path, collision handling
src/lib/sourcemap.js     sourceMappingURL discovery, map parsing
src/lib/zip.js           ZIP writer
src/lib/dump.js          fetch pool, source maps, manifest, archive
src/popup/               UI
_locales/                en, de
test/                    node --test suites, test/e2e for the Firefox run
```

The core modules use only standard web APIs, so they run unchanged in Node
(tests) and in the extension. There is deliberately no bundler, transpiler or
runtime dependency; the development dependencies are `web-ext` and
`geckodriver` (for the end-to-end test only). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the manual test checklist and the
ground rules.

Before publishing on addons.mozilla.org, change the extension ID in
`manifest.json` (`browser_specific_settings.gecko.id`) if you prefer an
e-mail-style ID.

## Ideas for later

- Pretty-print minified JavaScript and CSS (would need a formatter dependency).
- A DevTools panel next to the Network tab.
- Capturing requests from page load on, via `webRequest`, as an opt-in.
- Fetching sources that maps list without `sourcesContent`.
- ZIP64 for very large dumps.

## License

[Mozilla Public License 2.0](LICENSE). Use it in anything you like, including
closed software; changes to these files must stay under the same license.
