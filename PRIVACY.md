# Captode privacy policy

_Last updated: 25 October 2026_

Captode is a browser extension for taking screenshots and screen recordings and editing
them. It does not collect, transmit, sell or share any personal or sensitive data.

## What Captode handles, and where it stays

- **Screenshots and recordings** are made, edited and exported entirely inside your
  browser, on your device. Nothing is uploaded anywhere.
- **Until you download them**, captures (and the edits you make to them) are kept in the
  extension's own browser storage (IndexedDB) so the editor and video pages can open them,
  and so you can reopen a recent capture where you left off. They are deleted automatically after a day (or a week, a month, or never, as you choose in Settings → Captures and storage), and you can remove any of them
  sooner from the editor's Recent captures list, or with **Discard** (the bin button) in the
  editor or the video page, which deletes the capture with its edits and slides.
- **Kept captures:** a capture you choose to **Keep** stays in that storage until you remove
  it (Settings → Captures and storage lists them, with what they take up), instead of being
  deleted automatically.
- **Project files** (.captode), made with Save project, are files you download: a capture with
  its edits, slides, guide and captions. Captode doesn't upload them. Opening one puts it back
  in Captode's storage on your device, kept until you remove it.
- **Exports added to the queue** are made in the background on your device and kept in that
  storage until you remove them, or for a day.
- **Share** hands the file to the app you pick in your system's share sheet; Captode sends it
  nowhere itself.
- **While you record**, the recording is also written to that storage a second at a time, so
  it isn't lost if the browser closes or crashes first. That copy is deleted as soon as the
  recording is saved; if it was cut off, Captode saves what it has as a capture (offered in
  the popup), which is then kept and deleted like any other.
- **Slides** you add to a recording, and any pictures you choose for them (background,
  logo, picture), are kept with that recording in the same storage and deleted with it.
- **Your settings** (theme, export background, default formats, device-frame and
  recording options, export presets and recently used devices) are kept in the browser's
  extension storage on your device. So are:
  - **Slide brand kits**: slide styles you saved by name, with any logo, font file and
    background picture in them (each up to 3 MB). Delete one from the Brand kit list.
  - **The style of the last slide you edited** (theme, colours, font, layout, and its logo
    and font file if each is under 1.5 MB; never a background picture), so new slides can
    reuse it. Editing another slide's style replaces it; **Forget saved style** in the
    Slides section, or removing Captode, deletes it.
- **Slide files** made with Export in the Slides section are files you download; Captode
  doesn't upload them. They hold the slides' words, settings, pictures and font file.
- **Review pages** made with Share for review, and zips of several devices, are files you
  download: Captode doesn't upload or host them. A review page contains the image and the
  notes you wrote, and the address of the page you captured.
- **Camera and microphone** are used only if you turn on Camera bubble or Microphone in
  the recording options, and only while a recording is running. What they capture goes
  into that recording on your device and nowhere else. Your browser asks you before
  Captode can use them, and you can withdraw that at any time in the browser's site
  settings.
- **Private details** (email addresses, phone and card numbers) are looked for only if you
  turn on Blur private details in Settings, on the page you capture, at the moment you
  capture it, to blur them. Their positions
  are kept with the capture; the text itself isn't kept or sent.
- **Where you click** while Captode records a tab (the position on the page, the time, and
  the words on the button or link clicked, or the name of the field) is kept with the
  recording on your device, so the video page can offer **Zoom in on clicks**, **Show
  clicks** and **Step-by-step guide**. What you type is never kept, and nothing is kept
  about password fields. It is deleted with the recording.
- **Step-by-step guides** and **subtitle files** are files you download; Captode doesn't
  upload them. A guide holds the pictures and notes of its steps.
- **Drawing on the page** while recording happens on that page only, and is part of the
  recording; nothing about it is kept.
- **Copy it to the clipboard** (Settings → After a screenshot) puts the screenshot on your
  clipboard through the tab you captured, which has the focus the clipboard needs. The image
  is handed over in Captode's own isolated script, which the page's scripts can't read, and
  nothing is sent anywhere.
- **Copy diagnostics** in Settings puts versions, settings and the last error on your
  clipboard for you to paste into a report yourself. Captode doesn't send it.
- **Compression** (including the oxipng and MozJPEG encoders bundled with the extension)
  runs locally. No code is downloaded at run time.

## What Captode never does

- It makes no network requests of its own. The only links to the internet are the Help,
  Report a problem and Privacy policy buttons in Settings, which open a web page when you
  click them, and Share Captode, which hands the store's address to your system's share
  sheet or clipboard.
- It has no accounts, analytics, advertising, telemetry or tracking.
- It doesn't read pages in the background. It only acts on the tab you're on, when you
  start a capture or recording yourself.

## Permissions

| Permission | Why Captode needs it |
| --- | --- |
| `activeTab` | Capture the tab you're on, only after you click Captode, press one of its shortcuts or choose it in the right-click menu. |
| `contextMenus` | Offer the screenshot modes in the page's right-click menu and the toolbar icon's menu. |
| `scripting` | Show the area picker and countdown on that tab, and scroll it for a full-page screenshot. |
| `tabCapture` | Record the current tab when you start a tab or selected-area recording. |
| `offscreen` | Keep a tab recording running after the popup closes. |
| `storage` | Remember your settings. |
| `unlimitedStorage` | Keep large recordings safe on your device until you export them, so the browser doesn't clear them under storage pressure. |

Recording your whole screen or a window uses your browser's own screen-sharing picker,
which needs no extra permission and always asks you first. The camera and microphone
likewise need no extension permission: the browser asks you itself.

## Contact

Questions or concerns: open an issue at https://github.com/nevin/Captode/issues
