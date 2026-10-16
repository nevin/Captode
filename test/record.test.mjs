// Tab recordings, end to end: started and stopped as the toolbar does, with Chrome's
// real tab capture (the test extension is allow-listed to record without a click).
import { open, waitForTab, ok, near, sleep, Skip } from './helpers.mjs';

export async function setup({ browser, url, site }) {
  const page = await open(browser, `${site}/rich.html`);
  const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
  const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/*` }))[0].id, site);
  const seen = new Set();

  // Can this browser capture a tab at all? Chrome for Testing on macOS can't (not even
  // a page sharing itself), so there these tests are skipped, and say why.
  await page.bringToFront();
  const probe = await ctl.evaluate(async (tabId) => {
    try {
      const sid = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      const s = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: sid } } });
      s.getTracks().forEach((t) => t.stop());
      return null;
    } catch (e) { return e.message; }
  }, tabId);
  await sleep(300);

  /** Records the test page for about two seconds; returns the video page's view of it. */
  const record = async ({ size = 'page', mode = 'visible' } = {}) => {
    if (probe) throw new Skip(`this browser can't capture tabs here (${probe})`);
    await page.bringToFront();
    const res = await ctl.evaluate((tabId, size, mode) => chrome.runtime.sendMessage({ type: 'record-start', mode, tabId, fps: 30, audio: false, countdown: 0, size }), tabId, size, mode);
    await ctl.waitForFunction(async () => (await chrome.storage.session.get('rec')).rec?.state === 'recording' || (await chrome.storage.session.get('lastError')).lastError, { polling: 100 });
    const error = await ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError);
    ok(!error, `recording didn't start: ${error} (${JSON.stringify(res)})`);
    await page.bringToFront();
    // Something moving, so there are frames.
    await page.evaluate(() => { window.__tick = setInterval(() => { document.body.style.outline = `${Date.now() % 7}px solid transparent`; }, 50); });
    await sleep(2200);
    await ctl.evaluate(() => chrome.runtime.sendMessage({ target: 'recorder', type: 'rec-stop' }));
    const video = await waitForTab(browser, (u) => u.includes('video.html?id=') && !seen.has(u), 45000);
    seen.add(video.url());
    await page.evaluate(() => clearInterval(window.__tick));
    await video.waitForFunction(() => document.querySelector('#player').videoWidth > 0, { polling: 100, timeout: 30000 });
    // A frame from the middle, and its colours at the left and right edges halfway down.
    const info = await video.evaluate(async () => {
      const v = document.querySelector('#player');
      await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = Math.min(1, (v.duration || 2) / 2); });
      const c = new OffscreenCanvas(v.videoWidth, v.videoHeight).getContext('2d', { willReadFrequently: true });
      c.drawImage(v, 0, 0);
      const px = (x, y) => [...c.getImageData(x, y, 1, 1).data.slice(0, 3)];
      const y = Math.round(v.videoHeight / 2);
      return { w: v.videoWidth, h: v.videoHeight, left: px(2, y), right: px(v.videoWidth - 3, y) };
    });
    await video.close();
    return info;
  };
  return { page, ctl, record };
}

const black = (p) => p.every((v) => v < 16);

export const tests = {
  async 'a tab recording is the page at its own size'({ page, record }) {
    const want = await page.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio]);
    const r = await record();
    near(r.w, want[0], 4, 'width');
    near(r.h, want[1], 4, 'height');
    return `${r.w} × ${r.h}`;
  },

  async 'in DevTools device mode only the phone-sized page is recorded, without black bars'({ page, record }) {
    const cdp = await page.createCDPSession();
    // As DevTools' device toolbar shows a Pixel 7: a 412 × 915 page, smaller than the tab.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    await sleep(300);
    try {
      const r = await record();
      // The page's shape, not the tab's, and the page right up to both edges.
      near(r.w / r.h, 412 / 915, 0.03, `shape of ${r.w} × ${r.h}`);
      ok(!black(r.left) && !black(r.right), `black at the edges: ${r.left} … ${r.right}`);
      // Scaled to 1080p (the shorter side), it keeps that shape.
      const big = await record({ size: '1080p' });
      ok(big.w === 1080, `1080p width ${big.w}`);
      near(big.w / big.h, 412 / 915, 0.03, `1080p shape of ${big.w} × ${big.h}`);
      return `${r.w} × ${r.h}; 1080p ${big.w} × ${big.h}`;
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await cdp.detach();
    }
  },
};
