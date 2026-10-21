// Discarding a capture: it asks first, deletes the capture (and its edits or slides)
// from storage, and leaves for a fresh page so nothing of it stays in memory.
import { open, recordClip, ok, sleep } from './helpers.mjs';

export async function setup({ browser, url }) {
  const lab = await open(browser, url('lab/lab.html'));
  await lab.waitForFunction(() => globalThis.lab, { polling: 100 });
  return { lab };
}

const stored = (page, id) => page.evaluate(async (id) => {
  const { getCapture } = await import('/lib/db.js');
  return !!(await getCapture(id));
}, id);

/** Clicks a button in the confirmation dialog (0: Cancel, 1: Discard). */
const answer = async (page, which) => {
  await page.waitForFunction(() => document.querySelector('dialog.confirm[open]'), { polling: 50 });
  await page.evaluate((which) => document.querySelectorAll('dialog.confirm button')[which].click(), which);
};

export const tests = {
  async 'a screenshot can be discarded, after asking: it is deleted with its edits'({ browser, url, lab }) {
    const id = await lab.evaluate(async () => {
      const { putCapture, saveEdits } = await import('/lib/db.js');
      const c = new OffscreenCanvas(400, 300);
      c.getContext('2d').fillRect(0, 0, 100, 100);
      const id = await putCapture(await c.convertToBlob(), { title: 'Discard me', mode: 'visible' });
      await saveEdits(id, { objects: [], frame: { padding: 8 }, base: null, saved: Date.now() });
      return id;
    });
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1280, height: 900 });
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
    ok(await ed.evaluate(() => !document.querySelector('#discard').classList.contains('hidden')), 'no Discard button');
    let asked = null;
    ed.on('dialog', (d) => { asked = d.type(); d.dismiss(); });

    // Cancel keeps it.
    await ed.click('#discard');
    await answer(ed, 0);
    await sleep(200);
    ok(await stored(ed, id), 'Cancel deleted it');
    ok(await ed.evaluate(() => !document.querySelector('dialog.confirm')), 'the dialog stayed');

    await ed.click('#discard');
    await Promise.all([ed.waitForNavigation(), answer(ed, 1)]);
    await ed.waitForFunction(() => document.querySelector('.toast:not(.hidden)'), { polling: 50 });
    const after = await ed.evaluate(() => ({
      url: location.href, empty: document.body.classList.contains('no-image'),
      toast: document.querySelector('.toast').textContent, button: !document.querySelector('#discard').classList.contains('hidden'),
    }));
    ok(!(await stored(ed, id)), 'still stored');
    ok(after.url.endsWith('/editor/editor.html') && after.empty && !after.button, JSON.stringify(after));
    ok(after.toast.includes('Screenshot discarded'), `toast: ${after.toast}`);
    ok(!asked, `asked before leaving: ${asked}`);
    await ed.close();
  },

  async 'a recording can be discarded, even while it exports, without a leave warning'({ browser, url, lab }) {
    const id = await recordClip(lab, { seconds: 4 });
    const page = await open(browser, url(`video/video.html?id=${id}`), { width: 1440, height: 900 });
    await page.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
    let asked = null;
    page.on('dialog', (d) => { asked = d.type(); d.dismiss(); });
    await page.click('#formats [data-f="gif"]');
    await page.click('#convert');
    await page.click('#discard');
    await Promise.all([page.waitForNavigation(), answer(page, 1)]);
    await page.waitForFunction(() => document.querySelector('.toast:not(.hidden)'), { polling: 50 });
    const after = await page.evaluate(() => ({ url: location.href, toast: document.querySelector('.toast').textContent }));
    ok(!(await stored(page, id)), 'still stored');
    ok(after.url.endsWith('/editor/editor.html') && after.toast.includes('Recording discarded'), JSON.stringify(after));
    ok(!asked, `asked before leaving: ${asked}`);
    await page.close();
  },
};
