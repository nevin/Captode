// Still-image encoders the browser does not provide: PDF, BMP, 8-bit PNG, GIF.
import { buildPalette, mapPixels, exactColors } from './quantize.js';
import { GifEncoder } from './gif.js';
import { deflate, encodeIndexed, encodePng, filterRows } from './png.js';
import { oxipng, mozjpeg } from './wasm.js';
import { SRGB_ICC, tagPng, tagJpeg } from './srgb.js';

const enc = new TextEncoder();

function canvasOf(w, h) {
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

/** Draws `src` on white (formats without transparency) and returns the canvas. */
function flatten(src, x = 0, y = 0, w = src.width, h = src.height) {
  const [c, ctx] = canvasOf(w, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

// ---------- PDF ----------

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} src
 * @param {{ page: 'fit'|'a4'|'letter', split: boolean, margin: number, quality: number }} o
 */
export async function toPdf(src, { page = 'fit', split = true, margin = 24, quality = 0.92, calibrate = true } = {}) {
  const W = src.width, H = src.height;
  const pages = [];
  const jpeg = (c) => pdfImage(c, quality, calibrate);

  if (page === 'fit') {
    // 96 dpi screen pixels at 72 points an inch; PDF pages top out at 14400 points.
    const s = Math.min(0.75, 14400 / W, 14400 / H);
    pages.push({ pw: W * s, ph: H * s, img: await jpeg(flatten(src)), iw: W, ih: H, x: 0, y: 0, w: W * s, h: H * s });
  } else {
    let [pw, ph] = PAGE_SIZES[page];
    if (W > H && !split) [pw, ph] = [ph, pw];
    const cw = pw - margin * 2;
    const ch = ph - margin * 2;
    if (!split) {
      const s = Math.min(0.75, cw / W, ch / H);
      pages.push({ pw, ph, img: await jpeg(flatten(src)), iw: W, ih: H, x: (pw - W * s) / 2, y: ph - margin - H * s, w: W * s, h: H * s });
    } else {
      const s = Math.min(0.75, cw / W);
      const slice = Math.max(1, Math.floor(ch / s));
      for (let top = 0; top < H; top += slice) {
        const sh = Math.min(slice, H - top);
        pages.push({
          pw, ph, img: await jpeg(flatten(src, 0, top, W, sh)), iw: W, ih: sh,
          x: (pw - W * s) / 2, y: ph - margin - sh * s, w: W * s, h: sh * s,
        });
      }
    }
  }
  return buildPdf(pages);
}

/**
 * A page image for the PDF: JPEG, or lossless Flate when that is smaller (screenshots
 * of text and UI often are) or when the quality is set to 100%. Lossless pages use a
 * colour index when the image has 256 colours or fewer, and PNG row prediction
 * otherwise.
 */
async function pdfImage(c, quality, calibrate = true) {
  const w = c.width, h = c.height;
  const lossless = quality >= 0.995;
  // Baseline JPEG: every PDF reader handles it.
  const jpegData = lossless ? null : await jpegBytes(c, quality, { progressive: false, calibrate });
  const px = pixelsOf(c);
  let flate;
  const pal = exactColors(px, 256);
  if (pal) {
    const lookup = new Map();
    for (let i = 0; i < pal.length / 3; i++) lookup.set(pal[i * 3] | (pal[i * 3 + 1] << 8) | (pal[i * 3 + 2] << 16), i);
    const idx = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < idx.length; i += 4, p++) idx[p] = lookup.get(px[i] | (px[i + 1] << 8) | (px[i + 2] << 16));
    const hex = [...pal].map((b) => b.toString(16).padStart(2, '0')).join('');
    flate = {
      colorSpace: `[/Indexed /DeviceRGB ${pal.length / 3 - 1} <${hex}>]`, filter: '/FlateDecode',
      parms: `<< /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ${w} >>`,
      data: await deflate(filterRows(idx, w, h, 1, 'none')),
    };
  } else if (lossless || jpegData.length > w * h / 4) {
    // Only worth trying when the JPEG isn't already tiny: lossless RGB rarely gets
    // below a quarter of a byte per pixel.
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, o = 0; i < px.length; i += 4) { rgb[o++] = px[i]; rgb[o++] = px[i + 1]; rgb[o++] = px[i + 2]; }
    flate = {
      colorSpace: '/DeviceRGB', filter: '/FlateDecode',
      parms: `<< /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${w} >>`,
      data: await deflate(filterRows(rgb, w * 3, h, 3)),
    };
  }
  if (lossless || (flate && flate.data.length <= jpegData.length)) return flate;
  return { colorSpace: '/DeviceRGB', filter: '/DCTDecode', data: jpegData };
}

function buildPdf(pages) {
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); pos += b.length; };
  const f = (n) => Number(n.toFixed(2));
  const obj = (n, ...body) => { offsets[n] = pos; push(`${n} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const n = 3 + i * 3;
    const content = `q ${f(p.w)} 0 0 ${f(p.h)} ${f(p.x)} ${f(p.y)} cm /Im0 Do Q`;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(p.pw)} ${f(p.ph)}] ` +
      `/Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const im = p.img;
    // Colours are sRGB (the profile is the last object).
    const colorSpace = im.colorSpace.replace('/DeviceRGB', `[/ICCBased ${3 + pages.length * 3} 0 R]`);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.iw} /Height ${p.ih} /ColorSpace ${colorSpace} ` +
      `/BitsPerComponent 8 /Filter ${im.filter}${im.parms ? ` /DecodeParms ${im.parms}` : ''} /Length ${im.data.length} >>\nstream\n`, im.data, '\nendstream');
  });
  const icc = 3 + pages.length * 3;
  obj(icc, `<< /N 3 /Alternate /DeviceRGB /Length ${SRGB_ICC.length} >>\nstream\n`, SRGB_ICC, '\nendstream');
  const count = icc + 1;
  const xref = pos;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// ---------- BMP ----------

export function toBmp(src) {
  const c = flatten(src);
  const { width: w, height: h } = c;
  const px = c.getContext('2d').getImageData(0, 0, w, h).data;
  const row = (w * 3 + 3) & ~3;
  // The basic header: BMP colours are sRGB unless a later header says otherwise.
  const HEAD = 54;
  const buf = new ArrayBuffer(HEAD + row * h);
  const v = new DataView(buf);
  v.setUint16(0, 0x4d42, true);
  v.setUint32(2, buf.byteLength, true);
  v.setUint32(10, HEAD, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, row * h, true);
  v.setInt32(38, 2835, true);
  v.setInt32(42, 2835, true);
  const out = new Uint8Array(buf);
  for (let y = 0; y < h; y++) {
    let o = HEAD + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[o++] = px[i + 2];
      out[o++] = px[i + 1];
      out[o++] = px[i];
    }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

// ---------- PNG ----------

const pixelsOf = (src) => src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height).data;

/**
 * Lossless PNG: the smaller of the browser's encoding and Captode's optimised one,
 * then recompressed by oxipng when that can run.
 */
export async function toPng(src) {
  const [own, browser] = await Promise.all([
    encodePng(pixelsOf(src), src.width, src.height),
    src.convertToBlob({ type: 'image/png' }),
  ]);
  return squeeze(own.size <= browser.size ? own : browser);
}

/** Recompresses a PNG blob with oxipng, keeping whichever is smaller, marked as sRGB. */
async function squeeze(png) {
  const better = await oxipng(await png.arrayBuffer());
  const bytes = better && better.length < png.size ? better : new Uint8Array(await png.arrayBuffer());
  return new Blob([tagPng(bytes)], { type: 'image/png' });
}

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = a[i] - b[i], dg = a[i + 1] - b[i + 1], db = a[i + 2] - b[i + 2];
    se += dr * dr + dg * dg + db * db;
  }
  return 10 * Math.log10((255 * 255) / Math.max(1e-9, se / ((a.length / 4) * 3)));
}

async function decodedPixels(bytes, w, h) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * JPEG of `src` on white. MozJPEG makes smaller files than the browser at the
 * same quality, but its quality numbers don't line up with the browser's. So by
 * default (`calibrate`) this finds the smallest MozJPEG file at least as faithful
 * (by PSNR) as the browser's at `quality`, and keeps the browser's if that's
 * smaller: the quality setting keeps its meaning, the file gets smaller. Without
 * `calibrate` (when searching for a size), `quality` goes to MozJPEG as it is.
 * Returns bytes.
 */
async function jpegBytes(src, quality, { progressive = true, calibrate = true } = {}) {
  const flat = flatten(src);
  const { width: w, height: h } = flat;
  const px = pixelsOf(flat);
  const browserJpeg = async () => new Uint8Array(await (await flat.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
  if (!calibrate) return (await mozjpeg(px, w, h, { quality, progressive })) || browserJpeg();
  const browser = await browserJpeg();

  const target = psnr(px, await decodedPixels(browser, w, h));
  let best = browser;
  let lo = Math.max(0.2, quality - 0.3), hi = Math.min(1, quality + 0.1);
  for (let i = 0; i < 5; i++) {
    const q = (lo + hi) / 2;
    const moz = await mozjpeg(px, w, h, { quality: q, progressive });
    if (!moz) break;
    if (psnr(px, await decodedPixels(moz, w, h)) >= target) {
      if (moz.length < best.length) best = moz;
      hi = q; // good enough: try lower
    } else {
      lo = q;
    }
  }
  return best;
}

/**
 * The fewest colours (256, 128 … 16) that keep `px` looking right: at least 39 dB
 * PSNR, where banding and blotches start to show. Measured on a sample of the
 * pixels, so it's quick. An image with 256 colours or fewer keeps them all.
 */
export function autoColours(px, max = 256) {
  const exact = exactColors(px, max);
  if (exact) return Math.max(2, exact.length / 3);
  const step = Math.max(1, Math.floor(px.length / 4 / 200000)); // about 200k pixels
  const sample = new Uint8ClampedArray(Math.ceil(px.length / 4 / step) * 4);
  for (let i = 0, o = 0; i < px.length; i += step * 4, o += 4) sample.set(px.subarray(i, i + 4), o);
  const n = sample.length / 4;
  let pick = max;
  for (const c of [128, 64, 32, 16].filter((c) => c < max)) {
    const pal = buildPalette(sample, c);
    const idx = mapPixels(sample, n, 1, pal);
    let se = 0, count = 0;
    for (let p = 0; p < n; p++) {
      if (sample[p * 4 + 3] < 128) continue;
      for (let k = 0; k < 3; k++) { const d = sample[p * 4 + k] - pal[idx[p] * 3 + k]; se += d * d; }
      count += 3;
    }
    const psnr = 10 * Math.log10((255 * 255) / Math.max(1e-9, se / Math.max(1, count)));
    if (psnr < 39) break;
    pick = c;
  }
  return pick;
}

/**
 * Palette PNG with at most `colors` colours ('auto' picks the fewest that look
 * right): much smaller than a full-colour PNG.
 */
export async function toPng8(src, { colors = 256, dither = true } = {}) {
  const { width: w, height: h } = src;
  const px = pixelsOf(src);
  let hasAlpha = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) { hasAlpha = true; break; }
  if (colors === 'auto') colors = autoColours(px, hasAlpha ? 255 : 256) + (hasAlpha ? 1 : 0);
  const pal = buildPalette(px, hasAlpha ? colors - 1 : colors);
  const n = pal.length / 3;
  const idx = mapPixels(px, w, h, pal, { dither, transparentIndex: hasAlpha ? n : -1 });
  if (!hasAlpha) return squeeze(await encodeIndexed(idx, w, h, pal));
  // The transparent entry goes first, so the tRNS chunk is a single byte.
  const rgb = new Uint8Array((n + 1) * 3);
  rgb.set(pal, 3);
  const shifted = new Uint8Array(idx.length);
  for (let p = 0; p < idx.length; p++) shifted[p] = idx[p] === n ? 0 : idx[p] + 1;
  const alpha = new Uint8Array(n + 1).fill(255);
  alpha[0] = 0;
  return squeeze(await encodeIndexed(shifted, w, h, rgb, alpha));
}

// ---------- GIF (still) ----------

export function toGif(src, { colors = 256, dither = true, lossy = 0 } = {}) {
  const { width: w, height: h } = src;
  const px = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  if (colors === 'auto') colors = autoColours(px, 255) + 1;
  const g = new GifEncoder(w, h, { colors, dither, optimize: false, transparent: true, lossy });
  g.addFrame(px, 0);
  return g.finish();
}

// ---------- any format ----------

/**
 * Encodes `src` (an OffscreenCanvas) as `format`: png, png8, jpeg, webp, avif, gif,
 * bmp or pdf. `o`: `{ quality (0–1), colors, dither, page, split }`.
 */
export async function encodeImage(src, format, { quality = 0.85, colors = 256, dither = true, lossy = 0, page = 'fit', split = true, calibrate = true } = {}) {
  switch (format) {
    case 'png': return toPng(src);
    case 'png8': return toPng8(src, { colors, dither });
    case 'jpeg': return new Blob([tagJpeg(await jpegBytes(src, quality, { calibrate }))], { type: 'image/jpeg' });
    case 'webp': return src.convertToBlob({ type: 'image/webp', quality });
    case 'avif': {
      // Browsers without an AVIF encoder quietly return PNG instead.
      const blob = await src.convertToBlob({ type: 'image/avif', quality });
      if (blob.type !== 'image/avif') throw new Error('This browser cannot save AVIF.');
      return blob;
    }
    case 'gif': return toGif(src, { colors, dither, lossy });
    case 'bmp': return toBmp(src);
    case 'pdf': return toPdf(src, { page, split, quality, calibrate });
    default: throw new Error(`Unknown format: ${format}`);
  }
}

// ---------- fitting a size limit ----------

function scaled(src, s) {
  const w = Math.max(1, Math.round(src.width * s));
  const h = Math.max(1, Math.round(src.height * s));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

/**
 * Encodes `src` as `format` no larger than `maxBytes`, giving up as little as it
 * can: first quality (JPEG, WebP, AVIF, PDF), or lossy compression and colours
 * (GIF, PNG-8), and only then pixel size. PNG and BMP are lossless, so only their
 * size can change.
 * Returns `{ blob, width, height, fitted }`; `fitted` describes what changed.
 */
export async function fitImage(src, format, o, maxBytes) {
  const first = await encodeImage(src, format, o);
  if (!maxBytes || first.size <= maxBytes) return { blob: first, width: src.width, height: src.height, fitted: null };

  let settings = { ...o };
  let best = null; // smallest result so far, in case nothing fits
  const keep = (blob, c, s) => { if (!best || blob.size < best.blob.size) best = { blob, width: c.width, height: c.height, settings: s }; };
  keep(first, src, settings);

  if (['jpeg', 'webp', 'avif', 'pdf'].includes(format)) {
    // Binary search for the highest quality that fits.
    let lo = 0.2, hi = o.quality ?? 0.85, fit = null;
    for (let i = 0; i < 7 && hi - lo > 0.02; i++) {
      const q = (lo + hi) / 2;
      const blob = await encodeImage(src, format, { ...o, quality: q, calibrate: false });
      keep(blob, src, { ...o, quality: q, calibrate: false });
      if (blob.size <= maxBytes) { fit = { blob, q }; lo = q; } else hi = q;
    }
    if (fit) return { blob: fit.blob, width: src.width, height: src.height, fitted: { quality: fit.q } };
    settings = { ...o, quality: 0.6, calibrate: false }; // then shrink, at a quality that still looks fine
  } else if (format === 'gif' || format === 'png8') {
    const steps = format === 'gif'
      ? [{ lossy: 30 }, { lossy: 60 }, { lossy: 60, colors: 128 }, { lossy: 80, colors: 64 }]
      : [{ colors: 128 }, { colors: 64 }, { colors: 32 }];
    for (const step of steps) {
      const s = { ...o, ...step };
      const blob = await encodeImage(src, format, s);
      keep(blob, src, s);
      settings = s;
      if (blob.size <= maxBytes) return { blob, width: src.width, height: src.height, fitted: step };
    }
  }

  // Shrink, guessing the scale from how far over the limit it is.
  let scale = 1;
  let size = best.blob.size;
  for (let i = 0; i < 8 && scale > 0.05; i++) {
    scale *= Math.min(0.95, Math.sqrt(maxBytes / size) * 0.97);
    const c = scaled(src, scale);
    const blob = await encodeImage(c, format, settings);
    keep(blob, c, settings);
    size = blob.size;
    if (blob.size <= maxBytes) {
      const changed = { scale };
      for (const k of ['quality', 'colors', 'lossy']) if (settings[k] !== o[k]) changed[k] = settings[k];
      return { blob, width: c.width, height: c.height, fitted: changed };
    }
  }
  return { blob: best.blob, width: best.width, height: best.height, fitted: { tooBig: true } };
}
