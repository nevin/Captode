// Video page: exporting a recording to MP4, WebM, GIF and WebP in the worker,
// with trims that land on the right frames, audio, and device frames.
import { open, recordClip, ok, near, sleep } from './helpers.mjs';

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
  return { video: page, exportAs, set, mp4AudioSeconds, sourceFrames, clip };
}

export const tests = {
  async 'MP4 export: whole clip, faster than real time'({ exportAs }) {
    const r = await exportAs('mp4');
    ok(!r.failed && r.type === 'video/mp4', `export failed: ${r.failed || r.type}`);
    ok(!r.fallback, `fell back to real-time export: ${r.fallback}`);
    ok(r.width === 1280 && r.height === 720, `size ${r.width}×${r.height}`);
    near(r.duration, 8, 0.15, 'duration');
    near(r.first, 0, 0.05, 'first frame time');
    ok(r.ms < 8000, `took ${r.ms} ms for an 8 s clip`);
    return `${r.ms} ms, ${Math.round(r.size / 1024)} KB`;
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
    const r = await video.evaluate(async (clip) => {
      const { getCapture } = await import('/lib/db.js');
      const { demuxWebm } = await import('/lib/webm.js');
      const { muxMp4 } = await import('/lib/mp4.js');
      const src = demuxWebm(await (await getCapture(clip)).blob.arrayBuffer());
      // A short H.264 track to go with it.
      const chunks = [];
      let avcC = null;
      const enc = new VideoEncoder({
        output: (c, md) => { if (md?.decoderConfig?.description) avcC = new Uint8Array(md.decoderConfig.description); const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ timestamp: c.timestamp, duration: c.duration, key: c.type === 'key', data: d }); },
        error: () => {},
      });
      enc.configure({ codec: 'avc1.42e01e', width: 320, height: 240, bitrate: 500000, framerate: 30, avc: { format: 'avc' } });
      const cv = new OffscreenCanvas(320, 240);
      const cx = cv.getContext('2d');
      for (let k = 0; k < 90; k++) {
        cx.fillStyle = `hsl(${k * 4} 60% 50%)`; cx.fillRect(0, 0, 320, 240);
        const f = new VideoFrame(cv, { timestamp: Math.round((k * 1e6) / 30), duration: 33333 });
        enc.encode(f, { keyFrame: k % 30 === 0 }); f.close();
      }
      await enc.flush();
      // Opus packets from the recording's first 3 s, starting 0.1 s in.
      const packets = src.audio.frames.filter((f) => f.timestamp < 3e6);
      const frames = packets.map((f, i) => ({ timestamp: f.timestamp + 100000, duration: (packets[i + 1]?.timestamp ?? f.timestamp + 20000) - f.timestamp, key: true, data: f.data }));
      const blob = muxMp4({ video: { width: 320, height: 240, avcC, frames: chunks }, audio: { codec: 'opus', sampleRate: 48000, channels: src.audio.channels, opusHead: src.audio.description, frames } });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const text = new TextDecoder('latin1').decode(bytes);
      const audio = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(bytes.buffer.slice(0));
      const v = document.createElement('video');
      v.src = URL.createObjectURL(blob);
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('video element could not load it')); });
      const recorded = (frames.at(-1).timestamp + frames.at(-1).duration - frames[0].timestamp) / 1e6;
      return { hasOpus: text.includes('dOps'), hasEdit: text.includes('elst'), audioSeconds: audio.duration, recorded, delay: frames[0].timestamp / 1e6, videoSeconds: v.duration };
    }, clip);
    ok(r.hasOpus && r.hasEdit, `missing boxes: ${JSON.stringify(r)}`);
    // As much audio as was recorded (it can start a little late), and the movie
    // spans the delayed audio.
    near(r.audioSeconds, r.recorded, 0.1, 'Opus audio length');
    ok(r.videoSeconds >= Math.max(3, r.delay + r.recorded) - 0.1, `movie length ${r.videoSeconds}`);
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
};
