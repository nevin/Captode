// Still-image encoders the browser does not provide: PDF, BMP, 8-bit PNG, GIF.
import { buildPalette, mapPixels, exactColors } from './quantize.js';
import { GifEncoder } from './gif.js';
import { deflate, encodeIndexed, encodePng, filterRows } from './png.js';

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
export async function toPdf(src, { page = 'fit', split = true, margin = 24, quality = 0.92 } = {}) {
  const W = src.width, H = src.height;
  const pages = [];
  const jpeg = (c) => pdfImage(c, quality);

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
async function pdfImage(c, quality) {
  const w = c.width, h = c.height;
  const lossless = quality >= 0.995;
  const jpegData = lossless ? null : new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
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
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.iw} /Height ${p.ih} /ColorSpace ${im.colorSpace} ` +
      `/BitsPerComponent 8 /Filter ${im.filter}${im.parms ? ` /DecodeParms ${im.parms}` : ''} /Length ${im.data.length} >>\nstream\n`, im.data, '\nendstream');
  });
  const count = 3 + pages.length * 3;
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
  const buf = new ArrayBuffer(54 + row * h);
  const v = new DataView(buf);
  v.setUint16(0, 0x4d42, true);
  v.setUint32(2, buf.byteLength, true);
  v.setUint32(10, 54, true);
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
    let o = 54 + (h - 1 - y) * row;
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

/** Lossless PNG: the smaller of the browser's encoding and Captode's optimised one. */
export async function toPng(src) {
  const [own, browser] = await Promise.all([
    encodePng(pixelsOf(src), src.width, src.height),
    src.convertToBlob({ type: 'image/png' }),
  ]);
  return own.size <= browser.size ? own : browser;
}

/** Palette PNG with at most `colors` colours: much smaller than a full-colour PNG. */
export async function toPng8(src, { colors = 256, dither = true } = {}) {
  const { width: w, height: h } = src;
  const px = pixelsOf(src);
  let hasAlpha = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) { hasAlpha = true; break; }
  const pal = buildPalette(px, hasAlpha ? colors - 1 : colors);
  const n = pal.length / 3;
  const idx = mapPixels(px, w, h, pal, { dither, transparentIndex: hasAlpha ? n : -1 });
  if (!hasAlpha) return encodeIndexed(idx, w, h, pal);
  // The transparent entry goes first, so the tRNS chunk is a single byte.
  const rgb = new Uint8Array((n + 1) * 3);
  rgb.set(pal, 3);
  const shifted = new Uint8Array(idx.length);
  for (let p = 0; p < idx.length; p++) shifted[p] = idx[p] === n ? 0 : idx[p] + 1;
  const alpha = new Uint8Array(n + 1).fill(255);
  alpha[0] = 0;
  return encodeIndexed(shifted, w, h, rgb, alpha);
}

// ---------- GIF (still) ----------

export function toGif(src, { colors = 256, dither = true } = {}) {
  const { width: w, height: h } = src;
  const px = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new GifEncoder(w, h, { colors, dither, optimize: false, transparent: true });
  g.addFrame(px, 0);
  return g.finish();
}
