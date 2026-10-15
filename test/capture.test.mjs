// Screenshots of a page: full page, visible area and a dragged selection, opened in
// the editor, then exported in every format.
import { open, waitForTab, ok, near, sleep, launch } from './helpers.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'output');

export async function setup({ browser, url, site }) {
  // No emulated viewport: in real use the page fills the window, which is what tab
  // capture sees. (An emulated size bigger than the window can't be scrolled into view.)
  const page = await browser.newPage();
  await page.goto(`${site}/index.html`);
  await page.evaluate(() => window.scrollTo(0, 700));
  const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
  const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/*` }))[0].id, site);
  await page.bringToFront();

  const seen = new Set(); // editors already handed out, so a stale one is never reused
  // Starts a capture of the test page and returns the editor it opens.
  const capture = async (mode, during) => {
    await ctl.evaluate((tabId, mode) => chrome.runtime.sendMessage({ type: 'capture-image', mode, tabId }), tabId, mode);
    if (during) await during();
    const ed = await waitForTab(browser, (u) => u.includes('editor.html?id=') && !seen.has(u));
    seen.add(ed.url());
    await ed.bringToFront();
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 20000 });
    const size = await ed.evaluate(() => [document.querySelector('#bg').width, document.querySelector('#bg').height]);
    const error = await ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError);
    ok(!error, `capture reported an error: ${error}`);
    return { ed, size };
  };
  return { page, capture };
}

export const tests = {
  async 'full page is stitched and the scroll position restored'({ page, capture }) {
    // Expected size from the page itself: window frames and scrollbars differ by OS.
    const want = await page.evaluate(() => ({ w: Math.round(document.documentElement.clientWidth * devicePixelRatio), h: Math.round(document.documentElement.scrollHeight * devicePixelRatio), sb: window.innerWidth - document.documentElement.clientWidth }));
    const { ed, size } = await capture('full');
    // The capture hides the scrollbar, so the page gains its width.
    near(size[0], want.w + want.sb, 2, 'width of the page');
    near(size[1], want.h, 2, 'height of the whole page');
    near(await page.evaluate(() => window.scrollY), 700, 1, 'scroll position afterwards');
    await ed.close();
    await page.bringToFront();
  },

  async 'visible area matches the viewport'({ page, capture }) {
    const want = await page.evaluate(() => [Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]);
    const { ed, size } = await capture('visible');
    near(size[0], want[0], 2, 'width');
    near(size[1], want[1], 2, 'height');
    await ed.close();
    await page.bringToFront();
  },

  async 'selected area is the dragged rectangle, exported in every format'({ page, capture }) {
    const { ed, size } = await capture('area', async () => {
      await page.bringToFront();
      await page.waitForSelector('#__captode_pick');
      await page.mouse.move(100, 100);
      await page.mouse.down();
      await page.mouse.move(400, 300, { steps: 5 });
      await page.mouse.up();
    });
    ok(size[0] === 300 && size[1] === 200, `size ${size}`);
    const sizes = [];
    for (const f of ['png', 'png8', 'jpeg', 'webp', 'gif', 'bmp', 'pdf']) {
      await ed.evaluate((f) => {
        const s = document.querySelector('#x-format');
        s.value = f;
        s.dispatchEvent(new Event('input', { bubbles: true }));
      }, f);
      await sleep(600);
      await ed.waitForFunction(() => !/Working/.test(document.querySelector('#x-estimate').textContent), { timeout: 30000 });
      const est = await ed.evaluate(() => document.querySelector('#x-estimate').textContent);
      ok(/\d+(\.\d+)? (B|KB|MB)/.test(est), `${f}: no size estimate (${est})`);
      sizes.push(`${f} ${est.replace(/.*px/, '')}`);
    }
    await ed.close();
    return sizes.join(', ');
  },

  async 'captures line up at every display scale (100%, 125%, 150%, 200%)'({ site }) {
    const notes = [];
    for (const scale of [1, 1.25, 1.5, 2]) {
      // A Chrome that really runs at this scale, as on a Windows display set to 125%:
      // emulating it only changes the page, not what tab capture sees.
      const env = await launch({ args: [`--force-device-scale-factor=${scale}`] });
      const { browser, url } = env;
      const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
      const page = await browser.newPage();
      await page.goto(`${site}/long.html`);
      await sleep(300);
      // Chrome's own full-page screenshot, to compare with.
      const reference = await page.screenshot({ fullPage: true, encoding: 'base64' });
      await page.evaluate(() => window.scrollTo(0, 0));
      const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/long.html` }))[0].id, site);
      await page.bringToFront();
      await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'full', tabId }), tabId);
      const ed = await waitForTab(browser, (u) => u.includes('editor.html?id='));
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 30000 });
      const r = await ed.evaluate(async (b64) => {
        const bg = document.querySelector('#bg');
        const ours = bg.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bg.width, bg.height).data;
        const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const c = new OffscreenCanvas(img.width, img.height).getContext('2d', { willReadFrequently: true });
        c.drawImage(img, 0, 0);
        const ref = c.getImageData(0, 0, img.width, img.height).data;
        const w = Math.min(bg.width, img.width), h = Math.min(bg.height, img.height);
        // Every band of 40 rows must match Chrome's screenshot exactly at some small
        // vertical shift. A seam, or a doubled or missing line, breaks the band it's
        // in. A shift that changes across plain background is invisible, so it's
        // allowed, as long as the total stays small.
        const rowDiff = (ya, yb) => {
          let d = 0;
          for (let x = 0; x < w; x += 2) {
            const i = (ya * bg.width + x) * 4, j = (yb * img.width + x) * 4;
            d += Math.abs(ours[i] - ref[j]) + Math.abs(ours[i + 1] - ref[j + 1]) + Math.abs(ours[i + 2] - ref[j + 2]);
          }
          return d / Math.ceil(w / 2) / 3;
        };
        let badRows = 0, worst = 0, maxShift = 0;
        for (let y0 = 0; y0 + 40 <= h - 8; y0 += 40) {
          let best = Infinity, bestShift = 0;
          for (let s = -6; s <= 6 && best > 0; s++) {
            if (y0 + s < 0 || y0 + s + 40 > img.height) continue;
            let sum = 0;
            for (let y = y0; y < y0 + 40 && sum < best; y++) sum += rowDiff(y, y + s);
            if (sum < best) { best = sum; bestShift = s; }
          }
          // Judge by the worst row: one doubled line barely moves the average.
          let rowWorst = 0;
          for (let y = y0; y < y0 + 40; y++) rowWorst = Math.max(rowWorst, rowDiff(y, y + bestShift));
          worst = Math.max(worst, rowWorst);
          maxShift = Math.max(maxShift, Math.abs(bestShift));
          if (rowWorst > 15) badRows += 40; // real seams measure 30+; anti-aliasing stays under 8
        }
        // No unpainted (transparent) pixels anywhere along the edges.
        let blankEdge = 0;
        for (let x = 0; x < bg.width; x++) if (ours[((bg.height - 1) * bg.width + x) * 4 + 3] < 255) blankEdge++;
        for (let y = 0; y < bg.height; y++) if (ours[(y * bg.width + bg.width - 1) * 4 + 3] < 255) blankEdge++;
        let png = null;
        if (badRows || blankEdge) { // keep the evidence
          const c = new OffscreenCanvas(bg.width, bg.height);
          c.getContext('2d').drawImage(bg, 0, 0);
          const a = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
          let str = '';
          for (let i = 0; i < a.length; i += 0x8000) str += String.fromCharCode(...a.subarray(i, i + 0x8000));
          png = btoa(str);
        }
        return { ours: [bg.width, bg.height], ref: [img.width, img.height], badRows, worst: +worst.toFixed(1), maxShift, blankEdge, png };
      }, reference);
      if (r.png) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `scale-${scale * 100}-captode.png`), Buffer.from(r.png, 'base64'));
        writeFileSync(join(outDir, `scale-${scale * 100}-chrome.png`), Buffer.from(reference, 'base64'));
      }
      // Chrome rounds the page height its own way; a few rows either way is fine as
      // long as every row is painted and matches.
      ok(Math.abs(r.ours[0] - r.ref[0]) <= 2 && Math.abs(r.ours[1] - r.ref[1]) <= 6, `${scale * 100}%: size ${r.ours} vs Chrome's ${r.ref}`);
      ok(r.maxShift <= 6, `${scale * 100}%: drifted ${r.maxShift} rows from Chrome's screenshot`);
      ok(r.blankEdge === 0, `${scale * 100}%: ${r.blankEdge} unpainted pixels along the right or bottom edge`);
      ok(r.badRows === 0, `${scale * 100}%: ${r.badRows} rows don't match Chrome's own full-page screenshot at any small shift (worst ${r.worst})`);
      await ed.close();

      // Selected area: a 300 × 200 CSS-pixel drag gives 300 × 200 × scale pixels.
      await page.bringToFront();
      await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'area', tabId }), tabId);
      await page.bringToFront();
      await page.waitForSelector('#__captode_pick');
      await page.mouse.move(100, 100);
      await page.mouse.down();
      await page.mouse.move(400, 300, { steps: 5 });
      await page.mouse.up();
      const ed2 = await waitForTab(browser, (u) => u.includes('editor.html?id='));
      await ed2.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 30000 });
      const area = await ed2.evaluate(() => [document.querySelector('#bg').width, document.querySelector('#bg').height]);
      near(area[0], 300 * scale, 1, `${scale * 100}%: area width`);
      near(area[1], 200 * scale, 1, `${scale * 100}%: area height`);
      notes.push(`${scale * 100}% ${r.ours.join('×')}`);
      await env.close();
    }
    return notes.join(', ');
  },

  async 'selected area can be dragged out with a finger (touchscreens)'({ page, capture }) {
    await page.bringToFront();
    const { ed, size } = await capture('area', async () => {
      await page.bringToFront();
      await page.waitForSelector('#__captode_pick');
      await page.touchscreen.touchStart(120, 140);
      await page.touchscreen.touchMove(220, 200);
      await page.touchscreen.touchMove(320, 260);
      await page.touchscreen.touchEnd();
    });
    near(size[0], 200, 1, 'width');
    near(size[1], 120, 1, 'height');
    await ed.close();
  },
};
