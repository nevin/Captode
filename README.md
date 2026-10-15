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

- **Crop**, freely or to 1:1, 16:9, 4:3, 9:16 or 3:4.
- **Draw** with a pen or highlighter.
- **Add shapes:** lines, arrows, rectangles and ellipses, with stroke colour, fill, thickness and opacity.
- **Add text:** choose the font (including fonts installed on your computer), size (A− / A+),
  bold, italic, text colour and background colour.
- **Blur, pixelate or black out** sensitive details.
- Select, move, restyle and delete anything you added. Undo and redo.
- **Resize** to exact pixel sizes, with or without keeping the proportions.
- **Frame** the shot with padding, a backdrop colour, rounded corners and a shadow.
- **Export** as PNG, compressed 8-bit PNG, JPEG, WebP, GIF, BMP or PDF (one page, or A4 or
  Letter pages with long pages split across them). The quality and size controls compress the
  file, and the live estimate shows the size before you download. You can also copy the image
  to the clipboard.
- **Keyboard shortcuts** for every tool. Press **?** in the editor to see them all.
- **Recent captures:** open the editor from the popup to get back any capture from the last
  24 hours, even after closing its tab.

### Recordings

- **Full screen:** your whole screen or any window.
- **Visible area:** the current tab.
- **Selected area:** drag a rectangle; only that part of the tab is recorded.

You can pick the frame rate (15, 24, 30 or 60 fps), include audio, and start after a 3-second
countdown. Click the Captode icon (or press **Alt+Shift+R**) to stop. The recording then
opens in the video page, where you can:

- Trim on a timeline with thumbnails: drag the handles, or play to a point and press **I**
  (start) or **O** (end). **Space** plays only the trimmed part; the arrow keys step frame by
  frame.
- Export as **MP4**, **GIF**, **WebP** (animated) or **WebM**.
- Choose the resolution (original, 2160p down to 240p) and the frame rate.
- **Reduce file size losslessly** (GIF and WebP). Repeated frames are merged and only the
  pixels that change are stored, so the file is smaller with no visible quality loss.
  WebP can also use lossless frames.
- Set the MP4 or WebM quality, from visually lossless to smallest file.

### Device mode

Turn on **Device mode** in the popup, the editor or the video page to export a screenshot or
video inside a phone or tablet frame. You can choose:

- the device and its colour
- portrait or landscape
- how the capture fits the screen
- a transparent, white or custom-colour background (the default is set in Settings)
- padding
- a status bar

### Settings

Open **Settings** from the gear in the popup (or right-click the icon → Options) to choose:

- **Theme:** System (follows your browser and computer), Light or Dark.
- **Export background:** Transparent, White or a custom colour, used behind device frames
  and around padded screenshots. JPEG, BMP, PDF, MP4 and WebM can't be transparent, so
  they get white when Transparent is chosen.
- **Default formats** for screenshots and recordings, and whether device frames are on.

Settings also has links to help, problem reports and the privacy policy, and a button that
resets everything to the defaults.

On browser pages that Chrome protects (such as `chrome://` pages and the Web Store), the
popup explains that the page can't be captured and leaves full-screen recording available.

## Install

Captode works in Chromium browsers: Chrome 116 or later, Edge, Brave, Opera and Arc.
MP4 export needs Chrome 126 or later.

### From source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `src` folder.

## Development

The extension is plain JavaScript modules with no build step and no dependencies.

```
src/
  manifest.json
  background.js          service worker: captures, recording state, toolbar icon
  content/page.js        functions injected into the page (area picker, scrolling, countdown)
  popup/                 the toolbar popup
  settings/              the Settings page
  editor/                image editor
  video/                 recording preview and export
  recorder/offscreen.*   records the tab (offscreen document)
  recorder/screen.*      records the whole screen or a window
  lib/
    db.js                hands captures between pages through IndexedDB
    recorder.js          MediaRecorder wrapper, with cropping for selected-area recordings
    device.js            phone and tablet frames
    settings.js          user settings shared by every page
    theme.js             applies the Light, Dark or System theme
    gif.js               animated GIF encoder with lossless frame diffing
    webp.js              animated WebP muxer
    quantize.js          median-cut colour reduction and dithering
    formats.js           PDF, BMP, 8-bit PNG and still GIF encoders
tools/
  make-icons.mjs         draws the icons
  package.mjs            builds the store zip
```

```bash
npm run icons     # redraw src/icons/*.png
npm run package   # build dist/captode-<version>.zip for the stores
```

## Publishing

1. Bump `version` in `src/manifest.json`.
2. Run `npm run package`.
3. Upload `dist/captode-<version>.zip` to the
   [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) and to
   [Microsoft Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge/).
   Listing text, permission justifications and the privacy statement are in [`store/`](store/).

Firefox is not supported yet. It has no offscreen documents or `tabCapture`, which tab
recording relies on.

## Privacy

Captode does not collect, send or store anything outside your browser. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
