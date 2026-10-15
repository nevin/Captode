// Image and animation encoders: exactness where they promise it, quality at least
// as good as the browser's where they replace it, and size limits that hold.
import { open, ok, sleep } from './helpers.mjs';

export async function setup({ browser, url, site }) {
  const page = await open(browser, `${site}/rich.html`);
  await sleep(300);
  const ui = await page.screenshot({ encoding: 'base64' });
  const r = await page.evaluate(() => { const b = document.getElementById('photo').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
  const photo = await page.screenshot({ encoding: 'base64', clip: r });
  await page.close();
  const lab = await open(browser, url('lab/lab.html'));
  await lab.waitForFunction(() => globalThis.lab);
  return { lab, images: { ui, photo } };
}

export const tests = {
  async 'PNG is lossless and smaller than the browser\'s own'({ lab, images }) {
    const r = await lab.evaluate(async (b64) => {
      const { toPng } = await import('/lib/formats.js');
      const c = await lab.canvasFromPng(b64);
      const png = await toPng(c);
      const browser = await c.convertToBlob({ type: 'image/png' });
      return { exact: lab.psnr(lab.pixels(c), await lab.decode(png, c.width, c.height)) === Infinity, size: png.size, browser: browser.size };
    }, images.ui);
    ok(r.exact, 'decoded PNG differs from the original');
    ok(r.size < r.browser, `not smaller: ${r.size} vs ${r.browser}`);
    return `${Math.round(r.size / 1024)} KB vs ${Math.round(r.browser / 1024)} KB`;
  },

  async 'palette PNGs decode exactly at every bit depth, with transparency'({ lab }) {
    const r = await lab.evaluate(async () => {
      const { encodePng } = await import('/lib/png.js');
      const out = [];
      for (const [n, w, h, alpha] of [[2, 37, 9, false], [3, 33, 7, false], [4, 31, 11, true], [11, 29, 13, true], [200, 61, 17, true]]) {
        const px = new Uint8ClampedArray(w * h * 4);
        let s = n;
        for (let p = 0; p < w * h; p++) {
          const c = (s = (s * 16807) % 2147483647) % n;
          px.set([(c * 53) & 255, (c * 97) & 255, (c * 31) & 255, alpha ? [0, 255, 255][c % 3] : 255], p * 4);
          if (!px[p * 4 + 3]) px.set([0, 0, 0, 0], p * 4);
        }
        const blob = await encodePng(px, w, h);
        const depth = new Uint8Array(await blob.arrayBuffer())[24];
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const x = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
        x.drawImage(bmp, 0, 0);
        const got = x.getImageData(0, 0, w, h).data;
        let bad = 0;
        for (let i = 0; i < px.length; i++) if (px[i] !== got[i]) bad++;
        out.push({ n, depth, bad });
      }
      return out;
    });
    for (const { n, depth, bad } of r) ok(bad === 0, `${n} colours at ${depth} bits: ${bad} values differ`);
    ok(r.map((x) => x.depth).join() === '1,2,2,4,8', `bit depths ${r.map((x) => x.depth)}`);
  },

  async 'PNG-8 "Auto" picks fewer colours without visible loss'({ lab, images }) {
    const r = await lab.evaluate(async (b64) => {
      const { toPng8 } = await import('/lib/formats.js');
      const c = await lab.canvasFromPng(b64);
      const auto = await toPng8(c, { colors: 'auto', dither: false });
      const full = await toPng8(c, { colors: 256, dither: false });
      return { auto: auto.size, full: full.size, ssim: lab.ssim(lab.pixels(c), await lab.decode(auto, c.width, c.height), c.width, c.height) };
    }, images.ui);
    ok(r.auto < r.full, `auto ${r.auto} not smaller than 256 colours ${r.full}`);
    ok(r.ssim > 0.97, `SSIM ${r.ssim}`);
    return `${Math.round(r.auto / 1024)} KB vs ${Math.round(r.full / 1024)} KB, SSIM ${r.ssim.toFixed(3)}`;
  },

  async 'JPEG is as faithful as the browser\'s at the same quality, and no larger'({ lab, images }) {
    const rows = await lab.evaluate(async (images) => {
      const { encodeImage } = await import('/lib/formats.js');
      const out = [];
      for (const [name, b64] of Object.entries(images)) {
        const c = await lab.canvasFromPng(b64);
        const ref = lab.pixels(c);
        for (const quality of [0.92, 0.85, 0.7]) {
          const ours = await encodeImage(c, 'jpeg', { quality });
          const browser = await c.convertToBlob({ type: 'image/jpeg', quality });
          out.push({
            name, quality, ours: ours.size, browser: browser.size,
            q: lab.psnr(ref, await lab.decode(ours, c.width, c.height)),
            qb: lab.psnr(ref, await lab.decode(browser, c.width, c.height)),
          });
        }
      }
      return out;
    }, images);
    for (const r of rows) {
      ok(r.ours <= r.browser, `${r.name} at ${r.quality}: ${r.ours} bytes, browser ${r.browser}`);
      ok(r.q >= r.qb - 0.01, `${r.name} at ${r.quality}: ${r.q.toFixed(2)} dB, browser ${r.qb.toFixed(2)} dB`);
    }
    const saved = rows.map((r) => 1 - r.ours / r.browser);
    return `on average ${Math.round((saved.reduce((a, b) => a + b, 0) / saved.length) * 100)}% smaller`;
  },

  async 'PDFs are well formed, with lossless and split pages'({ lab }) {
    const r = await lab.evaluate(async () => {
      const { toPdf } = await import('/lib/formats.js');
      const text = async (b) => new TextDecoder('latin1').decode(await b.arrayBuffer());
      const xrefOk = (t) => {
        const at = Number(t.match(/startxref\n(\d+)/)[1]);
        const entries = t.slice(at).split('\n').slice(3).filter((l) => / n $/.test(l));
        return t.slice(at, at + 4) === 'xref' && entries.every((l, i) => t.slice(Number(l.slice(0, 10))).startsWith(`${i + 1} 0 obj`));
      };
      const flat = new OffscreenCanvas(400, 240);
      const x = flat.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 240); x.fillStyle = '#5b4bff'; x.fillRect(20, 20, 200, 80);
      const indexed = await text(await toPdf(flat, { page: 'fit', quality: 0.9 }));
      const tall = new OffscreenCanvas(800, 5000);
      tall.getContext('2d').fillRect(0, 0, 10, 10);
      const split = await text(await toPdf(tall, { page: 'a4', split: true }));
      return {
        indexedXref: xrefOk(indexed), indexedFlate: /\/Indexed/.test(indexed) && /FlateDecode/.test(indexed),
        splitXref: xrefOk(split), pages: (split.match(/\/Type \/Page /g) || []).length,
      };
    });
    ok(r.indexedXref && r.splitXref, 'cross-reference table is wrong');
    ok(r.indexedFlate, 'a few-colour page should be stored losslessly as indexed colour');
    ok(r.pages === 5, `tall image split into ${r.pages} pages`);
  },

  async 'size limits are met for every format'({ lab, images }) {
    const rows = await lab.evaluate(async (b64) => {
      const { fitImage } = await import('/lib/formats.js');
      const c = await lab.canvasFromPng(b64);
      const out = [];
      for (const [format, kb] of [['jpeg', 60], ['webp', 40], ['pdf', 80], ['png8', 100], ['gif', 120], ['png', 200], ['jpeg', 5]]) {
        const r = await fitImage(c, format, { quality: 0.9, colors: 256, dither: true }, kb * 1024);
        out.push({ format, kb, size: r.blob.size, fitted: r.fitted });
      }
      return out;
    }, images.ui);
    for (const r of rows) ok(r.size <= r.kb * 1024 && !r.fitted?.tooBig, `${r.format} ≤ ${r.kb} KB came out at ${(r.size / 1024).toFixed(1)} KB`);
  },

  async 'animated GIF stores only changes, exactly (and within tolerance by default)'({ lab }) {
    const r = await lab.evaluate(async () => {
      const { GifEncoder } = await import('/lib/gif.js');
      const { buildPalette } = await import('/lib/quantize.js');
      const W = 200, H = 120, N = 20;
      let seed = 1;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const frames = [];
      for (let f = 0; f < N; f++) {
        const px = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const inSq = f < 14 && x >= 10 + f * 6 && x < 50 + f * 6 && y >= 40 && y < 80;
          const n = Math.floor(rnd() * 3) - 1; // decoder-like noise
          const g = 200 + Math.round((40 * x) / W);
          px.set(inSq ? [91, 75, 255, 255] : [g + n, g + n, 235 + n, 255], (y * W + x) * 4);
        }
        frames.push(px);
      }
      const all = new Uint8ClampedArray(frames.length * frames[0].length);
      frames.forEach((f, i) => all.set(f, i * f.length));
      const palette = buildPalette(all, 255);
      const encode = async (o) => { const g = new GifEncoder(W, H, { palette, ...o }); frames.forEach((f) => g.addFrame(new Uint8ClampedArray(f), 100)); return g.finish(); };
      // What a viewer sees every 10 ms.
      const timeline = async (blob) => {
        const d = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/gif' });
        await d.tracks.ready;
        await d.completed;
        const x = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
        const out = [];
        for (let i = 0; i < d.tracks.selectedTrack.frameCount; i++) {
          const { image } = await d.decode({ frameIndex: i });
          x.clearRect(0, 0, W, H); x.drawImage(image, 0, 0);
          const px = x.getImageData(0, 0, W, H).data;
          for (let t = 0; t < Math.round(image.duration / 10000); t++) out.push(px);
          image.close();
        }
        return out;
      };
      const full = await encode({ optimize: false, tolerance: 0 });
      const exact = await encode({ optimize: true, tolerance: 0 });
      const loose = await encode({ optimize: true });
      const lossy = await encode({ optimize: true, lossy: 40 });
      const [a, b, c, l] = [await timeline(full), await timeline(exact), await timeline(loose), await timeline(lossy)];
      let differing = 0;
      for (let t = 0; t < Math.min(a.length, b.length); t++) if (a[t].some((v, i) => v !== b[t][i])) differing++;
      let maxDev = 0;
      for (let t = 0; t < Math.min(a.length, c.length); t++) for (let i = 0; i < a[t].length; i += 4) for (let k = 0; k < 3; k++) maxDev = Math.max(maxDev, Math.abs(a[t][i + k] - c[t][i + k]));
      let lossyDev = 0;
      for (let t = 0; t < Math.min(a.length, l.length); t++) for (let i = 0; i < a[t].length; i += 4) for (let k = 0; k < 3; k++) lossyDev = Math.max(lossyDev, Math.abs(a[t][i + k] - l[t][i + k]));
      return { lengths: [a.length, b.length, c.length], differing, maxDev, lossyDev, sizes: [full.size, exact.size, loose.size, lossy.size] };
    });
    ok(r.lengths[0] === r.lengths[1] && r.lengths[1] === r.lengths[2], `timelines differ in length: ${r.lengths}`);
    ok(r.differing === 0, `${r.differing} moments differ with tolerance 0`);
    ok(r.maxDev <= 6, `default tolerance changed a pixel by ${r.maxDev}`);
    ok(r.sizes[2] < r.sizes[0] / 3, `tolerance saved too little: ${r.sizes}`);
    ok(r.sizes[3] < r.sizes[2] && r.lossyDev <= 40, `lossy: ${r.sizes[3]} bytes, max change ${r.lossyDev}`);
    return `full ${Math.round(r.sizes[0] / 1024)} KB, exact ${Math.round(r.sizes[1] / 1024)} KB, default ${Math.round(r.sizes[2] / 1024)} KB, lossy 40 ${Math.round(r.sizes[3] / 1024)} KB`;
  },
};
