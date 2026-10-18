# Safari (Mac App Store): step by step

Safari is different from the other browsers. Its extensions are published inside a small
Mac app, made with Apple's Xcode and sent through the App Store. This is Captode's
**first** Safari submission, and it takes the most steps of the four stores.

**You need:**
- a Mac with **Xcode** (free, from the Mac App Store)
- an **Apple Developer Program** membership

**Cost:** $99 a year for the Apple membership.
**Review:** usually 1 to 3 days.

> **Note:** the Safari version hasn't been tried in Safari yet. Step 3 below is where you
> check that it works. If something doesn't, stop there and report it here before
> submitting.

## Before you start

You need the folder `captode-1.5.0-safari`, from either place:
- the project's `dist` folder
- `captode-1.5.0-safari.zip` from https://github.com/nevin/Captode/releases/tag/v1.5.0
  (unzip it)

## One-time setup

1. Join the Apple Developer Program at https://developer.apple.com/programs/enroll/ (as an
   individual). Approval can take a day or two.
2. Install **Xcode** from the Mac App Store, open it once, and let it finish installing.
3. In Xcode, go to **Settings → Accounts**, click **+**, and sign in with your Apple ID.

## Steps

1. **Turn the extension into a Mac app**
   1. Open **Terminal**: press ⌘ Space, type "Terminal", press Return.
   2. Type `cd ` (with a space after it) and drag the project folder onto the window, then
      press Return.
   3. Paste this, then press Return:
      ```
      xcrun safari-web-extension-converter dist/captode-1.5.0-safari --app-name Captode --bundle-identifier com.nevinpaul.captode --macos-only
      ```
   4. Xcode opens with a new project called **Captode**.
   5. Keep the bundle identifier the same in every future version.
2. **Sign it**
   1. In Xcode, click **Captode** at the top of the left panel.
   2. For each item under **Targets**, open **Signing & Capabilities** and choose your team.
3. **Try it in Safari**
   1. Press ⌘R to run the app.
   2. In Safari, open **Settings → Extensions** and tick **Captode**.
   3. If Captode isn't listed: open **Settings → Advanced**, tick "Show features for web
      developers", then in the **Develop** menu tick "Allow unsigned extensions".
   4. Check that it works:
      - Open any website.
      - Click the Captode button, then **Full page**: the editor should open with the
        whole page.
      - Try **Visible area** and **Selected area**.
      - Try **Record → Full screen**.
4. **Set the version**
   1. On the Captode target, open **General**.
   2. Set **Version** to `1.5.0` and **Build** to `1`.
5. **Create the App Store entry** (first time only)
   1. Go to https://appstoreconnect.apple.com, open **Apps**, click **+**, then **New App**.
   2. Platform: **macOS**.
   3. Name: **Captode**.
   4. Bundle ID: `com.nevinpaul.captode`.
   5. SKU: `captode`.
6. **Upload**
   1. In Xcode choose **Product → Archive**.
   2. When it finishes, click **Distribute App**, then **App Store Connect**, then
      **Upload**.
7. **Fill in the App Store page** (in App Store Connect):
   - **Screenshots:** the files in `store/screenshots`. Their 1280 × 800 size is one the Mac
     App Store accepts. Leave out `5-record.jpg`.
   - **Description:** from [`../listing.md`](../listing.md), using the Firefox **Record**
     paragraph from [`../listing-firefox.md`](../listing-firefox.md). Safari, like Firefox,
     can't record a single tab.
   - **Privacy:** choose **Data Not Collected**.
   - **Privacy policy URL:** `https://github.com/nevin/Captode/blob/main/PRIVACY.md`
   - **Category:** Productivity.
   - **Price:** Free.
8. Choose the build you uploaded, then click **Add for Review** and **Submit**.

## After it's live

Send the App Store link here, so the **Share Captode** button can point to it in the next
version.
