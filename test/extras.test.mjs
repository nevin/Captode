// Your logo, Copy text, searching captures, copying a guide, and translating where
// the browser can.
import { open, ok, sleep } from './helpers.mjs';

/** A plain white screenshot, saved as a capture with `meta`. */
const shot = (page, meta) => page.evaluate(async (meta) => {
  const c = new OffscreenCanvas(600, 400);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 400);
  const { putCapture } = await import('/lib/db.js');
  return putCapture(await c.convertToBlob(), meta);
}, meta);

const openEditor = async (browser, url, id) => {
  const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1300, height: 860 });
  await ed.waitForFunction(() => globalThis.captodeEditor?.size(), { polling: 100, timeout: 15000 });
  return ed;
};

export const tests = {
  async 'logo: chosen once, added to the corner of screenshots, off for one in Export'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    await lab.evaluate(async () => {
      const c = new OffscreenCanvas(40, 40);
      const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 40, 40);
      const image = await new Promise(async (r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(await c.convertToBlob()); });
      await chrome.storage.local.set({ brand: { image, position: 'br', size: 2, opacity: 1, images: true, videos: false } });
    });
    const id = await shot(lab, { title: 'Logo test' });
    const ed = await openEditor(browser, url, id);
    const at = (x, y) => ed.evaluate(async (x, y) => { const d = await captodeEditor.render(); const i = (y * d.width + x) * 4; return [...d.data.slice(i, i + 3)]; }, x, y);
    // 15% of the shorter side (60 px), 3% (12 px) in from the bottom right.
    const corner = await at(600 - 12 - 20, 400 - 12 - 20);
    const middle = await at(300, 200);
    ok(corner[0] > 200 && corner[1] < 60 && middle[1] > 240, `logo in the corner: ${corner}, middle ${middle}`);
    ok(await ed.evaluate(() => !document.getElementById('x-logo-row').classList.contains('hidden') && document.getElementById('x-logo').checked), 'Add my logo shown and on');
    await ed.evaluate(() => { const x = document.getElementById('x-logo'); x.checked = false; x.dispatchEvent(new Event('change', { bubbles: true })); });
    const off = await at(600 - 12 - 20, 400 - 12 - 20);
    ok(off[1] > 240, `turned off: ${off}`);
    await ed.close();
    // Settings: the logo shows, and Remove takes it away.
    const st = await open(browser, url('settings/settings.html'));
    await st.waitForFunction(() => !document.getElementById('brand-options').classList.contains('hidden'), { polling: 100, timeout: 5000 });
    await st.evaluate(() => document.getElementById('brand-remove').click());
    await st.waitForFunction(() => document.getElementById('brand-options').classList.contains('hidden'), { polling: 100, timeout: 5000 });
    const left = await st.evaluate(async () => (await chrome.storage.local.get('brand')).brand);
    ok(!left.image && !left.images, `removed: ${JSON.stringify(left)}`);
    await st.close();
    // Without a logo, the editor doesn't offer one.
    const ed2 = await openEditor(browser, url, id);
    ok(await ed2.evaluate(() => document.getElementById('x-logo-row').classList.contains('hidden')), 'no logo, no switch');
    await ed2.close();
    await lab.close();
  },

  async 'copy text: the words a screenshot kept are copied line by line, and follow a crop'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const text = [[20, 20, 60, 16, 'Hello'], [86, 20, 70, 16, 'world,'], [156, 20, 40, 16, 'again'], [20, 60, 90, 16, 'Second'], [116, 60, 50, 16, 'line'], [400, 300, 80, 16, 'Far']];
    const id = await shot(lab, { title: 'Words', text });
    const plain = await shot(lab, { title: 'No words' });
    await lab.close();
    const ed = await openEditor(browser, url, id);
    ok(await ed.evaluate(() => !document.querySelector('[data-tool="copytext"]').hidden), 'Copy text offered');
    const got = await ed.evaluate(() => captodeEditor.words(0, 0, 300, 100));
    ok(got === 'Hello world,again\nSecond line', `two lines: ${JSON.stringify(got)}`);
    ok(await ed.evaluate(() => captodeEditor.words(410, 305, 410, 305)) === 'Far', 'a click copies the run under it');
    // A crop: the words move with the picture, and those cut off go.
    await ed.evaluate(() => document.querySelector('[data-tool="crop"]').click());
    const box = await ed.evaluate(() => { const r = document.getElementById('fg').getBoundingClientRect(); const [w] = captodeEditor.size(); return { x: r.left, y: r.top, k: r.width / w }; });
    // The fg canvas covers the visible part; drag from (100, 50) to (590, 390) in image pixels.
    await ed.mouse.move(box.x + 100 * box.k, box.y + 50 * box.k);
    await ed.mouse.down();
    await ed.mouse.move(box.x + 590 * box.k, box.y + 390 * box.k, { steps: 4 });
    await ed.mouse.up();
    await ed.keyboard.press('Enter');
    await ed.waitForFunction(() => captodeEditor.size()[0] < 600, { polling: 100, timeout: 5000 });
    const after = await ed.evaluate(() => captodeEditor.words(0, 0, 1000, 1000));
    ok(after === 'line\nFar', `after the crop: ${JSON.stringify(after)} (${await ed.evaluate(() => captodeEditor.size())})`);
    await ed.close();
    const ed2 = await openEditor(browser, url, plain);
    ok(await ed2.evaluate(() => document.querySelector('[data-tool="copytext"]').hidden), 'not offered without words');
    await ed2.close();
  },

  async 'captures: search by title or website, and show only one kind'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    for (const [i, title] of ['Invoice March', 'Invoice April', 'Dashboard', 'Login page', 'Pricing', 'Docs home', 'Blog'].entries()) {
      await shot(lab, { title, url: i === 2 ? 'https://grafana.example.com/d/1' : 'https://example.org/' });
    }
    await lab.close();
    const st = await open(browser, url('settings/settings.html'));
    await st.waitForFunction(() => document.querySelectorAll('#storage-list li').length >= 7, { polling: 100, timeout: 8000 });
    ok(await st.evaluate(() => !document.getElementById('storage-filter').classList.contains('hidden')), 'search offered');
    const shown = () => st.evaluate(() => [...document.querySelectorAll('#storage-list li b')].map((b) => b.textContent));
    await st.type('#storage-search', 'invoice');
    await st.waitForFunction(() => document.querySelectorAll('#storage-list li').length === 2, { polling: 100, timeout: 3000 }).catch(() => {});
    const inv = await shown();
    ok(inv.length === 2 && inv.every((t) => /Invoice/.test(t)), `invoice: ${inv}`);
    await st.evaluate(() => { const s = document.getElementById('storage-search'); s.value = 'grafana'; s.dispatchEvent(new Event('input')); });
    await st.waitForFunction(() => document.querySelectorAll('#storage-list li').length === 1, { polling: 100, timeout: 3000 }).catch(() => {});
    ok((await shown()).join() === 'Dashboard', `by website: ${await shown()}`);
    await st.evaluate(() => { const s = document.getElementById('storage-search'); s.value = 'nothing like this'; s.dispatchEvent(new Event('input')); });
    await st.waitForFunction(() => !document.getElementById('storage-none').classList.contains('hidden'), { polling: 100, timeout: 3000 });
    await st.evaluate(() => { const s = document.getElementById('storage-search'); s.value = ''; s.dispatchEvent(new Event('input')); const k = document.getElementById('storage-kind'); k.value = 'video'; k.dispatchEvent(new Event('change')); });
    await st.waitForFunction(() => !document.querySelector('#storage-list li') || [...document.querySelectorAll('#storage-list small')].every((s) => !/Screenshot/.test(s.textContent)), { polling: 100, timeout: 3000 });
    await st.close();
  },

  async 'guide: copied with pictures for documents, alt text from the notes, translate only where the browser can'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const g = await import('/lib/guide.js');
      const { canTranslate } = await import('/lib/translate.js');
      const long = 'Click Save'.padEnd(200, '!');
      const clip = g.guideClipboard({ title: 'My <guide>', steps: [{ text: 'Open the menu\nthen pick one', image: 'data:image/png;base64,AA', width: 1600, height: 900 }] });
      return {
        alt: [g.stepAlt('  \nOpen Settings\nmore', 1), g.stepAlt('', 2), g.stepAlt(long, 3).length],
        clip,
        page: g.buildGuidePage({ title: 'T', steps: [{ text: 'Press Go', image: 'data:,', width: 1, height: 1 }] }),
        canTranslate,
        has: typeof globalThis.Translator?.create === 'function',
      };
    });
    ok(r.alt[0] === 'Open Settings' && /2/.test(r.alt[1]) && r.alt[2] <= 125, `alt ${JSON.stringify(r.alt)}`);
    ok(/<h1>My &lt;guide&gt;<\/h1>/.test(r.clip.html) && /width="720" height="405"/.test(r.clip.html) && /alt="Open the menu"/.test(r.clip.html), `html ${r.clip.html.slice(0, 300)}`);
    ok(r.clip.text === 'My <guide>\n\n1. Open the menu\n   then pick one\n', `text ${JSON.stringify(r.clip.text)}`);
    ok(/alt="Press Go"/.test(r.page), 'the page uses the note as alt text');
    ok(r.canTranslate === r.has, 'translate follows the browser');
    // The guide page offers the menu, or says it can't: never neither.
    const page = await open(browser, url('guide/guide.html'));
    await page.waitForFunction(() => document.readyState === 'complete', { polling: 100 });
    await sleep(300);
    const shown = await page.evaluate(() => ['#translate', '#translate-note'].filter((s) => !document.querySelector(s).classList.contains('hidden')));
    ok(shown.length === 1 && shown[0] === (r.has ? '#translate' : '#translate-note'), `guide page: ${JSON.stringify(shown)}`);
    await page.close();
    await lab.close();
    return r.has ? 'this browser can translate' : 'no translator in this browser: not offered';
  },
};
