// PNG writer that looks for the smallest lossless encoding of an image:
// a palette (at the lowest bit depth that fits) when there are 256 colours or
// fewer, greyscale when there's no colour, and no alpha channel when everything
// is opaque. Each row gets the filter that suits it best before deflate.
// The browser's own PNG encoder always writes 32-bit RGBA and favours speed, so
// this is often much smaller with exactly the same pixels.

const enc = new TextEncoder();

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib-wrapped deflate, as PNG and PDF's FlateDecode both expect. */
export async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Adds a filter byte to each row of `raw` (`h` rows of `stride` bytes, `bpp` bytes
 * per pixel). `mode` 'none' leaves rows as they are; 'adaptive' picks, per row, the
 * filter with the smallest sum of absolute values, the heuristic libpng uses.
 */
export function filterRows(raw, stride, h, bpp, mode = 'adaptive') {
  const out = new Uint8Array((stride + 1) * h);
  if (mode === 'none') {
    for (let y = 0; y < h; y++) out.set(raw.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
    return out;
  }
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = raw.subarray(y * stride, y * stride + stride);
    const up = y ? raw.subarray((y - 1) * stride, y * stride) : zero;
    const [c0, c1, c2, c3, c4] = cand;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    const cost = (v) => (v < 128 ? v : 256 - v);
    for (let i = 0; i < stride; i++) {
      const x = row[i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = up[i];
      const c = i >= bpp ? up[i - bpp] : 0;
      const v1 = (x - a) & 255, v2 = (x - b) & 255, v3 = (x - ((a + b) >> 1)) & 255, v4 = (x - paeth(a, b, c)) & 255;
      c0[i] = x; c1[i] = v1; c2[i] = v2; c3[i] = v3; c4[i] = v4;
      s0 += cost(x); s1 += cost(v1); s2 += cost(v2); s3 += cost(v3); s4 += cost(v4);
    }
    const sums = [s0, s1, s2, s3, s4];
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
    out[y * (stride + 1)] = best;
    out.set(cand[best], y * (stride + 1) + 1);
  }
  return out;
}

/** Packs 8-bit palette indices into rows of `depth` bits per pixel. */
function packIndices(idx, w, h, depth) {
  if (depth === 8) return { raw: idx, stride: w };
  const stride = Math.ceil((w * depth) / 8);
  const raw = new Uint8Array(stride * h);
  const per = 8 / depth;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = idx[y * w + x];
      raw[y * stride + Math.floor(x / per)] |= v << (8 - depth * (1 + (x % per)));
    }
  }
  return { raw, stride };
}

const depthFor = (n) => (n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8);

function header(w, h, depth, colourType) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([depth, colourType, 0, 0, 0], 8);
  return ihdr;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Deflates each candidate filtering of the same rows and returns the smallest. */
async function smallestIdat(raw, stride, h, bpp, modes) {
  let best = null;
  for (const m of modes) {
    const z = await deflate(filterRows(raw, stride, h, bpp, m));
    if (!best || z.length < best.length) best = z;
  }
  return best;
}

/**
 * Palette PNG from 8-bit indices. `rgb` holds packed RGB triples; `alpha`, if given,
 * the alpha of each entry (entries without one are opaque).
 */
export async function encodeIndexed(idx, w, h, rgb, alpha = null) {
  const n = rgb.length / 3;
  const depth = depthFor(n);
  const { raw, stride } = packIndices(idx, w, h, depth);
  // Low bit depths almost always compress best unfiltered; at 8 bits it depends.
  const idat = await smallestIdat(raw, stride, h, 1, depth === 8 ? ['none', 'adaptive'] : ['none']);
  const parts = [SIGNATURE, chunk('IHDR', header(w, h, depth, 3)), chunk('PLTE', rgb)];
  if (alpha) {
    let last = alpha.length;
    while (last > 0 && alpha[last - 1] === 255) last--; // trailing opaque entries can be left out
    if (last) parts.push(chunk('tRNS', alpha.subarray(0, last)));
  }
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

/**
 * The smallest lossless PNG for RGBA `data`. Fully transparent pixels are stored
 * as transparent black, which looks identical and compresses better.
 */
export async function encodePng(data, w, h) {
  const px = new Uint8Array(data);
  let opaque = true, grey = true;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) { px[i] = px[i + 1] = px[i + 2] = 0; }
    if (px[i + 3] !== 255) opaque = false;
    if (px[i] !== px[i + 1] || px[i] !== px[i + 2]) grey = false;
  }

  // Up to 256 distinct colours (counting alpha): a palette loses nothing.
  const colours = new Map();
  const u32 = new Uint32Array(px.buffer);
  for (let p = 0; p < u32.length && colours.size <= 256; p++) {
    if (!colours.has(u32[p])) colours.set(u32[p], colours.size);
  }
  if (colours.size <= 256 && !(grey && colours.size > 16)) {
    // Put translucent entries first so the tRNS chunk can stop early.
    const entries = [...colours.keys()].sort((a, b) => (a >>> 24) - (b >>> 24));
    const index = new Map(entries.map((c, i) => [c, i]));
    const rgb = new Uint8Array(entries.length * 3);
    const alpha = new Uint8Array(entries.length);
    entries.forEach((c, i) => {
      rgb[i * 3] = c & 255; rgb[i * 3 + 1] = (c >> 8) & 255; rgb[i * 3 + 2] = (c >> 16) & 255;
      alpha[i] = c >>> 24;
    });
    const idx = new Uint8Array(w * h);
    for (let p = 0; p < idx.length; p++) idx[p] = index.get(u32[p]);
    return encodeIndexed(idx, w, h, rgb, opaque ? null : alpha);
  }

  const channels = (grey ? 1 : 3) + (opaque ? 0 : 1);
  const raw = new Uint8Array(w * h * channels);
  for (let i = 0, o = 0; i < px.length; i += 4) {
    raw[o++] = px[i];
    if (!grey) { raw[o++] = px[i + 1]; raw[o++] = px[i + 2]; }
    if (!opaque) raw[o++] = px[i + 3];
  }
  const colourType = grey ? (opaque ? 0 : 4) : (opaque ? 2 : 6);
  const idat = await smallestIdat(raw, w * channels, h, channels, ['adaptive']);
  return new Blob([SIGNATURE, chunk('IHDR', header(w, h, 8, colourType)), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}
