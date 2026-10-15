# Chrome Web Store submission — Captode

Everything to fill in the Chrome Web Store Developer Dashboard, field by field, plus the
assets to upload. (Microsoft Edge Add-ons asks for the same things; notes at the end.)

Build the package with `npm run package` and upload `dist/captode-1.0.0.zip`.

---

## Package (uploaded zip)

- Manifest V3, version 1.0.0, minimum Chrome 116.
- Permissions: `activeTab`, `scripting`, `tabCapture`, `offscreen`, `storage`,
  `unlimitedStorage`. **No host permissions** and no content scripts: Captode only touches
  a page after the user invokes it, which avoids the extra review that broad host access
  triggers.
- No remote code: every script and WebAssembly module is in the package. The extension
  pages' content security policy is `script-src 'self' 'wasm-unsafe-eval'`, which Chrome
  allows for packaged WebAssembly.

---

## Store listing tab

**Item name** (in the manifest, 38 of 75 characters)
Captode — Screenshot & Screen Recorder

**Summary** (in the manifest, 129 of 132 characters)
Capture full-page, visible or selected-area screenshots and recordings. Annotate, then export as PNG, JPG, PDF, GIF, MP4 or WebP.

**Description**

```
Captode captures exactly what you need from any web page, lets you mark it up, and
exports it in the format you want. Everything happens in your browser: no account, no
uploads, no watermark.

SCREENSHOTS
• Full page: the whole scrolling page in one image, with fixed headers shown once
• Visible area: just what's on screen
• Selected area: drag out a region, with a mouse, finger or pen

ANNOTATE
• Arrows, lines, rectangles and ellipses
• Text in any font, size and colour, with an optional background
• Pen and highlighter
• Blur, pixelate or black out anything private
• Crop freely or to 1:1, 16:9, 4:3 and more; resize; add padding, a backdrop, rounded corners and a shadow
• Undo and redo, and keyboard shortcuts for every tool (press ? to see them)

EXPORT
• PNG, compressed PNG, JPEG, WebP, GIF, BMP and PDF (one page, or A4 / Letter pages for long captures)
• Set a size limit, from 100 KB to 25 MB, and Captode finds the best quality that fits
• Smart compression: lossless PNGs up to half the size, and smaller JPEGs at the same quality
• See the file size before you download, or copy the image to the clipboard

RECORD
• Your whole screen or a window, the current tab, or a selected area of the tab
• 15 to 60 fps, with optional audio and a 3-second countdown
• Stop with one click on the toolbar icon, or with the keyboard shortcut

EDIT AND EXPORT VIDEO
• Trim on a timeline with thumbnails, frame by frame if you need to
• Export to MP4, GIF, animated WebP or WebM, in seconds rather than in real time
• Choose the resolution and frame rate
• Make GIFs and WebPs smaller without visible loss, with optional lossy compression for even smaller GIFs

DEVICE FRAMES
• Show any screenshot or recording inside a phone or tablet, on a transparent, white or custom background

MADE FOR EVERYONE
• Light, dark or system theme
• Works on Windows, macOS, Linux and ChromeOS, including touchscreens and high-contrast mode
• Keyboard accessible, with screen-reader labels

PRIVATE BY DESIGN
Captode has no servers and makes no network requests. Your captures stay on your device
until you download them, and are cleared automatically after 24 hours. No account, no
analytics, no tracking.

Open source: https://github.com/nevin/Captode
```

**Category:** Productivity › Tools

**Language:** English

**Graphic assets**

| Field | File | Size |
| --- | --- | --- |
| Store icon | `store/icon-128.png` | 128 × 128 (96 × 96 artwork, 16 px transparent padding) |
| Screenshots (upload in this order) | `store/screenshots/1-capture.jpg` … `5-private.jpg` | 1280 × 800, JPEG |
| Small promo tile | `store/promo-small.jpg` | 440 × 280 |
| Marquee promo tile | `store/promo-marquee.jpg` | 1400 × 560 |

Regenerate them after any interface or logo change: `npm run icons`, then `npm run store`.

**Official URL:** none (needs a verified domain; leave blank)
**Homepage URL:** https://github.com/nevin/Captode
**Support URL:** https://github.com/nevin/Captode/issues

**Mature content:** No

---

## Privacy tab

**Single purpose description**

```
Captode takes screenshots and screen recordings of the user's current tab or screen, and
lets the user annotate, trim and export them as image, PDF or video files.
```

**Permission justifications**

| Permission | Justification to paste |
| --- | --- |
| activeTab | Captures the tab the user is on, only after they click the Captode toolbar button or press its keyboard shortcut. Captode has no host permissions and does nothing on pages until the user invokes it. |
| scripting | After the user starts a capture, injects a temporary overlay for selecting an area and a recording countdown into the active tab, and scrolls the page to stitch full-page screenshots. Nothing stays injected afterwards. |
| tabCapture | Records the current tab (or a selected area of it) when the user starts a tab recording from the popup. |
| offscreen | Hosts the MediaRecorder for tab recordings in an offscreen document, because a service worker cannot hold a media stream. The recording keeps running after the popup closes. |
| storage | Stores the user's settings: theme, export background, default formats, and device-frame and recording options. |
| unlimitedStorage | Recordings and captures are kept in the extension's IndexedDB until the user exports them (and deleted after 24 hours). Screen recordings can be hundreds of megabytes; this keeps the browser from evicting a recording under storage pressure before the user has exported it. |

**Are you using remote code?** No, I am not using remote code.

```
All JavaScript and WebAssembly ships in the package. No code is fetched or evaluated at
run time.
```

**Data usage**: leave every category **unticked** (Captode collects none of them):
personally identifiable information, health, financial and payment, authentication,
personal communications, location, web history, user activity, website content.

Captures of website content are made at the user's request and never leave the device,
so they are not "collected" in the Chrome Web Store's sense (data transmitted off the
user's device).

Tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/nevin/Captode/blob/main/PRIVACY.md

---

## Distribution tab

- Payments: Free
- Visibility: Public
- Regions: All regions

---

## Test instructions (optional, for reviewers)

```
No account or setup is needed.
1. Open any web page (for example https://en.wikipedia.org/wiki/Web_browser).
2. Click the Captode toolbar button and choose Screenshot > Full page. The editor opens
   with the whole page; add an arrow or text, then use Export > Download.
3. Click the button again, choose Record > This tab, and wait a few seconds. Click the
   toolbar button to stop. The recording opens; choose GIF and click Export.
4. Record > Full screen shows Chrome's own screen picker and records the chosen screen
   or window.
Captode cannot capture chrome:// pages or the Chrome Web Store (Chrome blocks this for all
extensions); the popup says so on those pages.
```

---

## Before you submit: checklist

- [x] Every requested permission is used; the unused `desktopCapture` was removed
- [x] No host permissions, no content scripts, no remote code, no `eval`
- [x] Name, summary and description match what the extension does; no keyword lists, no
      claims about other products, no Google or Chrome logos in the assets
- [x] Privacy policy is public, accurate and matches the data-use answers
- [x] Icons: 16, 32, 48 and 128 px in the package; 128 px store icon with padding
- [x] Screenshots at 1280 × 800 without transparency, showing the real interface
- [x] Third-party code (oxipng, MozJPEG) credited with its licences in `src/vendor`
- [x] Tests pass on Windows, macOS and Linux (`npm test`, GitHub Actions)
- [ ] Go through the manual checklist in `docs/TESTING.md` (recording can't be automated)
- [ ] Developer account: one-time registration fee paid, contact email verified
- [ ] Upload `dist/captode-1.0.0.zip` and fill in the fields above

---

## Microsoft Edge Add-ons

Same zip, description and screenshots. Differences:
- Store logo: `store/icon-300.png` (300 × 300)
- Small promo tile 440 × 280: `store/promo-small.jpg`; large promo tile 1400 × 560:
  `store/promo-marquee.jpg`
- Category: Productivity
- "Search terms" (up to 7): screenshot, screen recorder, full page screenshot, annotate,
  gif maker, screen capture, pdf
