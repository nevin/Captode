// Video page: clips joined one after another (copied, or encoded to fit), moved and
// removed with their edits, and a video layer over the picture in the preview and
// the export.
import { open, recordClip, ok, near, sleep } from './helpers.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A WAV file of a steady tone, `seconds` long, written to a temporary folder; its path. */
function toneFile(seconds = 6, hz = 330) {
  const rate = 48000, n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2);
  const path = join(mkdtempSync(join(tmpdir(), 'captode-music-')), 'tone.wav');
  writeFileSync(path, b);
  return path;
}

/** A recording of one colour, `width` × `height`, without sound. */
const solidClip = (page, { seconds, width, height, color }) => page.evaluate(async (seconds, width, height, color) => {
  const { putCapture } = await import('/lib/db.js');
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  document.body.append(el);
  const ctx = el.getContext('2d');
  const rec = new MediaRecorder(el.captureStream(30), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 2e6 });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start(500);
  const t0 = performance.now();
  await new Promise((res) => {
    const draw = () => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(((performance.now() - t0) / 1000) * 50, 10, 20, 20); // something moving, so frames keep coming
      if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(draw); else res();
    };
    draw();
  });
  rec.stop();
  await new Promise((r) => { rec.onstop = r; });
  el.remove();
  return putCapture(new Blob(chunks, { type: 'video/webm' }), { fps: 30, duration: seconds, hasAudio: false, title: `Solid ${color}` });
}, seconds, width, height, color);

export async function setup({ browser, url }) {
  const ctl = await open(browser, url('lab/lab.html'));
  await ctl.waitForFunction(() => globalThis.lab, { polling: 100 });
  const a = await recordClip(ctl, { seconds: 4, audio: true });
  const b = await recordClip(ctl, { seconds: 3 }); // same size: copied
  const red = await solidClip(ctl, { seconds: 2, width: 640, height: 480, color: '#e00000' }); // smaller: encoded to fit
  const tone = await recordClip(ctl, { seconds: 2, audio: true }); // a layer with sound
  // A green picture (a screenshot, as Captode keeps them), for a picture layer.
  const pic = await ctl.evaluate(async () => {
    const { putCapture } = await import('/lib/db.js');
    const c = new OffscreenCanvas(400, 300);
    const g = c.getContext('2d');
    g.fillStyle = '#00c000';
    g.fillRect(0, 0, 400, 300);
    return putCapture(await c.convertToBlob({ type: 'image/png' }), { title: 'Green picture' });
  });
  // A caption at 1–2 s in the first recording, to follow it about.
  await ctl.evaluate(async (id) => {
    const { saveVideoEdits } = await import('/lib/db.js');
    await saveVideoEdits(id, { captions: [{ id: 'cap1', from: 1, to: 2, text: 'Hello', size: 2 }] });
  }, a);
  // The page opens itself again after joining, in a new frame: `cur.page` is the one showing.
  const cur = { page: await open(browser, url(`video/video.html?id=${a}`), { width: 1440, height: 900 }) };
  await cur.page.bringToFront();
  await cur.page.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100, timeout: 30000 });

  const saved = () => ctl.evaluate(async (id) => {
    const { getCapture } = await import('/lib/db.js');
    const r = await getCapture(id);
    return { clips: r.clips || null, edits: r.videoEdits || null, files: Object.keys(r.layerSources || {}), duration: r.meta.duration, slides: (r.slides || []).map((x) => ({ bgKind: x.bgKind, duration: x.duration })) };
  }, a);
  /** Does `act` (which joins clips), then waits for the page to open the new recording. */
  const rejoin = async (act) => {
    await cur.page.evaluate(() => { window.__old = true; });
    await act();
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 120000) {
        const said = await cur.page.evaluate(() => [document.querySelector('.toast')?.textContent, document.querySelector('#status').textContent, !!document.querySelector('#clip-trim[open]')]).catch((e) => e.message);
        ok(false, `the page never opened again: ${JSON.stringify(said)}`);
      }
      await sleep(250);
      for (const p of await browser.pages()) {
        if (!p.url().includes(`id=${a}`)) continue;
        const fresh = await p.evaluate(() => !window.__old && /fps/.test(document.querySelector('#dims')?.textContent || '')).catch(() => false);
        if (fresh) {
          cur.page = p;
          p.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'error') console.log(`    page: ${m.text().slice(0, 300)}`); });
          await p.evaluate(async () => { window.lab = await import('/lab/lab.js'); });
          return;
        }
      }
    }
  };
  const openClips = async (mode) => {
    await cur.page.evaluate(() => { document.querySelector('#clips-section').open = true; });
    await cur.page.$eval('#clips-section', (e) => e.scrollIntoView({ block: 'start' }));
    await cur.page.click(`#clip-mode [data-v="${mode}"]`);
    await cur.page.waitForFunction(() => document.querySelector('#clip-pick').options.length >= 2, { polling: 100 });
  };
  const pick = (id) => cur.page.select('#clip-pick', id);
  /** Add, then the dialog's Add (with the part to use, if given). */
  const addPicked = async (range) => {
    await cur.page.click('#clip-add');
    await cur.page.waitForSelector('#clip-trim[open]');
    await cur.page.waitForFunction(() => document.querySelector('#clip-trim-note').textContent, { polling: 100 });
    if (range) {
      await cur.page.evaluate(([a, b]) => {
        for (const [id, v] of [['#clip-trim-start', a], ['#clip-trim-end', b]]) {
          const el = document.querySelector(id);
          el.value = String(v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, range);
    }
    await cur.page.click('#clip-trim-ok');
  };
  /** The player's frame at t: its stamped time, and a pixel. */
  const frameAt = (t, x = 20, y = 360) => cur.page.evaluate(async (t, x, y) => {
    const v = document.querySelector('#player');
    v.pause();
    await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; });
    const c = new OffscreenCanvas(1280, 720).getContext('2d', { willReadFrequently: true });
    c.drawImage(v, 0, 0, 1280, 720);
    return { time: lab.frameTime(v), px: [...c.getImageData(x, y, 1, 1).data].slice(0, 3), duration: v.duration };
  }, t, x, y);
  await cur.page.evaluate(async () => { window.lab = await import('/lab/lab.js'); });
  return { cur, ctl, ids: { a, b, red, tone, pic }, saved, rejoin, openClips, pick, frameAt, addPicked };
}

export const tests = {
  async 'clips: a recording the same size is joined after, as it was recorded'({ cur, ids, saved, rejoin, openClips, pick, frameAt, addPicked }) {
    await openClips('after');
    await pick(ids.b);
    await rejoin(() => addPicked());
    ok(await cur.page.$$eval('#clip-list .clip-item', (r) => r.length) === 2, 'two clips listed');
    ok(await cur.page.$$eval('#clip-marks .clip-mark', (r) => r.length) === 2, 'two marks on the timeline');
    const s = await saved();
    near(s.clips.reduce((n, c) => n + c.len, 0), 7, 0.25, 'clips add up');
    const end = await frameAt(1.5);
    near(end.duration, 7, 0.25, 'joined length');
    near(end.time, 1.5, 0.1, 'first clip in place');
    near((await frameAt(5)).time, 1, 0.1, 'second clip starts where the first ends');
    near(s.edits.captions[0].from, 1, 0.01, 'caption stays where it was');
  },

  async 'clips: a video of another size fits inside, and moving a clip moves its edits'({ cur, ids, saved, rejoin, openClips, pick, frameAt, addPicked }) {
    await openClips('after');
    await pick(ids.red);
    await rejoin(() => addPicked());
    ok(await cur.page.$$eval('#clip-list .clip-item', (r) => r.length) === 3, 'three clips listed');
    const red = await frameAt(8, 640, 400);
    near(red.duration, 9, 0.3, 'joined length');
    ok(red.px[0] > 180 && red.px[1] < 60, `red clip shows: ${red.px}`);
    const bar = await frameAt(8, 20, 360);
    ok(bar.px.every((v) => v < 30), `black bars beside a 4:3 clip: ${bar.px}`);
    // The first clip after the second: its caption goes with it.
    await rejoin(() => cur.page.click('#clip-list .clip-item:first-child [data-act="down"]'));
    const s = await saved();
    near(s.edits.captions[0].from, s.clips[0].len + 1, 0.05, 'caption moved with its clip');
    ok(s.clips[1].len > 3.5, 'the 4 s recording is second');
    near((await frameAt(s.clips[0].len + 1.5)).time, 1.5, 0.1, 'its frames moved too');
  },

  async 'clips: removing a clip'({ cur, saved, rejoin }) {
    await rejoin(async () => {
      const rows = await cur.page.$$('#clip-list .clip-item');
      await (await rows.at(-1).$('[data-act="remove"]')).click();
      await cur.page.waitForSelector('dialog.confirm[open] button[value="yes"]');
      await cur.page.click('dialog.confirm[open] button[value="yes"]');
    });
    const s = await saved();
    ok(s.clips.length === 2, `${s.clips.length} clips left`);
    near(s.clips.reduce((n, c) => n + c.len, 0), 7, 0.25, 'length without it');
  },

  async 'clips: put in right at the playhead, the recording either side kept'({ cur, ids, saved, rejoin, openClips, pick, frameAt, addPicked }) {
    await cur.page.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 4.1; });
    await sleep(200);
    await openClips('here');
    await pick(ids.red);
    await rejoin(() => addPicked());
    const s = await saved();
    ok(s.clips.length === 4, `${s.clips.length} clips: ${JSON.stringify(s.clips)}`);
    near(s.clips.reduce((n, c) => n + c.len, 0), 9, 0.3, 'length with it');
    const at = s.clips[0].len + s.clips[1].len; // where it went in
    near(at, 4.1, 0.05, 'put in at the playhead');
    const red = await frameAt(at + 1, 640, 400);
    ok(red.px[0] > 180 && red.px[1] < 60, `the clip put in: ${red.px}`);
    // The rest of the recording carries on where it stopped.
    near((await frameAt(at + 2 + 0.3)).time, s.clips[1].len + 0.3, 0.1, 'the recording after it');
  },

  async 'clips: only the part chosen is added, and Undo puts the recording back'({ cur, ids, saved, rejoin, openClips, pick, frameAt, addPicked }) {
    const before = await saved();
    await openClips('after');
    await pick(ids.red);
    await rejoin(() => addPicked([0.5, 1.5]));
    let s = await saved();
    ok(s.clips.length === before.clips.length + 1, 'one more clip');
    near(s.clips.at(-1).len, 1, 0.05, 'only the second chosen');
    ok(await cur.page.$eval('#clip-undo', (b) => !b.classList.contains('hidden')), 'Undo offered');
    await cur.page.$eval('#clip-undo', (b) => b.scrollIntoView({ block: 'center' }));
    await rejoin(() => cur.page.click('#clip-undo'));
    s = await saved();
    ok(s.clips.length === before.clips.length, `back to ${before.clips.length} clips: ${s.clips.length}`);
    near((await frameAt(1)).duration, 9, 0.3, 'back to its length');
  },

  async 'layers: a video over the picture, in the preview and the export'({ cur, ids, saved, openClips, pick, addPicked }) {
    await cur.page.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 0.5; });
    await sleep(200);
    await openClips('top');
    await pick(ids.red);
    await addPicked();
    await cur.page.waitForFunction(() => [...document.querySelectorAll('#ed-list .ed-name b')].some((b) => /layer/i.test(b.textContent)), { timeout: 60000, polling: 100 });
    await sleep(700); // saved after a moment
    const s = await saved();
    const layer = s.edits.layers?.[0];
    ok(layer && s.files.includes(layer.src), 'layer saved with its video');
    near(layer.from, 0.5, 0.05, 'starts at the playhead');
    near(layer.to, 2.5, 0.1, 'as long as its video');
    ok(await cur.page.$eval('#fx-view', (c) => !c.classList.contains('hidden')), 'the preview draws the layer');

    // In the export: red in the lower right while it is on, not after.
    await cur.page.click('#formats [data-f="mp4"]');
    await cur.page.click('#convert');
    await cur.page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 120000, polling: 100 });
    const px = await cur.page.evaluate(async () => {
      const out = document.querySelector('#out-video');
      if (out.readyState < 2) await new Promise((r) => out.addEventListener('loadeddata', r, { once: true }));
      const at = async (t) => {
        await new Promise((r) => { out.addEventListener('seeked', r, { once: true }); out.currentTime = t; });
        const c = new OffscreenCanvas(out.videoWidth, out.videoHeight).getContext('2d', { willReadFrequently: true });
        c.drawImage(out, 0, 0);
        return [...c.getImageData(Math.round(out.videoWidth * 0.84), Math.round(out.videoHeight * 0.9), 1, 1).data].slice(0, 3);
      };
      return { on: await at(1.5), off: await at(4), fallback: window.__fallback || null };
    });
    ok(px.on[0] > 180 && px.on[1] < 60, `layer in the export: ${px.on}`);
    ok(!(px.off[0] > 180 && px.off[1] < 60), `gone after its end: ${px.off}`);
    await cur.page.click('#redo-export').catch(() => {});

    // GIF too (its colours come from the layer as well).
    await cur.page.click('#formats [data-f="gif"]');
    await cur.page.waitForFunction(() => document.querySelector('#result').classList.contains('hidden'), { polling: 100 });
    await cur.page.click('#convert');
    await cur.page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 180000, polling: 100 });
    const gif = await cur.page.evaluate(() => ({ shown: !document.querySelector('#out-img').classList.contains('hidden'), status: document.querySelector('#status').textContent, fallback: window.__fallback || null }));
    ok(gif.shown, `GIF made with a layer: ${gif.status}`);
    await cur.page.click('#redo-export').catch(() => {});
  },

  async 'layers: dragged anywhere on the picture, and their sound in the export'({ cur, ids, saved, openClips, pick, addPicked }) {
    await cur.page.click('#formats [data-f="mp4"]');
    await cur.page.waitForFunction(() => document.querySelector('#result').classList.contains('hidden'), { polling: 100 });
    await cur.page.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 0.5; });
    await sleep(200);
    await openClips('top');
    await pick(ids.tone);
    await addPicked();
    await cur.page.waitForFunction(() => document.querySelectorAll('#ed-list .ed-name b').length >= 2 && [...document.querySelectorAll('#ed-list .ed-name b')].filter((b) => /layer/i.test(b.textContent)).length >= 2, { timeout: 60000, polling: 100 });
    await sleep(700);
    let layer = (await saved()).edits.layers.at(-1);
    ok(layer.sound && layer.volume === 1, `has its sound: ${JSON.stringify(layer)}`);
    ok(await cur.page.$('#ed-item input[data-k="volume"]'), 'a volume slider for it');

    // Dragged from the lower right to the upper left of the paused picture.
    await cur.page.evaluate(() => { const p = document.querySelector('#player'); p.currentTime = 1.2; });
    await sleep(400);
    const r = await cur.page.$eval('#fx-view', (c) => { const b = c.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    await cur.page.mouse.move(r.x + r.w * 0.8, r.y + r.h * 0.8);
    await cur.page.mouse.down();
    for (let i = 1; i <= 8; i++) await cur.page.mouse.move(r.x + r.w * (0.8 - 0.06 * i), r.y + r.h * (0.8 - 0.06 * i));
    await cur.page.mouse.up();
    await sleep(700);
    layer = (await saved()).edits.layers.at(-1);
    ok(layer.pos === 'free', `placed by hand: ${layer.pos}`);
    ok(layer.x < 0.5 && layer.y < 0.5, `moved up and left: ${layer.x}, ${layer.y}`);

    // Its sound plays where it is on, over a part of the recording with none.
    await cur.page.click('#convert');
    await cur.page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 120000, polling: 100 });
    const loud = await cur.page.evaluate(async () => {
      const out = document.querySelector('#out-video');
      const buf = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(await (await fetch(out.src)).arrayBuffer());
      const rms = (a, b) => { const d = buf.getChannelData(0); let n = 0, s = 0; for (let i = Math.round(a * 48000); i < Math.round(b * 48000); i++, n++) s += d[i] * d[i]; return Math.sqrt(s / n); };
      return { on: rms(1, 2), off: rms(2.7, 2.95) };
    });
    ok(loud.on > 0.05, `layer's sound in the export: ${loud.on}`);
    ok(loud.off < 0.01, `silent after it: ${loud.off}`);
    await cur.page.click('#redo-export').catch(() => {});
  },

  async 'clips: a fade through black where two clips meet, and layer look settings'({ cur, saved }) {
    await cur.page.evaluate(() => { document.querySelector('#clips-section').open = true; });
    await cur.page.select('#clip-list select[data-trans="1"]', 'fade');
    await sleep(300);
    const s = await saved();
    ok(s.clips[1].trans === 'fade', `saved: ${JSON.stringify(s.clips[1])}`);
    const join = s.clips[0].len;
    // The layer form offers its look.
    for (const k of ['opacity', 'fade', 'shadow']) ok(await cur.page.$(`#ed-item [data-k="${k}"]`), `${k} control`);
    ok(await cur.page.$('#ed-item [data-seg="border"]'), 'edge colours');

    await cur.page.click('#formats [data-f="mp4"]');
    await cur.page.waitForFunction(() => document.querySelector('#result').classList.contains('hidden'), { polling: 100 });
    await cur.page.click('#convert');
    await cur.page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 120000, polling: 100 });
    const px = await cur.page.evaluate(async (join) => {
      const out = document.querySelector('#out-video');
      if (out.readyState < 2) await new Promise((r) => out.addEventListener('loadeddata', r, { once: true }));
      const at = async (t) => {
        await new Promise((r) => { out.addEventListener('seeked', r, { once: true }); out.currentTime = t; });
        const c = new OffscreenCanvas(out.videoWidth, out.videoHeight).getContext('2d', { willReadFrequently: true });
        c.drawImage(out, 0, 0);
        return [...c.getImageData(Math.round(out.videoWidth * 0.3), Math.round(out.videoHeight * 0.05), 1, 1).data].slice(0, 3);
      };
      return { join: await at(join), before: await at(join - 0.8) };
    }, join);
    ok(px.join.every((v) => v < 40), `black where they meet: ${px.join}`);
    ok(px.before.some((v) => v > 40), `not before: ${px.before}`);
    await cur.page.click('#redo-export').catch(() => {});
  },

  async 'timeline: zoomed in and out, following the playhead'({ cur }) {
    const ratio = () => cur.page.evaluate(() => document.querySelector('#track').getBoundingClientRect().width / document.querySelector('#track-view').getBoundingClientRect().width);
    near(await ratio(), 1, 0.01, 'whole timeline to start with');
    await cur.page.click('#tl-in');
    await cur.page.click('#tl-in');
    near(await ratio(), 4, 0.05, 'four times as wide');
    // Playing near the end: the view moves to keep the playhead in it.
    await cur.page.evaluate(() => { const p = document.querySelector('#player'); p.currentTime = p.duration - 1.5; });
    await cur.page.evaluate(() => document.querySelector('#play').click());
    await sleep(500);
    await cur.page.evaluate(() => document.querySelector('#player').pause());
    const seen = await cur.page.evaluate(() => {
      const v = document.querySelector('#track-view').getBoundingClientRect(), p = document.querySelector('#playhead').getBoundingClientRect();
      return p.left >= v.left - 1 && p.left <= v.right + 1;
    });
    ok(seen, 'the playhead stays in view');
    await cur.page.click('#tl-out');
    await cur.page.click('#tl-out');
    near(await ratio(), 1, 0.01, 'back to the whole timeline');
  },

  async 'layers: words and a picture over the video, in the export'({ cur, ids, saved, openClips, pick, addPicked }) {
    await cur.page.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 3.2; });
    await sleep(200);
    await cur.page.evaluate(() => { document.querySelector('#edit-section').open = true; });
    await cur.page.$eval('[data-add="textlayer"]', (e) => e.scrollIntoView({ block: 'center' }));
    await cur.page.click('[data-add="textlayer"]');
    await openClips('top');
    await cur.page.waitForFunction((id) => [...document.querySelectorAll('#clip-pick option')].some((o) => o.value === id), { polling: 100 }, ids.pic);
    await pick(ids.pic);
    await cur.page.click('#clip-add');
    await sleep(800);
    const s = await saved();
    const text = s.edits.layers.find((l) => l.kind === 'text'), pic = s.edits.layers.find((l) => l.kind === 'image');
    ok(text && text.text, `a text layer: ${JSON.stringify(text)}`);
    ok(pic && s.files.includes(pic.src), `a picture layer with its file: ${JSON.stringify(pic)}`);
    await cur.page.click('#formats [data-f="mp4"]');
    await cur.page.waitForFunction(() => document.querySelector('#result').classList.contains('hidden'), { polling: 100 });
    await cur.page.click('#convert');
    await cur.page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 120000, polling: 100 });
    const px = await cur.page.evaluate(async (at) => {
      const out = document.querySelector('#out-video');
      if (out.readyState < 2) await new Promise((r) => out.addEventListener('loadeddata', r, { once: true }));
      await new Promise((r) => { out.addEventListener('seeked', r, { once: true }); out.currentTime = at; });
      const c = new OffscreenCanvas(out.videoWidth, out.videoHeight).getContext('2d', { willReadFrequently: true });
      c.drawImage(out, 0, 0);
      const get = (x, y) => [...c.getImageData(Math.round(out.videoWidth * x), Math.round(out.videoHeight * y), 1, 1).data].slice(0, 3);
      return { picture: get(0.85, 0.12) };
    }, 3.2 + 1);
    ok(px.picture[1] > 150 && px.picture[0] < 80, `the picture in the upper right: ${px.picture}`);
    await cur.page.click('#redo-export').catch(() => {});
  },

  async 'music under the whole video, in the export'({ cur, saved }) {
    await cur.page.evaluate(() => { document.querySelector('#sound-section').open = true; });
    const input = await cur.page.$('#music-file');
    await input.uploadFile(toneFile(20));
    await cur.page.waitForFunction(() => !document.querySelector('#music-on').classList.contains('hidden'), { timeout: 30000, polling: 100 });
    await sleep(600);
    const s = await saved();
    ok(s.edits.music && s.files.includes(s.edits.music.src), `music saved with its file: ${JSON.stringify(s.edits.music)}`);
    await cur.page.click('#formats [data-f="mp4"]');
    await cur.page.waitForFunction(() => document.querySelector('#result').classList.contains('hidden'), { polling: 100 });
    await cur.page.click('#convert');
    await cur.page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 120000, polling: 100 });
    const rms = await cur.page.evaluate(async () => {
      const out = document.querySelector('#out-video');
      const buf = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(await (await fetch(out.src)).arrayBuffer());
      const d = buf.getChannelData(0);
      let s = 0, n = 0;
      for (let i = Math.round(2.7 * 48000); i < Math.round(2.95 * 48000); i++, n++) s += d[i] * d[i];
      return Math.sqrt(s / n);
    });
    // Where nothing else was heard before, the music is.
    ok(rms > 0.02, `music in the export: ${rms}`);
    await cur.page.click('#redo-export').catch(() => {});
    await cur.page.click('#music-remove');
  },

  async 'chapters: in the MP4, and a freeze frame as a slide'({ cur, saved }) {
    await cur.page.evaluate(() => { document.querySelector('#chapters-section').open = true; const p = document.querySelector('#player'); p.pause(); p.currentTime = 2; });
    await cur.page.$eval('#chapter-add', (e) => e.scrollIntoView({ block: 'center' }));
    await cur.page.click('#chapter-add');
    await cur.page.evaluate(() => { document.querySelector('#player').currentTime = 5; });
    await sleep(200);
    await cur.page.click('#chapter-add');
    await sleep(600);
    let s = await saved();
    ok(s.edits.chapters.length === 2, `two chapters: ${JSON.stringify(s.edits.chapters)}`);
    await cur.page.click('#formats [data-f="mp4"]');
    await cur.page.waitForFunction(() => document.querySelector('#result').classList.contains('hidden'), { polling: 100 });
    await cur.page.click('#convert');
    await cur.page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 120000, polling: 100 });
    const chpl = await cur.page.evaluate(async () => {
      const b = new Uint8Array(await (await fetch(document.querySelector('#out-video').src)).arrayBuffer());
      for (let i = 0; i < b.length - 4; i++) if (b[i] === 0x63 && b[i + 1] === 0x68 && b[i + 2] === 0x70 && b[i + 3] === 0x6c) return b[i + 12]; // chpl: how many
      return -1;
    });
    ok(chpl === 3, `chapters in the MP4 (one at 0:00 added): ${chpl}`);
    await cur.page.click('#redo-export').catch(() => {});

    const before = s.slides?.length ?? 0;
    await cur.page.evaluate(() => { document.querySelector('#slides-section').open = true; });
    await cur.page.$eval('#freeze-add', (e) => e.scrollIntoView({ block: 'center' }));
    await cur.page.click('#freeze-add');
    await sleep(800);
    s = await saved();
    const frozen = s.slides.at(-1);
    ok(s.slides.length === before + 1 && frozen.bgKind === 'image' && frozen.duration === 2, `a frozen frame: ${JSON.stringify({ n: s.slides.length, kind: frozen?.bgKind, d: frozen?.duration })}`);
  },

  async 'removing cut parts for good, platform setups and a thumbnail'({ cur, saved, rejoin, frameAt }) {
    const len0 = (await frameAt(0.5)).duration;
    await cur.page.evaluate(() => { const p = document.querySelector('#player'); p.currentTime = 1; captodeEdits.add('cuts'); });
    await sleep(300);
    await cur.page.$eval('#ed-apply-cuts', (e) => e.scrollIntoView({ block: 'center' }));
    await rejoin(async () => {
      await cur.page.click('#ed-apply-cuts');
      await cur.page.waitForSelector('dialog.confirm[open] button[value="yes"]');
      await cur.page.click('dialog.confirm[open] button[value="yes"]');
    });
    const s = await saved();
    near((await frameAt(0.5)).duration, len0 - 1, 0.15, 'a second shorter');
    ok(!s.edits.cuts.length, 'no cuts left');
    ok(await cur.page.$eval('#clip-storage', (e) => /\d/.test(e.textContent)), 'the room it takes is shown');

    // Shorts: upright, 1080 × 1920.
    await cur.page.$eval('#quick', (e) => e.scrollIntoView({ block: 'center' }));
    await cur.page.click('[data-quick="shorts"]');
    await sleep(300);
    ok(await cur.page.$eval('#dims', (e) => e.textContent.includes('1080 × 1920')), await cur.page.$eval('#dims', (e) => e.textContent));
    // A sped-up part that eases is a little longer than one that doesn't.
    const eased = await cur.page.evaluate(async () => {
      const { clipMap } = await import('/lib/video-edits.js');
      const sp = (ease) => clipMap({ speeds: [{ from: 1, to: 5, rate: 4, ease }] }, 0, 6).length;
      return [sp(false), sp(true)];
    });
    ok(eased[1] > eased[0], `easing in and out: ${eased}`);
    // A thumbnail of this frame.
    await cur.page.click('#thumb-open');
    await cur.page.waitForSelector('#thumb[open]');
    const w = await cur.page.$eval('#thumb-view', (c) => c.width);
    ok(w > 0, 'thumbnail drawn');
    await cur.page.click('#thumb [data-close="no"]');
  },
};
