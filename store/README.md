# Publishing to every store

One release, one set of packages, one upload to each store. Each package is built from the
same files with only its own browser's manifest and settings (`tools/targets.mjs`), and the
build stops if a package mentions another browser's store, ID or pages.

## Every release

1. If the interface or logo changed: `npm run icons`, `npm run store`, and commit.
2. `npm run release -- patch` (or `minor`, `major`, or a version) `--push`. It checks the
   translations, runs every test (Chrome, and Firefox when installed), builds the packages,
   checks the Firefox one with Mozilla's validator, commits, tags and pushes. The tag's
   GitHub release gets the same packages with their SHA-256 sums.
3. Upload from `dist/` (or the GitHub release):

| Store | Upload | Listing fields |
| --- | --- | --- |
| [Chrome Web Store](https://chrome.google.com/webstore/devconsole) | `captode-<version>-chrome.zip` | [`listing.md`](listing.md) |
| [Microsoft Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge/) | `captode-<version>-edge.zip` | [`listing.md`](listing.md), Edge section |
| [addons.mozilla.org](https://addons.mozilla.org/developers/) | `captode-<version>-firefox.zip`, and `captode-<version>-source.zip` when asked for source code | [`listing-firefox.md`](listing-firefox.md) |
| Safari (App Store) | `captode-<version>-safari/`, through Xcode (below) | [`listing.md`](listing.md) text; App Store Connect |

Every store needs a version higher than the one it has; the release script only makes
higher versions, so one version number serves all of them.

## What differs by browser

| | Chrome | Edge | Firefox | Safari |
| --- | --- | --- | --- | --- |
| Background | service worker | service worker | event page (`scripts`) | service worker |
| Tab and selected-area recording, clicks shown | yes | yes | no (no tab capture) | no |
| Camera bubble, video sizes | yes | yes | no (no MediaStreamTrackProcessor) | no |
| Screen and window recording, microphone | yes | yes | yes | yes |
| Screenshots, editor, exports, shortcuts, menus | yes | yes | yes | yes |
| Share button | store link | hidden until listed | store link | hidden until listed |

Captode checks for each feature rather than for a browser (`src/lib/platform.js`) and
offers only what works. Store links and the like live in `tools/targets.mjs`: when Edge or
the App Store gives Captode a page, put its address in `storeUrl` there.

## Firefox

- The add-on ID `captode@nevin.github.io` is permanent; never change it.
- `data_collection_permissions` says Captode collects nothing, which matches the
  privacy policy; keep them in step.
- Upload the source zip when asked: the packages hold WebAssembly (oxipng, MozJPEG from
  jSquash, unmodified; see `src/vendor/README.md`). The reviewer notes in
  `listing-firefox.md` say how to rebuild the package from it.

## Safari

Safari takes web extensions inside a Mac app, made with Xcode on a Mac and published
through App Store Connect (an Apple Developer Program membership is needed):

```bash
xcrun safari-web-extension-converter dist/captode-<version>-safari --app-name Captode --bundle-identifier <your.bundle.id> --macos-only
```

Open the project it makes, set the version to the release's, sign it with your team, test
it in Safari (Settings → Extensions), then archive and upload it. Safari support is
untested so far: check every screenshot mode and full-screen recording before the first
submission.
