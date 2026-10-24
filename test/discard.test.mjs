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
  async 'saving edits leaves the recording as it is, and captures saved before still open'({ lab }) {
    const r = await lab.evaluate(async () => {
      const db = await import('/lib/db.js');
      const blob = new Blob([new Uint8Array(100e6)], { type: 'video/webm' });
      const id = await db.putCapture(blob, { title: 'Big' });
      const before = (await navigator.storage.estimate()).usage;
      for (let i = 0; i < 5; i++) await db.saveVideoEdits(id, { cuts: [{ from: i, to: i + 1 }] });
      await db.updateMeta(id, { clicks: [{ t: 1, x: 0.5, y: 0.5 }] });
      const grew = ((await navigator.storage.estimate()).usage - before) / 1e6;
      const got = await db.getCapture(id);
      // A capture saved by an earlier version, with its edits in the record itself.
      const old = db.newId();
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('captode');
        req.onsuccess = () => {
          const t = req.result.transaction('captures', 'readwrite');
          t.objectStore('captures').put({ blob: new Blob(['x'], { type: 'image/png' }), meta: { title: 'Old' }, created: Date.now(), edits: { objects: [{ type: 'rect' }] } }, old);
          t.oncomplete = () => { req.result.close(); resolve(); };
          t.onerror = () => reject(t.error);
        };
      });
      const oldBefore = await db.getCapture(old);
      const listed = (await db.listCaptures(50)).find((c) => c.id === old);
      await db.saveEdits(old, null);
      const oldAfter = await db.getCapture(old);
      const listedAfter = (await db.listCaptures(50)).find((c) => c.id === old);
      // Deleting takes the extras too; Undo puts everything back.
      const rec = await db.deleteCapture(id);
      const gone = await db.getCapture(id);
      await db.saveVideoEdits(id, { cuts: [] }); // nothing to keep them with
      await db.restoreCapture(id, rec);
      const back = await db.getCapture(id);
      await db.deleteCapture(id);
      await db.deleteCapture(old);
      return {
        grew, cuts: got.videoEdits.cuts.length, from: got.videoEdits.cuts[0].from, title: got.meta.title, clicks: got.meta.clicks?.length,
        oldEdits: oldBefore.edits.objects.length, oldListed: listed?.edited, oldCleared: oldAfter.edits, oldListedAfter: listedAfter?.edited,
        gone, backCuts: back?.videoEdits.cuts[0].from, backSize: back?.blob.size, backClicks: back?.meta.clicks?.length,
      };
    });
    ok(r.grew < 50, `saving edits wrote ${Math.round(r.grew)} MB (the recording again?)`);
    ok(r.cuts === 1 && r.from === 4 && r.title === 'Big' && r.clicks === 1, `edits or details not kept: ${JSON.stringify(r)}`);
    ok(r.oldEdits === 1 && r.oldListed === true, `an older capture's edits are lost: ${JSON.stringify(r)}`);
    ok(r.oldCleared === null && r.oldListedAfter === false, `an older capture's edits can't be dropped: ${JSON.stringify(r)}`);
    ok(r.gone === null && r.backCuts === 4 && r.backSize === 100e6 && r.backClicks === 1, `delete and undo: ${JSON.stringify(r)}`);
    return `${Math.round(r.grew)} MB written for 5 saves of a 100 MB recording`;
  },

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
