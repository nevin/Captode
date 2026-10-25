// Recordings saved after a crash, step-by-step guides, drawing on the page while
// recording, what a click is recorded as, and captions.
import { open, ok, near, sleep, waitForTab } from './helpers.mjs';

/** A screen-recording page whose "screen" is a canvas that keeps changing. */
async function fakeScreen(browser, url, query = '') {
  const p = await open(browser, url(`recorder/screen.html?fps=30&audio=0&countdown=0${query}`), { width: 800, height: 600 });
  await p.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240;
      const x = c.getContext('2d');
      setInterval(() => { x.fillStyle = `hsl(${Date.now() / 10 % 360} 60% 50%)`; x.fillRect(0, 0, 320, 240); }, 33);
      return c.captureStream(30);
    };
  });
  return p;
}

const partsLeft = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('captode');
  req.onsuccess = () => {
    const db = req.result;
    const n = db.transaction('parts').objectStore('parts').count();
    n.onsuccess = () => { db.close(); resolve(n.result); };
  };
}));

/** A recording made in the lab page, saved as a capture with `meta`; resolves to its id. */
async function labRecording(lab, meta, seconds = 2.5) {
  return lab.evaluate(async (meta, seconds) => {
    const { record } = await import('/lib/recorder.js');
    const { putCapture } = await import('/lib/db.js');
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const g = c.getContext('2d');
    const t0 = performance.now();
    // Left half blue, right half green; a stripe moves so there are frames.
    const draw = () => {
      g.fillStyle = '#2050e0'; g.fillRect(0, 0, 320, 360);
      g.fillStyle = '#20a050'; g.fillRect(320, 0, 320, 360);
      g.fillStyle = '#fff'; g.fillRect(((performance.now() - t0) / 5) % 640, 340, 20, 20);
    };
    const timer = setInterval(draw, 20); draw();
    const session = await record(c.captureStream(30), { fps: 30 });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { blob, meta: m } = await session.stop();
    clearInterval(timer);
    return putCapture(blob, { ...m, ...meta });
  }, meta, seconds);
}

/** Catches downloads made with a link's click(): [{ name, type, size, text? }]. */
const catchDownloads = (page) => page.evaluate(() => {
  window.__downloads = [];
  HTMLAnchorElement.prototype.click = function () {
    const name = this.download;
    fetch(this.href).then((r) => r.blob()).then(async (b) => {
      const head = new Uint8Array(await b.slice(0, 4).arrayBuffer());
      const text = /text|html|vtt|subrip|markdown/.test(b.type) ? await b.text() : '';
      const bytes = b.type === 'application/pdf' ? await b.text() : '';
      window.__downloads.push({ name, type: b.type, size: b.size, text, head: [...head], pages: (bytes.match(/\/Type \/Page\b/g) || []).length });
    });
  };
});

export const tests = {
  async 'a recording cut off before it was saved is recovered, and the popup offers it'({ browser, url }) {
    const p = await fakeScreen(browser, url);
    await p.click('#choose');
    await p.waitForFunction(() => !document.getElementById('live').classList.contains('hidden'), { polling: 100, timeout: 5000 });
    await sleep(2600);
    // Closed without stopping (beforeunload skipped, as when the browser quits).
    await p.close({ runBeforeUnload: false });
    const pop = await open(browser, url('popup/popup.html'), { width: 340, height: 600 });
    await pop.waitForFunction(() => !document.getElementById('recovered').classList.contains('hidden'), { polling: 100, timeout: 15000 });
    const { id, rec } = await pop.evaluate(async () => {
      const { recovered } = await chrome.storage.local.get('recovered');
      const id = recovered.at(-1);
      const r = await (await import('/lib/db.js')).getCapture(id);
      return { id, rec: { size: r.blob.size, type: r.blob.type, meta: r.meta } };
    });
    ok(rec.size > 1000 && rec.type.startsWith('video/webm') && rec.meta.recovered, `recovered: ${JSON.stringify(rec)}`);
    near(rec.meta.duration, 2.5, 1.2, 'recorded time noted while recording');
    ok((await partsLeft(pop)) === 0, 'the copy is gone once saved');
    // Open it: it plays, about as long as it ran.
    await pop.click('#recovered-open');
    const video = await waitForTab(browser, (u) => u.includes(`video.html?id=${id}`), 15000);
    await video.waitForFunction(() => document.querySelector('#player').videoWidth > 0, { polling: 100, timeout: 20000 });
    const length = await video.evaluate(async () => {
      const v = document.querySelector('#player');
      for (let i = 0; i < 40 && !Number.isFinite(v.duration); i++) await new Promise((r) => setTimeout(r, 100));
      return v.duration;
    });
    ok(length > 1.2 && length < 4, `recovered video length ${length}`);
    ok(!(await chrome_get(video, 'recovered')), 'offered once');
    await video.close();

    // A recording stopped as usual leaves no copy behind, and nothing to recover.
    const q = await fakeScreen(browser, url);
    await q.click('#choose');
    await q.waitForFunction(() => !document.getElementById('live').classList.contains('hidden'), { polling: 100, timeout: 5000 });
    await sleep(1200);
    await q.click('#stop');
    await q.waitForNavigation({ timeout: 15000 });
    ok((await partsLeft(q)) === 0, 'parts left after a normal stop');
    await q.close();
    return `${(rec.size / 1024).toFixed(0)} KB, ${length.toFixed(1)} s`;
  },

  async 'clicks are recorded with what was clicked, never what was typed, and not while drawing'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const { trackClicks, drawLayer } = await import('/content/page.js');
      document.body.innerHTML = `
        <button id="b" style="position:absolute;left:10px;top:10px;width:120px;height:30px">  Save
          changes </button>
        <a id="a" href="#x" style="position:absolute;left:10px;top:60px">Pricing</a>
        <label style="position:absolute;left:10px;top:100px">Email <input id="e" style="width:120px" value="me@example.com"></label>
        <input id="pw" type="password" style="position:absolute;left:10px;top:140px;width:120px" value="hunter2">
        <div id="plain" style="position:absolute;left:300px;top:10px;width:100px;height:100px">just text</div>
        <button id="icon" aria-label="Close" style="position:absolute;left:300px;top:150px;width:30px;height:30px"></button>`;
      const sent = [];
      chrome.runtime.sendMessage = async (m) => { sent.push(m); };
      trackClicks(true);
      const hit = (el) => { const b = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', clientX: b.x + 5, clientY: b.y + 5 })); };
      for (const id of ['b', 'a', 'e', 'pw', 'plain', 'icon']) hit(document.getElementById(id));
      // While drawing, a press on the drawing layer isn't a click on the page.
      drawLayer(true, '');
      hit(document.getElementById('__captode_draw'));
      drawLayer(false);
      trackClicks(false);
      return sent.map(({ label, field }) => ({ label, field }));
    });
    const want = [{ label: 'Save changes' }, { label: 'Pricing' }, { label: 'Email', field: true }, {}, {}, { label: 'Close' }];
    ok(JSON.stringify(r) === JSON.stringify(want), `clicks: ${JSON.stringify(r)}`);
    ok(!JSON.stringify(r).includes('example.com') && !JSON.stringify(r).includes('hunter2'), 'typed text kept');
    await lab.close();
  },

  async 'drawing on the page shows strokes that fade, and Esc stops it'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'), { width: 800, height: 600 });
    await lab.evaluate(async () => {
      document.body.innerHTML = '';
      document.body.style.background = '#fff';
      const { drawLayer } = await import('/content/page.js');
      window.__on = [drawLayer('toggle', 'Draw')];
    });
    await lab.mouse.move(100, 100);
    await lab.mouse.down();
    for (let i = 1; i <= 10; i++) await lab.mouse.move(100 + i * 20, 100 + i * 10);
    await lab.mouse.up();
    const red = () => lab.evaluate(() => {
      const c = document.getElementById('__captode_draw');
      if (!c) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && d[i] > 180 && d[i + 1] < 120) n++;
      return n;
    });
    await sleep(150);
    const drawn = await red();
    ok(drawn > 200, `a red stroke is drawn: ${drawn} pixels`);
    await sleep(2600);
    ok((await red()) === 0, 'the stroke faded');
    await lab.keyboard.press('Escape');
    ok((await red()) === -1, 'Esc stops drawing');
    const toggled = await lab.evaluate(async () => {
      const { drawLayer } = await import('/content/page.js');
      return [...window.__on, drawLayer('toggle'), drawLayer('toggle'), !!document.getElementById('__captode_draw')];
    });
    ok(JSON.stringify(toggled) === '[true,true,false,false]', `toggles: ${toggled}`);
    await lab.close();
    return `${drawn} pixels`;
  },

  async 'a step-by-step guide has a step per click, keeps its notes, and downloads as a page, PDF and Markdown'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await labRecording(lab, {
      title: 'Saving a file',
      clicks: [
        { t: 0.6, x: 0.25, y: 0.5, label: 'Save' },
        { t: 0.75, x: 0.252, y: 0.5, label: 'Save' }, // a double click: one step
        { t: 1.6, x: 0.75, y: 0.5, label: 'Email', field: true },
        { t: 9, x: 0.5, y: 0.5 }, // after the end: left out
      ],
    });
    await lab.close();
    const video = await open(browser, url(`video/video.html?id=${id}`), { width: 1280, height: 800 });
    await video.waitForFunction(() => !document.getElementById('make-guide').classList.contains('hidden'), { polling: 100, timeout: 15000 });
    await video.click('#make-guide');
    const g = await waitForTab(browser, (u) => u.includes(`guide.html?id=${id}`), 10000);
    await video.close();
    await g.waitForFunction(() => document.querySelectorAll('#steps .step img[src^="blob:"]').length === 2, { polling: 100, timeout: 20000 });
    const first = await g.evaluate(async () => {
      const notes = [...document.querySelectorAll('#steps textarea')].map((t) => t.value);
      // The picture: the recording's frame, with the marker over the first click.
      const img = document.querySelector('#steps img');
      await img.decode();
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight).getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0);
      const px = (x, y) => [...c.getImageData(Math.round(x * img.naturalWidth), Math.round(y * img.naturalHeight), 1, 1).data.slice(0, 3)];
      return { notes, title: document.getElementById('title').value, size: [img.naturalWidth, img.naturalHeight], centre: px(0.25, 0.5), away: px(0.1, 0.2), right: px(0.9, 0.2) };
    });
    ok(JSON.stringify(first.notes) === JSON.stringify(['Click “Save”.', 'Click the “Email” field.']), `notes ${JSON.stringify(first.notes)}`);
    ok(first.title === 'Saving a file' && first.size[0] === 640, `title and size ${first.title} ${first.size}`);
    const blue = (p) => p[2] > 180 && p[0] < 80, green = (p) => p[1] > 130 && p[2] < 120;
    ok(blue(first.away) && green(first.right), `the frame: ${first.away} ${first.right}`);

    // Notes, order and removals are kept.
    await g.evaluate(() => {
      const t = document.querySelectorAll('#steps textarea')[1];
      t.value = 'Type your email address.';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await g.click('#steps li:nth-child(2) [data-act="up"]');
    await g.waitForFunction(() => document.querySelector('#steps textarea').value === 'Type your email address.', { polling: 100, timeout: 5000 });
    await sleep(700);
    await g.reload();
    await g.waitForFunction(() => document.querySelectorAll('#steps .step img[src^="blob:"]').length === 2, { polling: 100, timeout: 20000 });
    const kept = await g.evaluate(() => [...document.querySelectorAll('#steps textarea')].map((t) => t.value));
    ok(JSON.stringify(kept) === JSON.stringify(['Type your email address.', 'Click “Save”.']), `kept ${JSON.stringify(kept)}`);
    await g.click('#steps li:nth-child(2) [data-act="remove"]');
    await g.waitForFunction(() => document.querySelectorAll('#steps .step').length === 1, { polling: 100, timeout: 5000 });
    await g.click('.toast-action');
    await g.waitForFunction(() => document.querySelectorAll('#steps .step').length === 2, { polling: 100, timeout: 3000 });

    await catchDownloads(g);
    for (const b of ['#dl-page', '#dl-pdf', '#dl-md']) {
      await g.waitForFunction((b) => !document.querySelector(b).disabled, { polling: 100, timeout: 20000 }, b);
      await g.click(b);
      await g.waitForFunction((n) => window.__downloads.length >= n, { polling: 100, timeout: 30000 }, ['#dl-page', '#dl-pdf', '#dl-md'].indexOf(b) + 1);
    }
    const [page, pdf, md] = await g.evaluate(() => window.__downloads);
    ok(page.name.endsWith('.html') && page.text.includes('Type your email address.') && (page.text.match(/<img src="data:image\//g) || []).length === 2, `page ${page.name} ${page.size}`);
    ok(pdf.name.endsWith('.pdf') && String.fromCharCode(...pdf.head) === '%PDF' && pdf.pages === 2, `pdf ${JSON.stringify({ ...pdf, text: '' })}`);
    ok(md.name.endsWith('.zip') && md.head[0] === 0x50 && md.head[1] === 0x4b && md.size > 2000, `markdown zip ${JSON.stringify(md)}`);
    await g.close();
    return `page ${(page.size / 1024).toFixed(0)} KB, PDF ${(pdf.size / 1024).toFixed(0)} KB, zip ${(md.size / 1024).toFixed(0)} KB`;
  },

  async 'captions are drawn along the bottom and become subtitles timed for the export'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const { normaliseEdits, clipMap, composer, captionCues, subtitles, hasSpatial } = await import('/lib/video-edits.js');
      const e = normaliseEdits({
        cuts: [{ from: 2, to: 4 }],
        captions: [{ from: 0.5, to: 1.5, text: 'Hello there' }, { from: 5, to: 6, text: 'After the cut' }, { from: 2.5, to: 3, text: 'Cut out' }, { from: 7, to: 8, text: '   ' }],
      });
      const map = clipMap(e, 0, 10);
      // A slide of 2 s put in at 4.5 s plays before the second caption.
      const cues = captionCues(e, map, (t) => (t >= 4.5 ? 2 : 0));
      const src = new OffscreenCanvas(640, 360); const s = src.getContext('2d'); s.fillStyle = '#fff'; s.fillRect(0, 0, 640, 360);
      const out = new OffscreenCanvas(640, 360).getContext('2d', { willReadFrequently: true });
      const comp = composer(e, map, 640, 360, []);
      const darkRows = () => {
        let n = 0;
        for (let y = 250; y < 360; y++) { const p = out.getImageData(320, y, 1, 1).data; if (p[0] < 100) n++; }
        return n;
      };
      comp.draw(out, src, 1, map.outOf(1)); const on = darkRows();
      comp.draw(out, src, 1.8, map.outOf(1.8)); const off = darkRows();
      return { cues, srt: subtitles(cues, 'srt'), vtt: subtitles(cues, 'vtt'), on, off, spatial: [hasSpatial(e), hasSpatial(normaliseEdits({ captions: [{ from: 0, to: 1, text: '' }] }))], kept: e.captions.length };
    });
    ok(r.kept === 4 && r.spatial.join() === 'true,false', `edits ${r.kept} ${r.spatial}`);
    ok(r.cues.length === 2, `cues ${JSON.stringify(r.cues)}`);
    near(r.cues[0].start, 0.5, 0.01, 'first start');
    near(r.cues[1].start, 3 + 2, 0.01, 'after the 2 s cut and a 2 s slide');
    ok(r.srt.startsWith('1\n00:00:00,500 --> 00:00:01,500\nHello there\n\n2\n00:00:05,000 --> 00:00:06,000\nAfter the cut'), `srt ${JSON.stringify(r.srt)}`);
    ok(r.vtt.startsWith('WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nHello there'), `vtt ${JSON.stringify(r.vtt)}`);
    ok(r.on > 10 && r.off === 0, `caption band: ${r.on} rows while on, ${r.off} after`);
    await lab.close();
  },
};

const chrome_get = (page, key) => page.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
