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
23. **Video editing:** record a tab for 20 seconds, clicking a few buttons. In the video page
   press **Zoom in on clicks** and play: it zooms in where you clicked. Add a cut, a 4×
   speed-up, a blur over some text and an arrow; crop, turn on Background, mute a part and
   export MP4 and GIF: each matches the preview, and the sound is silent where cut, sped up
   or muted. Reload the page: the edits are still there. Turn on **Show clicks** and export:
   a ring appears at each click. Record a tab with the microphone, pausing while you speak,
   and press **Cut silent parts**: the pauses become cuts. Play at 150% volume with a fade in:
   it is louder than at 100% and fades in. Cut the last 3 seconds and play just before them:
   playback stops where the cut starts. Set a start and end, close the page and open the
   recording again: the same part is kept. Cut everything: the timeline says so and Export
   explains instead of starting.
   **Clips:** under Clips, with **After this one**, add another recording, then an MP4 from
   the computer: both play after it, with a numbered mark on the timeline at each start, and
   the MP4 fits inside the picture with bars. Move the first clip later: its captions and cuts
   go with it. Remove a clip. With **On top**, add a recording: a Video layer appears in the
   lower right from the playhead; change its corner, size and shape, and export MP4 and GIF:
   it is there in both, and gone after its end. Pause and drag the layer to the upper left,
   and its corner to make it bigger. Add a layer with sound over a quiet part: the export has
   its sound there, at the volume chosen. With **At the playhead**, put a clip in the middle
   of the recording: it plays there, and the recording carries on after it. Add only part of
   a clip with the dialog's Start and End; then **Undo last change**. Set a clip's
   transition to a fade and to a crossfade, and play across the join. Give a layer an edge
   colour, a shadow, half opacity and a 1 s fade; drag it near the middle: it snaps, with a
   guide line. Add a Text layer and a screenshot as a picture layer (On top). Zoom the
   timeline in and play: it follows the playhead. Add music in Sound, export, and listen: it
   gets quieter when you speak. Add two chapters and export an MP4: a player shows them; Copy
   for YouTube pastes a 0:00 list. Freeze a frame. Cut a second and Remove cut parts for good:
   the recording is a second shorter. Try Made for → Shorts, then Thumbnail….
   In Chrome only: record a tab while talking, then Sound → **Captions from speech**: after
   the language pack is ready, captions appear where you spoke, and one Undo removes them.
   In the Edge, Firefox and Safari packages the button isn't there.
   Choose a caption: set a light band at the top, a serif font and Light up each word; play
   and export: it looks the same in both. Join it with the next, press Enter mid-way to split
   it, and fix a word in Review captions.
24. **Pause:** record a tab, right-click the Captode icon and choose **Pause recording** (the badge
   shows ❚❚), click the page, wait 5 seconds, choose **Resume recording**, then stop. The video
   leaves the pause out, and **Show clicks** has no ring for the click made while paused. Record
   the full screen and use the page's **Pause** and **Resume**, with **Stop recording after** set:
   it stops after that much recorded time, not counting the pause. Set a shortcut for **Pause or
   resume the recording** in the browser's shortcut settings and try it.
25. **Recovery:** start a long tab recording and quit the browser (⌘Q / Alt+F4) or close the full
   screen recording page. Reopen and open the popup: it offers the recording; open it, it plays
   up to about when it stopped, and exports.
26. **Draw on the page:** while recording a tab, right-click the Captode icon and choose **Draw on
   the page**; draw with the mouse (and a finger on a touchscreen), check strokes fade, press Esc.
   The drawing is in the video, and no click ring or guide step comes from drawing.
27. **Step-by-step guide:** record a tab clicking a button, a link and a text field (type
   something, and into a password field too). In the video page press **Step-by-step guide**:
   a step per click, notes naming the button, link and field (never what was typed, nothing for
   the password field). Edit a note, move and remove steps, reload: the changes are kept.
   Download the web page, PDF and Markdown zip, and open each.
28. **Captions:** add two captions (**T**), cut a part before the second, and export MP4: the
   captions show at the bottom. Download .srt and .vtt and load them in VLC with the MP4:
   they line up.
29. **Keep and projects:** press Keep in the editor and the video page (the bookmark fills),
   check Settings → Captures and storage lists both as Kept; set the computer's clock a day
   ahead (or wait), take a new screenshot: kept ones stay, others go. Save project for a
   recording with edits, slides, a guide and captions, delete the recording, and open the
   .captode file from Settings and from the editor's Open: everything is back. Open it in
   another browser profile too.
30. **Export queue (Chrome, Edge):** add an MP4 and a GIF to the queue, close the video page:
   the badge counts up and shows ✓; the popup lists both with Download and Share. Quit the
   browser mid-export and reopen: it carries on. Cancel one while it runs.
31. **Share:** on Windows, macOS and ChromeOS, Share an exported MP4 and an edited screenshot to
   Mail or a chat app: the file arrives. Where the share sheet takes no files, no Share button.
32. **Callouts:** add a circle and a numbered step on a recording, export: they look like the
   editor's ellipse and step, in the same colours.
33. **Image export:** take a screenshot of a text-heavy page on a Retina or 150% display.
   Choose **Smallest**: the note says which format won; open the file. WebP with **Lossless**
   on opens pixel-identical. With PNG chosen, a hint offers Smallest when it's 15% smaller.
   Choose **1× — as on screen**: the file is the page's CSS size. In **Several sizes or
   formats**, tick 100%, 1×, PNG and WebP and download: the zip holds four files.

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
