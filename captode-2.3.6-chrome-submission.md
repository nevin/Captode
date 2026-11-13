# Captode 2.3.6: release and Chrome Web Store submission

## 1. Before releasing: 3 quick checks in your own Chrome (about 5 minutes)

The automated tests cover these, but they're worth a look by eye.

1. **Share for review.** Annotate a screenshot with a few numbered steps and a text label, then use **Share for review**. Check that the preview shows the image and details. Check that the source URL and image labels are left out until you turn them on, and that **View full size** opens the image.
2. **Frame to editor with slides.** On the video page, add an overlay slide (a lower third), pause on it and use **Frame to editor**. The editor should get the frame with the overlay on it. Then pause on an inserted slide and do the same: you should get the slide itself, titled with its heading.
3. **Compare.** Open two long full-page screenshots in Compare, choose **Difference**, and drag the tolerance slider back and forth. The result should settle on the final value with no stale result flashing up.

## 2. Release

Version 2.3.5 is released and pushed. Since then, three sets of changes are waiting uncommitted:
- Share for review lets you preview what is shared, and leaves out the source URL and image labels unless you include them.
- Frame to editor keeps the slides and overlays on screen.
- Compare uses less memory on long screenshots, and stops differences that are out of date.

That makes this a patch release:

```bash
npm run release -- patch --push --message="Share for review previews what is shared, with the source URL off by default; Frame to editor keeps slides and overlays; lighter Compare"
```

It runs translations, lint, the tests, packaging and the Firefox lint, then commits once and tags v2.3.6. It writes `dist/captode-2.3.6-chrome.zip`.

**Which version to upload**
- If 2.3.5 has **not** been uploaded to the Chrome Web Store yet, upload **2.3.6** instead and skip 2.3.5.
- If 2.3.5 is already in review, let it finish, then upload 2.3.6 as a normal update.

## 3. Chrome Web Store dashboard

### Package
Go to **Package**, then **Upload new package**, and choose `dist/captode-2.3.6-chrome.zip`.

- **Permissions:** unchanged since 2.3.1 (`src/manifest.json` has no changes): activeTab, contextMenus, scripting, tabCapture, offscreen, storage, unlimitedStorage.
- **Site access:** no host permissions and no optional permissions.
- **Code:** no remote code; scripts load only from the package.

### Store listing: "What's new" at the top of the description

> **New in 2.3.6**
> - **Share for review** shows a preview of the page before you save it. The source URL and the image's labels are left out unless you choose to include them.
> - **Frame to editor** keeps what's on screen: the frame with any overlays on it, or a slide by itself.
> - **Compare** handles long full-page screenshots with less memory, and keeps up as you change the tolerance.
>
> Everything is still made on your device: no account, no upload, no watermark.

Keep the **New in 2.3** section from the last submission under it.

### Privacy practices tab

Nothing to change. Captode still collects nothing.
- Review pages are files the user saves, never uploaded. They now hold *less* by default: the source URL and selectable text labels are opt-in.
- `PRIVACY.md` describes this and goes out with this release, so the policy URL stays the same: `https://github.com/nevin/Captode/blob/main/PRIVACY.md`.
- The single purpose, permission justifications, remote code answer and certifications are the same as in `captode-2.3.3-chrome-submission.md`.

### Notes for the reviewer (optional field)

> A patch release: Share for review previews its page and leaves out the source URL by default; Frame to editor includes slides and overlays; lighter screenshot comparison. No new permissions; nothing is sent to any server.

## 4. Afterwards

- **Firefox:** upload `dist/captode-2.3.6-firefox.zip` with `dist/captode-2.3.6-source.zip`.
- **Edge:** upload `dist/captode-2.3.6-edge.zip`.
- **Safari:** the release updates the Xcode project in `safari/` with the new package and version. Build and submit it from Xcode as usual.
