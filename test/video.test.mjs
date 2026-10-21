// Video page: exporting a recording to MP4, WebM, GIF and WebP in the worker,
// with trims that land on the right frames, audio, and device frames.
import { open, recordClip, ok, near, sleep, prepare } from './helpers.mjs';
import { boxFont } from './fonts.mjs';

export async function setup({ browser, url }) {
  const ctl = await open(browser, url('lab/lab.html'));
  await ctl.waitForFunction(() => globalThis.lab, { polling: 100 });
  const clip = await recordClip(ctl, { seconds: 8, audio: true });
  const page = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
  await page.bringToFront();
  await page.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
  await page.evaluate(() => { console.warn = (...a) => { window.__fallback = a.join(' '); }; });

  const set = (sel, value) => page.evaluate((sel, value) => {
    const el = document.querySelector(sel);
    if (el.type === 'checkbox') el.checked = value; else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, sel, value);

  /** Exports in `format` and returns details of the result. */
  const exportAs = async (format) => {
    await page.evaluate(() => { window.__fallback = null; });
    await page.click(`#formats [data-f="${format}"]`);
    await sleep(100);
    const t0 = Date.now();
    await page.click('#convert');
    await page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 180000, polling: 100 });
    const ms = Date.now() - t0;
    const info = await page.evaluate(async () => {
      const failed = document.querySelector('#status').textContent;
      const out = document.querySelector('#out-video:not(.hidden)') || document.querySelector('#out-img:not(.hidden)');
      if (!out) return { failed };
      const blob = await (await fetch(out.src)).blob();
      const r = { size: blob.size, type: blob.type, fallback: window.__fallback || null };
      if (out.tagName === 'VIDEO') {
        if (out.readyState < 2) await new Promise((res) => out.addEventListener('loadeddata', res, { once: true }));
        const seek = (t) => new Promise((res) => { out.addEventListener('seeked', res, { once: true }); out.currentTime = t; });
        await seek(0.02);
        r.first = lab.frameTime(out);
        await seek(out.duration - 0.05);
        r.last = lab.frameTime(out);
        Object.assign(r, { width: out.videoWidth, height: out.videoHeight, duration: out.duration });
      } else {
        const d = new ImageDecoder({ data: blob.stream(), type: blob.type });
        await d.tracks.ready;
        await d.completed;
        const { image } = await d.decode({ frameIndex: 0 });
        const c = new OffscreenCanvas(image.displayWidth, image.displayHeight).getContext('2d', { willReadFrequently: true });
        c.drawImage(image, 0, 0);
        Object.assign(r, { frames: d.tracks.selectedTrack.frameCount, width: image.displayWidth, height: image.displayHeight, corner: [...c.getImageData(1, 1, 1, 1).data] });
      }
      return r;
    });
    await page.click('#redo-export').catch(() => {});
    return { ms, ...info };
  };

  /** The audio track of an MP4, decoded: its length in seconds (or 0 if none). */
  const mp4AudioSeconds = () => page.evaluate(async () => {
    const out = document.querySelector('#out-video');
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    try {
      const buf = await ctx.decodeAudioData(await (await fetch(out.src)).arrayBuffer());
      return buf.duration;
    } catch { return 0; }
  });

  /** Times stamped on the source frame showing at `t` and on the frames either side. */
  const sourceFrames = (t) => page.evaluate(async (t) => {
    const v = document.querySelector('#player');
    const at = async (x) => { await new Promise((res) => { v.addEventListener('seeked', res, { once: true }); v.currentTime = x; }); return lab.frameTime(v); };
    const shown = await at(t);
    let before = shown, after = shown;
    for (let x = t - 0.01; before === shown && x > t - 0.5; x -= 0.01) before = await at(x);
    for (let x = t + 0.01; after === shown && x < t + 0.5; x += 0.01) after = await at(x);
    return [before, after];
  }, t);

  // The lab page reads frame times; give the video page the same helper.
  await page.evaluate(async () => { window.lab = await import('/lab/lab.js'); });
  // Slides start folded away (the recording has none), out of the way of trimming and exporting.
  ok(await page.evaluate(() => !document.querySelector('#slides-section').open), 'the Slides section starts open');
  await page.evaluate(() => { document.querySelector('#slides-section').open = true; });
  return { video: page, exportAs, set, mp4AudioSeconds, sourceFrames, clip };
}

/** Adds a 2 s paper overlay at `at` (a white lower band, a subtitle only, no fade); it stays chosen. */
async function addOverlay(video, set, at, duration = 2) {
  await video.evaluate((at) => { const p = document.querySelector('#player'); p.pause(); p.currentTime = at; }, at);
  await sleep(200);
  await video.click('#slide-add');
  await video.click('#sl-mode [data-v="overlay"]');
  await video.click('#sl-themes [data-theme="paper"]');
  await video.click('#sl-layout [data-v="lower"]');
  await set('#slide-editor [data-k="subtitle"]', 'Overlay test');
  await set('#slide-editor [data-k="at"]', String(at));
  await set('#slide-editor [data-k="duration"]', String(duration));
  await set('#slide-editor [data-k="fade"]', false);
}

/** Deletes every slide. */
async function deleteSlides(video) {
  while (await video.$('#slide-list .slide-item')) {
    await video.click('#slide-list .slide-item');
    await video.click('#sl-del');
  }
}

/** Makes the export worker fail to start, as where it can't run, until `restore`. */
const breakWorker = (video) => video.evaluate(() => {
  window.__Worker ??= window.Worker;
  window.Worker = class { constructor() { setTimeout(() => this.onerror?.({ message: 'no worker (test)' })); } postMessage() {} terminate() {} };
});
const restoreWorker = (video) => video.evaluate(() => { if (window.__Worker) window.Worker = window.__Worker; delete window.__Worker; });

/** The pixel in the lower band (at 1280×720 scale) and the stamped time, at each of `times`, in `which`: 'out' or 'src'. */
const bandAt = (video, which, times) => video.evaluate(async (which, times) => {
  const v = document.querySelector(which === 'out' ? '#out-video' : '#player');
  const res = [];
  for (const t of times) {
    await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; });
    const c = new OffscreenCanvas(1280, 720).getContext('2d', { willReadFrequently: true });
    c.drawImage(v, 0, 0, 1280, 720);
    res.push({ px: [...c.getImageData(100, 655, 1, 1).data].slice(0, 3), corner: [...c.getImageData(20, 20, 1, 1).data].slice(0, 3), time: lab.frameTime(v) });
  }
  return res;
}, which, times);

const diff = (x, y) => Math.max(...x.map((c, i) => Math.abs(c - y[i])));

/**
 * Muxes the recording's first 3 s of Opus audio (from 0.1 s in) into an MP4 with a short
 * H.264 track, as the worker does where there is no AAC encoder, and decodes it back.
 * `gap` µs of nothing at `gapAt` is what an inserted slide leaves.
 */
function opusMp4(video, clip, { gapAt = Infinity, gap = 0 } = {}) {
  return video.evaluate(async (clip, gapAt, gap) => {
    const { getCapture } = await import('/lib/db.js');
    const { demuxWebm } = await import('/lib/webm.js');
    const { muxMp4 } = await import('/lib/mp4.js');
    const { fillOpusGaps } = await import('/lib/opus.js');
    const src = demuxWebm(await (await getCapture(clip)).blob.arrayBuffer());
    const chunks = [];
    let avcC = null;
    const enc = new VideoEncoder({
      output: (c, md) => { if (md?.decoderConfig?.description) avcC = new Uint8Array(md.decoderConfig.description); const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ timestamp: c.timestamp, duration: c.duration, key: c.type === 'key', data: d }); },
      error: () => {},
    });
    enc.configure({ codec: 'avc1.42e01e', width: 320, height: 240, bitrate: 500000, framerate: 30, avc: { format: 'avc' } });
    const cv = new OffscreenCanvas(320, 240);
    const cx = cv.getContext('2d');
    for (let k = 0; k < 90 + Math.round((gap / 1e6) * 30); k++) {
      cx.fillStyle = `hsl(${k * 4} 60% 50%)`; cx.fillRect(0, 0, 320, 240);
      const f = new VideoFrame(cv, { timestamp: Math.round((k * 1e6) / 30), duration: 33333 });
      enc.encode(f, { keyFrame: k % 30 === 0 }); f.close();
    }
    await enc.flush();
    const packets = src.audio.frames.filter((f) => f.timestamp < 3e6);
    const frames = fillOpusGaps(packets.map((f, i) => ({
      timestamp: f.timestamp + 100000 + (f.timestamp >= gapAt ? gap : 0),
      duration: (packets[i + 1]?.timestamp ?? f.timestamp + 20000) - f.timestamp, key: true, data: f.data,
    })));
    const blob = muxMp4({ video: { width: 320, height: 240, avcC, frames: chunks }, audio: { codec: 'opus', sampleRate: 48000, channels: src.audio.channels, opusHead: src.audio.description, frames } });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    const audio = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(bytes.buffer.slice(0));
    // The loudest sample in a stretch of the decoded sound (in the file's own time,
    // which starts where the audio does).
    const level = (from, to) => {
      const d = audio.getChannelData(0).subarray(Math.round(from * audio.sampleRate), Math.round(to * audio.sampleRate));
      return d.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    };
    const v = document.createElement('video');
    v.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video element could not load it')); });
    const recorded = (frames.at(-1).timestamp + frames.at(-1).duration - frames[0].timestamp) / 1e6;
    const a0 = frames[0].timestamp / 1e6;
    const g = (gapAt + 100000) / 1e6 - a0; // where the gap starts in the decoded sound
    return {
      hasOpus: text.includes('dOps'), hasEdit: text.includes('elst'), audioSeconds: audio.duration, recorded, delay: a0, videoSeconds: v.duration,
      gapLevel: gap ? level(g + 0.1, g + gap / 1e6 - 0.1) : 0, afterLevel: gap ? level(g + gap / 1e6 + 0.1, g + gap / 1e6 + 0.6) : 0,
    };
  }, clip, gapAt, gap);
}

export const tests = {
  async 'MP4 export: whole clip, faster than real time'({ exportAs, video }) {
    await video.click('#formats [data-f="mp4"]');
    // The button gives a ceiling for the size, which the file must stay under.
    const est = await video.$eval('#convert-size', (e) => e.textContent);
    const [, n, unit] = est.match(/([\d.]+) (KB|MB)/) || [];
    const ceiling = Number(n) * (unit === 'MB' ? 1048576 : 1024);
    const r = await exportAs('mp4');
    ok(ceiling && r.size <= ceiling * 1.05, `${r.size} bytes against "${est}"`);
    ok(!r.failed && r.type === 'video/mp4', `export failed: ${r.failed || r.type}`);
    ok(!r.fallback, `fell back to real-time export: ${r.fallback}`);
    ok(r.width === 1280 && r.height === 720, `size ${r.width}×${r.height}`);
    near(r.duration, 8, 0.15, 'duration');
    near(r.first, 0, 0.05, 'first frame time');
    ok(r.ms < 8000, `took ${r.ms} ms for an 8 s clip`);
    return `${r.ms} ms, ${Math.round(r.size / 1024)} KB`;
  },

  async 'timeline: a drag chooses the part to keep, a click moves, F opens the frame in the editor'({ browser, video }) {
    const tr = await video.evaluate(() => { const r = document.querySelector('#track').getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width }; });
    const st = () => video.evaluate(() => ({ start: Number(document.querySelector('#t-start').value), end: Number(document.querySelector('#t-end').value), now: document.querySelector('#player').currentTime, len: document.querySelector('#range-len').textContent }));
    try {
      await video.mouse.move(tr.x + tr.w * 0.25, tr.y);
      await video.mouse.down();
      await video.mouse.move(tr.x + tr.w * 0.5, tr.y, { steps: 6 });
      await video.mouse.up();
      let r = await st();
      near(r.start, 2, 0.15, 'start');
      near(r.end, 4, 0.15, 'end');
      ok(r.len === `${(r.end - r.start).toFixed(1)} s`, `length on the timeline: ${r.len}`);
      await video.mouse.click(tr.x + tr.w * 0.75, tr.y);
      await sleep(150);
      r = await st();
      near(r.now, 6, 0.15, 'a click moves the playhead');
      ok(r.start > 1.8 && r.end < 4.2, 'a click keeps the trim');
      // GIF and WebP have no size until they are made.
      await video.click('#formats [data-f="gif"]');
      ok(!(await video.$eval('#convert-size', (e) => e.textContent)), 'no guess for GIF');
      await video.click('#formats [data-f="mp4"]');
      const before = new Set(browser.targets());
      await video.evaluate(() => document.activeElement?.blur());
      await video.keyboard.press('f');
      const target = await browser.waitForTarget((x) => !before.has(x) && x.url().includes('editor.html?id='), { timeout: 15000 });
      const ed = await prepare(await target.page()); // waited on from here, as Windows runners need
      await ed.bringToFront();
      await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
      const e = await ed.evaluate(() => ({ name: document.querySelector('#doc-name').textContent, size: captodeEditor.size() }));
      ok(e.size.join() === '1280,720' && /0:06\.\d$/.test(e.name), JSON.stringify(e));
      await ed.close();
    } finally {
      await video.evaluate(() => { const d = document.querySelector('#player').duration; document.querySelector('#t-start').value = '0'; document.querySelector('#t-end').value = d.toFixed(1); document.querySelector('#t-end').dispatchEvent(new Event('input', { bubbles: true })); });
      await video.bringToFront();
    }
  },

  async 'WebM export keeps the original audio'({ exportAs }) {
    const r = await exportAs('webm');
    ok(!r.failed && r.type === 'video/webm', `export failed: ${r.failed || r.type}`);
    ok(!r.fallback, `fell back to real-time export: ${r.fallback}`);
    near(r.duration, 8, 0.15, 'duration');
    return `${r.ms} ms, ${Math.round(r.size / 1024)} KB`;
  },

  async 'trimmed export starts and ends on the right frames'({ exportAs, set, sourceFrames }) {
    await set('#t-start', '2.5');
    await set('#t-end', '5.5');
    const r = await exportAs('mp4');
    near(r.duration, 3, 0.1, 'duration');
    // Each end must be the recording's own frame at that point, give or take one frame
    // (on a busy machine the recording has gaps, so frames aren't evenly spaced).
    const check = async (got, t, what) => {
      const [lo, hi] = await sourceFrames(t);
      ok(got >= lo - 0.005 && got <= hi + 0.005, `${what} ${got}, expected the recording's frame at ${t.toFixed(2)} s (${lo} to ${hi})`);
    };
    await check(r.first, 2.5 + 0.02, 'first frame time');
    await check(r.last, 5.45, 'last frame time');
    await set('#t-start', '0');
    await set('#t-end', '8');
  },

  async 'MP4 audio lasts as long as the video'({ exportAs, mp4AudioSeconds }) {
    const r = await exportAs('mp4');
    const audio = await mp4AudioSeconds();
    near(audio, r.duration, 0.15, 'audio length');
  },

  async 'MP4 can carry the original Opus audio (used where there is no AAC encoder)'({ video, clip }) {
    const r = await opusMp4(video, clip);
    ok(r.hasOpus && r.hasEdit, `missing boxes: ${JSON.stringify(r)}`);
    // As much audio as was recorded (it can start a little late), and the movie
    // spans the delayed audio.
    near(r.audioSeconds, r.recorded, 0.1, 'Opus audio length');
    ok(r.videoSeconds >= Math.max(3, r.delay + r.recorded) - 0.1, `movie length ${r.videoSeconds}`);
  },

  async 'Opus audio in MP4 stays in step across an inserted slide, silent while it shows'({ video, clip }) {
    // A 1 s slide at 1 s: the sound after it moves 1 s later.
    const r = await opusMp4(video, clip, { gapAt: 1e6, gap: 1e6 });
    near(r.audioSeconds, r.recorded, 0.1, 'Opus audio length with the gap');
    ok(r.gapLevel < 0.01, `sound during the slide: ${r.gapLevel}`);
    ok(r.afterLevel > 0.05, `no sound after the slide: ${r.afterLevel}`);
  },

  async 'GIF and WebP export, with and without a device frame'({ video, exportAs, set }) {
    const gif = await exportAs('gif');
    ok(gif.type === 'image/gif' && gif.frames > 30, `GIF: ${JSON.stringify(gif)}`);
    const webp = await exportAs('webp');
    ok(webp.type === 'image/webp' && webp.frames > 30, `WebP: ${JSON.stringify(webp)}`);
    await set('#g-lossy', '40');
    const lossy = await exportAs('gif');
    ok(lossy.size < gif.size, `lossy GIF ${lossy.size} not smaller than ${gif.size}`);
    await set('#g-lossy', '0');
    // Scroll the switch clear of the sticky export bar before clicking it.
    const toggle = async () => {
      await video.evaluate(() => {
        document.querySelector('#device-section').open = true;
        document.querySelector('#device-panel input[data-k="enabled"]').scrollIntoView({ block: 'center' });
      });
      await video.click('#device-panel input[data-k="enabled"]');
    };
    await toggle();
    await sleep(200);
    const framed = await exportAs('gif');
    ok(framed.corner[3] === 0, `device frame corner should be transparent: ${framed.corner}`);
    ok(framed.width !== gif.width, 'device frame should change the size');
    await toggle();
    return `GIF ${gif.ms} ms ${Math.round(gif.size / 1024)} KB (lossy 40: ${Math.round(lossy.size / 1024)} KB), WebP ${webp.ms} ms ${Math.round(webp.size / 1024)} KB`;
  },

  async 'exports keep the colours of the recording, and say which colours they are'({ browser, url }) {
    // A recording of colour patches (brand colours, primaries, greys), as Chrome
    // records a tab: VP9 with the BT.601 matrix.
    const COLOURS = ['#6c56ff', '#e5484d', '#ffb224', '#30a46c', '#ff0000', '#00ff00', '#0000ff', '#00b8d9',
      '#1e1e1e', '#808080', '#f5f5f5', '#c9a227', '#0f62fe', '#ff6b9a', '#4a3aa8', '#e8f5e9'];
    const lab = await open(browser, url('lab/lab.html'));
    await lab.bringToFront();
    const id = await lab.evaluate(async (COLOURS) => {
      const { record } = await import('/lib/recorder.js');
      const { putCapture } = await import('/lib/db.js');
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720; document.body.append(c);
      const g = c.getContext('2d');
      let t = 0;
      const draw = () => {
        COLOURS.forEach((col, i) => { g.fillStyle = col; g.fillRect((i % 4) * 320, Math.floor(i / 4) * 180, 320, 180); });
        g.fillStyle = '#000'; g.fillRect(10 + (t++ % 50), 5, 4, 4);
      };
      draw();
      const timer = setInterval(draw, 33);
      const s = await record(c.captureStream(30), { fps: 30 });
      await new Promise((r) => setTimeout(r, 2000));
      const { blob, meta } = await s.stop();
      clearInterval(timer);
      return putCapture(blob, meta);
    }, COLOURS);
    await lab.close();
    const page = await open(browser, url(`video/video.html?id=${id}`), { width: 1440, height: 900 });
    await page.bringToFront();
    await page.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
    // The worst difference from the true colours, over all patches, in a frame 1 s in.
    const measure = (src) => page.evaluate(async (src, COLOURS) => {
      const blob = await (await fetch(src)).blob();
      let d, w;
      if (blob.type.startsWith('video')) {
        const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob);
        await new Promise((r) => { v.onloadeddata = r; });
        v.currentTime = 1; await new Promise((r) => { v.onseeked = r; });
        w = v.videoWidth;
        const k = new OffscreenCanvas(w, v.videoHeight).getContext('2d', { willReadFrequently: true });
        k.drawImage(v, 0, 0); d = k.getImageData(0, 0, w, v.videoHeight).data;
      } else {
        const bmp = await createImageBitmap(blob);
        w = bmp.width;
        const k = new OffscreenCanvas(w, bmp.height).getContext('2d', { willReadFrequently: true });
        k.drawImage(bmp, 0, 0); d = k.getImageData(0, 0, w, bmp.height).data;
      }
      const s = w / 1280;
      let worst = 0, where = '';
      COLOURS.forEach((col, i) => {
        const x = Math.round(((i % 4) * 320 + 160) * s), y = Math.round((Math.floor(i / 4) * 180 + 90) * s);
        const k = (y * w + x) * 4;
        const e = Math.max(...[1, 3, 5].map((j, c) => Math.abs(parseInt(col.slice(j, j + 2), 16) - d[k + c])));
        if (e > worst) { worst = e; where = `${col} came out rgb(${d[k]}, ${d[k + 1]}, ${d[k + 2]})`; }
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const find = (seq) => bytes.findIndex((_, i) => seq.every((b, j) => bytes[i + j] === b));
      const at = find([0x63, 0x6f, 0x6c, 0x72]); // 'colr'
      const webmColour = find([0x55, 0xb0]) >= 0;
      return { worst, where, colr: at >= 0 ? [...bytes.slice(at + 4, at + 15)] : null, webmColour };
    }, src, COLOURS);
    const notes = [];
    for (const f of ['mp4', 'webm', 'gif', 'webp']) {
      await page.click(`#formats [data-f="${f}"]`);
      await sleep(100);
      await page.click('#convert');
      await page.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 180000, polling: 100 });
      const out = await page.evaluate(() => (document.querySelector('#out-video:not(.hidden)') || document.querySelector('#out-img:not(.hidden)'))?.src);
      ok(out, `${f} export failed`);
      const r = await measure(out);
      // Compression costs a few levels; the wrong colour matrix cost up to 40.
      ok(r.worst <= 8, `${f}: ${r.where}`);
      if (f === 'mp4') {
        // nclx: sRGB primaries (1) and transfer (13), and the matrix the encoder used:
        // BT.709 (1) for hardware encoders, BT.601 (6) for Chrome's software H.264.
        ok(r.colr && String.fromCharCode(...r.colr.slice(0, 4)) === 'nclx' && /^0,1,0,13,0,[16],0$/.test(r.colr.slice(4, 11).join()), `MP4 colour tag ${r.colr}`);
      }
      if (f === 'webm') ok(r.webmColour, 'WebM has no Colour element');
      notes.push(`${f} ±${r.worst}`);
      await page.click('#redo-export').catch(() => {});
    }
    await page.close();
    return notes.join(', ');
  },

  async 'the video page remembers the format, resolution and frame rate'({ browser, url, clip }) {
    const page = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
    const ready = () => page.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent) && document.querySelector('#formats .on'), { polling: 100 });
    await ready();
    await page.click('#formats [data-f="gif"]');
    const res = await page.$eval('#res', (e) => [...e.options].map((o) => o.value).find((v) => v !== '0' && v !== e.value));
    await page.select('#res', res);
    await page.select('#fps', '10');
    await page.waitForFunction(async (res) => (await chrome.storage.local.get('lastExport')).lastExport?.video?.controls?.gif?.res === res, { polling: 100 }, res);
    await page.reload();
    await ready();
    const got = await page.evaluate(() => [document.querySelector('#formats .on').dataset.f, document.querySelector('#res').value, document.querySelector('#fps').value].join());
    ok(got === `gif,${res},10`, `remembered ${got}, expected gif,${res},10`);
    await page.evaluate(() => chrome.storage.local.remove('lastExport'));
    await page.close();
  },

  async 'video presets set the format, resolution and frame rate'({ browser, url, clip }) {
    const page = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
    await page.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent) && document.querySelector('#presets .preset-select option'), { polling: 100 });
    await page.select('#presets .preset-select', 'chat-gif');
    await page.waitForFunction(() => document.querySelector('#formats .on')?.dataset.f === 'gif', { polling: 100 });
    const got = await page.evaluate(() => [document.querySelector('#res').value, document.querySelector('#fps').value, document.querySelector('#g-lossy').value].join());
    ok(got === '480,15,20', `chat GIF: ${got}`);
    await page.click('#formats [data-f="mp4"]');
    ok(await page.$eval('#presets .preset-select', (e) => e.value) === '', 'choosing a format by hand makes it custom');
    await page.evaluate(() => chrome.storage.local.remove('lastExport'));
    await page.close();
  },

  async 'the original WebM download keeps everything and says its colours'({ video }) {
    await video.evaluate(() => { window.__download = null; HTMLAnchorElement.prototype.click = function () { window.__download = { name: this.download, href: this.href }; }; });
    await video.click('#dl-original');
    await video.waitForFunction(() => window.__download, { polling: 100 });
    const r = await video.evaluate(async () => {
      const { demuxWebm } = await import('/lib/webm.js');
      const blob = await (await fetch(window.__download.href)).blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const colour = bytes.findIndex((b, i) => b === 0x55 && bytes[i + 1] === 0xb0) >= 0;
      const original = demuxWebm(await (await fetch(document.querySelector('#player').src)).arrayBuffer());
      const copy = demuxWebm(bytes.buffer);
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(blob);
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('does not play')); });
      if (!isFinite(v.duration)) { v.currentTime = 1e9; await new Promise((res) => { v.ontimeupdate = res; }); }
      const sound = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(bytes.buffer.slice(0)).then((b) => b.duration, () => 0);
      return {
        name: window.__download.name, colour,
        frames: [original.video.frames.length, copy.video.frames.length],
        audioPackets: [original.audio?.frames.length, copy.audio?.frames.length],
        size: [v.videoWidth, v.videoHeight, document.querySelector('#player').videoWidth, document.querySelector('#player').videoHeight],
        duration: v.duration, sound,
      };
    });
    ok(/^captode-recording-\d+\.webm$/.test(r.name), `file name ${r.name}`);
    ok(r.colour, 'the colour space is written into the file');
    ok(r.frames[0] === r.frames[1] && r.audioPackets[0] === r.audioPackets[1], `every frame and sound packet kept: ${JSON.stringify(r)}`);
    ok(r.size[0] === r.size[2] && r.size[1] === r.size[3], `same size: ${r.size}`);
    ok(r.duration > 7 && r.sound > 7, `plays for its full length, with sound: ${r.duration} s, sound ${r.sound} s`);
  },

  async 'review a frame: measure with edge snapping and check colours on a paused frame'({ video }) {
    await video.evaluate(() => { document.querySelector('#review-section').open = true; document.querySelector('#review-section').scrollIntoView(); });
    await video.click('#rv-tools [data-rt="measure"]');
    ok(await video.evaluate(() => document.querySelector('#player').paused && !document.querySelector('#rv-overlay').classList.contains('hidden')), 'the video pauses and the layer shows');
    // The clip's time blocks are 90 px wide, at x = 40 + 100n, from y = 400 to 600.
    const at = (x, y) => video.evaluate((x, y) => {
      const r = document.querySelector('#rv-overlay').getBoundingClientRect();
      const v = document.querySelector('#player');
      return [r.left + (x / v.videoWidth) * r.width, r.top + (y / v.videoHeight) * r.height];
    }, x, y);
    await video.mouse.move(...(await at(36, 500)));
    await video.mouse.down();
    await video.mouse.move(...(await at(134, 502)), { steps: 5 });
    await video.mouse.up();
    const text = await video.$eval('#rv-m', (e) => e.textContent);
    ok(text === '90 px', `a block measures ${text}`);
    // Colours: the background and a block.
    await video.click('#rv-tools [data-rt="pick"]');
    await video.mouse.click(...(await at(20, 300)));
    await video.mouse.click(...(await at(85, 450)));
    const contrast = await video.$eval('#rv-c', (e) => e.textContent);
    ok(/Contrast \d+\.\d\d : 1/.test(contrast), `contrast: ${contrast}`);
    // Playing again hides the layer.
    await video.evaluate(() => document.querySelector('#player').play());
    await video.waitForFunction(() => document.querySelector('#rv-overlay').classList.contains('hidden'), { polling: 100 });
    await video.evaluate(() => document.querySelector('#player').pause());
  },

  async 'slides: shown in playback, put into the export at their moment, with the sound after them'({ video, exportAs, set, mp4AudioSeconds, clip }) {
    await video.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 2; });
    await sleep(200);
    await video.click('#slide-add');
    await video.type('#sl-title', 'Slides test');
    await video.click('#sl-themes [data-theme="paper"]'); // white: easy to tell from the recording
    await set('#slide-editor [data-k="duration"]', '2');
    await set('#slide-editor [data-k="fade"]', false);
    try {
      const ui = await video.evaluate(() => ({
        view: !document.querySelector('#slide-view').classList.contains('hidden'),
        marks: document.querySelectorAll('#slide-marks .slide-mark').length,
        item: document.querySelector('#slide-list .slide-item b').textContent,
        length: document.querySelector('#dims b').textContent,
        timeline: document.querySelector('#tc-len').textContent,
        timelineTitle: document.querySelector('#tc-len').title,
        adds: document.querySelector('#slide-marks .slide-mark').dataset.adds,
        label: getComputedStyle(document.querySelector('#slide-marks .slide-mark'), '::after').opacity,
      }));
      ok(ui.view && ui.marks === 1 && ui.item === 'Slides test', JSON.stringify(ui));
      ok(ui.length === '10.0 s', `length with the slide: ${ui.length}`);
      // The timeline says how long the export is with the slide, and its marker what it adds.
      ok(ui.timeline === '10.0 s with slides' && /8\.0 s of the recording and 2\.0 s of slides/.test(ui.timelineTitle), `timeline: ${ui.timeline} (${ui.timelineTitle})`);
      ok(ui.adds === '+2 s' && Number(ui.label) > 0.5,  `marker: ${ui.adds}, label shown: ${ui.label}`);

      // Playback stops at the slide, shows it for its time, then carries on.
      await video.evaluate(() => { const p = document.querySelector('#player'); p.currentTime = 1.6; });
      await sleep(200);
      await video.evaluate(() => document.querySelector('#player').play());
      await video.waitForFunction(() => document.querySelector('#player').paused && !document.querySelector('#slide-view').classList.contains('hidden'), { timeout: 4000, polling: 50 });
      await video.waitForFunction(() => !document.querySelector('#player').paused && document.querySelector('#slide-view').classList.contains('hidden'), { timeout: 4000, polling: 50 });
      await video.evaluate(() => document.querySelector('#player').pause());

      const r = await exportAs('mp4');
      ok(!r.failed && !r.fallback, `export: ${r.failed || r.fallback}`);
      near(r.duration, 10, 0.15, 'duration with a 2 s slide');
      const f = await video.evaluate(async () => {
        const out = document.querySelector('#out-video');
        const seek = (t) => new Promise((res) => { out.addEventListener('seeked', res, { once: true }); out.currentTime = t; });
        await seek(3);
        const c = new OffscreenCanvas(out.videoWidth, out.videoHeight).getContext('2d', { willReadFrequently: true });
        c.drawImage(out, 0, 0);
        const slide = [...c.getImageData(20, 20, 1, 1).data].slice(0, 3);
        await seek(5);
        return { slide, after: lab.frameTime(out) };
      });
      ok(f.slide.every((c) => c > 240), `the slide at 3 s: ${f.slide}`);
      near(f.after, 3, 0.1, 'the recording carries on from where it waited');
      near(await mp4AudioSeconds(), 10, 0.2, 'audio length');
      // WebM copies the recording's Opus sound: silence fills the slide's time.
      const w = await exportAs('webm');
      near(w.duration, 10, 0.15, 'WebM duration with a 2 s slide');
      near(await mp4AudioSeconds(), 10, 0.2, 'WebM audio length');

      const saved = await video.evaluate(async (clip) => {
        const { getCapture } = await import('/lib/db.js');
        return (await getCapture(clip)).slides?.map((s) => [s.title, s.at, s.duration]);
      }, clip);
      ok(saved?.length === 1 && saved[0].join() === 'Slides test,2,2', `kept with the recording: ${JSON.stringify(saved)}`);

      // An opening slide, in a GIF: its colours are in the palette.
      await set('#slide-editor [data-k="at"]', '0');
      const g = await exportAs('gif');
      ok(!g.failed && g.corner.slice(0, 3).every((c) => c > 240), `first GIF frame: ${g.failed || g.corner}`);
      return `${r.ms} ms MP4, ${g.ms} ms GIF`;
    } finally {
      await video.click('#sl-del');
      await video.click('#formats [data-f="mp4"]');
    }
  },

  async 'overlay slides: drawn over the playing recording, adding no time and keeping the sound'({ video, exportAs, set, mp4AudioSeconds }) {
    await video.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 2; });
    await sleep(200);
    await video.click('#slide-add');
    await video.click('#sl-mode [data-v="overlay"]');
    await video.click('#sl-themes [data-theme="paper"]'); // a white band: easy to tell from the recording
    await video.click('#sl-layout [data-v="lower"]');
    // Only a subtitle, so the band stays below the clip's time stamp.
    await set('#slide-editor [data-k="subtitle"]', 'Overlay test');
    await set('#slide-editor [data-k="duration"]', '2');
    await set('#slide-editor [data-k="fade"]', false);
    try {
      const ui = await video.evaluate(() => {
        const mark = document.querySelector('#slide-marks .slide-mark');
        return {
          length: document.querySelector('#dims b').textContent,
          bar: mark.classList.contains('overlay') && mark.getBoundingClientRect().width / document.querySelector('#track').getBoundingClientRect().width,
          bg: document.querySelector('#sl-bg-opts').classList.contains('hidden'),
          band: !document.querySelector('#sl-band-f').classList.contains('hidden'),
        };
      });
      ok(ui.length === '8.0 s', `length with the overlay: ${ui.length}`);
      ok(ui.bar > 0.2 && ui.bar < 0.3, `the marker is a bar 2 s of 8 long: ${ui.bar}`);
      ok(ui.bg && ui.band, `no background options, a band switch: ${JSON.stringify(ui)}`);

      // Playback doesn't stop for it: the overlay shows while the recording plays on.
      await video.evaluate(() => { document.querySelector('#player').currentTime = 1.6; });
      await sleep(200);
      await video.evaluate(() => document.querySelector('#player').play());
      await video.waitForFunction(() => { const p = document.querySelector('#player'); return !p.paused && p.currentTime > 2.3 && !document.querySelector('#slide-view').classList.contains('hidden'); }, { timeout: 4000, polling: 50 });
      await video.waitForFunction(() => document.querySelector('#player').currentTime > 4.2 && document.querySelector('#slide-view').classList.contains('hidden'), { timeout: 4000, polling: 50 });
      await video.evaluate(() => document.querySelector('#player').pause());

      const r = await exportAs('mp4');
      ok(!r.failed && !r.fallback, `export: ${r.failed || r.fallback}`);
      near(r.duration, 8, 0.15, 'duration with a 2 s overlay');
      const f = await video.evaluate(async () => {
        const at = async (v, t) => {
          await new Promise((res) => { v.addEventListener('seeked', res, { once: true }); v.currentTime = t; });
          const c = new OffscreenCanvas(1280, 720).getContext('2d', { willReadFrequently: true });
          c.drawImage(v, 0, 0, 1280, 720);
          return { px: [...c.getImageData(100, 655, 1, 1).data].slice(0, 3), time: lab.frameTime(v) };
        };
        const out = document.querySelector('#out-video');
        const src = document.querySelector('#player');
        return { a: await at(out, 3), b: await at(out, 3.6), source: await at(src, 3), after: await at(out, 5) };
      });
      const diff = (x, y) => Math.max(...x.map((c, i) => Math.abs(c - y[i])));
      ok(diff(f.a.px, f.source.px) > 60 && f.a.px.every((c) => c > 160), `the band at 3 s: ${f.a.px}, the recording: ${f.source.px}`);
      ok(diff(f.after.px, f.source.px) < 30, `no band at 5 s: ${f.after.px}`);
      near(f.a.time, 3, 0.1, 'the recording plays under the overlay');
      near(f.b.time, 3.6, 0.1, 'and carries on under it');
      near(await mp4AudioSeconds(), 8, 0.2, 'audio length');
    } finally {
      await video.click('#sl-del');
    }
  },
  async 'overlay slides in the in-page GIF export: over the clip frames, adding none'({ video, exportAs, set }) {
    await addOverlay(video, set, 2);
    await breakWorker(video);
    await set('#optimize', false); // every frame kept, so frame n is at n / fps
    try {
      const r = await exportAs('gif');
      ok(!r.failed && r.type === 'image/gif', `export: ${r.failed || r.type}`);
      ok(r.fallback, 'the in-page exporter made it');
      const fps = Number(await video.$eval('#fps', (e) => e.value));
      // As many frames as the clip has (overlays add none): what the page said it would make.
      // Not 8 s × fps: the recording can come out a frame or two short of 8 s.
      const planned = Number((await video.$eval('#dims', (e) => e.textContent)).match(/(\d+) frames/)[1]);
      ok(r.frames === planned, `${r.frames} frames at ${fps} fps, ${planned} planned`);
      const times = [3, 6];
      const out = await video.evaluate(async (times, fps) => {
        const blob = await (await fetch(document.querySelector('#out-img').src)).blob();
        const d = new ImageDecoder({ data: blob.stream(), type: blob.type });
        await d.completed;
        const res = [];
        for (const t of times) {
          const { image } = await d.decode({ frameIndex: Math.round(t * fps) });
          const c = new OffscreenCanvas(1280, 720).getContext('2d', { willReadFrequently: true });
          c.drawImage(image, 0, 0, 1280, 720);
          image.close();
          res.push([...c.getImageData(100, 655, 1, 1).data].slice(0, 3));
        }
        return res;
      }, times, fps);
      const src = (await bandAt(video, 'src', times)).map((f) => f.px);
      ok(diff(out[0], src[0]) > 60 && out[0].every((c) => c > 160), `the band at 3 s: ${out[0]}, the recording: ${src[0]}`);
      ok(diff(out[1], src[1]) < 40, `no band at 6 s: ${out[1]}, the recording: ${src[1]}`);
      return `${r.ms} ms`;
    } finally {
      await set('#optimize', true);
      await restoreWorker(video);
      await deleteSlides(video);
      await video.click('#formats [data-f="mp4"]');
    }
  },

  async 'overlay slides in the in-page MP4 export: drawn over the clip, adding no time'({ video, exportAs, set }) {
    await addOverlay(video, set, 2);
    await breakWorker(video);
    try {
      const r = await exportAs('mp4');
      ok(!r.failed && /^video\//.test(r.type), `export: ${r.failed || r.type}`);
      ok(r.fallback, 'the in-page exporter made it');
      near(r.duration, 8, 0.25, 'duration with a 2 s overlay');
      const [a, after] = await bandAt(video, 'out', [3, 6]);
      const [src, srcAfter] = await bandAt(video, 'src', [3, 6]);
      ok(diff(a.px, src.px) > 60 && a.px.every((c) => c > 160), `the band at 3 s: ${a.px}, the recording: ${src.px}`);
      ok(diff(after.px, srcAfter.px) < 40, `no band at 6 s: ${after.px}, the recording: ${srcAfter.px}`);
      return `${r.ms} ms`;
    } finally {
      await restoreWorker(video);
      await deleteSlides(video);
    }
  },

  async 'overlay slides wait while an inserted slide shows'({ video, exportAs, set }) {
    // An overlay over the clip from 2 s to 5 s, and a 1 s slide put in at 3 s.
    await addOverlay(video, set, 2, 3);
    await video.evaluate(() => { document.querySelector('#player').currentTime = 3; });
    await sleep(200);
    await video.click('#slide-add');
    await video.click('#sl-mode [data-v="insert"]');
    await set('#slide-editor [data-k="at"]', '3');
    await set('#slide-editor [data-k="duration"]', '1');
    await set('#slide-editor [data-k="fade"]', false);
    try {
      const r = await exportAs('mp4');
      ok(!r.failed && !r.fallback, `export: ${r.failed || r.fallback}`);
      near(r.duration, 9, 0.15, 'duration with a 1 s slide');
      // Output 2.9 s is the clip's 2.9 s; 4.1 s its 3.1 s; 5.5 s its 4.5 s (still under
      // the overlay, which ends by the clip's time); 6.5 s its 5.5 s, after it.
      const [before, slide, after, late, gone] = await bandAt(video, 'out', [2.9, 3.5, 4.1, 5.5, 6.5]);
      const src = await bandAt(video, 'src', [2.9, 3.1, 4.5, 5.5]);
      ok(slide.corner.every((c) => c > 240), `the slide at 3.5 s: ${slide.corner}`);
      for (const [f, s, what] of [[before, src[0], 'just before the slide'], [after, src[1], 'just after the slide'], [late, src[2], 'at 5.5 s (the clip\'s 4.5 s)']]) {
        ok(diff(f.px, s.px) > 60 && f.px.every((c) => c > 160), `the band ${what}: ${f.px}, the recording: ${s.px}`);
      }
      ok(diff(gone.px, src[3].px) < 30, `no band at 6.5 s (the clip's 5.5 s): ${gone.px}`);
      near(before.time, 2.9, 0.1, 'the clip before the slide');
      near(after.time, 3.1, 0.1, 'the clip carries on from 3 s after the slide');
      near(late.time, 4.5, 0.1, 'and stays 1 s behind');
    } finally {
      await deleteSlides(video);
    }
  },

  async 'overlay slides: over the whole recording, sliding in, and shown with the others while edited'({ video, exportAs, set }) {
    await addOverlay(video, set, 1);
    await set('#slide-editor [data-k="whole"]', true);
    await set('#slide-editor [data-k="slideIn"]', true);
    const timing = () => video.evaluate(() => {
      const f = (k) => document.querySelector(`#slide-editor [data-k="${k}"]`);
      return { at: f('at').value, duration: f('duration').value, locked: f('at').disabled && f('duration').disabled };
    });
    try {
      let t = await timing();
      ok(t.at === '0.0' && t.duration === '8' && t.locked, `over the whole recording: ${JSON.stringify(t)}`);
      // It follows the trim.
      await set('#t-start', '2');
      await set('#t-end', '6');
      await video.waitForFunction(() => document.querySelector('#slide-editor [data-k="at"]').value === '2.0', { timeout: 3000, polling: 50 });
      t = await timing();
      ok(t.duration === '4', `after trimming to 2–6 s: ${JSON.stringify(t)}`);
      const r = await exportAs('mp4');
      ok(!r.failed && !r.fallback, `export: ${r.failed || r.fallback}`);
      near(r.duration, 4, 0.15, 'trimmed duration');
      const [mid] = await bandAt(video, 'out', [2]);
      const [src] = await bandAt(video, 'src', [4]);
      ok(diff(mid.px, src.px) > 60 && mid.px.every((c) => c > 160), `the band mid-way: ${mid.px}, the recording: ${src.px}`);

      // Sliding in: moved left on its first and last frames, in place between.
      const look = await video.evaluate(async () => {
        const { overlayLook } = await import('/lib/slides.js');
        const e = { s: { slideIn: true, fade: false }, frames: 120 };
        return [0, 60, 119].map((j) => overlayLook(e, j, 30));
      });
      ok(look[0].dx < -0.05 && look[1].dx === 0 && look[2].dx < -0.05 && look.every((x) => x.a === 1), `slide-in: ${JSON.stringify(look)}`);

      // A second overlay being edited shows with the first one under it.
      await video.evaluate(() => { document.querySelector('#player').currentTime = 3; });
      await sleep(200);
      await video.click('#slide-add');
      await video.click('#sl-mode [data-v="overlay"]');
      await video.waitForFunction(() => {
        const v = document.querySelector('#slide-view');
        if (v.classList.contains('hidden') || !v.width) return false;
        const px = v.getContext('2d').getImageData(Math.round((100 * v.width) / 1280), Math.round((655 * v.height) / 720), 1, 1).data;
        return px[3] > 200 && px[0] > 200;
      }, { timeout: 3000, polling: 50 });
    } finally {
      await set('#t-start', '0');
      await set('#t-end', '8');
      await deleteSlides(video);
    }
  },

  async 'slides: the style kept for later recordings can be forgotten, and brought back'({ video }) {
    const stored = () => video.evaluate(async () => !!(await chrome.storage.local.get('slideStyle')).slideStyle);
    const button = () => video.evaluate(() => !document.querySelector('#slide-forget').classList.contains('hidden'));
    await video.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 1; });
    await sleep(200);
    await video.click('#slide-add');
    try {
      await video.click('#sl-themes [data-theme="sunset"]');
      await video.waitForFunction(async () => !!(await chrome.storage.local.get('slideStyle')).slideStyle, { timeout: 5000, polling: 100 });
      ok(await button(), 'no Forget button once a style is kept');
      await video.click('#slide-forget');
      await sleep(200);
      ok(!(await stored()) && !(await button()), 'the style is still kept');
      // Undo puts it back.
      await video.click('.toast-action');
      await sleep(200);
      ok((await stored()) && (await button()), 'Undo did not bring the style back');
    } finally {
      await video.click('#sl-del');
    }
  },

  async 'slides: the words and the logo are dragged and resized on the slide itself'({ video, set, clip }) {
    await video.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 1; });
    await sleep(200);
    await video.click('#slide-add');
    await video.type('#sl-title', 'Drag me');
    await video.click('#sl-themes [data-theme="paper"]');
    await video.evaluate(() => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#f59e0b"/></svg>';
      const input = document.querySelector('#sl-file');
      const dt = new DataTransfer();
      dt.items.add(new File([svg], 'logo.svg', { type: 'image/svg+xml' }));
      input.dataset.target = 'logo';
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    });
    // The slide as saved with the recording, and where its parts are on screen.
    const look = (want) => video.waitForFunction(async (clip, want) => {
      const { getCapture } = await import('/lib/db.js');
      const { drawSlide, slideImages } = await import('/lib/slides.js');
      const s = (await getCapture(clip)).slides?.find((x) => x.title === 'Drag me');
      // The extension's pages allow no eval: the conditions waited for, by name.
      const ready = { logo: !!s?.logo, moved: !!s?.textAt, larger: s?.textSize > 100, placed: !!s?.logoAt, reset: s && !s.logoAt && !s.textAt && s.textSize === 100 };
      if (!s || !ready[want]) return false;
      const v = document.querySelector('#slide-view');
      const [W, H] = [v.width, v.height]; // drawn at the output size (720p)
      const r = drawSlide(new OffscreenCanvas(W, H).getContext('2d'), s, W, H, await slideImages(s));
      const b = v.getBoundingClientRect();
      const css = (q) => q && { x: b.left + (q.x / W) * b.width, y: b.top + (q.y / H) * b.height, w: (q.w / W) * b.width, h: (q.h / H) * b.height };
      return { s, text: css(r.text), logo: css(r.logo), view: { x: b.left, y: b.top, w: b.width, h: b.height } };
    }, { timeout: 5000, polling: 100 }, clip, want);
    const drag = async (x1, y1, x2, y2) => {
      await video.mouse.move(x1, y1);
      await video.mouse.down();
      await video.mouse.move(x2, y2, { steps: 8 });
      await video.mouse.up();
    };
    try {
      let at = await look('logo');
      const t = at.text;
      // The words: moved by 120 × 50 CSS pixels.
      await drag(t.x + t.w / 2, t.y + t.h / 2, t.x + t.w / 2 + 120, t.y + t.h / 2 + 50);
      at = await look('moved');
      near(at.s.textAt.x, 120 / at.view.w, 0.01, 'words moved across');
      near(at.s.textAt.y, 50 / at.view.h, 0.01, 'words moved down');
      ok(await video.evaluate(() => document.querySelector('#player').paused && !document.querySelector('#slide-view').classList.contains('hidden')), 'dragging played the recording');
      // Their corner: larger.
      await drag(at.text.x + at.text.w - 1, at.text.y + at.text.h - 1, at.text.x + at.text.w + 40, at.text.y + at.text.h + 40);
      at = await look('larger');
      // The logo: to the middle, where it snaps.
      const l = at.logo;
      await drag(l.x + l.w / 2, l.y + l.h / 2, at.view.x + at.view.w / 2 + 3, at.view.y + at.view.h / 2 - 3);
      at = await look('placed');
      ok(at.s.logoAt.x === 0.5 && at.s.logoAt.y === 0.5, `logo at ${JSON.stringify(at.s.logoAt)}, not snapped to the middle`);
      ok(await video.$eval('#slide-editor [data-k="logoPos"]', (e) => e.value) === 'custom', 'Position does not say it was put by hand');
      // The form puts both back.
      await set('#slide-editor [data-k="logoPos"]', 'tl');
      await video.click('#sl-text-reset');
      at = await look('reset');
      ok(at.logo.x - at.view.x < at.view.w / 4, 'the logo is not back in the corner');
    } finally {
      await video.click('#sl-del');
    }
  },

  async 'slides: a font file of your own is used in the preview and in the export'({ video, set, exportAs }) {
    await video.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 0; });
    await sleep(200);
    await video.click('#slide-add');
    await video.type('#sl-title', 'Hello fonts');
    await video.click('#sl-themes [data-theme="midnight"]'); // white words on dark, whatever style was kept before
    await video.click('#sl-layout [data-v="center"]');
    await set('#slide-editor [data-k="fade"]', false);
    // Every character of this font is a solid box.
    await video.evaluate((bytes) => {
      const input = document.querySelector('#sl-font-file');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'Brand Box.ttf', { type: 'font/ttf' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    }, [...boxFont()]);
    await video.waitForFunction(() => document.querySelector('#slide-editor [data-k="font"]').value === 'custom', { timeout: 5000, polling: 100 });
    ok(await video.$eval('#sl-font-custom', (o) => o.textContent) === 'Brand Box', 'the font is not listed by its name');
    /** How much of the words' area is white, in the exported MP4's first frame. */
    const inked = async () => {
      const r = await exportAs('mp4');
      ok(!r.failed && !r.fallback, `export: ${r.failed || r.fallback}`);
      return video.evaluate(async () => {
        const out = document.querySelector('#out-video');
        await new Promise((res) => { out.addEventListener('seeked', res, { once: true }); out.currentTime = 0.5; });
        const W = out.videoWidth, H = out.videoHeight;
        const c = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
        c.drawImage(out, 0, 0);
        // The title's line: the middle of the picture, a tenth of it high.
        const d = c.getImageData(W * 0.15, H * 0.45, W * 0.7, H * 0.1).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++;
        return n / (d.length / 4);
      });
    };
    try {
      const own = await inked();
      await set('#slide-editor [data-k="font"]', 'sans');
      const sans = await inked();
      ok(own > sans * 2 && own > 0.08, `white in the title's line: ${own.toFixed(3)} with the font, ${sans.toFixed(3)} without`);
      return `${(own * 100).toFixed(0)}% against ${(sans * 100).toFixed(0)}%`;
    } finally {
      await video.click('#sl-del');
    }
  },

  async 'slides: a brand kit keeps a style with its logo, and puts it on another slide'({ video, clip }) {
    const saved = (title) => video.evaluate(async (clip, title) => {
      const { getCapture } = await import('/lib/db.js');
      const s = (await getCapture(clip)).slides?.find((x) => x.title === title);
      return s && { theme: s.theme, bg1: s.bg1, logo: s.logo?.size || 0 };
    }, clip, title);
    await video.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 1; });
    await sleep(200);
    await video.click('#slide-add');
    await video.type('#sl-title', 'Kit source');
    await video.click('#sl-themes [data-theme="sunset"]');
    await video.evaluate(() => {
      const input = document.querySelector('#sl-file');
      const c = new OffscreenCanvas(40, 20);
      c.getContext('2d').fillRect(0, 0, 40, 20);
      return c.convertToBlob().then((b) => {
        const dt = new DataTransfer();
        dt.items.add(new File([b], 'logo.png', { type: 'image/png' }));
        input.dataset.target = 'logo'; input.files = dt.files; input.dispatchEvent(new Event('change'));
      });
    });
    try {
      await video.waitForFunction(() => !document.querySelector('#sl-logo-opts').classList.contains('hidden'), { polling: 100 });
      // Kept as a kit.
      await video.select('#sl-kits .preset-select', '__save');
      await video.type('#sl-kits .preset-name', 'Acme');
      await video.click('#sl-kits .preset-save [type="submit"]');
      await video.waitForFunction(() => [...document.querySelectorAll('#sl-kits option')].some((o) => o.textContent === 'Acme'), { polling: 100 });
      // A plain slide, then the kit on it.
      await video.evaluate(() => { document.querySelector('#player').currentTime = 3; });
      await sleep(200);
      await video.click('#slide-add');
      await video.type('#sl-title', 'Kit target');
      await video.click('#sl-themes [data-theme="paper"]');
      await video.click('.img-field[data-img="logo"] [data-clear]');
      await video.waitForFunction(async (clip) => {
        const { getCapture } = await import('/lib/db.js');
        const s = (await getCapture(clip)).slides?.find((x) => x.title === 'Kit target');
        return s?.theme === 'paper' && !s.logo;
      }, { polling: 100 }, clip);
      const id = await video.$$eval('#sl-kits option', (os) => os.find((o) => o.textContent === 'Acme').value);
      await video.select('#sl-kits .preset-select', id);
      await video.waitForFunction(async (clip) => {
        const { getCapture } = await import('/lib/db.js');
        return (await getCapture(clip)).slides?.find((x) => x.title === 'Kit target')?.theme === 'sunset';
      }, { timeout: 5000, polling: 100 }, clip);
      const [a, b] = [await saved('Kit source'), await saved('Kit target')];
      ok(b.bg1 === a.bg1 && b.logo === a.logo && b.logo > 0, `the kit's style: ${JSON.stringify({ a, b })}`);
    } finally {
      for (const title of ['Kit target', 'Kit source']) {
        await video.evaluate((title) => [...document.querySelectorAll('#slide-list .slide-item')].find((i) => i.querySelector('b').textContent === title)?.click(), title);
        await video.click('#sl-del');
      }
      await video.evaluate(() => chrome.storage.local.remove('exportPresets'));
    }
  },

  async 'slides: exported to a file and imported again; only what is sensible comes in'({ video }) {
    await video.evaluate(() => { const p = document.querySelector('#player'); p.pause(); p.currentTime = 2; });
    await sleep(200);
    await video.click('#slide-add');
    await video.type('#sl-title', 'Round trip');
    await video.click('#sl-themes [data-theme="ocean"]');
    // Export: the file the button would download.
    const file = await video.evaluate(async () => {
      const real = HTMLAnchorElement.prototype.click;
      let got = null;
      HTMLAnchorElement.prototype.click = function () { got = { name: this.download, href: this.href }; };
      try {
        document.querySelector('#slide-export').click();
        for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 50));
      } finally { HTMLAnchorElement.prototype.click = real; }
      return { name: got.name, text: await (await fetch(got.href)).text() };
    });
    const json = JSON.parse(file.text);
    ok(file.name.endsWith('.json') && json.type === 'captode-slides' && json.slides.some((x) => x.title === 'Round trip' && x.theme === 'ocean'), `exported: ${file.text.slice(0, 200)}`);
    // Import it, with a slide of nonsense alongside.
    const before = await video.$$eval('#slide-list .slide-item', (x) => x.length);
    const hostile = {
      title: 'Hostile', at: 1e12, duration: -5, theme: 'nope', titleColor: 'red;</style>', bg1: '#123456', layout: 'evil',
      logo: 'javascript:alert(1)', picture: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', fontFile: 'data:text/html;base64,PGI+',
      textAt: { x: 'a', y: 2 }, logoAt: { x: 9, y: -9 }, fade: 'yes', extra: { nested: true },
    };
    await video.evaluate((text) => {
      const input = document.querySelector('#slide-import-file');
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'slides.json', { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      // A "__proto__" key, as only a file (not an object literal) can carry one.
    }, JSON.stringify({ ...json, slides: [...json.slides.filter((x) => x.title === 'Round trip'), hostile] })
      .replace('"title":"Hostile"', '"__proto__":{"polluted":true},"title":"Hostile"'));
    await video.waitForFunction((n) => document.querySelectorAll('#slide-list .slide-item').length === n + 2, { timeout: 5000, polling: 100 }, before);
    try {
      const r = await video.evaluate(async () => {
        const { cleanFields } = await import('/lib/slides.js');
        const c = await cleanFields({
          title: 'Hostile', at: 1e12, duration: -5, theme: 'nope', titleColor: 'red;</style>', bg1: '#123456', layout: 'evil',
          logo: 'javascript:alert(1)', picture: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', fontFile: 'data:text/html;base64,PGI+',
          textAt: { x: 'a', y: 2 }, logoAt: { x: 9, y: -9 }, fade: 'yes', extra: { nested: true },
        });
        const items = [...document.querySelectorAll('#slide-list .slide-item b')].map((b) => b.textContent);
        return { c, items, polluted: ({}).polluted };
      });
      ok(r.items.filter((x) => x === 'Round trip').length === 2 && r.items.includes('Hostile'), `list: ${r.items}`);
      ok(JSON.stringify(r.c) === JSON.stringify({ bg1: '#123456', at: 86400, duration: 0.5, title: 'Hostile', logoAt: { x: 1, y: 0 } }), `cleaned: ${JSON.stringify(r.c)}`);
      ok(r.polluted === undefined, 'prototype polluted');
    } finally {
      for (const title of ['Hostile', 'Round trip', 'Round trip']) {
        await video.evaluate((title) => [...document.querySelectorAll('#slide-list .slide-item')].find((i) => i.querySelector('b').textContent === title)?.click(), title);
        await video.click('#sl-del');
      }
    }
  },
};
