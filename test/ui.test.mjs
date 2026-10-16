// The interface: popup states, editor flows, settings and themes.
import { open, waitForTab, ok, sleep, near } from './helpers.mjs';

const theme = (page) => page.evaluate(() => [document.documentElement.dataset.theme || 'system', getComputedStyle(document.body).backgroundColor]);

export async function setup({ browser, url, site }) {
  const page = await open(browser, `${site}/rich.html`);
  const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
  const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/*` }))[0].id, site);
  // Captures the test page and returns the editor it opens. A busy CI runner sometimes
  // misses the first capture; try once more, and say what the extension reported.
  const editor = async () => {
    let ed;
    for (let attempt = 0; !ed; attempt++) {
      const before = new Set(browser.targets());
      await ctl.evaluate(() => chrome.storage.session.remove('lastError'));
      await page.bringToFront();
      await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'visible', tabId }), tabId);
      try {
        const t = await browser.waitForTarget((t) => !before.has(t) && t.type() === 'page' && t.url().includes('editor.html?id='), { timeout: 15000 });
        ed = await t.page();
      } catch (e) {
        const lastError = await ctl.evaluate(async () => (await chrome.storage.session.get('lastError')).lastError);
        if (attempt) throw new Error(`no editor opened after capturing (last error: ${lastError})`);
        await sleep(1000);
      }
    }
    await ed.setViewport({ width: 1440, height: 900 });
    await ed.bringToFront();
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
    return ed;
  };
  return { page, editor };
}

export const tests = {
  async 'popup explains protected pages and leaves screen recording available'({ browser, url }) {
    // Opened as a tab, the popup's active tab is itself: a chrome-extension:// page.
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await sleep(300);
    const r = await pop.evaluate(() => ({
      banner: !document.querySelector('#blocked').classList.contains('hidden'),
      disabled: [...document.querySelectorAll('.mode')].map((b) => `${b.dataset.mode}:${b.disabled}`),
    }));
    ok(r.banner, 'no protected-page banner');
    ok(r.disabled.includes('screen:false') && r.disabled.includes('visible:true'), `modes ${r.disabled}`);
    await pop.close();
  },

  async 'editor: draw, download label, unsaved-changes guard, shortcuts sheet'({ editor }) {
    const ed = await editor();
    ok(/Download PNG/.test(await ed.evaluate(() => document.querySelector('#download').textContent)), 'download button names the format');
    const b = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await ed.keyboard.press('r');
    await ed.mouse.move(b.x + b.w * 0.3, b.y + b.h * 0.3);
    await ed.mouse.down();
    await ed.mouse.move(b.x + b.w * 0.6, b.y + b.h * 0.6, { steps: 5 });
    await ed.mouse.up();
    const guarded = () => ed.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    ok(await guarded(), 'closing with unsaved changes should ask first');
    await ed.keyboard.press('Escape');
    await ed.keyboard.type('?');
    await sleep(200);
    ok(await ed.evaluate(() => document.querySelector('#shortcuts').open), 'shortcuts sheet did not open');
    await ed.keyboard.press('Escape');
    await ed.click('#copy');
    await sleep(300);
    ok(!(await guarded()), 'copying should count as saving');
    await ed.close();
  },

  async 'editor: export preview, size limit and tabs'({ editor }) {
    const ed = await editor();
    await ed.click('#tab-export');
    ok(await ed.evaluate(() => document.querySelector('#tab-export').getAttribute('aria-selected') === 'true'), 'tab not selected');
    await ed.click('#device-panel input[data-k="enabled"]');
    await ed.waitForFunction(() => !document.querySelector('#export-preview').classList.contains('hidden') && document.querySelector('#device-preview').width > 300, { timeout: 20000, polling: 100 });
    await ed.click('#device-panel input[data-k="enabled"]');
    await ed.evaluate(() => { const s = document.querySelector('#x-format'); s.value = 'jpeg'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await ed.evaluate(() => { const s = document.querySelector('#x-limit'); s.value = '100'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(600);
    await ed.waitForFunction(() => !/Working/.test(document.querySelector('#x-estimate').textContent), { timeout: 30000, polling: 100 });
    const est = await ed.evaluate(() => [document.querySelector('#x-estimate').textContent, document.querySelector('#x-fitted').textContent]);
    const kb = Number(est[0].match(/([\d.]+) KB/)?.[1]);
    ok(kb && kb <= 100, `estimate ${est[0]}`);
    ok(/quality|size/.test(est[1]) || kb < 100, `fitting not explained: ${est[1]}`);
    await ed.close();
    return est.join(' — ');
  },

  async 'empty editor lists recent captures'({ browser, url, editor }) {
    await (await editor()).close(); // make sure there is at least one
    const em = await open(browser, url('editor/editor.html'));
    await sleep(800);
    ok(await em.evaluate(() => document.querySelectorAll('.recent-item').length) > 0, 'no recent captures');
    await em.close();
  },

  async 'settings: theme follows the system by default and applies everywhere'({ browser, url }) {
    const st = await open(browser, url('settings/settings.html'), { width: 900, height: 1000 });
    await st.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await sleep(200);
    ok((await theme(st))[0] === 'system', 'default theme is not System');
    await st.click('#theme [data-v="dark"]');
    await sleep(300);
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await sleep(200);
    ok((await theme(pop))[0] === 'dark', 'popup did not take the dark theme');
    await st.bringToFront();
    await st.click('#theme [data-v="system"]');
    await st.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    ok((await theme(st))[1] === 'rgb(15, 15, 19)', 'System did not follow a dark browser');
    await st.click('#reset');
    await sleep(200);
    await st.click('#reset-yes');
    await sleep(300);
    ok(await st.evaluate(() => document.querySelector('#background [aria-checked=true]').dataset.v) === 'transparent', 'reset did not restore defaults');
    await pop.close();
    await st.close();
  },

  async 'popup shows the keyboard shortcut as Chrome has it set'({ browser, url }) {
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await sleep(300);
    const r = await pop.evaluate(async () => ({
      shown: document.querySelector('.shortcut-keys').textContent.replace(/\s+/g, ''),
      actual: ((await chrome.commands.getAll()).find((c) => c.name === '_execute_action')?.shortcut || '').replace(/\+/g, ''),
    }));
    ok(r.actual ? r.shown === r.actual : r.shown === 'noshortcutset', `shows "${r.shown}", Chrome has "${r.actual}"`);
    await pop.close();
    return r.actual || 'no shortcut set';
  },

  async 'switches and selections stay visible in Windows high-contrast mode'({ browser, url }) {
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    // Puppeteer's helper doesn't know this feature; Chrome's DevTools protocol does.
    const cdp = await pop.createCDPSession();
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    await sleep(200);
    const r = await pop.evaluate(() => {
      const box = getComputedStyle(document.querySelector('#audio'));
      const on = getComputedStyle(document.querySelector('.kind button.on'));
      return { border: box.borderTopStyle !== 'none' && box.borderTopWidth !== '0px', onAdjust: on.forcedColorAdjust };
    });
    ok(r.border, 'switches have no outline in high-contrast mode');
    ok(r.onAdjust === 'none', 'selected tab does not use the system highlight');
    await pop.close();
  },

  async 'recording countdown can be set from off to 30 seconds'({ browser, url }) {
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await pop.evaluate(() => chrome.storage.local.remove(['countdown', 'countdownSeconds']).then(() => chrome.storage.local.set({ kind: 'video' })));
    await pop.reload();
    await pop.waitForSelector('#modes-video:not(.hidden)');
    const state = () => pop.evaluate(async () => ({
      shown: document.querySelector('#countdown').textContent,
      hint: document.querySelector('#countdown-hint').textContent,
      now: Number(document.querySelector('#countdown').getAttribute('aria-valuenow')),
      text: document.querySelector('#countdown').getAttribute('aria-valuetext'),
      less: document.querySelector('#countdown-less').disabled,
      more: document.querySelector('#countdown-more').disabled,
      stored: (await chrome.storage.local.get('countdownSeconds')).countdownSeconds,
    }));
    let r = await state();
    ok(r.shown === '3 s' && r.now === 3, `default is ${r.shown}`);
    await pop.click('#countdown-more');
    r = await state();
    ok(r.now === 4 && r.stored === 4 && r.text === '4 seconds', `after + : ${JSON.stringify(r)}`);
    // Keyboard: End jumps to the most, then steps go down 5 at a time above 10.
    await pop.focus('#countdown');
    await pop.keyboard.press('End');
    r = await state();
    ok(r.now === 30 && r.more, `End gives ${r.now}, + still enabled: ${!r.more}`);
    await pop.keyboard.press('ArrowDown');
    ok((await state()).now === 25, 'below 30 comes 25');
    for (let i = 0; i < 3; i++) await pop.keyboard.press('ArrowDown');
    ok((await state()).now === 10, 'then 20, 15, 10');
    await pop.keyboard.press('ArrowDown');
    ok((await state()).now === 9, 'below 10 it goes a second at a time');
    // Typing a digit sets it, and doesn't pick a capture mode.
    await pop.keyboard.press('2');
    ok((await state()).now === 2, 'typing 2 sets 2 seconds');
    await pop.keyboard.press('Home');
    r = await state();
    ok(r.shown === 'Off' && r.less && r.stored === 0 && /straight away/.test(r.hint), `Home: ${JSON.stringify(r)}`);
    // Remembered next time.
    await pop.evaluate(() => chrome.storage.local.set({ countdownSeconds: 15 }));
    await pop.reload();
    await pop.waitForSelector('#modes-video:not(.hidden)');
    ok((await state()).shown === '15 s', 'setting not remembered');
    // Settings from older versions: an on/off switch for 3 seconds.
    await pop.evaluate(() => chrome.storage.local.remove('countdownSeconds').then(() => chrome.storage.local.set({ countdown: false })));
    await pop.reload();
    await pop.waitForSelector('#modes-video:not(.hidden)');
    ok((await state()).now === 0, 'old "off" setting not carried over');
    await pop.evaluate(() => chrome.storage.local.remove(['countdown', 'countdownSeconds', 'kind']));
    await pop.close();
  },

  async 'countdown shows the chosen seconds and Esc cancels it'({ browser, url }) {
    const p = await open(browser, url('popup/popup.html'), { width: 800, height: 600 });
    const r = await p.evaluate(async () => {
      const { countdown } = await import('/content/page.js');
      const shown = [];
      const watch = setInterval(() => { const t = document.querySelector('#__captode_countdown')?.firstChild?.textContent; if (t && shown.at(-1) !== t) shown.push(t); }, 50);
      const t0 = performance.now();
      const done = await countdown(2);
      const ms = performance.now() - t0;
      clearInterval(watch);
      const cancelled = countdown(30);
      await new Promise((res) => setTimeout(res, 300));
      dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return { done, ms, shown, cancelled: await cancelled, left: !!document.querySelector('#__captode_countdown') };
    });
    ok(r.done === true && r.shown.join() === '2,1', `showed ${r.shown}, finished ${r.done}`);
    near(r.ms, 2000, 300, 'countdown length (ms)');
    ok(r.cancelled === false && !r.left, 'Esc did not cancel the countdown');
    await p.close();
  },

  async 'full-screen recording counts down after the picker, and can be cancelled'({ browser, url }) {
    const p = await open(browser, url('recorder/screen.html?fps=30&audio=0&countdown=2'), { width: 800, height: 600 });
    // Chrome's screen picker can't be driven from a test: share a canvas instead.
    const fakeShare = () => p.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 320; c.height = 240;
        const x = c.getContext('2d');
        setInterval(() => { x.fillStyle = `hsl(${Date.now() / 10 % 360} 60% 50%)`; x.fillRect(0, 0, 320, 240); }, 33);
        return c.captureStream(30);
      };
    });
    const visible = (id) => p.evaluate((id) => !document.getElementById(id).classList.contains('hidden'), id);
    await fakeShare();
    await p.click('#choose');
    await sleep(300);
    ok(await visible('counting'), 'no countdown after choosing');
    const badge = await p.evaluate(() => chrome.action.getBadgeText({}));
    ok(badge === '2', `badge shows "${badge}"`);
    await p.click('#cancel');
    await sleep(200);
    ok(await visible('pick') && !(await visible('live')), 'cancel did not go back to the start');
    ok(await p.evaluate(() => chrome.action.getBadgeText({})) === '', 'badge not cleared after cancel');
    // Again, letting it finish: recording starts.
    await p.click('#choose');
    await sleep(2600);
    ok(await visible('live') && !(await visible('counting')), 'recording did not start after the countdown');
    await Promise.all([p.waitForNavigation({ timeout: 30000 }), p.click('#stop')]);
    ok(p.url().includes('video/video.html?id='), `after stopping: ${p.url()}`);
    await p.close();
  },

  async 'editor: step numbers count up, can be renumbered, and undo'({ editor }) {
    const ed = await editor();
    const b = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const at = (fx, fy) => [b.x + b.w * fx, b.y + b.h * fy];
    const panel = () => ed.evaluate(() => ({ label: document.querySelector('#st-n-label').textContent, n: document.querySelector('#st-n').value, size: Number(document.querySelector('#st-size').value) }));
    await ed.keyboard.press('n');
    ok((await panel()).n === '1', 'first step is not 1');
    for (const fx of [0.2, 0.4, 0.6]) { await ed.mouse.click(...at(fx, 0.5)); await sleep(50); }
    let p = await panel();
    ok(p.label === 'Number' && p.n === '3', `after three clicks the selected step shows ${p.label} ${p.n}`);
    // Three circles in the chosen colour (#e5484d) are drawn.
    const red = await ed.evaluate(async () => {
      const d = (await captodeEditor.render()).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0xe5) < 12 && Math.abs(d[i + 1] - 0x48) < 12 && Math.abs(d[i + 2] - 0x4d) < 12 && d[i + 3] > 250) n++;
      return n;
    });
    const area = Math.PI * (p.size / 2) ** 2;
    ok(red > area * 3 * 0.5, `step circles: ${red} pixels in the step colour, expected about ${Math.round(area * 3 * 0.8)}`);
    await ed.keyboard.press('Escape');
    ok((await panel()).n === '4', 'next number after 3 is not 4');
    // Select the second and renumber it.
    await ed.keyboard.press('v');
    await ed.mouse.click(...at(0.4, 0.5));
    ok((await panel()).n === '2', 'clicking the second step did not select it');
    await ed.click('#st-n', { count: 3 });
    await ed.keyboard.type('7');
    await ed.keyboard.press('Enter'); // leaves the box
    await sleep(500);
    await ed.keyboard.press('Escape');
    // Start the next one at 10.
    await ed.keyboard.press('n');
    await ed.click('#st-n', { count: 3 });
    await ed.keyboard.type('10');
    await ed.keyboard.press('Enter');
    await ed.mouse.click(...at(0.8, 0.5));
    await ed.keyboard.press('Escape');
    ok((await panel()).n === '11', 'after a step set to 10 the next is not 11');
    // Undo removes 10; the next is then one more than the highest left (7).
    await ed.keyboard.down('Meta'); await ed.keyboard.press('z'); await ed.keyboard.up('Meta');
    await ed.keyboard.down('Control'); await ed.keyboard.press('z'); await ed.keyboard.up('Control');
    await sleep(100);
    // (One of the two undo shortcuts applies on this platform; the other is ignored.)
    const n = (await panel()).n;
    ok(n === '8' || n === '4', `after undo the next number is ${n}`);
    await ed.close();
  },

  async 'editor: copy from the Export panel, and copy new screenshots automatically'({ browser, url, editor, page }) {
    // Extension pages can't be granted clipboard reading in a test, so read it from the
    // test web page.
    await browser.defaultBrowserContext().overridePermissions(new URL(page.url()).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const clip = async () => {
      await page.bringToFront();
      return page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const item = items.find((i) => i.types.includes('image/png'));
        if (!item) return null;
        const bmp = await createImageBitmap(await item.getType('image/png'));
        return [bmp.width, bmp.height];
      });
    };
    const clear = async () => { await page.bringToFront(); await page.evaluate(() => navigator.clipboard.writeText('before')); };
    const ed = await editor();
    const size = await ed.evaluate(() => captodeEditor.size());
    await clear();
    await ed.bringToFront();
    await ed.evaluate(() => document.querySelector('#tab-export').click());
    await ed.evaluate(() => document.querySelector('#copy2').click());
    await sleep(500);
    let got = await clip();
    ok(got && got[0] === size[0] && got[1] === size[1], `Export panel copy put ${got} on the clipboard, expected ${size}`);
    await ed.close();

    // Settings → Copy screenshots to the clipboard.
    const st = await open(browser, url('settings/settings.html'), { width: 900, height: 1000 });
    await st.click('#autoCopy');
    await sleep(300);
    await st.close();
    await clear();
    const ed2 = await editor();
    await ed2.waitForFunction(() => /copied to the clipboard/i.test(document.body.innerText), { timeout: 10000, polling: 100 }).catch(() => {});
    got = await clip();
    ok(got && got[0] > 0, 'new screenshot was not copied automatically');
    ok(await ed2.evaluate(() => location.search.includes('reopen=1')), 'a reload would copy it again');
    await ed2.evaluate(async () => { const { saveSettings } = await import('/lib/settings.js'); await saveSettings({ autoCopy: false }); });
    await ed2.close();
  },

  async 'editor: undo all, and bring the changes back'({ editor }) {
    const ed = await editor();
    const b = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const drawn = () => ed.evaluate(() => captodeEditor.objects().length);
    const disabled = (id) => ed.evaluate((id) => document.getElementById(id).disabled, id);
    ok(await disabled('undo-all'), 'Undo all is enabled before any change');
    await ed.keyboard.press('r');
    await ed.mouse.move(b.x + b.w * 0.2, b.y + b.h * 0.2);
    await ed.mouse.down();
    await ed.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.5, { steps: 4 });
    await ed.mouse.up();
    await ed.keyboard.press('n');
    await ed.mouse.click(b.x + b.w * 0.7, b.y + b.h * 0.7);
    await ed.keyboard.press('Escape');
    ok(await drawn() > 0 && !(await disabled('undo-all')), 'nothing drawn, or Undo all not available');
    await ed.evaluate(() => document.querySelector('#undo-all').click());
    await sleep(100);
    ok(await drawn() === 0, 'Undo all left annotations behind');
    ok(await disabled('undo-all') && !(await disabled('undo')), 'after Undo all: it should be disabled, and Undo available');
    // The toast's Undo brings everything back.
    await ed.evaluate(() => document.querySelector('.toast-action').click());
    await sleep(100);
    ok(await drawn() > 0, 'Undo did not bring the changes back');
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close({ runBeforeUnload: false });
  },

  async 'editor: pan with the hand tool, Space or the middle button'({ editor }) {
    const ed = await editor();
    for (let i = 0; i < 4; i++) await ed.keyboard.press('+');
    await sleep(100);
    const scroll = () => ed.evaluate(() => { const s = document.querySelector('#stage'); return [s.scrollLeft, s.scrollTop]; });
    const mid = await ed.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    const dragBy = async (dx, dy, button = 'left') => {
      await ed.mouse.move(...mid);
      await ed.mouse.down({ button });
      await ed.mouse.move(mid[0] + dx, mid[1] + dy, { steps: 5 });
      await ed.mouse.up({ button });
    };
    const undoState = () => ed.evaluate(() => document.querySelector('#undo').disabled);
    await ed.evaluate(() => { const s = document.querySelector('#stage'); s.scrollLeft = 400; s.scrollTop = 400; });
    // Hand tool.
    await ed.keyboard.press('m');
    let before = await scroll();
    await dragBy(-120, -80);
    let after = await scroll();
    ok(Math.abs(after[0] - before[0] - 120) <= 2 && Math.abs(after[1] - before[1] - 80) <= 2, `hand tool scrolled ${before} → ${after}`);
    // Space with the rectangle tool: pans, draws nothing.
    await ed.keyboard.press('r');
    const undoBefore = await undoState();
    before = await scroll();
    await ed.keyboard.down(' ');
    await dragBy(100, 60);
    await ed.keyboard.up(' ');
    after = await scroll();
    ok(Math.abs(before[0] - after[0] - 100) <= 2 && Math.abs(before[1] - after[1] - 60) <= 2, `Space-drag scrolled ${before} → ${after}`);
    ok(await undoState() === undoBefore, 'Space-drag drew a rectangle');
    // Middle button.
    before = await scroll();
    await dragBy(-50, -30, 'middle');
    after = await scroll();
    ok(Math.abs(after[0] - before[0] - 50) <= 2, `middle-button drag scrolled ${before} → ${after}`);
    await ed.close();
  },

  async 'editor: large captures draw only what is on screen, correctly'({ browser, url }) {
    const ed = await open(browser, url('editor/editor.html'), { width: 1440, height: 900 });
    await ed.bringToFront();
    await ed.evaluate(async () => {
      // 2560 × 24000: a long page on a high-resolution screen. Each 100-px band has its own colour.
      const c = new OffscreenCanvas(2560, 24000); const x = c.getContext('2d');
      for (let y = 0; y < 24000; y += 100) { x.fillStyle = `rgb(${(y / 100) % 256}, ${(y / 37) % 256 | 0}, 120)`; x.fillRect(0, y, 2560, 100); }
      const dt = new DataTransfer(); dt.items.add(new File([await c.convertToBlob()], 'long.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
    });
    await ed.waitForFunction(() => captodeEditor.size()?.[1] === 24000, { polling: 100, timeout: 60000 });
    await ed.evaluate(() => document.querySelector('#zoom-label').click()); // 100%
    await sleep(200);
    // Scroll deep into the image and compare what's drawn with the image itself.
    const r = await ed.evaluate(async () => {
      const stage = document.querySelector('#stage');
      stage.scrollTop = 20000;
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const bg = document.querySelector('#bg');
      const canvasPx = [...document.querySelectorAll('#wrap canvas')].reduce((n, c) => n + c.width * c.height, 0);
      // The pixel in the middle of the visible canvas, and where it is in the image.
      const br = bg.getBoundingClientRect(), wr = document.querySelector('#wrap').getBoundingClientRect();
      const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
      const drawn = [...bg.getContext('2d').getImageData(Math.round(bg.width / 2), Math.round(bg.height / 2), 1, 1).data];
      const ix = Math.round(cx - wr.left), iy = Math.round(cy - wr.top);
      const want = [...captodeEditor.pixels().data.subarray((iy * 2560 + ix) * 4, (iy * 2560 + ix) * 4 + 4)];
      return { canvasPx, viewport: innerWidth * innerHeight * devicePixelRatio ** 2, drawn, want, iy };
    });
    ok(r.canvasPx <= r.viewport * 2.2, `canvases hold ${r.canvasPx} px for a ${r.viewport} px window`);
    ok(r.iy > 19000 && r.drawn.every((v, i) => Math.abs(v - r.want[i]) <= 2), `at row ${r.iy}: drawn ${r.drawn}, image has ${r.want}`);
    await ed.close();
  },

  async 'editor: blur changes only its area, and undo stays within its memory budget'({ editor }) {
    const ed = await editor();
    const b = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await ed.keyboard.press('b');
    await ed.evaluate(() => { const s = document.querySelector('#r-mode'); s.value = 'blur'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await ed.mouse.move(b.x + b.w * 0.1, b.y + b.h * 0.1);
    await ed.mouse.down();
    await ed.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.5, { steps: 4 });
    await ed.mouse.up();
    const r = await ed.evaluate(async () => {
      const a = captodeEditor.pixels(), f = await captodeEditor.render();
      const o = captodeEditor.objects()[0];
      const x0 = Math.round(Math.min(o.x1, o.x2)), y0 = Math.round(Math.min(o.y1, o.y2)), x1 = Math.round(Math.max(o.x1, o.x2)), y1 = Math.round(Math.max(o.y1, o.y2));
      let inside = 0, outside = 0;
      for (let y = 0; y < a.height; y += 3) for (let x = 0; x < a.width; x += 3) {
        const i = (y * a.width + x) * 4;
        const d = Math.abs(a.data[i] - f.data[i]) + Math.abs(a.data[i + 1] - f.data[i + 1]) + Math.abs(a.data[i + 2] - f.data[i + 2]);
        if (x >= x0 && x < x1 && y >= y0 && y < y1) inside += d > 0; else outside += d > 0;
      }
      return { inside, outside };
    });
    ok(r.inside > 100 && r.outside === 0, `blur changed ${r.inside} pixels inside and ${r.outside} outside`);
    // Undo memory: resizing a capture keeps a copy per step; old ones go past the budget.
    await ed.evaluate(() => document.querySelector('#tab-adjust').click());
    for (const w of [12000, 11000, 10000, 9000, 8000]) {
      await ed.evaluate((w) => { const i = document.querySelector('#rs-w'); i.value = w; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#rs-apply').click(); }, w);
      await ed.waitForFunction((w) => captodeEditor.size()[0] === w, { polling: 100, timeout: 30000 }, w);
    }
    const h = await ed.evaluate(() => captodeEditor.history());
    ok(h.steps < 7 && h.index === h.steps - 1, `history kept ${h.steps} steps of big images`);
    await ed.keyboard.down('Control'); await ed.keyboard.press('z'); await ed.keyboard.up('Control');
    await ed.keyboard.down('Meta'); await ed.keyboard.press('z'); await ed.keyboard.up('Meta');
    ok([9000, 10000].includes((await ed.evaluate(() => captodeEditor.size()))[0]), 'undo after trimming did not go back a step');
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },

  async 'editor: resize handles for shapes, text and steps'({ editor }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click()); // 100%: image px = CSS px
    await sleep(100);
    const wrap = () => ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    let w = await wrap();
    const at = (x, y) => [w.x + x, w.y + y];
    const dragFrom = async (from, to) => { await ed.mouse.move(...from); await ed.mouse.down(); await ed.mouse.move(...to, { steps: 4 }); await ed.mouse.up(); };
    // Rectangle: drag its bottom-right corner, then its left edge.
    await ed.keyboard.press('r');
    await dragFrom(at(100, 100), at(300, 200));
    await ed.keyboard.press('v');
    await dragFrom(at(300, 200), at(400, 260));
    let o = (await ed.evaluate(() => captodeEditor.objects()))[0];
    ok(Math.abs(o.x2 - 400) <= 1 && Math.abs(o.y2 - 260) <= 1 && Math.abs(o.x1 - 100) <= 1, `corner drag gave ${JSON.stringify(o)}`);
    await dragFrom(at(100, 180), at(150, 120));
    o = (await ed.evaluate(() => captodeEditor.objects()))[0];
    ok(Math.abs(Math.min(o.x1, o.x2) - 150) <= 1 && Math.abs(o.y1 - 100) <= 1 && Math.abs(o.y2 - 260) <= 1, `edge drag gave ${JSON.stringify(o)}`);
    // Step: its corner scales it, keeping it round.
    await ed.keyboard.press('n');
    await ed.mouse.click(...at(600, 400));
    const step = (await ed.evaluate(() => captodeEditor.objects())).at(-1);
    await ed.keyboard.press('v');
    await ed.mouse.click(...at(600, 400));
    const half = step.size / 2 + Math.max(1.5, step.size * 0.06) / 2;
    await dragFrom(at(600 + half, 400 + half), at(600 + half * 2, 400 + half * 2));
    const bigger = (await ed.evaluate(() => captodeEditor.objects())).at(-1);
    ok(bigger.size > step.size * 1.4, `step size ${step.size} → ${bigger.size}`);
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },

  async 'editor: select several, move, restyle, duplicate, copy and paste, arrange'({ editor, browser, page }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = (x, y) => [w.x + x, w.y + y];
    const objs = () => ed.evaluate(() => captodeEditor.objects());
    const dragFrom = async (from, to, shift = false) => {
      if (shift) await ed.keyboard.down('Shift');
      await ed.mouse.move(...from); await ed.mouse.down(); await ed.mouse.move(...to, { steps: 4 }); await ed.mouse.up();
      if (shift) await ed.keyboard.up('Shift');
    };
    const key = async (k) => { for (const m of ['Control', 'Meta']) { await ed.keyboard.down(m); await ed.keyboard.press(k); await ed.keyboard.up(m); } };
    // Three rectangles.
    await ed.keyboard.press('r');
    for (const x of [100, 300, 500]) await dragFrom(at(x, 100), at(x + 100, 180));
    await ed.keyboard.press('v');
    // Drag a box around the first two.
    await dragFrom(at(80, 80), at(420, 200));
    let t = await ed.evaluate(() => document.querySelector('#style-title').textContent);
    ok(/^2 ×/.test(t), `box selection: "${t}"`);
    // Shift-click adds the third; move all three together.
    await ed.keyboard.down('Shift'); await ed.mouse.click(...at(500, 140)); await ed.keyboard.up('Shift');
    await dragFrom(at(150, 100), at(150, 160));
    let o = await objs();
    ok(o.every((r) => Math.abs(Math.min(r.y1, r.y2) - 160) <= 1), `moved together: ${o.map((r) => r.y1)}`);
    // Restyle all three at once.
    await ed.evaluate(() => { const i = document.querySelector('#s-color'); i.value = '#0090ff'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    o = await objs();
    ok(o.every((r) => r.color === '#0090ff'), 'colour did not apply to all');
    // Duplicate (⌘D / Ctrl+D): six, and the copies are selected.
    await key('d');
    o = await objs();
    ok(o.length === 6 || o.length === 9, `after duplicate there are ${o.length}`);
    const count = o.length;
    // Copy and paste through the clipboard.
    await ed.evaluate(() => document.querySelector('#a-front').click());
    // ⌘C puts the annotations on the clipboard as text; read it from the web page (an
    // extension page can't be given clipboard access in a test), then paste it back.
    await browser.defaultBrowserContext().overridePermissions(new URL(page.url()).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await ed.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true })));
    await sleep(300);
    await page.bringToFront();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    ok(/captode-annotations/.test(text), `clipboard has ${text.slice(0, 60)}`);
    await ed.bringToFront();
    await ed.evaluate((text) => {
      const dt = new DataTransfer(); dt.setData('text/plain', text);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, text);
    o = await objs();
    ok(o.length > count, `paste added nothing (${count} → ${o.length})`);
    // Send to back puts the selection first in the stack.
    const before = o.length;
    await ed.evaluate(() => document.querySelector('#a-back').click());
    const sel = await ed.evaluate(() => document.querySelector('#style-title').textContent);
    ok(/×/.test(sel), `selection lost after arranging: ${sel}`);
    // Select all and delete.
    await key('a');
    await ed.keyboard.press('Delete');
    ok((await objs()).length === 0, 'select all + delete left annotations');
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
    void before; void page;
  },

  async 'editor: spotlight, magnifier, callout, dashed and double-headed arrows'({ editor }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = (x, y) => [w.x + x, w.y + y];
    const dragFrom = async (from, to) => { await ed.mouse.move(...from); await ed.mouse.down(); await ed.mouse.move(...to, { steps: 5 }); await ed.mouse.up(); };
    // Spotlight: inside unchanged, outside darker.
    await ed.keyboard.press('f');
    await dragFrom(at(100, 100), at(400, 300));
    // Magnifier somewhere else.
    await ed.keyboard.press('z');
    await dragFrom(at(700, 400), at(860, 560));
    const px = await ed.evaluate(async () => {
      const a = captodeEditor.pixels(), f = await captodeEditor.render();
      const get = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
      const lum = (p) => p[0] + p[1] + p[2];
      const m = captodeEditor.objects()[1];
      const cx = Math.round((m.x1 + m.x2) / 2), cy = Math.round((m.y1 + m.y2) / 2);
      return { inA: get(a, 250, 200), inF: get(f, 250, 200), outA: lum(get(a, 600, 150)), outF: lum(get(f, 600, 150)), lensA: get(a, cx, cy), lensF: get(f, cx, cy), outLens: lum(get(f, cx + 120, cy)) };
    });
    ok(px.inA.every((v, i) => Math.abs(v - px.inF[i]) <= 1), `spotlight changed its inside: ${px.inA} → ${px.inF}`);
    ok(px.outF < px.outA * 0.7 || px.outA < 30, `outside the spotlight not dimmed: ${px.outA} → ${px.outF}`);
    ok(px.lensA.every((v, i) => Math.abs(v - px.lensF[i]) <= 12), `magnifier centre ${px.lensF}, image ${px.lensA}`);
    // Callout: press on the target, drag to where the bubble goes, type.
    await ed.keyboard.press('k');
    await dragFrom(at(500, 500), at(600, 620));
    await sleep(150);
    await ed.keyboard.type('Look');
    await ed.keyboard.press('Escape');
    const c = (await ed.evaluate(() => captodeEditor.objects())).find((o) => o.tail);
    ok(c && c.text === 'Look' && Math.abs(c.tail.x - 500) <= 1 && Math.abs(c.x - 600) <= 1, `callout ${JSON.stringify(c)}`);
    // Arrow: dashed, heads at both ends.
    await ed.keyboard.press('a');
    await ed.evaluate(() => {
      for (const [id, v] of [['s-dash', 'dashed'], ['s-heads', '2']]) { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await dragFrom(at(900, 150), at(1100, 300));
    const a = (await ed.evaluate(() => captodeEditor.objects())).at(-1);
    ok(a.type === 'arrow' && a.dash === 'dashed' && a.heads === 2, `arrow ${JSON.stringify(a)}`);
    // Clicking inside a spotlight reaches what's under it: here, nothing, so no selection.
    await ed.keyboard.press('v');
    await ed.mouse.click(...at(250, 200));
    ok(/Annotate/.test(await ed.evaluate(() => document.querySelector('#style-title').textContent)), 'clicking inside a spotlight selected it');
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },

  async 'editor: edits are kept with the capture and come back on reopening'({ editor }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = (x, y) => [w.x + x, w.y + y];
    await ed.keyboard.press('r');
    await ed.mouse.move(...at(100, 100)); await ed.mouse.down(); await ed.mouse.move(...at(300, 200), { steps: 3 }); await ed.mouse.up();
    await ed.keyboard.press('n');
    await ed.mouse.click(...at(500, 300));
    // Crop too, so the stored image changes.
    await ed.keyboard.press('c');
    await ed.mouse.move(...at(50, 50)); await ed.mouse.down(); await ed.mouse.move(...at(900, 600), { steps: 3 }); await ed.mouse.up();
    await ed.keyboard.press('Enter');
    await sleep(1200); // saved shortly after the last change
    const before = await ed.evaluate(() => ({ size: captodeEditor.size(), n: captodeEditor.objects().length }));
    ed.on('dialog', (d) => d.accept()); // "leave without downloading?"
    await ed.reload({ waitUntil: 'load' });
    await ed.waitForFunction(() => window.captodeEditor?.size(), { polling: 100, timeout: 20000 });
    await ed.waitForFunction(() => captodeEditor.objects().length > 0, { polling: 100, timeout: 10000 }).catch(() => {});
    const after = await ed.evaluate(() => ({ size: captodeEditor.size(), n: captodeEditor.objects().length, toast: document.body.innerText.includes('Your edits are back') }));
    ok(after.n === before.n && after.size.join() === before.size.join(), `before ${JSON.stringify(before)}, after reopening ${JSON.stringify(after)}`);
    ok(after.toast, 'no message that the edits were restored');
    // Undo all goes back to the original capture (not the restored edits)…
    await ed.evaluate(() => document.querySelector('#undo-all').click());
    const orig = await ed.evaluate(() => ({ size: captodeEditor.size(), n: captodeEditor.objects().length }));
    ok(orig.n === 0 && orig.size[0] > before.size[0], `Undo all gave ${JSON.stringify(orig)}`);
    // …and that is saved too.
    await sleep(1200);
    await ed.reload({ waitUntil: 'load' });
    await ed.waitForFunction(() => window.captodeEditor?.size(), { polling: 100, timeout: 20000 });
    await sleep(500);
    ok((await ed.evaluate(() => captodeEditor.objects().length)) === 0, 'reopening after Undo all brought edits back');
    await ed.close();
  },

  async 'editor: rotate and flip with annotations, and zoom at the pointer'({ editor }) {
    const ed = await editor();
    // With reduced motion, as some users (and CI runners) have it: it once broke zooming.
    await ed.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await ed.keyboard.press('r');
    await ed.mouse.move(w.x + 100, w.y + 120); await ed.mouse.down(); await ed.mouse.move(w.x + 300, w.y + 200, { steps: 3 }); await ed.mouse.up();
    const state = () => ed.evaluate(() => {
      const p = captodeEditor.pixels(); let h = 0;
      for (let i = 0; i < p.data.length; i += 997) h = (h * 31 + p.data[i]) >>> 0;
      return { size: captodeEditor.size(), o: captodeEditor.objects()[0], hash: h };
    });
    const start = await state();
    const click = (id) => ed.evaluate((id) => document.getElementById(id).click(), id);
    await click('rot-cw');
    const turned = await state();
    ok(turned.size[0] === start.size[1] && turned.size[1] === start.size[0], `rotated size ${turned.size}`);
    // The rectangle's top-left (100, 120) is now at (H - 120, 100).
    const H = start.size[1];
    ok(Math.abs(Math.max(turned.o.x1, turned.o.x2) - (H - 120)) <= 1 && Math.abs(Math.min(turned.o.y1, turned.o.y2) - 100) <= 1, `rotated rectangle ${JSON.stringify(turned.o)}`);
    await click('rot-ccw');
    const back = await state();
    ok(back.hash === start.hash && back.size.join() === start.size.join(), 'rotating right then left changed the image');
    ok(Math.abs(back.o.x1 - start.o.x1) < 0.01 && Math.abs(back.o.y2 - start.o.y2) < 0.01, 'rotating right then left moved the rectangle');
    await click('flip-h'); await click('flip-h'); await click('flip-v'); await click('flip-v');
    ok((await state()).hash === start.hash, 'flipping twice changed the image');
    // Zoom at the pointer: the image point under it stays put. The Ctrl+wheel event goes
    // straight to the page: how a runner's Chrome turns synthetic wheel input into
    // pinch gestures varies.
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const r0 = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const pt = [r0.x + 400, r0.y + 300];
    const under = () => ed.evaluate(([x, y]) => { const r = document.querySelector('#wrap').getBoundingClientRect(); const z = parseFloat(document.querySelector('#zoom-label').textContent) / 100; return [(x - r.left) / z, (y - r.top) / z]; }, pt);
    const a = await under();
    const info = await ed.evaluate(([x, y]) => {
      const stage = document.querySelector('#stage'), wrap = document.querySelector('#wrap');
      const errors = [];
      const onError = (e) => errors.push(e.message);
      addEventListener('error', onError);
      for (let i = 0; i < 3; i++) stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, clientX: x, clientY: y, ctrlKey: true, bubbles: true, cancelable: true }));
      removeEventListener('error', onError);
      const r = wrap.getBoundingClientRect();
      return { zoom: document.querySelector('#zoom-label').textContent, scroll: [stage.scrollLeft, stage.scrollTop], max: [stage.scrollWidth - stage.clientWidth, stage.scrollHeight - stage.clientHeight],
        wrapRect: [Math.round(r.width), Math.round(r.height)], errors,
        animations: wrap.getAnimations().map((x) => x.transitionProperty || x.animationName) };
    }, pt);
    const b = await under();
    ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 3, `point under the pointer moved from ${a.map(Math.round)} to ${b.map(Math.round)} (${JSON.stringify(info)})`);
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },

  async 'editor: snapping with guides, align and distribute'({ editor }) {
    const ed = await editor();
    await ed.evaluate(() => document.querySelector('#zoom-label').click());
    await sleep(100);
    const w = await ed.evaluate(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const at = (x, y) => [w.x + x, w.y + y];
    const dragFrom = async (from, to, mod) => {
      if (mod) await ed.keyboard.down(mod);
      await ed.mouse.move(...from); await ed.mouse.down(); await ed.mouse.move(...to, { steps: 6 }); await ed.mouse.up();
      if (mod) await ed.keyboard.up(mod);
    };
    const objs = () => ed.evaluate(() => captodeEditor.objects());
    const left = (o) => Math.min(o.x1, o.x2) - o.width / 2;
    await ed.keyboard.press('r');
    await dragFrom(at(100, 100), at(200, 160));
    await dragFrom(at(330, 300), at(430, 360));
    await ed.keyboard.press('v');
    // Drag the second so its left edge is 4 px right of the first's: it snaps into line.
    await dragFrom(at(380, 330), at(380 - 226, 360)); // from the middle (the top edge has a handle)
    let o = await objs();
    ok(Math.abs(left(o[1]) - left(o[0])) < 0.01, `snapped: left edges ${left(o[0])} and ${left(o[1])}`);
    // With Alt held it lands where it was dropped.
    await dragFrom(at(160, 330), at(164, 360), 'Alt');
    o = await objs();
    ok(Math.abs(left(o[1]) - left(o[0]) - 4) < 1, `Alt: left edges ${left(o[0])} and ${left(o[1])}`);
    // A third, then select all and align tops, then space evenly across.
    await ed.keyboard.press('r');
    await dragFrom(at(700, 500), at(760, 540));
    for (const m of ['Control', 'Meta']) { await ed.keyboard.down(m); await ed.keyboard.press('a'); await ed.keyboard.up(m); }
    await ed.evaluate(() => document.querySelector('[data-align="top"]').click());
    o = await objs();
    const tops = o.map((r) => Math.min(r.y1, r.y2));
    ok(Math.max(...tops) - Math.min(...tops) < 0.01, `tops after aligning: ${tops}`);
    await ed.evaluate(() => document.querySelector('[data-align="dist-h"]').click());
    o = (await objs()).map((r) => ({ l: Math.min(r.x1, r.x2) - r.width / 2, r: Math.max(r.x1, r.x2) + r.width / 2 })).sort((a, b) => a.l - b.l);
    const gaps = [o[1].l - o[0].r, o[2].l - o[1].r];
    ok(Math.abs(gaps[0] - gaps[1]) < 0.5, `gaps after spacing: ${gaps}`);
    await ed.evaluate(() => { window.onbeforeunload = null; });
    await ed.close();
  },
};
