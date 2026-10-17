// Tab recordings, end to end: started and stopped as the toolbar does, with Chrome's
// real tab capture (the test extension is allow-listed to record without a click).
import { open, waitForTab, ok, near, sleep, Skip, launch } from './helpers.mjs';

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
  async 'the camera bubble and microphone are recorded, and the bubble moves while the page stands still'() {
    // Chrome's stand-in camera (a moving picture) and microphone (a beep).
    const env = await launch({ args: ['--use-fake-device-for-media-stream'] });
    try {
      const lab = await open(env.browser, env.url('lab/lab.html'));
      await lab.bringToFront();
      const r = await lab.evaluate(async () => {
        const { record, openCameraAndMic } = await import('/lib/recorder.js');
        // A still page: a canvas drawn once sends no further frames by itself.
        const c = document.createElement('canvas'); c.width = 1280; c.height = 720; document.body.append(c);
        const g = c.getContext('2d'); g.fillStyle = '#2050e0'; g.fillRect(0, 0, 1280, 720);
        const stream = c.captureStream(30);
        // And the page's own sound, to be mixed with the microphone.
        const ac = new AudioContext(); const osc = ac.createOscillator(); const dest = ac.createMediaStreamDestination();
        osc.connect(dest); osc.start();
        stream.addTrack(dest.stream.getAudioTracks()[0]);
        const extras = await openCameraAndMic({ camera: true, mic: true });
        const session = await record(stream, { fps: 30, ...extras });
        await new Promise((res) => setTimeout(res, 3000));
        const { blob, meta } = await session.stop();
        const ended = extras.camera.readyState === 'ended' && extras.mic.readyState === 'ended';
        // Frames from early and late in the recording.
        const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob);
        await new Promise((res) => { v.onloadeddata = res; });
        const grab = async (t) => {
          v.currentTime = t; await new Promise((res) => { v.onseeked = res; });
          const k = new OffscreenCanvas(v.videoWidth, v.videoHeight).getContext('2d', { willReadFrequently: true });
          k.drawImage(v, 0, 0);
          return k;
        };
        const b = await grab(2.4);
        const W = v.videoWidth, H = v.videoHeight, d = Math.round(Math.min(W, H) * 0.24), m = Math.round(Math.min(W, H) * 0.03);
        const px = (k, x, y) => [...k.getImageData(x, y, 1, 1).data.slice(0, 3)];
        // How many frames the video holds: played through, counting each one shown.
        v.currentTime = 0; await new Promise((res) => { v.onseeked = res; });
        let frames = 0;
        const count = (_, info) => { frames = info.presentedFrames; v.requestVideoFrameCallback(count); };
        v.requestVideoFrameCallback(count);
        await v.play();
        await new Promise((res) => { v.onended = res; setTimeout(res, 6000); });
        return {
          size: [W, H], meta, ended, frames,
          page: px(b, W - 40, 40), // away from the bubble: the page itself
          bubble: px(b, m + d / 2, H - m - d / 2),
        };
      });
      const blue = (p) => Math.abs(p[0] - 0x20) < 24 && Math.abs(p[1] - 0x50) < 24 && Math.abs(p[2] - 0xe0) < 24;
      ok(r.size[0] === 1280 && r.size[1] === 720, `size ${r.size}`);
      ok(blue(r.page), `the page shows around the bubble: ${r.page}`);
      ok(!blue(r.bubble), `the camera shows in the bubble: ${r.bubble}`);
      // The stand-in camera gives 20 a second; without it driving them, a still page gives one or two.
      ok(r.frames > 25, `the bubble keeps moving on a still page: ${r.frames} frames in 3 s`);
      ok(r.meta.hasAudio && r.meta.mic && r.meta.camera, `meta ${JSON.stringify(r.meta)}`);
      ok(r.ended, 'camera and microphone are let go when the recording stops');

      // The page the popup opens to ask for them: once allowed, the switches are on and
      // the bubble is previewed. (Chrome answers by itself in tests.)
      const perm = await open(env.browser, env.url('recorder/permission.html?camera=1&mic=1'));
      await perm.click('#allow');
      await perm.waitForFunction(() => !document.querySelector('#done').classList.contains('hidden'), { polling: 100, timeout: 10000 });
      const after = await perm.evaluate(async () => ({
        stored: await chrome.storage.local.get(['camera', 'mic']),
        preview: !document.querySelector('#bubble').classList.contains('hidden') && document.querySelector('#preview').srcObject?.getVideoTracks().length === 1,
        title: document.querySelector('#ask-title').textContent,
      }));
      ok(after.stored.camera === true && after.stored.mic === true && after.preview && after.title && !/permission_/.test(after.title), `permission page: ${JSON.stringify(after)}`);
      return `${r.frames} frames in 3 s`;
    } finally {
      await env.close();
    }
  },

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
