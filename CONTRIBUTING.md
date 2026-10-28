# Contributing

Thanks for taking the time. The project is small on purpose; keeping it that
way is part of the goal.

## Ground rules

- **No runtime dependencies.** The extension ships only the code in this
  repository. A feature that needs a library should be discussed first.
- **No build step.** Plain ES modules that Firefox loads as they are. This
  keeps the published package identical to the source, which is also what
  reviewers at addons.mozilla.org see.
- **Least privilege.** New permissions need a clear reason in the README's
  permission table. Site access stays optional and on demand.
- **No data leaves the browser** except requests for the files the user asked
  for. Nothing is logged, counted or phoned home.

## Development

```sh
npm install        # web-ext (lint, package, launch) and geckodriver (end-to-end test)
npm test           # unit and integration tests (Node ≥ 20.12, built-in test runner)
npm run test:e2e   # real Firefox over WebDriver; needs Firefox on PATH or FIREFOX_BIN
npm run lint       # addons-linter
npm start          # Firefox with the extension loaded; reloads on file changes
npm run build      # package in web-ext-artifacts/
```

The end-to-end test covers the download paths, but not the toolbar popup
itself (it loads the popup page in a tab). So, before a release, also check by
hand in a fresh Firefox profile (`npm start` gives you one):

1. Open a page with external scripts, a stylesheet with `url()` references,
   an iframe and inline scripts. Click the toolbar button.
2. Check that every category shows plausible counts, expand a few, deselect
   single files.
3. **Download ZIP**: grant the site access prompt, verify the archive opens,
   `_devgrab/manifest.json` lists every file, source maps and `_sources/`
   are present. Deny the prompt once and confirm the error message.
4. **Save files individually**: files land in a folder named like the
   archive. **Copy URL list**: paste somewhere.
5. Close the popup while a download runs; reopen it and check that the
   progress is still shown.

## Code style

Two spaces, single quotes, semicolons, ES2022, `const` by default. Modules
under `src/lib` must stay free of browser extension APIs so they run in Node
(the tests rely on it). `src/content/collect.js` is injected by source text and
must remain a single self-contained function.

Keep comments for the *why*; the code should say the *what*. User-visible text
goes through `_locales` (English and German; add both, or ask for help with
the translation).

## Pull requests

One topic per pull request, with tests for changed behaviour in `src/lib`,
and an entry in `CHANGELOG.md` under *unreleased*.

Contributions are licensed under the Mozilla Public License 2.0 like the rest
of the project. There is no contributor agreement to sign.

## Releases

Bump `version` in `manifest.json` and `package.json`, date the entry in
`CHANGELOG.md`, commit, then tag it `vX.Y.Z` and push the tag. The release
workflow runs the tests, builds the package and attaches it to a GitHub
release. Signing for addons.mozilla.org stays a manual step.

## Security

Please report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
