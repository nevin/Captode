# Firefox Add-ons (addons.mozilla.org): step by step

Captode is already listed (https://addons.mozilla.org/firefox/addon/captode/). For a new
version, follow **Updating** just below; the rest of this page is how the listing was first made.

## Updating

1. Go to https://addons.mozilla.org/developers/addons, click **Captode**, then **Upload New Version**.
2. Choose `captode-<version>-firefox.zip` from `dist/`. Tick **Firefox** only (not Android).
3. Wait for "validated with no errors" (the release already ran the same validator), then **Continue**.
4. "Do you need to submit source code?": **Yes**, and upload `captode-<version>-source.zip`.
5. **Release notes:** a sentence on what changed. **Notes to reviewer:** the box under
   **Notes to reviewer** in [`../listing-firefox.md`](../listing-firefox.md), with `<version>` filled in.
6. Click **Submit Version**.

**You need:** a Mozilla account.
**Cost:** free.
**Review:** an automatic check right away. A person may also review it later, usually
within a few days.

## Before you start

From https://github.com/nevin/Captode/releases/tag/v2.3.1 (under **Assets**), or from the
project's `dist` folder, download these two files. Don't unzip either of them.
- `captode-2.3.1-firefox.zip`: the add-on itself
- `captode-2.3.1-source.zip`: Captode's source code. Firefox asks for it because Captode
  contains two small image compressors written in WebAssembly.

## One-time setup

1. Go to https://addons.mozilla.org/developers/ and click **Log in**.
2. Create a Mozilla account, or sign in with an existing one.
3. Accept the developer agreement when it appears.

## Steps

1. Click **Submit a New Add-on**.
2. "How to distribute this version": choose **On this site**, then click **Continue**.
3. **Upload the add-on**
   1. Click **Select a file** and choose `captode-2.3.1-firefox.zip`.
   2. Under compatibility, tick **Firefox** only. Untick **Firefox for Android**, because
      Captode isn't made for phones.
   3. Wait for "Your add-on was validated with no errors", then click **Continue**.
4. **Source code**
   1. When asked "Do you need to submit source code?", choose **Yes**.
   2. Upload `captode-2.3.1-source.zip`.
   3. Click **Continue**.
5. **Describe the add-on**: open [`../listing-firefox.md`](../listing-firefox.md) and copy
   each field from there.
   1. Name: `Captode — Screenshot & Screen Recorder`
   2. **Add-on URL:** keep it as **captode** if offered. If that name is taken, write down
      the one you get and send it here, because the Share button points to it.
   3. **Summary:** copy the box under **Summary**.
   4. **Description:** copy the description from [`../listing.md`](../listing.md), but swap
      in the **Record** paragraph given in `listing-firefox.md`. Firefox can't record a
      single tab, so that paragraph leaves it out.
   5. **Categories:** Photos, Music & Videos; Productivity.
      **Tags:** tick **privacy** and **video converter**, and no others.
   6. **Support website:** `https://github.com/nevin/Captode`
   7. **License:** GNU General Public License v3.0.
   8. **Privacy policy:** tick "This add-on has a privacy policy" and paste the text of
      `PRIVACY.md`.
   9. **Notes to reviewer:** copy the whole box under **Notes to reviewer**, changing
      `<version>` to `2.3.1`.
6. Click **Submit Version**.
7. **Add screenshots**
   1. Open Captode's page in the Developer Hub and click **Edit Product Page**.
   2. Upload, in this order: `1-capture.jpg`, `2-annotate.jpg`, `3-review.jpg` and
      `4-devices.jpg` from the `store/screenshots` folder; then `5-record.jpg` from
      `store/screenshots/firefox` (the Firefox version: it shows recording as Firefox
      offers it); then `6-compare.jpg` and `7-private.jpg` from `store/screenshots`.
   3. Give each screenshot its caption: copy them from **Screenshot captions** in
      [`../listing-firefox.md`](../listing-firefox.md).
   4. Don't use the `5-record.jpg` in `store/screenshots` itself: it shows tab recording
      and the camera bubble, which Firefox doesn't have.
   5. **Icon:** upload the three sizes from the `store/firefox` folder, `icon-32.png`,
      `icon-64.png` and `icon-128.png`, if asked for each size. If only one is asked for,
      use `icon-128.png`.

## After you submit

- **When it's live:** usually as soon as the automatic check passes. A Mozilla reviewer
  may still look at it later.
- **If a reviewer asks a question:** you'll get an email. Most questions are answered in the
  notes you pasted. If not, send the email here.
- **Updating users:** Firefox updates everyone automatically.

Next time, updating is shorter: open Captode, click **Upload New Version**, and upload the
new `-firefox.zip` with its `-source.zip`.
