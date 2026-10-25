// Image export: lossless WebP, Smallest, "1× — as on screen", the hint when another
// format would be smaller, and several sizes or formats in one zip.
import { open, ok } from './helpers.mjs';

/** A screenshot-like image (text and flat colours), saved as a capture taken at `dpr`. */
const shot = (page, dpr) => page.evaluate(async (dpr) => {
  const c = new OffscreenCanvas(800, 500);
  const g = c.getContext('2d');
  g.fillStyle = '#f6f6f9'; g.fillRect(0, 0, 800, 500);
  g.fillStyle = '#5b4bff'; g.fillRect(0, 0, 800, 56);
  g.fillStyle = '#17171c';
  g.font = '15px sans-serif';
  for (let i = 0; i < 18; i++) g.fillText(`Line ${i + 1}: the quick brown fox jumps over the lazy dog, 0123456789`, 24, 96 + i * 22);
  g.fillStyle = '#30a46c'; g.fillRect(560, 380, 180, 44);
  const { putCapture } = await import('/lib/db.js');
  return putCapture(await c.convertToBlob(), { title: 'Export test', dpr });
}, dpr);

/** Catches files saved with a link's click(): window.__saved = [{ name, size, type, bytes? }]. */
const catchSaves = (page) => page.evaluate(() => {
  window.__saved = [];
  HTMLAnchorElement.prototype.click = function () {
    const name = this.download;
    fetch(this.href).then((r) => r.blob()).then(async (b) => window.__saved.push({ name, size: b.size, type: b.type, url: URL.createObjectURL(b) }));
  };
});

export const tests = {
  async 'size limits keep text readable: lossless first, never below on-screen size, never blurry quality'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const f = await import('/lib/formats.js');
      // A 2× screenshot of text: 800 × 500 pixels, 400 × 250 on screen.
      const c = new OffscreenCanvas(800, 500);
      const g = c.getContext('2d');
      // A page with a photo-like background (gradients and grain), as real pages have.
      const img = g.createImageData(800, 500);
      let seed = 7;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let y = 0, i = 0; y < 500; y++) for (let x = 0; x < 800; x++, i += 4) {
        const n = rnd() * 24;
        img.data[i] = 180 + x / 10 + n; img.data[i + 1] = 200 + y / 12 + n; img.data[i + 2] = 230 + n; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      g.fillStyle = '#17171c'; g.font = '26px sans-serif';
      for (let i = 0; i < 16; i++) g.fillText(`Line ${i + 1}: readable text, 0123456789 ${'xyz'.repeat(i % 4)}`, 20, 34 + i * 29);
      const half = await f.smallestLossless((() => { const k = new OffscreenCanvas(400, 250); const x = k.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, 400, 250); return k; })());
      const opts = { readable: true, minScale: 0.5, quality: 0.9 };
      // Between the two lossless sizes: the on-screen size, every pixel kept.
      const full = await f.smallestLossless(c);
      const limit = Math.floor((half.blob.size + full.blob.size) / 2); // under full size, over on-screen size
      const a = await f.fitImage(c, 'smallest', opts, limit);
      // Far too small to stay readable: says so, and stays readable.
      const b = await f.fitImage(c, 'jpeg', opts, 2 * 1024);
      // The old way, for "Fit anyway": it fits, whatever it takes.
      const d = await f.fitImage(c, 'jpeg', { quality: 0.9 }, 2 * 1024);
      return {
        a: { w: a.width, size: a.blob.size, fitted: a.fitted, limit, half: half.blob.size, full: full.blob.size },
        b: { w: b.width, fitted: b.fitted },
        d: { size: d.blob.size, fitted: d.fitted },
      };
    });
    ok(r.a.size <= r.a.limit && r.a.w >= 400 && r.a.fitted?.quality === undefined && r.a.fitted?.readable, `lossless at on-screen size: ${JSON.stringify(r.a)}`);
    ok(r.b.fitted?.tooBig && r.b.fitted.readable && r.b.w >= 400, `too small to read: ${JSON.stringify(r.b)}`);
    ok(r.d.size <= 2 * 1024, `fit anyway still fits: ${JSON.stringify(r.d)}`);
    await lab.close();
  },

  async 'resizing keeps the original: Original size brings back the exact pixels'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await shot(lab, 2);
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1400, height: 900 });
    await ed.waitForFunction(() => globalThis.captodeEditor?.size(), { polling: 100, timeout: 15000 });
    const sum = () => ed.evaluate(() => { const d = captodeEditor.pixels().data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) >>> 0; return [captodeEditor.size().join('×'), h]; });
    const before = await sum();
    const resize = (w) => ed.evaluate((w) => {
      const i = document.getElementById('rs-w'); i.value = String(w); i.dispatchEvent(new Event('input'));
      document.getElementById('rs-apply').click();
    }, w);
    ok(await ed.evaluate(() => document.getElementById('rs-original').classList.contains('hidden')), 'Original size hidden at first');
    await resize(400);
    await ed.waitForFunction(() => captodeEditor.size()[0] === 400, { polling: 100, timeout: 5000 });
    await resize(600);
    await ed.waitForFunction(() => captodeEditor.size()[0] === 600, { polling: 100, timeout: 5000 });
    ok(await ed.evaluate(() => !document.getElementById('rs-original').classList.contains('hidden')), 'Original size offered');
    await ed.evaluate(() => document.getElementById('rs-original').click());
    await ed.waitForFunction(() => captodeEditor.size()[0] === 800, { polling: 100, timeout: 5000 });
    const after = await sum();
    ok(after[0] === before[0] && after[1] === before[1], `exact pixels back: ${before} → ${after}`);
    await ed.close();
  },

  async 'lossless WebP keeps every pixel, Smallest keeps the smaller lossless file, and size limits fall back to lossy'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const r = await lab.evaluate(async () => {
      const f = await import('/lib/formats.js');
      const c = new OffscreenCanvas(400, 300);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 300);
      g.fillStyle = '#123'; g.font = '14px sans-serif';
      for (let i = 0; i < 12; i++) g.fillText(`Row ${i} — Captode export check ${i * 37}`, 10, 24 + i * 22);
      g.fillStyle = 'rgba(229,72,77,0.5)'; g.fillRect(250, 150, 120, 90);
      const px = (bmp) => { const k = new OffscreenCanvas(400, 300).getContext('2d', { willReadFrequently: true }); k.drawImage(bmp, 0, 0); return k.getImageData(0, 0, 400, 300).data; };
      const src = g.getImageData(0, 0, 400, 300).data;
      const can = await f.canWebpLossless();
      const lossless = can ? await f.encodeImage(c, 'webp', { lossless: true }) : null;
      let diff = -1;
      if (lossless) { const d = px(await createImageBitmap(lossless)); diff = 0; for (let i = 0; i < d.length; i++) diff = Math.max(diff, Math.abs(d[i] - src[i])); }
      const small = await f.fitImage(c, 'smallest', {}, 0);
      const png = await f.encodeImage(c, 'png', {});
      const tight = await f.fitImage(c, 'smallest', { quality: 0.9 }, 3 * 1024);
      const lossy = can ? await f.fitImage(c, 'webp', { lossless: true, quality: 0.9 }, 3 * 1024) : null;
      return {
        can, diff, losslessSize: lossless?.size, png: png.size,
        small: { size: small.blob.size, type: small.blob.type, picked: small.picked },
        tight: { size: tight.blob.size, type: tight.blob.type, fitted: tight.fitted },
        lossy: lossy && { size: lossy.blob.size, fitted: lossy.fitted },
      };
    });
    if (r.can) {
      ok(r.diff === 0, `lossless WebP changed pixels by up to ${r.diff}`);
      ok(r.small.picked.sizes.webp === r.losslessSize && r.small.picked.sizes.png === r.png, `sizes ${JSON.stringify(r.small.picked)}`);
      ok(r.lossy.size <= 3 * 1024 && r.lossy.fitted?.quality !== undefined, `lossless WebP over the limit goes lossy: ${JSON.stringify(r.lossy)}`);
    }
    const want = r.can && r.losslessSize < r.png ? 'image/webp' : 'image/png';
    ok(r.small.type === want && r.small.size === Math.min(r.png, r.losslessSize ?? Infinity), `smallest ${JSON.stringify(r.small)} (PNG ${r.png}, WebP ${r.losslessSize})`);
    ok(r.small.picked.format === (want === 'image/webp' ? 'webp' : 'png'), 'says which won');
    ok(r.tight.size <= 3 * 1024 && r.tight.fitted?.format, `Smallest within a limit: ${JSON.stringify(r.tight)}`);
    await lab.close();
    return `PNG ${(r.png / 1024).toFixed(1)} KB, lossless WebP ${r.losslessSize ? (r.losslessSize / 1024).toFixed(1) : '—'} KB`;
  },

  async 'the Export panel offers Smallest, Lossless and 1× as on screen, hints at smaller files, and zips several'({ browser, url }) {
    const lab = await open(browser, url('lab/lab.html'));
    const id = await shot(lab, 2);
    const flat = await shot(lab, 1);
    await lab.close();
    const ed = await open(browser, url(`editor/editor.html?id=${id}&reopen=1`), { width: 1400, height: 900 });
    await ed.waitForFunction(() => document.querySelector('#tab-export'), { polling: 100 });
    await ed.evaluate(() => document.querySelector('#tab-export').click());
    await ed.waitForFunction(() => /\d/.test(document.getElementById('x-dims').textContent), { polling: 100, timeout: 15000 });
    const pick = async (sel, value) => ed.evaluate((sel, value) => {
      const el = document.querySelector(sel);
      if (el.type === 'checkbox') el.checked = value; else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, sel, value);
    const dims = () => ed.evaluate(() => document.getElementById('x-dims').textContent);
    const settle = (before) => ed.waitForFunction((b) => { const d = document.getElementById('x-dims').textContent; return d !== b && /\d/.test(d) && !document.querySelector('#x-estimate .working'); }, { polling: 100, timeout: 20000 }, before);

    // 1× — as on screen: half the size of a 2× screenshot.
    const css = await ed.evaluate(() => { const o = document.querySelector('#x-scale [value="css"]'); return { hidden: o.hidden, text: o.textContent }; });
    ok(!css.hidden && /50%/.test(css.text), `1× offered for a 2× screenshot: ${JSON.stringify(css)}`);
    let before = await dims();
    await pick('#x-scale', 'css');
    await settle(before);
    ok(/400 × 250/.test(await dims()), `1× size: ${await dims()}`);
    await pick('#x-scale', '1');
    await ed.waitForFunction(() => /800 × 500/.test(document.getElementById('x-dims').textContent), { polling: 100, timeout: 20000 });

    // PNG: when Smallest would be much smaller, the panel says so.
    await pick('#x-format', 'png');
    const hint = await ed.waitForFunction(() => !document.getElementById('x-hint').classList.contains('hidden'), { polling: 200, timeout: 15000 })
      .then(() => ed.evaluate(() => ({ shown: true, text: document.querySelector('#x-hint span').textContent })), () => ({ shown: false }));
    // Smallest: the note says which format won; the download is named for it.
    await pick('#x-format', 'smallest');
    await ed.waitForFunction(() => !document.getElementById('x-picked').classList.contains('hidden'), { polling: 100, timeout: 20000 });
    const picked = await ed.evaluate(() => document.getElementById('x-picked').textContent);
    await catchSaves(ed);
    await ed.evaluate(() => document.getElementById('download2').click());
    await ed.waitForFunction(() => window.__saved.length === 1, { polling: 100, timeout: 20000 });
    const saved = await ed.evaluate(() => window.__saved[0]);
    const ext = saved.type === 'image/webp' ? 'webp' : 'png';
    ok(saved.name.endsWith(`.${ext}`), `named for the format that won: ${saved.name} (${saved.type})`);
    ok(new RegExp(ext === 'webp' ? 'WebP' : 'PNG').test(picked), `note: ${picked}`);
    if (ext === 'webp') ok(hint.shown && /% smaller/.test(hint.text), `the PNG hint: ${JSON.stringify(hint)}`);

    // WebP: the Lossless switch hides the quality slider.
    await pick('#x-format', 'webp');
    const webp = await ed.evaluate(() => ({ lossless: !document.querySelector('[data-x="lossless"]').classList.contains('hidden'), quality: !document.querySelector('[data-x="quality"]').classList.contains('hidden') }));
    const canLossless = await ed.evaluate(async () => (await import('/lib/formats.js')).canWebpLossless());
    ok(webp.lossless === canLossless && webp.quality, `WebP controls ${JSON.stringify(webp)}`);
    if (canLossless) {
      await pick('#x-lossless', true);
      ok(await ed.evaluate(() => document.querySelector('[data-x="quality"]').classList.contains('hidden')), 'Lossless hides the quality');
      await pick('#x-lossless', false);
    }

    // Several sizes or formats: 100% and 1×, PNG and WebP, in one zip.
    await ed.evaluate(() => { const d = document.getElementById('x-several'); d.open = true; d.dispatchEvent(new Event('toggle')); });
    await ed.evaluate(() => {
      for (const i of document.querySelectorAll('#x-sizes input, #x-formats input')) i.checked = ['1', 'css', 'png', 'webp'].includes(i.value);
      document.getElementById('x-several-go').click();
    });
    await ed.waitForFunction(() => window.__saved.length === 2, { polling: 100, timeout: 60000 });
    const names = await ed.evaluate(async () => {
      const z = window.__saved[1];
      const { unzip } = await import('/lib/zip.js');
      const files = await unzip(await (await fetch(z.url)).blob());
      const out = [];
      for (const [name, blob] of files) { const b = await createImageBitmap(blob); out.push(`${name.split('-').pop()} ${b.width}×${b.height}`); b.close(); }
      return { zip: z.name, files: out.sort() };
    });
    ok(names.zip.endsWith('.zip') && names.files.length === 4, `zip ${JSON.stringify(names)}`);
    ok(names.files.some((f) => /@1x\.png 400×250/.test(f)) && names.files.some((f) => /test\.webp 800×500|\.webp 800×500/.test(f)), `files ${names.files}`);
    await ed.close();

    // A 1× screenshot isn't offered 1×.
    const ed1 = await open(browser, url(`editor/editor.html?id=${flat}&reopen=1`));
    await ed1.waitForFunction(() => document.querySelector('#tab-export'), { polling: 100 });
    await ed1.evaluate(() => document.querySelector('#tab-export').click());
    await ed1.waitForFunction(() => /\d/.test(document.getElementById('x-dims').textContent), { polling: 100, timeout: 15000 });
    ok(await ed1.evaluate(() => document.querySelector('#x-scale [value="css"]').hidden), '1× hidden at 100%');
    await ed1.close();
    return `${saved.name}; ${picked}`;
  },
};
