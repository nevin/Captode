# Captode privacy policy

_Last updated: 15 October 2026_

Captode is a browser extension for taking screenshots and screen recordings and editing
them. It does not collect, transmit, sell or share any personal or sensitive data.

## What Captode handles, and where it stays

- **Screenshots and recordings** are made, edited and exported entirely inside your
  browser, on your device. Nothing is uploaded anywhere.
- **Until you download them**, captures (and the edits you make to them) are kept in the
  extension's own browser storage (IndexedDB) so the editor and video pages can open them,
  and so you can reopen a recent capture where you left off. They are deleted automatically after 24 hours, and you can remove any of them
  sooner from the editor's Recent captures list.
- **Your settings** (theme, export background, default formats, device-frame and
  recording options, export presets and recently used devices) are kept in the browser's
  extension storage on your device.
- **Review pages** made with Share for review, and zips of several devices, are files you
  download: Captode doesn't upload or host them. A review page contains the image and the
  notes you wrote, and the address of the page you captured.
- **Compression** (including the oxipng and MozJPEG encoders bundled with the extension)
  runs locally. No code is downloaded at run time.

## What Captode never does

- It makes no network requests of its own. The only links to the internet are the Help,
  Report a problem and Privacy policy buttons in Settings, which open a web page when you
  click them.
- It has no accounts, analytics, advertising, telemetry or tracking.
- It doesn't read pages in the background. It only acts on the tab you're on, when you
  start a capture or recording yourself.

## Permissions

| Permission | Why Captode needs it |
| --- | --- |
| `activeTab` | Capture the tab you're on, only after you click Captode or press its shortcut. |
| `scripting` | Show the area picker and countdown on that tab, and scroll it for a full-page screenshot. |
| `tabCapture` | Record the current tab when you start a tab or selected-area recording. |
| `offscreen` | Keep a tab recording running after the popup closes. |
| `storage` | Remember your settings. |
| `unlimitedStorage` | Keep large recordings safe on your device until you export them, so the browser doesn't clear them under storage pressure. |

Recording your whole screen or a window uses your browser's own screen-sharing picker,
which needs no extra permission and always asks you first.

## Contact

Questions or concerns: open an issue at https://github.com/nevin/Captode/issues
