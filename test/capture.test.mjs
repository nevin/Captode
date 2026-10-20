// Screenshots of a page: full page, visible area and a dragged selection, opened in
// the editor, then exported in every format.
import { open, waitForTab, ok, near, sleep, launch, prepare } from './helpers.mjs';
import { mkdirSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  const capture = async (mode, during, extra = {}) => {
    await ctl.evaluate((tabId, mode, extra) => chrome.runtime.sendMessage({ type: 'capture-image', mode, tabId, ...extra }), tabId, mode, extra);
    if (during) await during();
    const ed = await waitForTab(browser, (u) => u.includes('editor.html?id=') && !seen.has(u));
    seen.add(ed.url());
    await ed.bringToFront();
    try {
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 45000, polling: 100 });
    } catch (e) {
      // Say what the editor shows instead, so a failure on a CI runner can be diagnosed.
      const state = await ed.evaluate(() => ({ url: location.href, visible: document.visibilityState, body: document.body.innerText.slice(0, 300) })).catch((err) => String(err));
      const error = await ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError);
      throw new Error(`editor did not show the capture: ${JSON.stringify(state)}, lastError ${error}`);
    }
    const size = await ed.evaluate(() => captodeEditor.size());
    const error = await ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError);
    ok(!error, `capture reported an error: ${error}`);
    return { ed, size };
  };
  return { page, capture, ctl, tabId };
}

/** Captures test/site/app.html in full and checks every row of its panel. */
async function panelCapture(browser, url, site) {
  const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
  const app = await browser.newPage();
  await app.goto(`${site}/app.html`);
  await app.evaluate(() => { document.querySelector('#panel').scrollTop = 500; });
  const want = await app.evaluate(() => {
    const p = document.querySelector('#panel');
    const marks = [...p.querySelectorAll('.row i')].map((i) => ({ y: i.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop + 10, x: i.getBoundingClientRect().left - p.getBoundingClientRect().left + 30, colour: getComputedStyle(i).backgroundColor.match(/\d+/g).map(Number) }));
    return { dpr: devicePixelRatio, w: p.offsetWidth, h: p.scrollHeight, marks };
  });
  const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/app.html` }))[0].id, site);
  await app.bringToFront();
  await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'full', tabId }), tabId);
  const ed = await waitForTab(browser, (u) => u.includes('editor.html?id='));
  try {
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 45000, polling: 100 });
    const r = await ed.evaluate((want) => {
      const img = captodeEditor.pixels();
      const at = (x, y) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
      const wrong = want.marks.filter((m) => at(m.x * want.dpr, m.y * want.dpr).some((v, k) => Math.abs(v - m.colour[k]) > 6)).map((m) => Math.round(m.y));
      // The sticky "Inbox" bar (yellow) is drawn once, at the top, not on every tile.
      let yellowRows = 0;
      for (let y = 0; y < img.height; y++) { const [r, g, b] = at(img.width - 4, y); if (r > 240 && g > 200 && g < 220 && b < 80) yellowRows++; }
      return { size: [img.width, img.height], wrong, yellowRows };
    }, want);
    near(r.size[0], want.w * want.dpr, 2, 'the panel\'s width (the scrollbar hidden)');
    near(r.size[1], want.h * want.dpr, 3, 'the panel\'s whole height');
    ok(!r.wrong.length, `rows out of place at ${r.wrong.slice(0, 8)} (of ${want.marks.length})`);
    near(r.yellowRows, 40 * want.dpr, 2, 'the sticky header once');
    const after = await app.evaluate(() => ({ top: document.querySelector('#panel').scrollTop, marked: !!document.querySelector('[data-captode-panel]'), hidden: [...document.querySelectorAll('*')].filter((e) => e.style.visibility).length }));
    ok(after.top === 500 && !after.marked && !after.hidden, `the page is as it was: ${JSON.stringify(after)}`);
    return `${want.dpr * 100}%: ${r.size.join(' × ')}, ${want.marks.length} rows in place`;
  } finally {
    await ed.close();
    await app.close();
    await ctl.close();
  }
}

/** Captures elements of test/site/tall.html: a button, and a card taller than the window. */
async function elementCapture(browser, url, site) {
  const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
  const el = await browser.newPage();
  await el.goto(`${site}/tall.html`);
  const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/tall.html` }))[0].id, site);
  const shoot = async (pick) => {
    await el.bringToFront();
    const before = new Set(browser.targets());
    await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'element', tabId }), tabId);
    await el.waitForSelector('#__captode_pick');
    await pick();
    const target = await browser.waitForTarget((x) => !before.has(x) && x.url().includes('editor.html?id='), { timeout: 30000 });
    // Waited on from here (prepare): a Windows runner's unfocused page can stall its own polling.
    const ed = await prepare(await target.page());
    await ed.bringToFront();
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 30000, polling: 100 });
    return ed;
  };
  const centre = (sel) => el.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  try {
    const dpr = await el.evaluate(() => devicePixelRatio);
    // The button: pointed at, outlined with its size, clicked.
    const go = await el.evaluate(() => { const r = document.querySelector('#go').getBoundingClientRect(); return [r.width, r.height]; });
    let ed = await shoot(async () => {
      await el.mouse.move(...(await centre('#go')));
      const label = await el.evaluate(() => [...document.querySelectorAll('#__captode_pick div')].map((d) => d.textContent).find((x) => x.startsWith('button')));
      ok(label === `button#go  ${Math.round(go[0])} × ${Math.round(go[1])}`, `label: ${label}`);
      await el.mouse.click(...(await centre('#go')));
    });
    let size = await ed.evaluate(() => captodeEditor.size());
    near(size[0], go[0] * dpr, 1, 'button width');
    near(size[1], go[1] * dpr, 1, 'button height');
    await ed.close();

    // A row, then ↑ for the card around it, taller than the window: stitched.
    const card = await el.evaluate(() => {
      const c = document.querySelector('#card');
      const box = c.getBoundingClientRect();
      const marks = [...c.querySelectorAll('.row i')].map((i) => { const r = i.getBoundingClientRect(); return { y: r.top - box.top + 12, x: r.left - box.left + 40, colour: getComputedStyle(i).backgroundColor.match(/\d+/g).map(Number) }; });
      return { w: c.offsetWidth, h: c.offsetHeight, marks, vh: innerHeight };
    });
    ok(card.h > card.vh, 'the card is taller than the window');
    ed = await shoot(async () => {
      await el.mouse.move(...(await centre('.row:nth-child(3)')));
      await el.keyboard.press('ArrowUp'); // from the row to the card (or from the row's text to the row)
      const label = await el.evaluate(() => [...document.querySelectorAll('#__captode_pick div')].map((d) => d.textContent).find((x) => /^div/.test(x)));
      if (!label?.startsWith('div#card')) await el.keyboard.press('ArrowUp');
      await el.keyboard.press('Enter');
    });
    const r = await ed.evaluate((card) => {
      const img = captodeEditor.pixels();
      const s = img.width / card.w;
      const at = (x, y) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
      const wrong = card.marks.filter((m) => at(m.x * s, m.y * s).some((v, k) => Math.abs(v - m.colour[k]) > 6)).map((m) => m.y);
      return { size: [img.width, img.height], wrong };
    }, card);
    near(r.size[0], card.w * dpr, 1, 'card width');
    near(r.size[1], card.h * dpr, 3, 'card height, stitched');
    ok(!r.wrong.length, `rows out of place at ${r.wrong.slice(0, 6)}`);
    await ed.close();

    // Esc cancels.
    await el.bringToFront();
    const before = new Set(browser.targets());
    await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'element', tabId }), tabId);
    await el.waitForSelector('#__captode_pick');
    await el.keyboard.press('Escape');
    await sleep(1500);
    ok(!(await el.$('#__captode_pick')) && !browser.targets().some((x) => !before.has(x) && x.url().includes('editor.html')), 'Esc cancels');
    return `${dpr * 100}%: button ${size.join('×')}, card ${r.size.join('×')}`;
  } finally {
    await el.close();
    await ctl.close();
  }
}

export const tests = {
  async 'with the setting on, email addresses, phone and card numbers are blurred, and nothing else'({ browser, url, site, page }) {
    const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    const pv = await browser.newPage();
    await pv.goto(`${site}/private.html`);
    const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/private.html` }))[0].id, site);
    // Waits are done from here (waitForTab prepares the page), as Windows runners can stall
    // a page's own polling. An editor still on its way when the test ends is closed, so a
    // later test can't mistake it for its own.
    let pending = null;
    const shoot = async (mode) => {
      await pv.bringToFront();
      const old = new Set(browser.targets().map((x) => x.url()));
      const isNew = (u) => u.includes('editor.html?id=') && !old.has(u);
      pending = isNew;
      await ctl.evaluate((tabId, mode) => chrome.runtime.sendMessage({ type: 'capture-image', mode, tabId }), tabId, mode);
      const ed = await waitForTab(browser, isNew, 45000);
      pending = null;
      await ed.bringToFront();
      try {
        await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 45000, polling: 100 });
      } catch (e) {
        const error = await ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError);
        await ed.close();
        throw new Error(`the editor did not show the capture (lastError ${error}): ${e.message}`);
      }
      return ed;
    };
    // Where each detail is, in the page (`doc`) or the window, in CSS pixels.
    const where = (doc) => pv.evaluate((doc) => Object.fromEntries(['email', 'phone', 'card', 'field', 'low', 'decoys'].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, { x: r.x + (doc ? scrollX : 0), y: r.y + (doc ? scrollY : 0), w: r.width, h: r.height }];
    })), doc);
    // Which of `boxes` (image pixels) cover the middle of a detail; and which touch the decoys.
    const check = (boxes, at, dpr, ids) => {
      const covers = (b, r) => { const cx = (r.x + r.w / 2) * dpr, cy = (r.y + r.h / 2) * dpr; return cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2; };
      const missing = ids.filter((id) => !boxes.some((b) => covers(b, at[id])));
      const d = at.decoys;
      const onDecoys = boxes.filter((b) => b.y1 < (d.y + d.h) * dpr - 2 && b.y2 > d.y * dpr + 2);
      return { missing, onDecoys: onDecoys.length };
    };
    try {
      const dpr = await pv.evaluate(() => devicePixelRatio);
      await pv.evaluate(() => window.scrollTo(0, 0));
      const setBlur = (on) => ctl.evaluate(async (on) => {
        const { settings = {} } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, autoBlur: on } });
      }, on);
      const meta = (ed) => ed.evaluate(async () => (await (await import('/lib/db.js')).getCapture(new URLSearchParams(location.search).get('id'))).meta);

      // Off, as it starts: nothing is looked for, nothing blurred.
      let ed = await shoot('visible');
      await sleep(500);
      ok((await ed.evaluate(() => captodeEditor.objects())).length === 0, 'nothing blurred with the setting off');
      ok(!(await meta(ed)).private, 'nothing looked for with the setting off');
      await ed.close();

      await setBlur(true);
      ed = await shoot('visible');
      await ed.waitForFunction(() => captodeEditor.objects().length > 0, { polling: 100, timeout: 5000 });
      let objs = await ed.evaluate(() => captodeEditor.objects());
      ok(objs.length === 4 && objs.every((o) => o.type === 'redact'), `four blurs: ${JSON.stringify(objs.map((o) => o.type))}`);
      let r = check(objs, await where(false), dpr, ['email', 'phone', 'card', 'field']);
      ok(!r.missing.length, `not blurred: ${r.missing}`);
      ok(!r.onDecoys, `${r.onDecoys} blurs on dates, sums, versions or order numbers`);
      await ed.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
      await ed.keyboard.press('z');
      await ed.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
      ok((await ed.evaluate(() => captodeEditor.objects())).length === 0, 'one undo removes them all');
      await ed.close();

      // The whole page: the one far down too, where it is in the page.
      ed = await shoot('full');
      await ed.waitForFunction(() => captodeEditor.objects().length > 0, { polling: 100, timeout: 5000 });
      objs = await ed.evaluate(() => captodeEditor.objects());
      r = check(objs, await where(true), dpr, ['email', 'phone', 'card', 'field', 'low']);
      ok(objs.length === 5 && !r.missing.length && !r.onDecoys, `full page: ${objs.length} blurs, missing ${r.missing}, ${r.onDecoys} on decoys`);
      await ed.close();
    } finally {
      if (pending) await waitForTab(browser, pending, 20000).then((late) => late.close(), () => {});
      await ctl.evaluate(async () => {
        const { settings = {} } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, autoBlur: false } });
      }).catch(() => {});
      await pv.close();
      await ctl.close();
      await page.bringToFront();
    }
  },

  async 'the right-click menu offers every screenshot mode'({ browser, url }) {
    // Captode's own worker: Chrome can run others (on Linux, for instance).
    const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url() === url('background.js'))).worker();
    // update() fails for an item that does not exist, so this shows all four were made.
    const missing = await sw.evaluate(async () => {
      const out = [];
      for (const id of ['full', 'visible', 'area', 'element']) await chrome.contextMenus.update(id, {}).catch(() => out.push(id));
      return out;
    });
    ok(!missing.length, `menu items missing: ${missing}`);
  },

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

  async 'full page of a web app that scrolls a panel, not the window, captures the panel in full'({ browser, url, site, page }) {
    const notes = [await panelCapture(browser, url, site)];
    // And at a fractional display scale, where tiles are hardest to line up.
    const env = await launch({ args: ['--force-device-scale-factor=1.5'] });
    try { notes.push(await panelCapture(env.browser, env.url, site)); } finally { await env.close(); }
    await page.bringToFront();
    return notes.join('; ');
  },

  async 'a delayed screenshot waits, catches what was opened meanwhile, and leaves its countdown out'({ page, capture, ctl, tabId, browser }) {
    await page.bringToFront();
    const t0 = Date.now();
    let pill = null;
    const { ed } = await capture('visible', async () => {
      // As a person would: open a menu while the countdown runs.
      await page.waitForSelector('#__captode_delay', { timeout: 5000 });
      pill = await page.$eval('#__captode_delay', (e) => ({ text: e.textContent, pointer: getComputedStyle(e).pointerEvents }));
      await page.evaluate(() => {
        const m = document.createElement('div');
        m.id = 'menu';
        m.style.cssText = 'position:fixed;left:40px;top:40px;width:200px;height:120px;background:rgb(0,200,120);z-index:9';
        document.body.append(m);
      });
    }, { delay: 3 });
    const waited = Date.now() - t0;
    try {
      ok(waited >= 2900, `waited ${waited} ms`);
      ok(/^Screenshot in 3 s/.test(pill?.text) && pill.pointer === 'none', `countdown: ${JSON.stringify(pill)}`);
      const pageWidth = await page.evaluate(() => innerWidth);
      const r = await ed.evaluate((pageWidth) => {
        const img = captodeEditor.pixels();
        const s = img.width / pageWidth; // image pixels per CSS pixel
        const at = (x, y) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
        // The menu is in; the dark countdown pill (top right) is not.
        let dark = 0;
        for (let y = 14; y < 40; y += 2) for (let x = img.width - 120; x < img.width - 14; x += 4) { const [r, g, b] = at(x, y); if (r < 40 && g < 40 && b < 45) dark++; }
        return { menu: at(140 * s, 100 * s), dark };
      }, pageWidth);
      ok(r.menu[0] < 20 && r.menu[1] > 180 && r.menu[2] > 100 && r.menu[2] < 140, `the menu opened during the wait is in the screenshot: ${r.menu}`);
      ok(r.dark < 5, `the countdown is not in the screenshot (${r.dark} dark samples)`);
    } finally {
      await ed.close();
      await page.evaluate(() => document.querySelector('#menu')?.remove());
      await page.bringToFront();
    }
    // Esc during the wait cancels: no editor opens.
    const before = new Set(browser.targets());
    await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'visible', tabId, delay: 5 }), tabId);
    await page.waitForSelector('#__captode_delay', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await sleep(6000);
    ok(!browser.targets().some((x) => !before.has(x) && x.url().includes('editor.html')), 'Esc cancelled the screenshot');
    ok(!(await page.$('#__captode_delay')), 'and the countdown is gone');
    // Another tab brought to the front during the wait is never captured.
    const other = await browser.newPage();
    await page.bringToFront();
    const before2 = new Set(browser.targets());
    await ctl.evaluate(() => chrome.storage.session.remove('lastError'));
    await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'visible', tabId, delay: 3 }), tabId);
    await page.waitForSelector('#__captode_delay', { timeout: 5000 });
    await other.bringToFront();
    // A page in the background runs its timers late, so the end of the wait (and the error)
    // can come well after 3 s: wait for it, so it can't land in a later test.
    const lastError = await ctl.waitForFunction(async () => (await chrome.storage.session.get('lastError')).lastError, { polling: 200, timeout: 20000 })
      .then(() => ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError), () => null);
    ok(!browser.targets().some((x) => !before2.has(x) && x.url().includes('editor.html')) && /tab/i.test(lastError || ''), `switching tabs stops it: ${lastError}`);
    await ctl.evaluate(async () => { await chrome.storage.session.remove('lastError'); await chrome.action.setBadgeText({ text: '' }); });
    await other.close();
    await page.bringToFront();
    // A selected area is dragged out first; then the wait.
    const { ed: ed2, size } = await capture('area', async () => {
      await page.bringToFront();
      await page.waitForSelector('#__captode_pick');
      await page.mouse.move(100, 100);
      await page.mouse.down();
      await page.mouse.move(300, 220, { steps: 4 });
      await page.mouse.up();
      await page.waitForSelector('#__captode_delay', { timeout: 5000 });
    }, { delay: 3 });
    const s = await page.evaluate(() => devicePixelRatio);
    near(size[0], 200 * s, 1, 'area width after the wait');
    near(size[1], 120 * s, 1, 'area height after the wait');
    await ed2.close();
    await page.bringToFront();
  },

  async 'element: pick one by pointing, take the larger one around it with ↑, tall ones stitched'({ browser, url, site, page }) {
    const notes = [await elementCapture(browser, url, site)];
    const env = await launch({ args: ['--force-device-scale-factor=1.5'] });
    try { notes.push(await elementCapture(env.browser, env.url, site)); } finally { await env.close(); }
    await page.bringToFront();
    return notes.join('; ');
  },

  async 'recordings can show clicks and shortcuts, but never typing or passwords'({ page, ctl, tabId }) {
    // Tab capture can't run in the test browser (see record.test.mjs), so the layer
    // is put on the page the way a recording does, and checked there.
    const inject = (on) => ctl.evaluate(async (tabId, on) => {
      const { showInputs } = await import('/content/page.js');
      await chrome.scripting.executeScript({ target: { tabId }, func: showInputs, args: [on] });
    }, tabId, on);
    await page.bringToFront();
    await page.evaluate(() => {
      const f = document.createElement('div');
      f.id = 'fields';
      f.style.cssText = 'position:fixed;left:20px;top:20px;z-index:5;background:#fff;padding:8px';
      f.innerHTML = '<input id="name"> <input id="pw" type="password">';
      document.body.append(f);
    });
    await inject(true);
    const shown = () => page.evaluate(() => {
      const root = document.querySelector('#__captode_inputs')?.shadowRoot;
      const keys = root?.querySelector('.keys');
      return { layer: !!root, ripples: root?.querySelectorAll('.ripple').length || 0, keys: keys && !keys.classList.contains('out') ? keys.textContent : null };
    });
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    try {
      await page.mouse.click(400, 300);
      ok((await shown()).ripples === 1, 'a click makes a ripple');
      await page.click('#name');
      await page.keyboard.type('secret words');
      ok((await shown()).keys === null, 'typing is not shown');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyK');
      await page.keyboard.up('Control');
      ok((await shown()).keys === (mac ? '⌃K' : 'Ctrl+K'), `a shortcut is shown: ${(await shown()).keys}`);
      await page.keyboard.press('Enter');
      ok((await shown()).keys === 'Enter', 'a named key is shown');
      await sleep(1500);
      await page.click('#pw');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyV');
      await page.keyboard.up('Control');
      await page.keyboard.press('Enter');
      ok((await shown()).keys === null, 'nothing at all in a password field');
      // A page load during the recording would inject it again; a second call replaces it.
      await inject(true);
      ok((await page.evaluate(() => document.querySelectorAll('#__captode_inputs').length)) === 1, 'one layer, not two');
      await inject(false);
      ok(!(await shown()).layer, 'removed when the recording stops');
    } finally {
      await inject(false).catch(() => {});
      await page.evaluate(() => document.querySelector('#fields')?.remove());
    }
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
      await ed.waitForFunction(() => /KB|MB|bytes|B$/.test(document.querySelector('#x-estimate').textContent), { timeout: 30000, polling: 100 });
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
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 30000, polling: 100 });
      const r = await ed.evaluate(async (b64) => {
        const bg = captodeEditor.pixels();
        const ours = bg.data;
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
      await ed2.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 30000, polling: 100 });
      const area = await ed2.evaluate(() => captodeEditor.size());
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

  async 'a click on the icon can take a screenshot straight away, if chosen in Settings'({ browser, url, page, ctl, tabId }) {
    const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url() === url('background.js'))).worker();
    try {
      await setSettings(ctl, { iconAction: 'visible' });
      await until(async () => (await ctl.evaluate(() => chrome.action.getPopup({}))) === '', 'the popup was not switched off');
      await page.bringToFront();
      const before = editorsOpen(browser);
      // The test browser has no toolbar to click: call what a click calls.
      await sw.evaluate((tabId) => chrome.tabs.get(tabId).then((tab) => captodeIconClick(tab)), tabId);
      const ed = await waitForTab(browser, (u) => u.includes('editor.html?id=') && !before.has(u));
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 45000 });
      const [size, view] = await Promise.all([ed.evaluate(() => captodeEditor.size()), page.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio])]);
      near(size[0], view[0], 2, 'visible area width');
      near(size[1], view[1], 2, 'visible area height');
      await ed.close();
    } finally {
      await setSettings(ctl, { iconAction: 'popup' });
      await until(async () => (await ctl.evaluate(() => chrome.action.getPopup({}))).endsWith('popup/popup.html'), 'the popup was not put back');
      await page.bringToFront();
    }
  },

  async 'file names follow the pattern chosen in Settings'({ ctl, capture }) {
    try {
      await setSettings(ctl, { fileName: '{site}_{title}' });
      const { ed } = await capture('visible');
      const name = await ed.$eval('#x-name', (e) => e.value);
      await ed.close();
      ok(/^127-0-0-1_[\p{L}\p{N}-]+$/u.test(name), `file name ${name}`);
    } finally {
      await setSettings(ctl, { fileName: '' });
    }
  },

  async 'pages too long for one image can be scaled down to fit, or split into parts'({ browser, ctl, site }) {
    const long = await browser.newPage();
    await long.goto(`${site}/very-long.html`);
    const longId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/very-long.html` }))[0].id, site);
    // The colour of each 1,000-pixel block, and how wide the page is.
    const page = await long.evaluate(() => ({
      colours: [...document.querySelectorAll('.block')].map((b) => getComputedStyle(b).backgroundColor.match(/\d+/g).map(Number)),
      width: innerWidth, dpr: devicePixelRatio, height: document.documentElement.scrollHeight,
    }));
    const shoot = async (count) => {
      const before = editorsOpen(browser);
      await long.bringToFront();
      await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'full', tabId }), longId);
      const eds = [];
      for (let i = 0; i < count; i++) {
        const ed = await waitForTab(browser, (u) => u.includes('editor.html?id=') && !before.has(u) && !eds.some((e) => e.url() === u), 120000);
        await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { timeout: 120000 });
        eds.push(ed);
      }
      return eds;
    };
    // Colours at these heights (image pixels) in an editor's image.
    const colours = (ed, ys) => ed.evaluate((ys) => {
      const [w] = captodeEditor.size();
      const d = captodeEditor.pixels();
      return ys.map((y) => { const i = (Math.round(y) * w + Math.round(w / 2)) * 4; return [d.data[i], d.data[i + 1], d.data[i + 2]]; });
    }, ys);
    const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 8);
    try {
      // Scaled: the whole page in one image of at most 32,000 pixels.
      await setSettings(ctl, { longPages: 'scale' });
      const [ed] = await shoot(1);
      const [w, h] = await ed.evaluate(() => captodeEditor.size());
      const s = h / page.height;
      ok(h <= 32000 && h > 31800, `scaled height ${h}`);
      near(w / h, page.width / page.height, 0.002, 'shape kept');
      const blocks = [0, 13, 26, 39];
      const got = await colours(ed, blocks.map((i) => (i * 1000 + 500) * s));
      blocks.forEach((b, j) => ok(close(got[j], page.colours[b]), `scaled: block ${b} is ${got[j]}, not ${page.colours[b]}`));
      await ed.close();

      // Split: the top 32,000 pixels, then the rest, each in its own editor.
      await setSettings(ctl, { longPages: 'split' });
      const parts = await shoot(2);
      const sizes = await Promise.all(parts.map((p) => p.evaluate(() => captodeEditor.size())));
      const order = sizes[0][1] >= sizes[1][1] ? [0, 1] : [1, 0];
      const [a, b] = order.map((i) => parts[i]);
      const [ha, hb] = order.map((i) => sizes[i][1]);
      near(ha, 32000 * page.dpr, 2, 'first part height');
      near(ha + hb, page.height * page.dpr, 4, 'both parts together');
      ok(close((await colours(a, [500 * page.dpr]))[0], page.colours[0]), 'first part starts at the top');
      ok(close((await colours(b, [500 * page.dpr]))[0], page.colours[32]), 'second part starts where the first ends');
      ok(close((await colours(b, [hb - 500 * page.dpr]))[0], page.colours[39]), 'second part reaches the bottom');
      ok(/2/.test(await b.$eval('#doc-name', (e) => e.textContent)), 'the part is not named');
      ok(/-2$/.test(await b.$eval('#x-name', (e) => e.value)), 'the second part\'s file name has no number');
      for (const p of parts) await p.close();
      return `scaled ${w} × ${h}; parts ${ha} + ${hb}`;
    } finally {
      await setSettings(ctl, { longPages: 'cut' });
      await long.close();
    }
  },

  async 'after a screenshot, it can be downloaded or copied straight away'({ browser, page, ctl, tabId, site }) {
    const dir = mkdtempSync(join(tmpdir(), 'captode-downloads-'));
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    const context = browser.defaultBrowserContext();
    await context.overridePermissions(site, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await prepare(page); // focused, as a page the user is looking at
    const view = await page.evaluate(() => [Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)]);
    const shoot = async () => {
      await page.bringToFront();
      await ctl.evaluate(() => chrome.storage.session.remove('lastError'));
      await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'visible', tabId }), tabId);
    };
    const editorGone = (before) => until(async () => {
      const now = editorsOpen(browser);
      return [...now].every((u) => before.has(u));
    }, 'the editor did not close itself', 30000);
    try {
      // Download: an editor works in the background, saves the file and closes.
      await setSettings(ctl, { afterCapture: 'download' });
      let before = editorsOpen(browser);
      await shoot();
      await until(() => readdirSync(dir).some((f) => /\.png$/.test(f)), 'nothing was downloaded', 30000);
      const file = readdirSync(dir).find((f) => /\.png$/.test(f));
      ok(/^captode-.*\d{8}-\d{6}\.png$/.test(file), `file ${file}`);
      await editorGone(before);
      ok(await page.evaluate(() => document.visibilityState === 'visible'), 'the page did not stay in front');

      // Copy: the image lands on the clipboard, and the editor closes.
      await page.evaluate(() => navigator.clipboard.writeText('nothing yet'));
      await setSettings(ctl, { afterCapture: 'copy' });
      before = editorsOpen(browser);
      await shoot();
      const size = await until(() => page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        if (!item.types.includes('image/png')) return null;
        const bmp = await createImageBitmap(await item.getType('image/png'));
        return [bmp.width, bmp.height];
      }).catch(() => null), 'nothing was copied', 30000);
      ok(size[0] === view[0] && size[1] === view[1], `copied ${size}, page ${view}`);
      await editorGone(before);
      const error = await ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError);
      ok(!error, `capture reported an error: ${error}`);
    } finally {
      await setSettings(ctl, { afterCapture: 'editor' });
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {});
      await context.clearPermissionOverrides();
      rmSync(dir, { recursive: true, force: true });
    }
  },

  async 'recordings can highlight the cursor'({ page, ctl, tabId }) {
    const inject = (on, opts) => ctl.evaluate(async (tabId, on, opts) => {
      const { showInputs } = await import('/content/page.js');
      await chrome.scripting.executeScript({ target: { tabId }, func: showInputs, args: opts ? [on, opts] : [on] });
    }, tabId, on, opts);
    await page.bringToFront();
    await inject(true, { clicks: false, cursor: true });
    const state = () => page.evaluate(() => {
      const root = document.querySelector('#__captode_inputs')?.shadowRoot;
      const dot = root?.querySelector('.cursor');
      return { layer: !!root, on: !!dot?.classList.contains('on'), at: dot?.style.transform || '', ripples: root?.querySelectorAll('.ripple').length || 0 };
    });
    try {
      await page.mouse.move(300, 200);
      await page.mouse.move(320, 240, { steps: 3 });
      const s = await state();
      ok(s.layer && s.on && /320px, 240px/.test(s.at), `cursor ${JSON.stringify(s)}`);
      await page.mouse.click(320, 240);
      ok((await state()).ripples === 0, 'clicks shown though only the cursor was asked for');
    } finally {
      await inject(false);
    }
    ok(!(await state()).layer, 'the layer was not removed');
  },
};

/** Changes Settings as the Settings page does. */
async function setSettings(ctl, patch) {
  await ctl.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);
}

/** The editors open now. */
const editorsOpen = (browser) => new Set(browser.targets().filter((t) => t.type() === 'page' && t.url().includes('editor.html?id=')).map((t) => t.url()));

/** Waits until `fn` gives something truthy, checking from here (see helpers' waitFor). */
async function until(fn, message, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(message);
    await sleep(150);
  }
}
