# Store listing — TabReel

Use this text for the Chrome Web Store and Microsoft Edge Add-ons.

**Name:** TabReel — Screenshot & Screen Recorder

**Short description (max 132 characters):**
Capture full-page, visible or selected-area screenshots and recordings. Annotate, then export as PNG, JPG, PDF, GIF, MP4 or WebP.

**Category:** Productivity (Chrome) / Productivity (Edge)

**Icon:** `store/icon-300.png` (Edge asks for 300 × 300), `src/icons/icon128.png` (Chrome)

## Description

TabReel captures exactly what you need from any web page, then lets you mark it up and export
it in the format you want. Everything happens in your browser. Nothing is uploaded.

SCREENSHOTS
• Full page: the entire scrolling page in one image
• Visible area: just what is on screen
• Selected area: drag to choose a region

EDIT
• Crop, with fixed ratios or freeform
• Pen and highlighter
• Arrows, lines, rectangles and ellipses
• Text with any font, size, colour and background
• Blur or pixelate private details
• Resize, plus padding, backdrop, rounded corners and shadow

EXPORT
• PNG, compressed PNG, JPEG, WebP, GIF, BMP and PDF
• Multi-page A4 or Letter PDFs for long pages
• Quality and size controls, with the file size shown before you download

RECORD
• Full screen or window, the current tab, or a selected area of the tab
• 15 to 60 fps, optional audio, 3-second countdown
• Click the icon to stop

VIDEO EXPORT
• MP4, GIF, animated WebP and WebM
• Trim, choose the resolution and frame rate
• Lossless size reduction for GIF and WebP: identical frames are merged and only changed pixels are stored

DEVICE MODE
• Present any screenshot or recording inside a phone or tablet frame, with a gradient or transparent background

No account, no watermark, no tracking.

## Single purpose (Chrome Web Store)

TabReel captures screenshots and screen recordings of the user's browser tab or screen, and
lets the user edit and export them.

## Permission justifications

- **activeTab:** Captures the tab the user is on when they invoke TabReel.
- **scripting:** Injects the area-selection overlay and countdown, and scrolls the page to stitch full-page screenshots.
- **tabCapture:** Records the current tab when the user starts a tab recording.
- **desktopCapture:** Lets the user pick a screen or window to record in Full screen mode.
- **offscreen:** Hosts the MediaRecorder for tab recordings, since a service worker cannot hold a media stream.
- **storage:** Stores the user's settings.
- **unlimitedStorage:** Holds recordings locally until the user exports them. Long recordings can exceed the default quota.

**Remote code:** No. All code ships in the package.

**Data usage:** TabReel does not collect or transmit user data. Tick "I do not collect" for every category.

## Screenshots to prepare (1280 × 800)

1. The popup with the three screenshot modes
2. The editor with arrows, text and a blurred area
3. The export panel showing format, size and estimated file size
4. The video page converting to GIF with the lossless option
5. Device mode: a screenshot in a phone frame on a gradient
