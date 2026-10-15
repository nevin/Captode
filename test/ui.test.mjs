// The interface: popup states, editor flows, settings and themes.
import { open, waitForTab, ok, sleep, near } from './helpers.mjs';

const theme = (page) => page.evaluate(() => [document.documentElement.dataset.theme || 'system', getComputedStyle(document.body).backgroundColor]);

export async function setup({ browser, url, site }) {
  const page = await open(browser, `${site}/rich.html`);
  const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
  const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/*` }))[0].id, site);
  const editor = async () => {
    await page.bringToFront();
    await ctl.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'capture-image', mode: 'visible', tabId }), tabId);
    const ed = await waitForTab(browser, (u) => u.includes('editor.html?id='));
    await ed.setViewport({ width: 1440, height: 900 });
    await ed.bringToFront();
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent));
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
    const b = await ed.evaluate(() => { const r = document.querySelector('#fg').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
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
    await ed.waitForFunction(() => !document.querySelector('#export-preview').classList.contains('hidden') && document.querySelector('#device-preview').width > 300, { timeout: 20000 });
    await ed.click('#device-panel input[data-k="enabled"]');
    await ed.evaluate(() => { const s = document.querySelector('#x-format'); s.value = 'jpeg'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await ed.evaluate(() => { const s = document.querySelector('#x-limit'); s.value = '100'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(600);
    await ed.waitForFunction(() => !/Working/.test(document.querySelector('#x-estimate').textContent), { timeout: 30000 });
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
    const b = await ed.evaluate(() => { const c = document.querySelector('#fg'); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, k: c.width / r.width }; });
    const at = (fx, fy) => [b.x + b.w * fx, b.y + b.h * fy];
    const panel = () => ed.evaluate(() => ({ label: document.querySelector('#st-n-label').textContent, n: document.querySelector('#st-n').value, size: Number(document.querySelector('#st-size').value) }));
    await ed.keyboard.press('n');
    ok((await panel()).n === '1', 'first step is not 1');
    for (const fx of [0.2, 0.4, 0.6]) { await ed.mouse.click(...at(fx, 0.5)); await sleep(50); }
    let p = await panel();
    ok(p.label === 'Number' && p.n === '3', `after three clicks the selected step shows ${p.label} ${p.n}`);
    // The circle is drawn in the chosen colour (#e5484d), away from its digit.
    const px = await ed.evaluate(([x, y, k, size]) => {
      const c = document.querySelector('#fg'); const r = c.getBoundingClientRect();
      return [...c.getContext('2d').getImageData(Math.round((x - r.x) * k - size * 0.32), Math.round((y - r.y) * k), 1, 1).data];
    }, [...at(0.2, 0.5), b.k, p.size]);
    ok(Math.abs(px[0] - 0xe5) < 12 && Math.abs(px[1] - 0x48) < 12 && Math.abs(px[2] - 0x4d) < 12, `step colour ${px}`);
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
    const size = await ed.evaluate(() => [document.querySelector('#bg').width, document.querySelector('#bg').height]);
    await clear();
    await ed.bringToFront();
    await ed.click('#tab-export');
    await ed.click('#copy2');
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
    await ed2.waitForFunction(() => /copied to the clipboard/i.test(document.body.innerText), { timeout: 10000 }).catch(() => {});
    got = await clip();
    ok(got && got[0] > 0, 'new screenshot was not copied automatically');
    ok(ed2.url().includes('reopen=1'), 'a reload would copy it again');
    await ed2.evaluate(async () => { const { saveSettings } = await import('/lib/settings.js'); await saveSettings({ autoCopy: false }); });
    await ed2.close();
  },

  async 'editor: undo all, and bring the changes back'({ editor }) {
    const ed = await editor();
    const b = await ed.evaluate(() => { const r = document.querySelector('#fg').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const drawn = () => ed.evaluate(() => { const c = document.querySelector('#fg'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
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
    await ed.click('#undo-all');
    await sleep(100);
    ok(await drawn() === 0, 'Undo all left annotations behind');
    ok(await disabled('undo-all') && !(await disabled('undo')), 'after Undo all: it should be disabled, and Undo available');
    // The toast's Undo brings everything back.
    await ed.click('.toast-action');
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
};
