// Makes the store screenshots and promo tiles from the real extension:
//   node tools/store-assets.mjs
// Writes store/screenshots/1-capture.jpg … 5-private.jpg (1280 × 800),
// store/promo-small.jpg (440 × 280) and store/promo-marquee.jpg (1400 × 560).
// JPEG, because the stores want screenshots without an alpha channel.
// Run tools/brand.mjs first so the pages show the current logo.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, open, serveSite, waitForTab, sleep } from '../test/helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = join(root, 'store');
mkdirSync(join(store, 'screenshots'), { recursive: true });
// The tiles and captions sit on the brand's violet, so they use the logo with white
// brackets (store/brand/logo-reverse.svg) when there is one.
const reverse = join(store, 'brand', 'logo-reverse.svg');
const logoPath = existsSync(join(store, 'logo.png')) ? join(store, 'logo.png') : join(root, 'src/icons/icon128.png');
const logo = existsSync(reverse)
  ? 'data:image/svg+xml;base64,' + readFileSync(reverse).toString('base64')
  : 'data:image/png;base64,' + readFileSync(logoPath).toString('base64');

const site = await serveSite();
// A window whose page area is exactly the UI part of a screenshot (1280 × 690), so
// what the page shows and what the extension captures are the same size.
// No vsync pacing: with a Mac's display asleep, Chrome otherwise stops producing
// frames and screenshots hang. (Not used for tests: unpaced animation makes the
// test recordings drop frames.)
const env = await launch({ args: ['--window-size=1280,777', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const { browser, url } = env;
const UI = { width: 1280, height: 690 }; // the UI part of each screenshot, under the caption

const light = (page) => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
// Puppeteer's clip is measured from the top of the document, so add the scroll.
const png = async (page, clip) => 'data:image/png;base64,' + (await page.screenshot({ encoding: 'base64', clip }));

/** Lays out a caption band over a UI image and saves it as a store screenshot. */
async function compose(file, title, subtitle, stageHtml) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: 1280px; height: 800px; overflow: hidden; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; background: #0f0f1a; }
    header { height: 110px; display: flex; align-items: center; gap: 22px; padding: 0 40px;
      background: linear-gradient(100deg, #2a1fa8 0%, #4b33e6 45%, #8a3ff0 100%); color: #fff; }
    header img { width: 62px; height: 62px; filter: drop-shadow(0 4px 12px rgba(0,0,0,.25)); }
    h1 { margin: 0; font-size: 31px; font-weight: 700; letter-spacing: -0.01em; }
    p { margin: 4px 0 0; font-size: 17px; opacity: .85; }
    .stage { position: relative; width: 1280px; height: 690px; overflow: hidden; background: #fff; }
    .stage > img.full { display: block; width: 1280px; height: 690px; }
  </style></head><body>
    <header><img src="${logo}"><div><h1>${title}</h1><p>${subtitle}</p></div></header>
    <div class="stage">${stageHtml}</div>
  </body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  await page.screenshot({ path: join(store, 'screenshots', file), type: 'jpeg', quality: 92 });
  await page.close();
  console.log('wrote store/screenshots/' + file);
}

// ---------- 1. The popup over a page ----------

const web = await browser.newPage();
await web.setViewport(UI);
await light(web);
await web.goto(`${site.url}/rich.html`);
console.log('page area', await web.evaluate(() => [innerWidth, innerHeight]));
await sleep(400);
const webShot = await png(web, { x: 0, y: 0, ...UI });
const pop = await browser.newPage();
await pop.setViewport({ width: 340, height: 700 });
await light(pop);
await web.bringToFront();
await pop.goto(url('popup/popup.html')); // opened while the page is in front, so it can capture it
await sleep(400);
await pop.bringToFront();
const popH = await pop.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
const popShot = await png(pop, { x: 0, y: 0, width: 340, height: popH });
await compose('1-capture.jpg', 'Capture any page in one click',
  'The whole scrolling page, just what you see, or a region you select',
  `<img class="full" src="${webShot}">
   <img src="${popShot}" style="position:absolute;right:28px;top:14px;width:340px;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.08)">`);

// ---------- 2. The editor, annotated ----------

const tabId = await pop.evaluate(async (s) => (await chrome.tabs.query({ url: `${s}/rich.html` }))[0].id, site.url);
await web.bringToFront();
await web.evaluate(() => window.scrollTo(0, 0));
await pop.evaluate((id) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'visible', tabId: id }), tabId);
const ed = await waitForTab(browser, (u) => u.includes('editor.html?id='));
await ed.setViewport(UI);
await light(ed);
await ed.bringToFront();
await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent));
await sleep(300);
const box = await ed.evaluate(() => { const r = document.querySelector('#fg').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
const drag = async (tool, from, to) => {
  await ed.keyboard.press(tool);
  await ed.mouse.move(...at(...from));
  await ed.mouse.down();
  await ed.mouse.move(...at(...to), { steps: 8 });
  await ed.mouse.up();
};
const setColour = (sel, c) => ed.evaluate((sel, c) => { const i = document.querySelector(sel); i.value = c; i.dispatchEvent(new Event('input', { bubbles: true })); }, sel, c);
// Positions are fractions of the captured page (1280 × 690).
await ed.keyboard.press('h');
await setColour('#s-color', '#ffc53d');
await drag('h', [0.025, 0.205], [0.425, 0.205]);       // highlight the headline
await ed.keyboard.press('r');
await setColour('#s-color', '#ffffff');
await drag('r', [0.016, 0.315], [0.222, 0.405]);       // box round the buttons
await ed.keyboard.press('a');
await setColour('#s-color', '#ffffff');
await drag('a', [0.445, 0.36], [0.24, 0.36]);          // arrow to them
await drag('b', [0.672, 0.625], [0.915, 0.705]);       // blur the names
await ed.keyboard.press('t');
await ed.mouse.click(...at(0.455, 0.335));
await sleep(150);
await ed.keyboard.type('Try the new demo!');
await ed.mouse.click(...at(0.5, 0.95));               // finish the text
await ed.keyboard.press('v');
await ed.keyboard.press('Escape');
await ed.keyboard.press('Escape');
await sleep(300);
await compose('2-annotate.jpg', 'Mark it up in seconds',
  'Arrows, shapes, text, highlighter, and blur for anything private',
  `<img class="full" src="${await png(ed, { x: 0, y: 0, ...UI })}">`);

// ---------- 3. Export with a device frame ----------

await ed.click('#tab-export');
await ed.evaluate(() => { const s = document.querySelector('#x-limit'); s.value = '1024'; s.dispatchEvent(new Event('input', { bubbles: true })); });
await ed.click('#device-panel input[data-k="enabled"]');
await ed.waitForFunction(() => !document.querySelector('#export-preview').classList.contains('hidden') && document.querySelector('#device-preview').width > 300, { timeout: 20000 });
await sleep(800);
await ed.waitForFunction(() => /KB|MB/.test(document.querySelector('#x-estimate').textContent), { timeout: 30000 });
await compose('3-export.jpg', 'Export it your way',
  'PNG, JPEG, WebP, GIF or PDF, with a size limit, in a phone or tablet frame',
  `<img class="full" src="${await png(ed, { x: 0, y: 0, ...UI })}">`);
await ed.click('#device-panel input[data-k="enabled"]'); // leave the setting off again

// ---------- 4. Recording and video export ----------

const lab = await open(browser, url('lab/lab.html'));
await lab.bringToFront();
const clip = await lab.evaluate(async (shot) => {
  const { putCapture } = await import('/lib/db.js');
  const bg = await createImageBitmap(await (await fetch(shot)).blob());
  const el = document.createElement('canvas'); el.width = 1280; el.height = 690; document.body.append(el);
  const ctx = el.getContext('2d');
  const rec = new MediaRecorder(el.captureStream(30), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 6e6, videoKeyFrameIntervalDuration: 2000 });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start(500);
  const t0 = performance.now();
  // A short "walkthrough": the page, a highlight moving over it, and a pointer.
  await new Promise((res) => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      ctx.drawImage(bg, 0, 0, 1280, 690);
      const hx = 30 + Math.min(1, t / 2.5) * 560, hy = 300 + Math.sin(t * 1.4) * 40;
      ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 5; ctx.strokeRect(hx, hy, 240, 70);
      ctx.fillStyle = '#17171c';
      ctx.beginPath(); ctx.moveTo(hx + 250, hy + 80); ctx.lineTo(hx + 250, hy + 110); ctx.lineTo(hx + 258, hy + 102); ctx.lineTo(hx + 266, hy + 116); ctx.lineTo(hx + 271, hy + 113); ctx.lineTo(hx + 263, hy + 99); ctx.lineTo(hx + 273, hy + 99); ctx.closePath(); ctx.fill();
      if (t < 6) requestAnimationFrame(draw); else res();
    };
    draw();
  });
  rec.stop();
  await new Promise((r) => { rec.onstop = r; });
  return putCapture(new Blob(chunks, { type: 'video/webm' }), { fps: 30, duration: 6, hasAudio: false, title: 'Product walkthrough' });
}, webShot);
const vp = await open(browser, url(`video/video.html?id=${clip}`), UI);
await light(vp);
await vp.bringToFront();
await vp.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent));
await vp.waitForFunction(() => document.querySelectorAll('#film canvas').length > 3, { timeout: 20000 });
await vp.click('#formats [data-f="gif"]');
await vp.evaluate(() => {
  const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  set('#t-start', '0.5'); set('#t-end', '5.5'); set('#g-lossy', '20');
});
await vp.click('#convert');
await vp.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden'), { timeout: 120000 });
await sleep(500);
await compose('4-record.jpg', 'Record, trim and share',
  'Record a tab, a selected area or your whole screen, then export MP4, GIF or WebP in seconds',
  `<img class="full" src="${await png(vp, { x: 0, y: 0, ...UI })}">`);

// ---------- 5. Settings, dark ----------

const st = await open(browser, url('settings/settings.html'), UI);
await st.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await st.evaluate(() => document.scrollingElement.scrollTo(0, 1e6)); // show About and the privacy note
await sleep(300);
const scrolled = await st.evaluate(() => window.scrollY);
await compose('5-private.jpg', 'Private by design',
  'Everything stays on your device: no account, no uploads, no tracking. Light and dark themes.',
  `<img class="full" src="${await png(st, { x: 0, y: scrolled, ...UI })}">`);

// ---------- promo tiles ----------

async function tile(file, w, h, body) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; color: #fff;
      background: radial-gradient(120% 140% at 0% 0%, #4b33e6 0%, #2a1fa8 45%, #120d4a 100%); }
  </style></head><body>${body}</body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  await page.screenshot({ path: join(store, file), type: 'jpeg', quality: 92 });
  await page.close();
  console.log('wrote store/' + file);
}

await tile('promo-small.jpg', 440, 280, `
  <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center">
    <img src="${logo}" style="width:118px;height:118px;filter:drop-shadow(0 8px 24px rgba(0,0,0,.35))">
    <div style="font-size:34px;font-weight:800;letter-spacing:-0.02em">Captode</div>
    <div style="font-size:16px;opacity:.85">Screenshots &amp; screen recordings</div>
  </div>`);

await tile('promo-marquee.jpg', 1400, 560, `
  <div style="height:100%;display:flex;align-items:center;gap:56px;padding:0 70px">
    <div style="flex:none;width:520px">
      <div style="display:flex;align-items:center;gap:22px">
        <img src="${logo}" style="width:120px;height:120px;filter:drop-shadow(0 8px 24px rgba(0,0,0,.35))">
        <div style="font-size:60px;font-weight:800;letter-spacing:-0.02em">Captode</div>
      </div>
      <div style="font-size:26px;margin:26px 0 22px;line-height:1.3;opacity:.95">Capture, annotate and record any page. Export to PNG, PDF, GIF or MP4.</div>
      <div style="font-size:18px;opacity:.75">Private by design · No account · No watermark</div>
    </div>
    <img src="${await png(ed, { x: 0, y: 0, ...UI })}" style="width:760px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.45)">
  </div>`);

await env.close();
site.close();
