# Microsoft Edge Add-ons: step by step

This is Captode's **first** submission to Edge, so you'll create a new listing.

**You need:** a Microsoft account.
**Cost:** free.
**Review:** up to 7 working days. You get an email when it's live.

## Before you start

Download these files:
- **The Edge package:** `captode-1.5.0-edge.zip`, from
  https://github.com/nevin/Captode/releases/tag/v1.5.0 (under **Assets**), or from the
  project's `dist` folder. Don't unzip it.
- **From the project's `store` folder:**
  - `icon-300.png` (the store logo)
  - `promo-small.jpg`
  - `promo-marquee.jpg`
  - the screenshots in `store/screenshots`

## One-time setup: a developer account

1. Go to https://partner.microsoft.com/dashboard/microsoftedge/ and sign in.
2. If you're asked to register as a developer, choose **Individual**.
3. Fill in your name, email and country, then accept the agreement. It's free.

## Steps

1. In the Edge dashboard, click **Create new extension**.
2. **Upload the package**
   1. Drag `captode-1.5.0-edge.zip` onto the upload box.
   2. Wait for the green tick, then click **Continue**.
3. **Availability**
   1. Visibility: **Public**.
   2. Markets: **All markets**.
   3. Click **Save**.
4. **Properties**
   1. Category: **Productivity**.
   2. Privacy policy URL: `https://github.com/nevin/Captode/blob/main/PRIVACY.md`
   3. Website: `https://github.com/nevin/Captode`
   4. Support: `https://github.com/nevin/Captode/issues`
   5. "Does your extension access, collect or transmit personal information?" **No**.
   6. Click **Save**.
5. **Store listings**: click **English**, then fill in each field.
   1. **Description:** copy the text in the box under **Description** in
      [`../listing.md`](../listing.md).
   2. **Extension store logo:** upload `icon-300.png`.
   3. **Small promotional tile:** upload `promo-small.jpg`.
   4. **Large promotional tile:** upload `promo-marquee.jpg`.
   5. **Screenshots:** upload `1-capture.jpg`, `2-annotate.jpg`, `3-review.jpg`,
      `4-devices.jpg` and `5-record.jpg`.
   6. **Search terms:** copy the seven from the Edge section of
      [`../listing.md`](../listing.md).
   7. Click **Save**.
6. **Submit**
   1. Click **Publish**.
   2. In **Notes for certification**, paste the **Test instructions** box from
      [`../listing.md`](../listing.md).
   3. Click **Publish** again.

## After it's live

Edge shows Captode's page address, something like
`https://microsoftedge.microsoft.com/addons/detail/captode/abcdef…`. Send it here: it goes
into the project, which turns on the **Share Captode** button for Edge users in the next
version. Until then, Edge users simply don't see that button.

Next time, updating is shorter: open Captode in the dashboard, click **Update** and upload
the new `-edge.zip`.
