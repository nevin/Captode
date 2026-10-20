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
- the popup, editor and settings, including every keyboard shortcut Chrome reports and
  Windows high-contrast mode
- element and delayed screenshots, full pages of apps that scroll a panel, and the
  right-click menu's items
- Blur private details: off, nothing is looked for; on, email addresses and phone and
  card numbers are blurred (and not dates, sums or order numbers), in visible and
  full-page screenshots
- recordings with a camera bubble and microphone, with Chrome's stand-in camera: the
  bubble is drawn, keeps moving on a still page, and both are let go afterwards
- Share Captode and Copy diagnostics (no page addresses)
- in Firefox, from the Firefox package: it installs, the popup offers only what Firefox can
  do, a full-page screenshot has the page's height, and Settings, the editor, the video
  page and Compare open without errors
- every package holds only its own browser's manifest, settings and store (the build
  stops otherwise), and the Firefox one passes Mozilla's validator

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
3. Set the **Countdown** in the popup to 10 s and start **Record → This tab**; press Esc
   partway through: nothing is recorded. Set it to Off: recording starts at once.
4. **Record → This tab** with **Record audio** on, on a page playing sound. Stop with the
   toolbar icon. Check the recording plays with sound.
5. **Record → Selected area**, stop with the keyboard shortcut shown in the popup.
   Open DevTools, turn on device mode (a phone such as Pixel 7), and **Record → This tab**:
   the video is phone-shaped with no black bars. Repeat with **Video size** at 200% and at
   1080p: the video is twice as large, then 1080 px wide.
6. **Record → Full screen**: pick a window in Chrome's picker, wait for the countdown
   (shown on the page and on the toolbar badge), record a few seconds, stop. Start again
   and press Cancel during the countdown: nothing is recorded. Then try again and press Cancel in the picker: Captode should say nothing
   was shared (on macOS, with a pointer to the Screen Recording permission).
7. In the recording, trim with the timeline, then export **MP4**, **GIF**, **WebP** and
   **WebM**. Open each downloaded file in the system's own player or viewer. Record
   test/site/colours.html (served by the tests' site, or opened as a file): colours in
   the exports, in QuickTime too, should match the page, with no lighter or washed-out look.
8. Turn on the **device frame** and export a screenshot and a GIF. Take a screenshot in
   DevTools' device mode as an iPhone or Pixel: **Best match** names that device and says
   the pixels are kept exactly. Switch to Landscape and to another device, a tablet included.
9. In Settings turn on **Copy screenshots to the clipboard**, take a screenshot, and paste
   it into another app (a chat or document). In the editor, add numbered steps and use
   **Copy** in the Export panel; paste again.
10. Switch the theme in Settings and check the popup and editor follow it; set it to
   System and change the operating system's dark mode.
11. **Review tab:** measure a button with U (the size is in CSS pixels and snaps to its
   edges), pick its text and background colours with I and read the contrast, press G for
   the grid. Export: none of it is in the file.
12. **Compare:** from the editor, compare a screenshot with an earlier one, then open a
   design PNG as B. Try the slider (drag, and arrow keys), side by side, overlay, and the
   difference; download the difference image.
13. **Share for review:** add numbered steps, write a note for each, download the page and
   open it in another browser. Clicking a note highlights its step.
14. **Several devices:** tick three devices and download the zip; open it in the system's
   own archive tool.
15. **Keyboard only:** with a screen reader on (VoiceOver: ⌘F5; NVDA on Windows), draw a
   shape, Tab to the Annotations list, choose items with the arrow keys, move one with Alt
   and the arrows, and delete it. Each step is announced.
16. Remove a capture from Recent captures, delete an annotation and reset Settings: each
   toast offers Undo, which brings it back.
17. **Camera and microphone:** in the popup's recording options turn on **Camera bubble**
   and **Microphone**. Captode's page asks Chrome for them and shows a preview; allow, and
   it closes. Then **Record → This tab** while talking: the video has you in the bottom
   left corner, and your voice. (Tab recordings run in a hidden page that can't ask by
   itself, so this checks that the permission given carries over.) Repeat with
   **Record → Full screen**. Block the camera for Captode in Chrome's site settings and
   record again: the popup reports that the camera can't be used.
18. **Shortcuts and menus:** press Alt+Shift+F, Alt+Shift+V and Alt+Shift+S on a web page;
   right-click the page and the toolbar icon and try each Captode item. With **Blur private
   details** on in Settings, an email address on the page comes out blurred.
19. **Firefox** (from about:debugging → This Firefox → Load Temporary Add-on, choosing
   `manifest.json` in an unpacked `captode-<version>-firefox.zip`): every screenshot mode,
   the right-click menu, shortcuts, **Record → Full screen** with the microphone, an MP4
   and a GIF export, and Copy in the editor. Record with **Record audio** on while a video
   plays: if Firefox shares no sound, the recording page must say so ("No sound was
   shared…") rather than record silence without a word.
20. **Settings → Screenshots** (in real Chrome, with its toolbar): set **Clicking Captode's
   icon** to the full page and click the icon on a web page; right-click the icon and choose
   **Open Captode's menu**; click the icon on `chrome://settings` (the menu opens and explains).
   Set **After a screenshot** to Download, take one with Alt+Shift+V, and check the file is in
   Downloads with no editor tab left open; then Copy, and paste into another app. Downloading
   several in a row must not stop at Chrome's "download multiple files" question.
21. **Device frames:** with an iPhone, choose **Safe area → Show its edges** and **Keep the
   page inside it**, press **Rotate** in both, and check the export in the video page too.
22. **Recording settings:** set **Stop recording after** 15 seconds and **Highlight the
   cursor**; record a tab: it stops by itself and the circle follows the mouse.

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
