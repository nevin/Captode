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
};
