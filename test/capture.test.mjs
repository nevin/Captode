// Screenshots of a page: full page, visible area and a dragged selection, opened in
// the editor, then exported in every format.
import { open, waitForTab, ok, near, sleep } from './helpers.mjs';

export async function setup({ browser, url, site }) {
  const page = await open(browser, `${site}/index.html`);
  await page.evaluate(() => window.scrollTo(0, 700));
  const ctl = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
  const tabId = await ctl.evaluate(async (site) => (await chrome.tabs.query({ url: `${site}/*` }))[0].id, site);
  await page.bringToFront();

  // Starts a capture of the test page and returns the editor it opens.
  const capture = async (mode, during) => {
    await ctl.evaluate((tabId, mode) => chrome.runtime.sendMessage({ type: 'capture-image', mode, tabId }), tabId, mode);
    if (during) await during();
    const ed = await waitForTab(browser, (u) => u.includes('editor.html?id='));
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
    const { ed, size } = await capture('full');
    ok(size[0] === 1280, `width ${size[0]}`);
    near(size[1], 3000, 2, 'height of the whole page');
    near(await page.evaluate(() => window.scrollY), 700, 1, 'scroll position afterwards');
    await ed.close();
    await page.bringToFront();
  },

  async 'visible area matches the viewport'({ page, capture }) {
    const { ed, size } = await capture('visible');
    ok(size[0] === 1280 && size[1] > 700, `size ${size}`);
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
};
