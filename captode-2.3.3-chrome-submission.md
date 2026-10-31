# Captode 2.3.3: release and Chrome Web Store submission

## 1. Before releasing: 4 quick checks in your own Chrome (about 5 minutes)

Automation couldn't do these.

1. **Tab recording with the pointer zoom.** Record a tab for about 10 seconds and move the mouse around. On the video page, use **All tools**, then **Zoom that follows the pointer**, and play it back.
2. **Voiceover.** In Sound, choose **Record voiceover**, allow the microphone, talk for a few seconds, then stop. Play it back and check that the timing lines up.
3. **Sound cleanup and filler words.** Turn on **Lower background noise** and **Even out the volume**, and listen. Add a caption containing "um", then try **Filler words**.
4. **Join two recordings and seek.** Add a clip in Clips, then click around the timeline. It must jump straight away. This is the Chrome 156 bug that's now fixed.

## 2. Release

Version 2.3.2 is already released and pushed, with all the features. Since then, only the review fixes are uncommitted: lint setup, small code fixes, the shared busy helper, and the lint step in the release script. That makes this a patch release:

```bash
npm run release -- patch --push --message="Code checks (npm run lint) and tidy-ups from the code review"
```

It runs translations, lint, the tests, packaging and the Firefox lint, then commits once and tags v2.3.3. It writes `dist/captode-2.3.3-chrome.zip`.

**Which version to upload**
- If 2.3.2 has **not** been uploaded to the Chrome Web Store yet, upload **2.3.3** instead and skip 2.3.2.
- If 2.3.2 is already in review, let it finish, then upload 2.3.3 as a normal update.

## 3. Chrome Web Store dashboard

### Package
Go to **Package**, then **Upload new package**, and choose `dist/captode-2.3.3-chrome.zip` (about 0.8 MB).

Checked on the trial build:
- **Permissions:** the same 7 as 2.3.1 (activeTab, contextMenus, scripting, tabCapture, offscreen, storage, unlimitedStorage).
- **Site access:** no host permissions and no optional permissions.
- **Code:** no remote code; scripts load only from the package.
- **Other browsers:** nothing about them is in the zip.

### Store listing: add a "What's new" section at the top of the description

> **New in 2.3**
> - **Simple or All tools:** start with trim, cut, captions and export; turn on everything else when you need it. A short tour shows you around.
> - **Clips:** join recordings and video files, put a clip at the playhead, with fades between clips.
> - **Layers:** webcam or other video, pictures and text over your recording, which can move across the screen.
> - **Captions:** from speech (on the device), styled and lit up word by word, cleaned of "um"s, and added to MP4 and WebM as subtitles in several languages.
> - **Sound:** record a voiceover, add background music trimmed to the right moment, lower background noise and even out the volume.
> - **Zoom that follows the pointer**, chapters, brand kits with intro and outro slides, and templates for bug reports, tutorials and social clips.
> - **Export several:** other formats and upright or square copies made in the background, with a check before exporting for anything unexpected.
> - **Undo history** to go back several steps at once, and recovery if the tab closes during an export.
>
> Everything is still made on your device: no account, no upload, no watermark.

**Screenshots:** at least one showing the new video page would help. Simple mode with the tour card, and All tools with a layer and captions, show off the new features best. `npm run store` regenerates the store images if you want fresh ones.

### Privacy practices tab

**Single purpose**
> Capture your screen as screenshots and recordings, then edit and export them on your device.

**Permission justifications** (unchanged; re-use these if asked)

| Permission | Justification |
|---|---|
| activeTab | Capture the tab the user is on, only after they click Captode, use its shortcut or choose it from the right-click menu. |
| contextMenus | Offer screenshot modes and recording controls (pause, draw) in the page's and the toolbar icon's right-click menus. |
| scripting | Add Captode's capture helpers to the current tab when the user starts a capture: scrolling for full-page screenshots, choosing an area, and noting clicks and the pointer's position during a tab recording the user started. |
| tabCapture | Record the current tab's picture and sound when the user starts a recording. |
| offscreen | Run the recorder in an offscreen document so recording continues while the popup is closed. |
| storage | Keep settings, export presets, brand kits and the logo on the device. |
| unlimitedStorage | Keep recordings and screenshots on the device until the user deletes them; videos are large. |

**Remote code:** "No, I am not using remote code."

**Data usage:** Captode collects nothing: no data is sent off the device, and there is no server or analytics.
- **New since your last submission:**
  - The pointer's position is noted during a tab recording, for the zoom that follows it.
  - The microphone is used for voiceovers, only while the user records one.
- **How to answer:** both stay on the device, deleted with the recording, so answer as before: no user data collected.
- **If you ticked anything before** (for example "User activity" for clicks), keep it ticked for consistency.
- **Tick the three certifications:** not sold, not used for unrelated purposes, not used for credit decisions.

**Privacy policy URL:** `https://github.com/nevin/Captode/blob/main/PRIVACY.md`. It already describes the pointer position and the voiceover microphone use (it was committed with 2.3.2).

### Notes for the reviewer (optional field)

> 2.3 adds video editing on the extension's own video page: clips, layers, captions, music, voiceover and exports. No new permissions. Microphone access for voiceovers is requested at runtime through the browser's usual prompt, only when the user clicks Record voiceover. Captions from speech use Chrome's on-device speech recognition (processLocally). Nothing is sent to any server.

## 4. Afterwards

- **Firefox:** upload `dist/captode-2.3.3-firefox.zip` with `dist/captode-2.3.3-source.zip`, and re-paste the privacy policy.
- **Edge:** upload `dist/captode-2.3.3-edge.zip`. Once listed, set its store URL in `tools/targets.mjs`; that also turns on the "Rate it" link for Edge users.
- **Release notes:** the Firefox and Edge versions have no captions from speech, so leave that bullet out of their notes.
