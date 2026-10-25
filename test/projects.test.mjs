// Keeping captures past a day, project files, exports queued in the background,
// sharing files with other apps, and the drawing the editor and video page share.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, ok, sleep, waitForTab, recordClip } from './helpers.mjs';

export async function setup({ browser, url }) {
  const lab = await open(browser, url('lab/lab.html'));
  const clip = await recordClip(lab, { seconds: 2, width: 640, height: 360 });
  await lab.close();
  return { clip };
}

/** Pretends the system's share sheet takes files; what is shared lands in window.__shared. */
const fakeShare = (page) => page.evaluateOnNewDocument(() => {
  window.__shared = [];
  navigator.canShare = (d) => !!d?.files?.length;
  navigator.share = async (d) => { for (const f of d.files) window.__shared.push({ name: f.name, type: f.type, size: f.size }); };
});

export const tests = {
  async 'kept captures stay past a day, the rest go'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const db = await import('/lib/db.js');
      const img = () => { const c = new OffscreenCanvas(8, 8); c.getContext('2d').fillRect(0, 0, 4, 4); return c.convertToBlob(); };
      const a = await db.putCapture(await img(), { title: 'keep me' });
      const b = await db.putCapture(await img(), { title: 'let me go' });
      await db.setKept(a, true);
      // Both two days old, as if made the day before yesterday.
      await new Promise((resolve) => {
        const req = indexedDB.open('captode');
        req.onsuccess = () => {
          const t = req.result.transaction('captures', 'readwrite');
          const s = t.objectStore('captures');
          for (const id of [a, b]) { const g = s.get(id); g.onsuccess = () => s.put({ ...g.result, created: Date.now() - 2 * 86400000 }, id); }
          t.oncomplete = () => { req.result.close(); resolve(); };
        };
      });
      await db.putCapture(await img(), { title: 'new' }); // tidies up
      const listed = await db.listCaptures(500);
      return { a: !!(await db.getCapture(a)), b: !!(await db.getCapture(b)), kept: listed.find((x) => x.id === a)?.kept };
    });
    ok(r.a && r.kept === true, `kept one: ${JSON.stringify(r)}`);
    ok(!r.b, 'the one not kept was removed after a day');
    await lab.close();
  },

  async 'a project file holds a capture with its edits, slides, guide and captions, and opens again'({ browser, url, clip }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async (clip) => {
      const db = await import('/lib/db.js');
      const { saveProject, openProject } = await import('/lib/project.js');
      const { unzip } = await import('/lib/zip.js');
      const pc = new OffscreenCanvas(30, 20); pc.getContext('2d').fillRect(0, 0, 9, 9);
      const picture = await pc.convertToBlob();
      await db.saveVideoEdits(clip, { cuts: [{ id: 'c1', from: 0.5, to: 1 }], captions: [{ id: 'k1', from: 0, to: 1, text: 'Héllo “world”' }] });
      await db.saveSlides(clip, [{ id: 's1', at: 1, duration: 2, title: 'Intro', image: picture }]);
      await db.saveGuide(clip, { title: 'How to', steps: [{ t: 0.5, x: 0.2, y: 0.3, text: 'Click “Save”.' }] });
      const before = await db.getCapture(clip);
      const file = await saveProject(clip);
      const names = [...(await unzip(file)).keys()];
      const opened = await openProject(new File([file], 'test.captode'));
      const after = await db.getCapture(opened.id);
      // Not projects: a zip of something else, and one from a newer Captode.
      const { zip } = await import('/lib/zip.js');
      const enc = new TextEncoder();
      const err = async (blob) => { try { await openProject(blob); return 'opened'; } catch (e) { return e.message; } };
      const notOne = await err(new Blob(['hello']));
      const other = await err(zip([{ name: 'readme.txt', data: enc.encode('hi') }]));
      const newer = await err(zip([{ name: 'project.json', data: enc.encode(JSON.stringify({ format: 'captode-project', version: 99, capture: {} })) }]));
      return {
        names, kind: opened.kind, size: [before.blob.size, after.blob.size], type: after.blob.type, kept: after.kept,
        same: await before.blob.arrayBuffer().then(async (x) => { const y = await after.blob.arrayBuffer(); return x.byteLength === y.byteLength && new Uint8Array(x).every((v, i) => v === new Uint8Array(y)[i]); }),
        caption: after.videoEdits?.captions?.[0]?.text, cuts: after.videoEdits?.cuts?.length,
        slide: [after.slides?.[0]?.title, after.slides?.[0]?.image instanceof Blob && after.slides[0].image.size === picture.size],
        guide: after.guide?.steps?.[0]?.text, title: after.meta?.title, errors: [notOne, other, newer],
      };
    }, clip);
    ok(r.names.includes('project.json') && r.names.includes('files/0') && r.names.includes('files/1'), `files ${r.names}`);
    ok(r.kind === 'video' && r.same && r.type.startsWith('video/'), `recording back as it was: ${JSON.stringify(r.size)} ${r.type}`);
    ok(r.kept === true, 'an opened project is kept');
    ok(r.caption === 'Héllo “world”' && r.cuts === 1, `edits ${r.caption} ${r.cuts}`);
    ok(r.slide[0] === 'Intro' && r.slide[1], `slide ${r.slide}`);
    ok(r.guide === 'Click “Save”.', `guide ${r.guide}`);
    ok(r.errors.join() === 'not-project,not-project,too-new', `errors ${r.errors}`);
    await lab.close();
  },

  async 'Settings lists captures to keep, save or delete, and opens a project file'({ browser, url, clip }) {
    // A project file on disk, as if downloaded.
    const lab = await open(browser, url('lab/lab.html'));
    const bytes = await lab.evaluate(async (clip) => {
      const { saveProject } = await import('/lib/project.js');
      return [...new Uint8Array(await (await saveProject(clip)).arrayBuffer())];
    }, clip);
    await lab.close();
    const dir = mkdtempSync(join(tmpdir(), 'captode-project-'));
    const path = join(dir, 'clip.captode');
    writeFileSync(path, Buffer.from(bytes));

    const st = await open(browser, url('settings/settings.html'));
    await st.waitForFunction((clip) => [...document.querySelectorAll('#storage-list li')].length > 0 && /\d/.test(document.getElementById('storage-usage').textContent), { polling: 100, timeout: 5000 }, clip);
    const rows = await st.$$eval('#storage-list li', (l) => l.length);
    await st.click('#storage-list li .keep');
    await st.waitForFunction(() => document.querySelector('#storage-list li .keep').getAttribute('aria-pressed') === 'true', { polling: 100, timeout: 3000 });
    const input = await st.$('#open-project');
    await input.uploadFile(path);
    const opened = await waitForTab(browser, (u) => u.includes('video/video.html?id='), 10000);
    await opened.waitForFunction(() => document.querySelector('#player').videoWidth > 0, { polling: 100, timeout: 15000 });
    const keep = await opened.evaluate(() => document.getElementById('keep').getAttribute('aria-pressed'));
    ok(keep === 'true', `the opened project is kept: ${keep}`);
    await opened.close();
    await st.waitForFunction((n) => document.querySelectorAll('#storage-list li').length === n + 1, { polling: 100, timeout: 5000 }, rows);
    await st.close();
    return `${rows} captures listed`;
  },

  async 'an export added to the queue finishes after its page is closed, and the popup offers it'({ browser, url, clip }) {
    const video = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
    await video.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent) && !document.getElementById('queue-export').classList.contains('hidden'), { polling: 100, timeout: 15000 });
    await video.$eval('#formats', (e) => e.scrollIntoView({ block: 'center' }));
    await video.click('#formats [data-f="mp4"]');
    await video.click('#queue-export');
    await video.waitForFunction(() => document.querySelectorAll('#queue-list .job').length === 1, { polling: 100, timeout: 5000 });
    await video.close();
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    let job = null;
    for (let i = 0; i < 480 && !job; i++) {
      job = await pop.evaluate(async () => {
        const { listJobs } = await import('/lib/db.js');
        const j = (await listJobs()).at(-1);
        return j && ['done', 'failed'].includes(j.status) ? { status: j.status, error: j.error, type: j.result?.type, size: j.result?.size, name: j.name } : null;
      });
      if (!job) await sleep(250);
    }
    ok(job.status === 'done' && job.type === 'video/mp4' && job.size > 1000 && job.name.endsWith('.mp4'), `job ${JSON.stringify(job)}`);
    const badge = await pop.evaluate(() => chrome.action.getBadgeText({}));
    await pop.reload();
    await pop.waitForFunction(() => document.querySelector('#exports-list .job.done'), { polling: 100, timeout: 5000 });
    const actions = await pop.$$eval('#exports-list .job.done .job-actions .btn', (b) => b.length);
    ok(actions >= 2, `download and remove: ${actions}`);
    // Once the queue is empty, the offscreen document isn't kept open for it.
    await sleep(500);
    const open_ = await pop.evaluate(async () => (await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))?.length ?? 0);
    ok(open_ === 0, `offscreen documents left open: ${open_}`);
    await pop.click('#exports-list .job.done .job-actions .btn:last-child'); // remove
    await pop.waitForFunction(() => document.getElementById('exports').classList.contains('hidden'), { polling: 100, timeout: 3000 });
    await pop.close();
    return `${(job.size / 1024).toFixed(0)} KB; badge ${badge}`;
  },

  async 'Share hands the exported file to the system share sheet, and is hidden where it cannot'({ browser, url, clip }) {
    // Where the browser can't share files (as here, headless), no Share button.
    const plain = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
    await plain.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
    const can = await plain.evaluate(() => !!navigator.canShare?.({ files: [new File(['x'], 'x.png', { type: 'image/png' })] }));
    await plain.close();
    const ed = await browser.newPage();
    await fakeShare(ed);
    await ed.setViewport({ width: 1280, height: 900 });
    const lab = await open(browser, url('lab/lab.html'));
    const shot = await lab.evaluate(async () => {
      const c = new OffscreenCanvas(200, 120); const g = c.getContext('2d'); g.fillStyle = '#0090ff'; g.fillRect(0, 0, 200, 120);
      return (await import('/lib/db.js')).putCapture(await c.convertToBlob(), { title: 'Shared shot' });
    });
    await lab.close();
    await ed.goto(url(`editor/editor.html?id=${shot}&reopen=1`));
    await ed.waitForFunction(() => !document.getElementById('share-file').classList.contains('hidden'), { polling: 100, timeout: 30000 });
    await ed.waitForFunction(() => /\d/.test(document.getElementById('doc-dims').textContent), { polling: 100, timeout: 30000 }); // the image is in
    await ed.evaluate(() => document.getElementById('share-file').click()); // it sits in the Export panel
    await ed.waitForFunction(() => window.__shared.length === 1, { polling: 100, timeout: 30000 });
    const shared = await ed.evaluate(() => window.__shared[0]);
    ok(/\.(png|jpe?g|webp)$/.test(shared.name) && shared.type.startsWith('image/') && shared.size > 50, `shared ${JSON.stringify(shared)}`);
    await ed.close();
    return `share sheet here: ${can}; shared ${shared.name}`;
  },

  async 'circles and numbered steps on a recording are drawn as the editor draws them'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const { normaliseEdits, clipMap, composer } = await import('/lib/video-edits.js');
      const { PALETTE } = await import('/lib/shapes.js');
      const e = normaliseEdits({ callouts: [
        { from: 0, to: 2, kind: 'ellipse', x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.5, color: '#0090ff', size: 3 },
        { from: 0, to: 2, kind: 'step', x1: 0.75, y1: 0.5, text: '7', color: '#e5484d', size: 2 },
        { from: 0, to: 2, kind: 'nonsense' },
      ] });
      const src = new OffscreenCanvas(640, 360); const s = src.getContext('2d'); s.fillStyle = '#fff'; s.fillRect(0, 0, 640, 360);
      const out = new OffscreenCanvas(640, 360).getContext('2d', { willReadFrequently: true });
      const map = clipMap(e, 0, 2);
      composer(e, map, 640, 360, []).draw(out, src, 1, map.outOf(1));
      const px = (x, y) => [...out.getImageData(Math.round(x * 640), Math.round(y * 360), 1, 1).data.slice(0, 3)];
      return {
        kinds: e.callouts.map((c) => c.kind),
        ring: px(0.25, 0.1), inside: px(0.25, 0.3),
        step: px(0.75 - 0.015, 0.5 - 0.02), palette: PALETTE.length,
      };
    });
    ok(r.kinds.join() === 'ellipse,step,arrow', `kinds ${r.kinds}`);
    ok(r.ring[2] > 180 && r.ring[0] < 120, `the circle's outline: ${r.ring}`);
    ok(r.inside.every((v) => v > 240), `inside the circle is left alone: ${r.inside}`);
    ok(r.step[0] > 180 && r.step[1] < 120, `the step's red disc: ${r.step}`);
    ok(r.palette === 8, 'one palette');
    await lab.close();
  },
};
