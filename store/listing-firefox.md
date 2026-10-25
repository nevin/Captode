# addons.mozilla.org submission — Captode

Every field on the Firefox Add-on Developer Hub, ready to paste. Upload
`dist/captode-<version>-firefox.zip`; when asked whether the add-on uses machine-generated
code, answer yes (WebAssembly) and upload `dist/captode-<version>-source.zip`.

## Package

- Manifest V3, background event page, Firefox 140 or later (desktop only).
- Add-on ID `ccaptode@thecodersworld.com` (permanent).
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
of up to 30 seconds gives you time to get ready, you can pause and carry on, and one click
on the toolbar button stops the recording. If the browser closes mid-recording, what was
recorded is kept. Add captions, burned in or as subtitle files.
```

and the Edit recordings paragraph's last sentence replaced by:

```
Then save it as a video or an animated GIF, in seconds rather than the length of the
recording.
```

(Firefox has no tab capture, so tab recording, the camera bubble, video sizes, step-by-step
guides and the background export queue aren't offered there.)

**Categories:** Photos, Music & Videos; Productivity

**Tags** (picked from the store's fixed list, which has none for screenshots): **privacy**,
**video converter**. The others don't describe Captode (for example "dark mode" means
darkening websites, "video downloader" means saving videos from sites); searches for
screenshots and screen recording find Captode through its name, summary and description.

**Support site:** https://github.com/nevin/Captode
**Support email:** none (issues on GitHub)
**Licence:** GNU General Public License v3.0 (GPL-3.0-or-later)
**Privacy policy:** paste the text of `PRIVACY.md`

**Icons:** `store/firefox/icon-32.png`, `icon-64.png` and `icon-128.png` (made by
`npm run icons` from the logo; the artwork fills the square).

**Screenshots:** `store/screenshots/` 1, 2, 3 and 4, then `store/screenshots/firefox/5-record.jpg`,
then 6 and 7. (The plain 5 shows tab recording and the camera bubble, which Firefox doesn't
offer; the Firefox one is made from the popup's own code with Firefox's settings.)

**Screenshot captions** (one per screenshot, in upload order):

1. Capture any page in one click: the whole scrolling page, what you see, a region you drag out, or a single element.
2. Mark it up in seconds with callouts, numbered steps, arrows and highlights, and blur anything private.
3. Check the build against the design: measure in CSS pixels, check colour contrast against WCAG, and lay a spacing grid over the page.
4. Show it on a real device: 63 phones and tablets at their true sizes, portrait or landscape, with your pixels kept exact.
5. Record your screen or a window with your voice, then trim it and export it as MP4, GIF, WebP or WebM in seconds.
6. See exactly what changed: compare two captures, or a capture and a design, with a slider or a highlight of every changed pixel.
7. Private by design: everything stays on your computer, with no account, no uploads and no tracking. Light and dark themes.

## Notes to reviewer

```
Captode is open source: https://github.com/nevin/Captode (tag v<version>).

Source code: the attached source zip is the repository at that tag. The extension's files
are src/ as written (no bundler, no minifier, no transpiler, no template engine), except
three files the build sets for Firefox, all from tools/targets.mjs:
  manifest.json   src/manifest.json with Firefox's keys (event-page background,
                  browser_specific_settings) and without Chromium-only permissions
  lib/target.js   Firefox's store link, shortcut settings and protected pages
To rebuild the package (Node.js 22 or later; nothing to install):
  npm run package firefox     -> dist/captode-<version>-firefox.zip
The result is identical byte for byte (fixed timestamps; SHA256SUMS on the GitHub release).
The only other machine-generated code is two WebAssembly codecs, with the loader scripts
their toolchains made, unmodified from npm:
  src/vendor/oxipng   @jsquash/oxipng@2.3.0 (squoosh_oxipng_bg.wasm, single-threaded)
  src/vendor/mozjpeg  @jsquash/jpeg@1.6.0 (mozjpeg_enc.wasm)
Both are loaded only inside the extension's own workers (src/lib/wasm.js) to compress
images the user exports.

innerHTML: used only with fixed markup, numbers and the add-on's own translations
(_locales). Text from web pages, files or the user is inserted as text (textContent,
.value, new Option) or escaped.

lib/tab-capture.js is also replaced in the Firefox package, by tools/tab-capture-none.js:
Firefox has no tab capture, so its package holds no tabCapture or offscreen code and no
offscreen recorder.

To test: open any web page, click the toolbar button, choose Screenshot > Full page; the
editor opens with the whole page. Record > Full screen uses Firefox's screen picker.
```
