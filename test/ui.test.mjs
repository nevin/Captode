// The interface: popup states, editor flows, settings and themes.
import { open, waitForTab, ok, sleep } from './helpers.mjs';

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

  async 'empty editor lists recent captures'({ browser, url }) {
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
};
