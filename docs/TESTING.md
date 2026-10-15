# Testing Captode on every platform

Captode supports Chrome 116 or later (and other Chromium browsers: Edge, Brave, Opera,
Arc) on **Windows, macOS, Linux and ChromeOS**.

## What is tested automatically

`npm test` runs on Windows, macOS and Linux in GitHub Actions on every push. It loads
the extension into Chrome for Testing and checks:

- full-page, visible and selected-area captures, at 100%, 125%, 150% and 200% display
  scale (compared row by row with Chrome's own full-page screenshot)
- selecting an area with a mouse and with touch
- every image format, including that lossless output is pixel-identical and that size
  limits are met
- video export to MP4, WebM, GIF and WebP: speed, trims, audio length, device frames,
  and MP4 with Opus audio for systems without an AAC encoder (Chrome on Linux, and
  Windows without Media Foundation)
- the popup, editor and settings, including the keyboard shortcut Chrome reports and
  Windows high-contrast mode

## What needs a person

Chrome only lets an extension record a tab or the screen after a real click on its
icon or a real choice in the screen picker, so recording can't be automated. ChromeOS
can't run in CI. Before a release, go through this list on each platform you can.

Load the extension from `src/` (chrome://extensions → Developer mode → Load unpacked),
or install the zip from `npm run package`.

### Every platform

1. **Screenshot → Full page** on a long page (for example a news article). Check the
   result has no lines, gaps or repeated strips, and fixed headers appear once.
2. **Screenshot → Selected area**: drag a rectangle. On a touchscreen, drag with a
   finger. Press Esc once to check it cancels.
3. **Record → This tab** with **Record audio** on, on a page playing sound. Stop with the
   toolbar icon. Check the recording plays with sound.
4. **Record → Selected area**, stop with the keyboard shortcut shown in the popup.
5. **Record → Full screen**: pick a window in Chrome's picker, record a few seconds,
   stop. Then try again and press Cancel in the picker: Captode should say nothing
   was shared (on macOS, with a pointer to the Screen Recording permission).
6. In the recording, trim with the timeline, then export **MP4**, **GIF**, **WebP** and
   **WebM**. Open each downloaded file in the system's own player or viewer.
7. Turn on the **device frame** and export a screenshot and a GIF.
8. Switch the theme in Settings and check the popup and editor follow it; set it to
   System and change the operating system's dark mode.

### Windows

- Run at **125% or 150%** display scale (Settings → System → Display → Scale), which
  most laptops use, and repeat the full-page and selected-area screenshots.
- Turn on a **contrast theme** (Settings → Accessibility → Contrast themes). Switches,
  tabs and selected buttons in the popup and editor should all stay visible.
- Open an exported MP4 in the Photos or Media Player app.
- On Windows "N" editions without the Media Feature Pack, MP4 export uses Chrome's
  built-in H.264 encoder and keeps Opus audio; check it still exports.

### macOS

- The popup and Settings show the shortcut as **⌥⇧R** (Option-Shift-R).
- In the editor, shortcuts use **⌘** (⌘Z, ⌘S, ⌘⇧C).
- Full screen recording: macOS asks for **Screen Recording** permission for Chrome the
  first time (System Settings → Privacy & Security → Screen Recording).
- Open an exported MP4 in QuickTime Player (sound and picture).

### Linux

- Full screen recording on **Wayland** goes through the desktop portal's own picker.
- MP4 exports carry **Opus** audio (Chrome on Linux has no AAC encoder). Check the file
  plays with sound in the browser and in VLC or the desktop's video player.

### ChromeOS (Chromebook)

- Shortcuts show as **Ctrl** and **Alt**; the Backspace key deletes a selected shape.
- Selected-area capture and the editor work with the **touchscreen** and a stylus, and in
  **tablet mode**.
- **Full screen** recording: ChromeOS shows its own screen-share picker; record the
  whole screen and a window.
- Downloads land in the **Downloads** folder in the Files app; open an exported MP4 and
  GIF from there (the Gallery app plays both).
- On a low-memory Chromebook (4 GB), export a 30-second recording as GIF at 720p; the
  page should stay responsive and finish.
- Check on both an Intel and an ARM Chromebook if you can (the WebAssembly codecs and
  WebCodecs run on both).
