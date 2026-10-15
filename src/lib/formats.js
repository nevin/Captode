// Still-image encoders the browser does not provide: PDF, BMP, 8-bit PNG, GIF.
import { buildPalette, mapPixels } from './quantize.js';
import { GifEncoder } from './gif.js';

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
  const jpeg = async (c) => new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());

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
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.iw} /Height ${p.ih} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.img.length} >>\nstream\n`, p.img, '\nendstream');
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

// ---------- 8-bit PNG ----------

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Palette PNG with at most `colors` colours: much smaller than a full-colour PNG. */
export async function toPng8(src, { colors = 256, dither = true } = {}) {
  const { width: w, height: h } = src;
  const px = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let hasAlpha = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) { hasAlpha = true; break; }
  const pal = buildPalette(px, hasAlpha ? colors - 1 : colors);
  const n = pal.length / 3;
  const idx = mapPixels(px, w, h, pal, { dither, transparentIndex: hasAlpha ? n : -1 });
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(idx.subarray(y * w, y * w + w), y * (w + 1) + 1);

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const plte = new Uint8Array((n + (hasAlpha ? 1 : 0)) * 3);
  plte.set(pal);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
  ];
  if (hasAlpha) {
    const trns = new Uint8Array(n + 1).fill(255);
    trns[n] = 0;
    parts.push(pngChunk('tRNS', trns));
  }
  parts.push(pngChunk('IDAT', await deflate(raw)), pngChunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

// ---------- GIF (still) ----------

export function toGif(src, { colors = 256, dither = true } = {}) {
  const { width: w, height: h } = src;
  const px = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new GifEncoder(w, h, { colors, dither, optimize: false, transparent: true });
  g.addFrame(px, 0);
  return g.finish();
}
