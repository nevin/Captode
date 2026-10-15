// Compression benchmark: node test/bench.mjs [--update]
//
// Encodes a UI screenshot, a photo-like image, a flat page and two animations in
// every format, and records size, PSNR and SSIM. Results are compared with
// test/bench-baseline.json: the run fails if a file grows by more than 3% or its
// quality drops (PSNR by 0.25 dB or SSIM by 0.003). --update saves new baselines.
// Baselines are kept per operating system, since fonts (and so the screenshots)
// differ; with none saved for this one, the numbers are only reported.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, open, serveSite, sleep } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const baselineFile = join(here, 'bench-baseline.json');
const update = process.argv.includes('--update');
const reportOnly = process.argv.includes('--report'); // print, never fail (for CI)

const site = await serveSite();
const env = await launch();
const page = await open(env.browser, `${site.url}/rich.html`);
await sleep(300);
const images = { ui: await page.screenshot({ encoding: 'base64' }) };
const r = await page.evaluate(() => { const b = document.getElementById('photo').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
images.photo = await page.screenshot({ encoding: 'base64', clip: r });
await page.goto(`${site.url}/index.html`);
await sleep(200);
images.flat = await page.screenshot({ encoding: 'base64' });

const lab = await open(env.browser, env.url('lab/lab.html'));
await lab.waitForFunction(() => globalThis.lab, { polling: 100 });

const results = await lab.evaluate(async (images) => {
  const f = await import('/lib/formats.js');
  const out = {};
  const measure = async (key, c, run) => {
    const t = performance.now();
    const blob = await run();
    const ms = performance.now() - t;
    const entry = { bytes: blob.size, ms: Math.round(ms) };
    if (!key.includes('pdf')) {
      const got = await lab.decode(blob, c.width, c.height);
      const ref = lab.pixels(c);
      const p = lab.psnr(ref, got);
      entry.psnr = p === Infinity ? 99 : +p.toFixed(2);
      entry.ssim = +lab.ssim(ref, got, c.width, c.height).toFixed(4);
    }
    out[key] = entry;
  };
  for (const [name, b64] of Object.entries(images)) {
    const c = await lab.canvasFromPng(b64);
    await measure(`${name} png`, c, () => f.toPng(c));
    await measure(`${name} png8 256 dither`, c, () => f.toPng8(c, { colors: 256, dither: true }));
    await measure(`${name} png8 auto`, c, () => f.toPng8(c, { colors: 'auto', dither: false }));
    await measure(`${name} jpeg 85`, c, () => f.encodeImage(c, 'jpeg', { quality: 0.85 }));
    await measure(`${name} webp 85`, c, () => f.encodeImage(c, 'webp', { quality: 0.85 }));
    await measure(`${name} gif dither`, c, () => f.toGif(c, { colors: 256, dither: true }));
    await measure(`${name} pdf 92`, c, () => f.toPdf(c, { page: 'fit', quality: 0.92 }));
  }

  // Animations: a UI-like scene with a moving card, clean and with decoder-like noise.
  const { GifEncoder } = await import('/lib/gif.js');
  const { WebpAnimEncoder } = await import('/lib/webp.js');
  const { buildPalette } = await import('/lib/quantize.js');
  const W = 640, H = 360, N = 30;
  for (const noise of [0, 2]) {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const c = new OffscreenCanvas(W, H);
    const x = c.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (let t = 0; t < N; t++) {
      x.fillStyle = '#fafafb'; x.fillRect(0, 0, W, H);
      const g = x.createLinearGradient(0, 0, W, 0); g.addColorStop(0, '#6a5cff'); g.addColorStop(0.6, '#e5484d'); g.addColorStop(1, '#ffb224');
      x.fillStyle = g; x.fillRect(0, 30, W, 100);
      x.fillStyle = '#1d1d24'; x.font = '13px sans-serif';
      for (let i = 0; i < 7; i++) x.fillText('Lorem ipsum dolor sit amet, consectetur adipiscing elit.', 20, 170 + i * 20);
      x.fillStyle = '#5b4bff'; x.fillRect(400 + Math.sin(t / 5) * 50, 160 + t * 3, 140, 80);
      const d = x.getImageData(0, 0, W, H);
      if (noise) for (let i = 0; i < d.data.length; i += 4) { const n = Math.round((rnd() - 0.5) * 2 * noise); d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; }
      frames.push(d.data);
    }
    const merged = new Uint8ClampedArray(frames.length * frames[0].length / 4);
    for (let k = 0; k < 4; k++) merged.set(frames[k * 7], k * frames[0].length);
    const palette = buildPalette(merged, 255);
    // Mean PSNR and SSIM of what's on screen at each frame's time.
    const quality = async (blob) => {
      const dec = new ImageDecoder({ data: blob.stream(), type: blob.type });
      await dec.tracks.ready;
      await dec.completed;
      const shown = [];
      const cx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
      for (let i = 0; i < dec.tracks.selectedTrack.frameCount; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        cx.clearRect(0, 0, W, H); cx.drawImage(image, 0, 0);
        shown.push({ t: image.timestamp / 1000, px: cx.getImageData(0, 0, W, H).data });
        image.close();
      }
      let p = 0, s = 0;
      for (let t = 0; t < N; t++) {
        const f = shown.findLast((v) => v.t <= t * 100 + 50) || shown[0];
        p += Math.min(99, lab.psnr(frames[t], f.px)); s += lab.ssim(frames[t], f.px, W, H);
      }
      return { psnr: +(p / N).toFixed(2), ssim: +(s / N).toFixed(4) };
    };
    const tag = noise ? 'noisy' : 'clean';
    for (const [label, opts] of [['gif', {}], ['gif dither', { dither: true }], ['gif lossy 40', { lossy: 40 }]]) {
      const t = performance.now();
      const g = new GifEncoder(W, H, { palette, optimize: true, ...opts });
      for (const fr of frames) g.addFrame(new Uint8ClampedArray(fr), 100);
      const blob = await g.finish();
      out[`anim ${tag} ${label}`] = { bytes: blob.size, ms: Math.round(performance.now() - t), ...(await quality(blob)) };
    }
    const t = performance.now();
    const w = new WebpAnimEncoder(W, H, { quality: 0.8, optimize: true });
    for (const fr of frames) { x.putImageData(new ImageData(new Uint8ClampedArray(fr), W, H), 0, 0); await w.addFrame(c, 100); }
    const blob = w.finish();
    out[`anim ${tag} webp 80`] = { bytes: blob.size, ms: Math.round(performance.now() - t), ...(await quality(blob)) };
  }
  return out;
}, images);

await env.close();
site.close();

const all = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
const baseline = all[process.platform] || {};
const problems = [];
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('case', 28)}${pad('size', 12)}${pad('change', 9)}${pad('PSNR', 9)}${pad('SSIM', 9)}time`);
for (const [key, v] of Object.entries(results)) {
  const b = baseline[key];
  const change = b ? ((v.bytes / b.bytes - 1) * 100).toFixed(1) + '%' : 'new';
  console.log(`${pad(key, 28)}${pad((v.bytes / 1024).toFixed(1) + ' KB', 12)}${pad(change, 9)}${pad(v.psnr ?? '–', 9)}${pad(v.ssim ?? '–', 9)}${v.ms} ms`);
  if (!b) continue;
  if (v.bytes > b.bytes * 1.03) problems.push(`${key}: ${v.bytes} bytes, baseline ${b.bytes}`);
  if (v.psnr !== undefined && b.psnr !== undefined && v.psnr < b.psnr - 0.25) problems.push(`${key}: PSNR ${v.psnr}, baseline ${b.psnr}`);
  if (v.ssim !== undefined && b.ssim !== undefined && v.ssim < b.ssim - 0.003) problems.push(`${key}: SSIM ${v.ssim}, baseline ${b.ssim}`);
}

if (update) {
  all[process.platform] = Object.fromEntries(Object.entries(results).map(([k, { ms, ...rest }]) => [k, rest]));
  writeFileSync(baselineFile, JSON.stringify(all, null, 2) + '\n');
  console.log(`\nSaved ${process.platform} baselines to ${baselineFile}`);
} else if (problems.length && reportOnly) {
  console.log(`\nDiffers from the ${process.platform} baseline (not failing: --report):\n  ${problems.join('\n  ')}`);
} else if (problems.length) {
  console.log(`\nWorse than the baseline:\n  ${problems.join('\n  ')}`);
  process.exit(1);
} else if (!Object.keys(baseline).length) {
  console.log(`\nNo ${process.platform} baselines to compare with; run with --update to save these.`);
} else {
  console.log('\nNo regressions.');
}
