# Chrome Web Store submission — Captode

Everything to fill in the Chrome Web Store Developer Dashboard, field by field, plus the
assets to upload. (Microsoft Edge Add-ons asks for the same things; notes at the end.)

Build the package with `npm run package` and upload `dist/captode-1.2.0.zip`.

---

## Package (uploaded zip)

- Manifest V3, version 1.2.0, minimum Chrome 116.
- Translated into Spanish, Portuguese (Brazil), French, German, Italian, Japanese, Korean and
  Simplified Chinese. The Web Store shows the extension's name and short description in each of
  these languages from the package; the detailed description below can be added per language
  in the dashboard (optional).
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

**Summary** (in the manifest, 130 of 132 characters)
Take full-page, visible or selected-area screenshots and screen recordings, mark them up, and save them as images, PDFs or videos.

**Description**

Written as plain sentences, without lists of formats, platforms or features: the store
treats runs of such terms as keyword spam (the first submission was rejected for a list
of image formats). Keep it this way when editing.

```
Captode takes screenshots and screen recordings of web pages, lets you mark them up,
and saves them to your computer. Everything happens in your browser: no account, no
uploads and no watermark.

Screenshots
Capture a whole scrolling page in one image, just what's on screen, or an area you drag
out with a mouse, finger or pen. Long pages are stitched cleanly, with sticky headers
shown once.

Mark up
Add arrows, shapes, text, callouts, highlights and numbered steps, spotlight or magnify
what matters, and blur or black out anything private before you share. Select several
things to align, arrange or copy them, and pick up where you left off: your edits are
kept with each capture. Crop, resize, or add padding, a background and a shadow. Every tool has a
keyboard shortcut, and changes can be undone.

Save
Save as an image or a PDF, or copy straight to the clipboard, automatically if you like. You can see the file size
before you save, and set a size limit for email or chat apps: Captode keeps the best
quality that fits.

Record
Record the current tab, an area of it, or your whole screen or a window, with sound if
you like. Only the page is kept, even when DevTools shows it at a phone's size, and you can
record it as shown, scaled up or down, or at a standard resolution. A countdown of up to 30
seconds gives you time to get ready, and one click on the toolbar button stops the recording.

Review designs
Check a build against its design: measure spacing in CSS pixels, check colour contrast against
accessibility guidelines, lay a spacing grid over the page, or compare two images with a slider
or a highlight of what changed. Share a capture for review as a single web page with a note for
each numbered step.

Edit recordings
Trim the start and end on a timeline, then save the result as a video or an animated
GIF. Exports take seconds rather than the length of the recording.

Device frames
Present any screenshot or recording inside real phone and tablet models, portrait or
landscape, at their true screen sizes and proportions. Your capture keeps its exact pixels.

For everyone
Captode follows your light or dark theme, works with touchscreens, keyboards, screen
readers and high-contrast mode, and runs wherever Chrome does, including Chromebooks.

Private by design
Captode has no servers and makes no network requests. Your captures stay on your
device until you save them, and are cleared automatically after 24 hours. There is no
account, analytics or tracking.

Captode is open source: https://github.com/nevin/Captode
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
lets the user annotate, review, compare, trim and export them as image, PDF or video files.
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
- [x] No lists of formats, platforms or keywords in the summary, description or images
- [x] Name, summary and description match what the extension does; no keyword lists, no
      claims about other products, no Google or Chrome logos in the assets
- [x] Privacy policy is public, accurate and matches the data-use answers
- [x] Icons: 16, 32, 48 and 128 px in the package; 128 px store icon with padding
- [x] Screenshots at 1280 × 800 without transparency, showing the real interface
- [x] Third-party code (oxipng, MozJPEG) credited with its licences in `src/vendor`
- [x] Tests pass on Windows, macOS and Linux (`npm test`, GitHub Actions)
- [ ] Go through the manual checklist in `docs/TESTING.md` (recording can't be automated)
- [ ] Developer account: one-time registration fee paid, contact email verified
- [ ] Upload `dist/captode-1.2.0.zip` and fill in the fields above

---

## Microsoft Edge Add-ons

Same zip, description and screenshots. Differences:
- Store logo: `store/icon-300.png` (300 × 300)
- Small promo tile 440 × 280: `store/promo-small.jpg`; large promo tile 1400 × 560:
  `store/promo-marquee.jpg`
- Category: Productivity
- "Search terms" (up to 7): screenshot, screen recorder, full page screenshot, annotate,
  gif maker, screen capture, pdf
