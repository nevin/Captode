<p align="center"><img src="docs/logo.png" width="96" alt="Captode logo"></p>

# Captode

Screenshots and screen recordings of the current tab, with an editor to mark them up and
export to the format you need. Captode runs entirely in your browser. Nothing is uploaded.

## Features

### Screenshots

- **Full page:** the whole scrolling page, stitched together. Fixed headers appear once.
- **Visible area:** what is on screen now.
- **Selected area:** drag out a rectangle.

The capture opens in the editor, where you can:

- **Crop**, freely or to 1:1, 16:9, 4:3, 9:16 or 3:4. **Rotate** a quarter turn either way
  and **flip**, with your annotations following.
- **Draw** with a pen or highlighter.
- **Add shapes:** lines, arrows, rectangles and ellipses, with stroke colour, fill, thickness,
  opacity, and solid, dashed or dotted lines; arrows can have heads at both ends.
- **Callouts:** speech bubbles whose tail points at what you're talking about.
- **Spotlight** an area by dimming everything else, or **magnify** a detail with a lens.
- **Add text:** choose the font (including fonts installed on your computer), size (A− / A+),
  bold, italic, text colour and background colour.
- **Number the steps:** each click adds a numbered marker (1, 2, 3…) in the colour and
  size you choose; start from any number, or renumber one.
- **Blur, pixelate or black out** sensitive details.
- Select, move, resize (handles on every annotation), restyle and delete anything you
  added. **Select several** with Shift-click or by dragging a box, then move, restyle,
  duplicate, copy and paste (between editor tabs too), bring to front or send to back,
  **align** and **space evenly**. Moving and resizing **snap** to edges and centres, with
  guides (hold Alt to place freely). Undo and redo, or **Undo all** to go back to the
  original (itself undoable).
- **Your edits are kept** with the capture, so reopening it from Recent captures picks up
  where you left off.
- **Large captures stay fast:** the editor draws only what's on screen.
- **Pan** around a zoomed-in or long capture with the hand tool, by holding Space, or with
  the middle mouse button; ⌘/Ctrl + scroll zooms towards the pointer.
- **Resize** to exact pixel sizes, with or without keeping the proportions.
- **Frame** the shot with padding, a backdrop colour, rounded corners and a shadow.
- **Set a size limit** (100 KB to 25 MB) and Captode finds the best quality that fits,
  lowering quality or colours before it shrinks the image. **Auto** picks the fewest
  colours for PNG-8 and GIF that still look right. GIF has **lossy compression** too.
- **Export** as PNG, compressed 8-bit PNG, JPEG, WebP, GIF, BMP or PDF (one page, or A4 or
  Letter pages with long pages split across them). The quality and size controls compress the
  file, and the live estimate shows the size before you download. You can also copy the image
  to the clipboard, from the top bar or the Export panel, or have every new screenshot copied
  automatically (Settings → Copy screenshots to the clipboard). See [How compression works](#how-compression-works).
- **Quick styles:** Bug, Review, Note, Approved, Neutral and Brand set the colours of every
  tool at once, and of whatever is selected.
- **Presets** for common uses (chat, issue trackers, email, design review, phone mock-ups,
  websites), or save your own. Your last format and options are remembered.
- **Several devices at once:** one zip with an image for each device you tick.
- **Share for review:** a single web page with the annotated image, a note for each numbered
  step and where the capture came from, to attach to a ticket or send in chat. It opens in any
  browser, needs no account, and nothing is uploaded.
- **Keyboard shortcuts** for every tool. Press **?** in the editor to see them all.
- **Keyboard and screen readers:** every annotation is listed in words in the Annotate tab,
  where it can be chosen, moved, edited or removed from the keyboard, and changes are announced.
- **Undo** for removing a capture, deleting annotations and resetting settings.
- **Recent captures:** open the editor from the popup to get back any capture from the last
  24 hours, even after closing its tab.

### Review tools

For checking a build against its design, in the editor's **Review** tab (nothing here is exported):

- **Measure (U):** drag across the image. Sizes are in CSS pixels, using the capture's pixel
  ratio. Lines straighten and their ends snap to edges, so an element's size comes out exact.
- **Colour picker (I):** pick a text and a background colour to see their hex codes and WCAG
  contrast ratio, with AA and AAA results for normal and large text.
- **Spacing grid (G):** every 4, 8, 16 or 24 CSS pixels.
- **Compare:** two captures, or a capture and a design file, with a slider, side by side, as an
  overlay, or as a difference that highlights the changed pixels and says how many changed.
  Images of different widths (a 1× design and a 2× screenshot) are lined up automatically.

### Recordings

- **Full screen:** your whole screen or any window.
- **Visible area:** the current tab.
- **Selected area:** drag a rectangle; only that part of the tab is recorded.

Tab recordings keep only the page: if DevTools shows it at a phone's size (device mode),
the black space around it is left out. **Video size** records the page as shown (the
default), scaled (50%, 75%, 150% or 200%), or at a standard resolution (480p to 4K,
measured on the shorter side so phone-shaped pages stay portrait).

You can pick the frame rate (15, 24, 30 or 60 fps), include audio, and set a countdown of up
to 30 seconds (or none) to get ready; press Esc, or Cancel for full-screen recordings, to
call it off. Click the Captode icon (or press **Alt+Shift+R**) to stop. The recording then
opens in the video page, where you can:

- Trim on a timeline with thumbnails: drag the handles, or play to a point and press **I**
  (start) or **O** (end). **Space** plays only the trimmed part; the arrow keys step frame by
  frame.
- Export as **MP4** (H.264, with AAC audio), **GIF**, **WebP** (animated) or **WebM** (VP9, with
  Opus audio). Exports run in the background and much faster than real time: a 20-second
  clip takes about 2 seconds. Trims are frame-accurate.
- Choose the resolution (original, 2160p down to 240p) and the frame rate.
- **Reduce file size losslessly** (GIF and WebP). Repeated frames are merged and only the
  pixels that change are stored; every frame looks exactly as it would without this.
  **Ignore flicker** (on by default) also treats changes too small to see (2 levels out
  of 255) as no change, which makes screen recordings much smaller. WebP can also use
  lossless frames.
- Set the MP4 or WebM quality, from visually lossless to smallest file.

### Device mode

Turn on **Device mode** in the popup, the editor or the video page to export a screenshot or
video inside a real phone or tablet: 63 devices, including iPhone 13 mini to iPhone 18 Pro Max
and the iPhone Duo, iPhone SE, iPad mini to iPad Pro 13″, Pixel 7 to Pixel 11 Pro XL and the
Pixel 11 Pro Fold, Galaxy S24 to S26 Ultra, Galaxy Z Flip and Fold (including the Fold8 and
Fold8 Ultra), and Pixel and Galaxy tablets. Sizes come from the manufacturers' published
specifications (see the sources in `src/lib/devices.js`).

Each device uses its published screen resolution, pixel density and body size, so its
proportions and bezels are real. The frame is sized around the capture, so the capture keeps
its exact pixels: a screenshot taken on a device, or in DevTools' device mode, fills its screen
pixel for pixel. You can choose:

- the device, or **Best match for the capture**, which picks the device whose screen the
  capture fits (the panel says which, and whether the pixels are kept exactly)
- portrait or landscape (the hardware turns; the status bar and home indicator stay upright)
- the size: the capture's own pixels (exact), or the device's screen resolution
- how the capture fits the screen
- the finish, padding, and a transparent, white or custom-colour background (the default is set in Settings)
- a status bar above or over the page, or none

### Settings

Open **Settings** from the gear in the popup (or right-click the icon → Options) to choose:

- **Theme:** System (follows your browser and computer), Light or Dark.
- **Export background:** Transparent, White or a custom colour, used behind device frames
  and around padded screenshots. JPEG, BMP, PDF, MP4 and WebM can't be transparent, so
  they get white when Transparent is chosen.
- **Default formats** for screenshots and recordings (or the last one used), and whether
  device frames are on.

Settings also has links to help, problem reports and the privacy policy, and a button that
resets everything to the defaults.

On browser pages that Chrome protects (such as `chrome://` pages and the Web Store), the
popup explains that the page can't be captured and leaves full-screen recording available.

### How compression works

Everything runs in the browser; nothing is uploaded.

- **PNG** is always lossless. Captode checks a few encodings and keeps the smallest: a
  palette at 1, 2, 4 or 8 bits per pixel when the image has 256 colours or fewer, greyscale
  when there's no colour, no alpha channel when nothing is transparent, and the best
  filter for each row. Fully transparent pixels are stored as transparent black. oxipng
  then recompresses the result.
- **JPEG** uses MozJPEG, tuned so each file is at least as faithful (by PSNR) as Chrome's
  own encoder at the same quality setting: the setting means what it did, the file is
  smaller (27% on average in the tests).
- **PNG-8 and GIF** keep the exact colours when an image has few enough of them, so flat
  UI screenshots lose nothing. Otherwise a median-cut palette is refined with k-means and
  colours are matched by a perceptual distance. Dithering is serpentine Floyd–Steinberg
  at reduced strength, and leaves areas of exact palette colours clean.
- **Lossy GIF** lets a pixel take a slightly different colour when that continues a run
  the compressor already knows, the technique behind gifsicle's `--lossy`.
- **Animated GIF** uses one palette for the whole clip and stores only the pixels that
  change. Dithering uses an ordered pattern, which stays still from frame to frame so it
  doesn't count as motion.
- **Animated WebP** stores each frame lossy or lossless, whichever is smaller. Lossless
  frames can leave unchanged pixels transparent to show the frame below.
- **PDF** pages use lossless compression when that is smaller than JPEG, which is common
  for screenshots of text, or always when quality is set to 100%.
- **MP4 and WebM** are made with WebCodecs: the recording is decoded, each frame is drawn
  (in a device frame if chosen) and encoded again, then written to a new file. WebM keeps
  the original Opus audio as it is; MP4 converts it to AAC, or keeps it as Opus where the
  browser has no AAC encoder (Chrome on Linux). If the browser can't do this,
  Captode falls back to playing the clip through in real time.
- **Recordings** are made with settings for screen content (sharp text, enough bitrate that
  still areas don't shimmer, and a key frame every 2 seconds), which also keeps exports small.
- Encoding runs in background workers, so the editor and video page stay responsive. GIF
  exports spread colour mapping and compression across several CPU cores.

Colours stay true for design and UX reviews: video exports keep the recording's exact
colours and are tagged as sRGB, so QuickTime, browsers and chat apps show them the same
way, and image exports (PNG, JPEG, PDF) are tagged as sRGB too.

## Supported platforms

Captode runs on **Windows, macOS, Linux and ChromeOS**, in Chrome 116 or later and other
Chromium browsers (Edge, Brave, Opera, Arc). The automated tests run on Windows, macOS
and Linux on every push, including captures at 125%, 150% and 200% display scale, touch
input and Windows high-contrast mode. [docs/TESTING.md](docs/TESTING.md) has the manual
checklist for what automation can't reach: recording (which needs a real click) and
Chromebooks.

Platform differences, all handled:

- Keyboard shortcuts show as the platform writes them: ⌘ and ⌥ on macOS, Ctrl and Alt
  elsewhere. The popup and Settings show the shortcut actually set in Chrome.
- On Linux, and on Windows without Media Foundation, Chrome has no AAC encoder, so MP4
  exports keep the recording's Opus audio.
- Touchscreens (Chromebooks, Windows tablets) can drag out a selected area.

## Install

Captode works in Chromium browsers: Chrome 116 or later, Edge, Brave, Opera and Arc.
MP4 export uses the H.264 encoder built into Chrome. On the rare system without one, Captode falls back to real-time export, which needs Chrome 126 or later.

### From source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `src` folder.

## Development

The extension is plain JavaScript modules with no build step. Its only third-party code is
two WebAssembly codecs in `src/vendor` (see [Credits](#credits)).

```
src/
  manifest.json
  background.js          service worker: captures, recording state, toolbar icon
  content/page.js        functions injected into the page (area picker, scrolling, countdown)
  popup/                 the toolbar popup
  settings/              the Settings page
  editor/                image editor; review-page.js builds the Share for review page
  compare/               compare two images
  video/                 recording preview and export
  recorder/offscreen.*   records the tab (offscreen document)
  recorder/screen.*      records the whole screen or a window
  lib/
    db.js                hands captures between pages through IndexedDB
    recorder.js          MediaRecorder wrapper, with cropping for selected-area recordings
    device.js            phone and tablet frames
    devices.js           the device catalogue: real resolutions, densities and sizes
    device-picker.js     the searchable device menu
    presets.js           export presets
    remember.js          remembers export choices
    srgb.js              marks exported images as sRGB
    video-colour.js      colour spaces for recordings and their exports
    zip.js               ZIP writer for several-device exports
    settings.js          user settings shared by every page
    theme.js             applies the Light, Dark or System theme
    gif.js               animated GIF encoder: frame diffing, lossy LZW
    gif-worker.js        GIF colour mapping and compression on a worker pool
    webp.js              animated WebP muxer
    quantize.js          colour reduction (exact, median cut + k-means) and dithering
    png.js               lossless PNG writer (palette, greyscale, adaptive filters)
    formats.js           every still format, Auto colours and size limits
    encoder.js           runs still-image encoding in a worker (encode-worker.js)
    wasm.js              loads oxipng and MozJPEG
    webm.js, mp4.js      WebM reader/writer and MP4 writer for WebCodecs export
    pool.js              a small worker pool
  video/export-worker.js decodes, draws and encodes video exports with WebCodecs
  vendor/                oxipng and MozJPEG, compiled to WebAssembly
test/
  *.test.mjs             browser tests (capture, encoders, video export, interface)
  bench.mjs              compression benchmark with stored baselines
tools/
  brand.mjs              makes every icon from the vector logo in store/brand/
  store-assets.mjs       makes the store screenshots and promo tiles from the real UI
  package.mjs            builds the store zip
```

```bash
npm install       # test tools only: Puppeteer and its Chrome for Testing
npm test          # run the browser tests (npm test -- video runs only matching ones)
npm run bench     # compression benchmark; fails on a size or quality regression
npm run icons     # every icon size from store/brand/logo.svg and logo-small.svg
npm run store     # store screenshots and promo tiles in store/
npm run package   # build dist/captode-<version>.zip for the stores
```

The tests load the extension into Chrome and drive real captures, edits and exports
against a local test page. They check what the encoders promise: lossless output is
pixel-identical, JPEG is at least as faithful as Chrome's own at the same quality and no
larger, size limits are met, trims land on the right frame, and audio lasts as long as
the video. Set `CHROME_PATH` to use another Chrome. GitHub Actions runs the tests and the
benchmark on every push.

The logo is vector artwork in `store/brand/`: `logo.svg` (the full mark),
`logo-small.svg` (the window alone, for 16 and 32 px, where the brackets would be lost)
and `logo-reverse.svg` (white brackets, for the brand's violet backgrounds). The window
has a thin light outline so it stays visible on dark toolbars. Edit these, then run
`npm run icons` and `npm run store`.

`npm run bench` compares sizes, PSNR and SSIM with `test/bench-baseline.json`, kept per
operating system. After an intended change, save new numbers with
`npm run bench -- --update`.

## Publishing

1. Bump `version` in `src/manifest.json`.
2. Run `npm test`, then `npm run icons` and `npm run store` if the logo or interface changed.
3. Run `npm run package`.
4. Upload `dist/captode-<version>.zip` to the
   [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) and to
   [Microsoft Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge/).
   [`store/listing.md`](store/listing.md) has every dashboard field ready to paste
   (description, single purpose, permission justifications, data-use answers) and lists
   the assets in `store/` to upload.

Firefox is not supported yet. It has no offscreen documents or `tabCapture`, which tab
recording relies on.

## Privacy

Captode does not collect, send or store anything outside your browser. See [PRIVACY.md](PRIVACY.md).

## Credits

Captode includes, compiled to WebAssembly from the [jSquash](https://github.com/jamsinclair/jSquash)
packages of Google's [Squoosh](https://github.com/GoogleChromeLabs/squoosh) codecs:

- [oxipng](https://github.com/shssoichiro/oxipng) (MIT) for lossless PNG recompression
- [MozJPEG](https://github.com/mozilla/mozjpeg) (IJG and BSD licences) for JPEG

This software is based in part on the work of the Independent JPEG Group. The licences
are in `src/vendor`.

## License

[MIT](LICENSE)
