// Captions: breaks at the speaker's pauses, how they look (in the export too), the word
// being said lit up, joining and splitting them, and reviewing them all in one list.
import { open, recordClip, ok, near, sleep } from './helpers.mjs';

export async function setup({ browser, url }) {
  const ctl = await open(browser, url('lab/lab.html'));
  await ctl.waitForFunction(() => globalThis.lab, { polling: 100 });
  const clip = await recordClip(ctl, { seconds: 4, audio: true });
  const page = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
  await page.bringToFront();
  await page.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
  return { ctl, video: page };
}

/** Puts these captions in place of any, and chooses the first. */
const setCaptions = (video, list) => video.evaluate((list) => {
  captodeEdits.replace({ ...captodeEdits.get(), captions: list.map((c, i) => ({ id: `c${i}`, size: 2, ...c })) });
  captodeEdits.chooseCaption('c0');
  document.querySelector('#edit-section').open = true;
}, list);

export const tests = {
  async 'captions from speech break where the speaker pauses'({ ctl }) {
    const caps = await ctl.evaluate(async () => {
      const { captionsAtPauses } = await import('/lib/speech.js');
      // Three phrases: 0–1.5 s, 1.8–3 s, 3.3–5 s, with short pauses between.
      const rms = Array.from({ length: 120 }, (_, k) => { const t = k * 0.05; return (t < 1.5) || (t >= 1.8 && t < 3) || (t >= 3.3 && t < 5) ? 0.2 : 0.001; });
      return captionsAtPauses('one two three four five six seven eight nine ten eleven twelve', 0, 5, { step: 0.05, rms });
    });
    ok(caps.length === 3, `a caption a phrase: ${JSON.stringify(caps)}`);
    near(caps[0].to, 1.5, 0.06, 'first ends at the first pause');
    near(caps[1].from, 1.8, 0.06, 'second starts after it');
    ok(caps.map((c) => c.text).join(' ').split(' ').length === 12, 'every word kept');
  },

  async 'caption styles: a light band at the top, in the export'({ video }) {
    await setCaptions(video, [{ from: 0, to: 4, text: 'Hello there' }]);
    await video.waitForSelector('#ed-item [data-seg="cs-band"]');
    await video.$eval('#ed-item [data-seg="cs-band"]', (e) => e.scrollIntoView({ block: 'center' }));
    await video.click('#ed-item [data-seg="cs-band"] [data-v="light"]');
    await video.click('#ed-item [data-seg="cs-place"] [data-v="top"]');
    await video.click('#ed-item [data-seg="cs-font"] [data-v="serif"]');
    const st = await video.evaluate(() => captodeEdits.get().captionStyle);
    ok(st.band === 'light' && st.place === 'top' && st.font === 'serif', JSON.stringify(st));
    await video.$eval('#formats', (e) => e.scrollIntoView({ block: 'center' }));
    await video.click('#formats [data-f="mp4"]');
    await video.click('#convert');
    await video.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 120000, polling: 100 });
    const px = await video.evaluate(async () => {
      const out = document.querySelector('#out-video');
      if (out.readyState < 2) await new Promise((r) => out.addEventListener('loadeddata', r, { once: true }));
      await new Promise((r) => { out.addEventListener('seeked', r, { once: true }); out.currentTime = 1; });
      const c = new OffscreenCanvas(out.videoWidth, out.videoHeight).getContext('2d', { willReadFrequently: true });
      c.drawImage(out, 0, 0);
      // The band's left end, just inside it, at the top; and the same place at the bottom.
      const row = (y) => { const d = c.getImageData(0, Math.round(y), out.videoWidth, 1).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) n++; return n; };
      return { top: row(out.videoHeight * 0.09), bottom: row(out.videoHeight * 0.91) };
    });
    ok(px.top > 60, `a light band at the top: ${px.top} light pixels`);
    ok(px.bottom < px.top / 3, `not at the bottom: ${px.bottom}`);
    await video.click('#redo-export').catch(() => {});
  },

  async 'captions: the word being said lit up'({ video }) {
    const lit = await video.evaluate(async () => {
      const { drawCaption, DEFAULT_CAPTION_STYLE } = await import('/lib/video-edits.js');
      const yellow = (p, highlight) => {
        const c = new OffscreenCanvas(640, 360);
        const g = c.getContext('2d');
        g.fillStyle = '#333'; g.fillRect(0, 0, 640, 360);
        drawCaption(g, { text: 'one two three four', size: 3 }, 2, { ...DEFAULT_CAPTION_STYLE, highlight }, p);
        const d = g.getImageData(0, 0, 640, 360).data;
        let n = 0, sx = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 170 && d[i + 2] < 90) { n++; sx += (i / 4) % 640; }
        return { n, x: n ? sx / n : 0 };
      };
      return { start: yellow(0.05, true), end: yellow(0.95, true), off: yellow(0.5, false) };
    });
    ok(lit.start.n > 20 && lit.end.n > 20, `a word lit: ${JSON.stringify(lit)}`);
    ok(lit.end.x > lit.start.x + 50, 'later on, a later word');
    ok(lit.off.n === 0, 'none when not chosen');
  },

  async 'captions: joined with the next, split with Enter, and reviewed in one list'({ video }) {
    await setCaptions(video, [{ from: 0.5, to: 1.5, text: 'hello there' }, { from: 1.5, to: 3, text: 'general kenobi' }]);
    await video.waitForSelector('#ed-item [data-join]');
    await video.$eval('#ed-item [data-join]', (e) => e.scrollIntoView({ block: 'center' }));
    await video.click('#ed-item [data-join]');
    let caps = await video.evaluate(() => captodeEdits.get().captions);
    ok(caps.length === 1 && caps[0].to === 3 && caps[0].text === 'hello there general kenobi', `joined: ${JSON.stringify(caps)}`);
    // Enter splits it at the playhead.
    await video.evaluate(() => { document.querySelector('#player').currentTime = 2; document.activeElement?.blur(); });
    await sleep(200);
    await video.keyboard.press('Enter');
    caps = await video.evaluate(() => captodeEdits.get().captions);
    ok(caps.length === 2 && caps.some((c) => Math.abs(c.to - 2) < 0.05), `split at the playhead: ${JSON.stringify(caps)}`);
    // Every caption in one list: a word fixed there is fixed in the caption.
    await video.evaluate(() => captodeEdits.chooseCaption(captodeEdits.get().captions[0].id));
    await video.waitForSelector('#ed-item [data-review]');
    await video.click('#ed-item [data-review]');
    await video.waitForSelector('dialog.cap-review[open] textarea');
    ok(await video.$$eval('dialog.cap-review .cap-review-row', (r) => r.length) === 2, 'both listed');
    await video.evaluate(() => { const ta = document.querySelector('dialog.cap-review textarea'); ta.value = 'Hello there!'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await video.click('dialog.cap-review [data-close]');
    caps = await video.evaluate(() => captodeEdits.get().captions.sort((a, b) => a.from - b.from));
    ok(caps[0].text === 'Hello there!', `fixed: ${caps[0].text}`);
  },
};
