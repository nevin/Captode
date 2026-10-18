# Chrome Web Store: step by step

Captode is already on the Chrome Web Store, so this is an **update** to the existing listing.

**You need:** the Google account that published Captode.
**Cost:** nothing; the one-time $5 developer fee is already paid.
**Review:** usually 1 to 3 days. You get an email when it's live.

## Before you start

Download the Chrome package. It's the file called `captode-1.5.0-chrome.zip`, and you'll
find it in either of these places:
- on the release page: https://github.com/nevin/Captode/releases/tag/v1.5.0 (under **Assets**)
- in the `dist` folder of the project on your computer

Don't unzip it. The store wants the zip file itself.

## Steps

1. Go to https://chrome.google.com/webstore/devconsole and sign in.
2. Click **Captode** in your list of items.
3. **Upload the new version**
   1. In the left menu, click **Package**.
   2. Click **Upload new package**.
   3. Choose `captode-1.5.0-chrome.zip`.
   4. Wait until the page shows version **1.5.0**.
4. **Update the description**
   1. Click **Store listing**.
   2. Open [`../listing.md`](../listing.md) and copy the text in the box under **Description**.
   3. Paste it over the old description.
5. **Update the screenshots**
   1. Still on **Store listing**, scroll to **Screenshots**.
   2. Remove the old ones.
   3. Upload these five files from the `store/screenshots` folder, in this order:
      `1-capture.jpg`, `2-annotate.jpg`, `3-review.jpg`, `4-devices.jpg`, `5-record.jpg`.
6. **Explain the new permission**
   1. Click **Privacy**.
   2. In the permissions list there's now one called **contextMenus** (for the right-click
      menu).
   3. In [`../listing.md`](../listing.md), under **Permission justifications**, copy the
      sentence next to **contextMenus** and paste it into its box.
   4. Leave the other permission boxes as they are.
7. Check the rest of the **Privacy** page is still as it was:
   - Remote code: **No**
   - Data usage: **nothing ticked**
   - All three statements at the bottom: **ticked**
8. Click **Save draft**.
9. Click **Submit for review**, then confirm.

## After you submit

- **"Pending review":** the status in the dashboard reads this until Google approves it.
- **If it's rejected:** the email says why. Reply here with the email and the fix can be
  made.
- **Updating users:** you don't need to do anything. Chrome updates everyone who has
  Captode automatically, usually within a day of approval.
