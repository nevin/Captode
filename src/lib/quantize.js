// Colour reduction for GIF and 8-bit PNG: median cut over a 15-bit colour histogram,
// with optional Floyd–Steinberg dithering when mapping pixels to the palette.

const key = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * Builds a palette of at most `maxColors` from RGBA `data`. Pixels with alpha below
 * 128, and pixels whose `mask` entry is 0, are left out.
 * Returns a Uint8Array of packed RGB triples.
 */
export function buildPalette(data, maxColors, mask = null) {
  const count = new Uint32Array(32768);
  const sr = new Float64Array(32768);
  const sg = new Float64Array(32768);
  const sb = new Float64Array(32768);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 128 || (mask && !mask[p])) continue;
    const k = key(data[i], data[i + 1], data[i + 2]);
    count[k]++;
    sr[k] += data[i];
    sg[k] += data[i + 1];
    sb[k] += data[i + 2];
  }
  const bins = [];
  for (let k = 0; k < 32768; k++) if (count[k]) bins.push(k);
  if (!bins.length) return new Uint8Array([0, 0, 0]);

  const comp = [(k) => k >> 10, (k) => (k >> 5) & 31, (k) => k & 31];
  let boxes = [{ keys: bins, n: bins.reduce((a, k) => a + count[k], 0) }];

  const spread = (box) => {
    let best = -1;
    let axis = 0;
    for (let a = 0; a < 3; a++) {
      let lo = 31, hi = 0;
      for (const k of box.keys) {
        const v = comp[a](k);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > best) { best = hi - lo; axis = a; }
    }
    return { range: best, axis };
  };

  while (boxes.length < maxColors) {
    let pick = -1;
    let score = 0;
    let pickAxis = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.keys.length < 2) continue;
      b.s ||= spread(b);
      const { range, axis } = b.s;
      const s = range * Math.sqrt(b.n);
      if (s > score) { score = s; pick = i; pickAxis = axis; }
    }
    if (pick < 0) break;
    const box = boxes[pick];
    const f = comp[pickAxis];
    box.keys.sort((a, b) => f(a) - f(b));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.keys.length - 1; i++) {
      acc += count[box.keys[i]];
      cut = i + 1;
      if (acc >= box.n / 2) break;
    }
    const a = box.keys.slice(0, cut);
    const b = box.keys.slice(cut);
    const sum = (ks) => ks.reduce((s, k) => s + count[k], 0);
    boxes.splice(pick, 1, { keys: a, n: sum(a) }, { keys: b, n: sum(b) });
  }

  const pal = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    let r = 0, g = 0, b = 0;
    for (const k of box.keys) { r += sr[k]; g += sg[k]; b += sb[k]; }
    pal[i * 3] = Math.round(r / box.n);
    pal[i * 3 + 1] = Math.round(g / box.n);
    pal[i * 3 + 2] = Math.round(b / box.n);
  });
  return pal;
}

function nearestFinder(pal) {
  const cache = new Int16Array(32768).fill(-1);
  const n = pal.length / 3;
  return (r, g, b) => {
    const k = key(r, g, b);
    let c = cache[k];
    if (c >= 0) return c;
    const cr = (r & ~7) | 4, cg = (g & ~7) | 4, cb = (b & ~7) | 4;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = pal[i * 3] - cr, dg = pal[i * 3 + 1] - cg, db = pal[i * 3 + 2] - cb;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < best) { best = d; c = i; }
    }
    cache[k] = c;
    return c;
  };
}

/**
 * Maps RGBA pixels to palette indices. Transparent pixels and pixels outside `mask`
 * get `transparentIndex` (pass -1 when the image has no transparent slot).
 */
export function mapPixels(data, width, height, pal, { dither = false, transparentIndex = -1, mask = null } = {}) {
  const out = new Uint8Array(width * height);
  const find = nearestFinder(pal);
  if (!dither) {
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
      if (transparentIndex >= 0 && (data[i + 3] < 128 || (mask && !mask[p]))) out[p] = transparentIndex;
      else out[p] = find(data[i], data[i + 1], data[i + 2]);
    }
    return out;
  }
  let cur = new Float32Array((width + 2) * 3);
  let next = new Float32Array((width + 2) * 3);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      if (transparentIndex >= 0 && (data[i + 3] < 128 || (mask && !mask[p]))) {
        out[p] = transparentIndex;
        continue;
      }
      const e = (x + 1) * 3;
      const r = clamp(data[i] + cur[e]);
      const g = clamp(data[i + 1] + cur[e + 1]);
      const b = clamp(data[i + 2] + cur[e + 2]);
      const c = find(r | 0, g | 0, b | 0);
      out[p] = c;
      const er = r - pal[c * 3], eg = g - pal[c * 3 + 1], eb = b - pal[c * 3 + 2];
      cur[e + 3] += er * 7 / 16; cur[e + 4] += eg * 7 / 16; cur[e + 5] += eb * 7 / 16;
      next[e - 3] += er * 3 / 16; next[e - 2] += eg * 3 / 16; next[e - 1] += eb * 3 / 16;
      next[e] += er * 5 / 16; next[e + 1] += eg * 5 / 16; next[e + 2] += eb * 5 / 16;
      next[e + 3] += er / 16; next[e + 4] += eg / 16; next[e + 5] += eb / 16;
    }
    [cur, next] = [next, cur];
    next.fill(0);
  }
  return out;
}
