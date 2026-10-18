# addons.mozilla.org submission — Captode

Every field on the Firefox Add-on Developer Hub, ready to paste. Upload
`dist/captode-<version>-firefox.zip`; when asked whether the add-on uses machine-generated
code, answer yes (WebAssembly) and upload `dist/captode-<version>-source.zip`.

## Package

- Manifest V3, background event page, Firefox 140 or later (desktop only).
- Add-on ID `captode@nevin.github.io` (permanent).
- Permissions: `activeTab`, `contextMenus`, `scripting`, `storage`, `unlimitedStorage`.
  No host permissions, no content scripts, no remote code.
- `data_collection_permissions`: `none`. Captode collects and transmits nothing.
- Passes `addons-linter` (`npm run lint:firefox`) with no errors; the warnings it keeps
  are listed and explained in `tools/lint-firefox.mjs`.

## Listing

**Name:** Captode — Screenshot & Screen Recorder

**Summary** (250 characters at most)

```
Full-page, visible-area, selected-area and single-element screenshots and screen
recordings, marked up and saved as images, PDFs or videos. Everything stays on your
computer: no account, no uploads, no tracking.
```

**Description:** the description in [`listing.md`](listing.md), with the Record paragraph
replaced by:

```
Record
Record your whole screen or a window, with sound and your voice if you like. A countdown
of up to 30 seconds gives you time to get ready, and one click on the toolbar button
stops the recording.
```

(Firefox has no tab capture, so tab recording, the camera bubble and video sizes aren't
offered there.)

**Categories:** Photos, Music & Videos; Productivity

**Tags:** screenshot, screen recorder, annotate, capture, gif

**Support site:** https://github.com/nevin/Captode
**Support email:** none (issues on GitHub)
**Licence:** the repository's licence (see `LICENSE`)
**Privacy policy:** paste the text of `PRIVACY.md`

**Screenshots:** `store/screenshots/` 1, 2, 3, 4, 6 and 7 (5 shows tab recording, which
Firefox doesn't offer).

## Notes to reviewer

```
Captode is open source: https://github.com/nevin/Captode (tag v<version>).

Source code: the attached source zip is the repository at that tag. The extension's files
are src/ as written (no bundler, no minifier, no transpiler). To rebuild the package:
  npm ci
  npm run package     -> dist/captode-<version>-firefox.zip
The only machine-generated code is two WebAssembly codecs, unmodified, from npm:
  src/vendor/oxipng   @jsquash/oxipng@2.3.0 (squoosh_oxipng_bg.wasm, single-threaded)
  src/vendor/mozjpeg  @jsquash/jpeg@1.6.0 (mozjpeg_enc.wasm)
Both are loaded only inside the extension's own workers (src/lib/wasm.js) to compress
images the user exports.

innerHTML: used only with fixed markup, numbers and the add-on's own translations
(_locales). Text from web pages, files or the user is inserted as text (textContent,
.value, new Option) or escaped.

tabCapture / offscreen calls are Chromium-only code paths, checked for before use
(src/lib/platform.js) and never reached in Firefox.

To test: open any web page, click the toolbar button, choose Screenshot > Full page; the
editor opens with the whole page. Record > Full screen uses Firefox's screen picker.
```
