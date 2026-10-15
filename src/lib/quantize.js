// Colour reduction for GIF and 8-bit PNG.
//
// 1. If the image has no more colours than the palette allows (common for UI
//    screenshots), the palette is exactly those colours and nothing is lost.
// 2. Otherwise a median cut over a 15-bit histogram picks starting colours, and a
//    few rounds of k-means move them to where the pixels actually are.
// 3. Pixels are mapped to the nearest colour by a perceptually weighted distance,
//    optionally with serpentine Floyd–Steinberg dithering that leaves areas of
//    exact palette colours clean (noise there costs bytes and looks worse).

const key = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
export const WR = 2, WG = 4, WB = 3; // channel weights: the eye is most sensitive to green

/**
 * The distinct opaque colours in `data`, as packed RGB triples, or null when there
 * are more than `max`. Pixels with alpha below 128, or whose `mask` entry is 0, are
 * left out.
 */
export function exactColors(data, max, mask = null) {
  const seen = new Map();
  let last = -1;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 128 || (mask && !mask[p])) continue;
    const v = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
    if (v === last) continue;
    last = v;
    if (!seen.has(v)) {
      if (seen.size === max) return null;
      seen.set(v, seen.size);
    }
  }
  const pal = new Uint8Array(Math.max(1, seen.size) * 3);
  let i = 0;
  for (const v of seen.keys()) {
    pal[i++] = v & 255;
    pal[i++] = (v >> 8) & 255;
    pal[i++] = (v >> 16) & 255;
  }
  return pal;
}

/**
 * Builds a palette of at most `maxColors` from RGBA `data`. Pixels with alpha below
 * 128, and pixels whose `mask` entry is 0, are left out.
 * Returns a Uint8Array of packed RGB triples.
 */
export function buildPalette(data, maxColors, mask = null) {
  const exact = exactColors(data, maxColors, mask);
  if (exact) return exact;

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

  const n = boxes.length;
  const pal = new Float64Array(n * 3);
  boxes.forEach((box, i) => {
    let r = 0, g = 0, b = 0;
    for (const k of box.keys) { r += sr[k]; g += sg[k]; b += sb[k]; }
    pal[i * 3] = r / box.n;
    pal[i * 3 + 1] = g / box.n;
    pal[i * 3 + 2] = b / box.n;
  });
  refine(pal, bins, count, sr, sg, sb);

  const out = new Uint8Array(n * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(pal[i]);
  return out;
}

/**
 * k-means over the histogram: each bin goes to its nearest palette colour, and each
 * colour moves to the weighted mean of its bins. Median cut splits boxes along
 * straight lines; this lets colours settle where the pixels cluster.
 */
function refine(pal, bins, count, sr, sg, sb, rounds = 4) {
  const n = pal.length / 3;
  const m = bins.length;
  const br = new Float64Array(m), bg = new Float64Array(m), bb = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const k = bins[j];
    br[j] = sr[k] / count[k];
    bg[j] = sg[k] / count[k];
    bb[j] = sb[k] / count[k];
  }
  const acc = new Float64Array(n * 4);
  for (let round = 0; round < rounds; round++) {
    acc.fill(0);
    let moved = 0;
    for (let j = 0; j < m; j++) {
      let best = Infinity, c = 0;
      for (let i = 0; i < n; i++) {
        const dr = pal[i * 3] - br[j], dg = pal[i * 3 + 1] - bg[j], db = pal[i * 3 + 2] - bb[j];
        const d = dr * dr * WR + dg * dg * WG + db * db * WB;
        if (d < best) { best = d; c = i; }
      }
      const w = count[bins[j]];
      acc[c * 4] += br[j] * w;
      acc[c * 4 + 1] += bg[j] * w;
      acc[c * 4 + 2] += bb[j] * w;
      acc[c * 4 + 3] += w;
    }
    for (let i = 0; i < n; i++) {
      const w = acc[i * 4 + 3];
      if (!w) continue; // keep colours that lost all their pixels where they were
      for (let ch = 0; ch < 3; ch++) {
        const v = acc[i * 4 + ch] / w;
        moved = Math.max(moved, Math.abs(v - pal[i * 3 + ch]));
        pal[i * 3 + ch] = v;
      }
    }
    if (moved < 0.5) break;
  }
}

/**
 * Returns a function that maps an RGB colour to its palette index: exact matches by
 * lookup, everything else by a search cached at 6 bits per channel.
 */
function nearestFinder(pal) {
  const n = pal.length / 3;
  const exact = new Map();
  for (let i = n - 1; i >= 0; i--) exact.set(pal[i * 3] | (pal[i * 3 + 1] << 8) | (pal[i * 3 + 2] << 16), i);
  const cache = new Int16Array(1 << 18).fill(-1);
  return (r, g, b) => {
    const e = exact.get(r | (g << 8) | (b << 16));
    if (e !== undefined) return e;
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let c = cache[k];
    if (c >= 0) return c;
    const cr = (r & ~3) | 2, cg = (g & ~3) | 2, cb = (b & ~3) | 2;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = pal[i * 3] - cr, dg = pal[i * 3 + 1] - cg, db = pal[i * 3 + 2] - cb;
      const d = dr * dr * WR + dg * dg * WG + db * db * WB;
      if (d < best) { best = d; c = i; }
    }
    cache[k] = c;
    return c;
  };
}

// 8×8 Bayer matrix, as thresholds from -0.5 to 0.5.
const BAYER = (() => {
  const m = [[0]];
  let b = m;
  for (let n = 1; n < 8; n *= 2) {
    b = Array.from({ length: n * 2 }, (_, y) => Array.from({ length: n * 2 }, (_, x) =>
      4 * b[y % n][x % n] + [[0, 2], [3, 1]][(y / n) | 0][(x / n) | 0]));
  }
  return Float32Array.from(b.flat(), (v) => (v + 0.5) / 64 - 0.5);
})();

/**
 * Maps RGBA pixels to palette indices. Transparent pixels and pixels outside `mask`
 * get `transparentIndex` (pass -1 when the image has no transparent slot).
 *
 * `dither`: false, true (error diffusion: best for a single image) or 'ordered'
 * (a fixed pattern that depends only on position, so areas that don't change in
 * an animation stay identical from frame to frame and compress away).
 */
export function mapPixels(data, width, height, pal, { dither = false, transparentIndex = -1, mask = null } = {}) {
  const out = new Uint8Array(width * height);
  const find = nearestFinder(pal);
  const clear = (i, p) => transparentIndex >= 0 && (data[i + 3] < 128 || (mask && !mask[p]));
  if (!dither) {
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
      out[p] = clear(i, p) ? transparentIndex : find(data[i], data[i + 1], data[i + 2]);
    }
    return out;
  }

  const inPalette = new Set();
  for (let i = 0; i < pal.length; i += 3) inPalette.add(pal[i] | (pal[i + 1] << 8) | (pal[i + 2] << 16));

  if (dither === 'ordered') {
    // Spread the pattern over about the distance between neighbouring palette colours.
    const spread = 255 / Math.cbrt(pal.length / 3) * 0.3;
    const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
    for (let y = 0, p = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p++) {
        const i = p * 4;
        if (clear(i, p)) { out[p] = transparentIndex; continue; }
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (inPalette.has(r | (g << 8) | (b << 16))) { out[p] = find(r, g, b); continue; }
        const t = BAYER[(y & 7) * 8 + (x & 7)] * spread;
        out[p] = find(clamp8(r + t), clamp8(g + t), clamp8(b + t));
      }
    }
    return out;
  }

  // Diffusing a little less than the full error keeps gradients smooth without
  // sprinkling noise over flat areas, which compresses badly.
  const STRENGTH = 0.8;
  let cur = new Float32Array((width + 2) * 3);
  let next = new Float32Array((width + 2) * 3);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < height; y++) {
    // Serpentine: alternate direction each row so errors don't streak one way.
    const ltr = (y & 1) === 0;
    const dir = ltr ? 1 : -1;
    for (let s = 0; s < width; s++) {
      const x = ltr ? s : width - 1 - s;
      const p = y * width + x;
      const i = p * 4;
      if (clear(i, p)) {
        out[p] = transparentIndex;
        continue;
      }
      const e = (x + 1) * 3;
      const sr = data[i], sg = data[i + 1], sb = data[i + 2];
      if (inPalette.has(sr | (sg << 8) | (sb << 16))) {
        // An exact palette colour stays exact, and the error stops here.
        out[p] = find(sr, sg, sb);
        continue;
      }
      const r = clamp(sr + cur[e]);
      const g = clamp(sg + cur[e + 1]);
      const b = clamp(sb + cur[e + 2]);
      const c = find(r | 0, g | 0, b | 0);
      out[p] = c;
      const er = (r - pal[c * 3]) * STRENGTH, eg = (g - pal[c * 3 + 1]) * STRENGTH, eb = (b - pal[c * 3 + 2]) * STRENGTH;
      const f = e + dir * 3; // next pixel in scan order
      const bk = e - dir * 3; // pixel behind, on the next row
      cur[f] += er * 7 / 16; cur[f + 1] += eg * 7 / 16; cur[f + 2] += eb * 7 / 16;
      next[bk] += er * 3 / 16; next[bk + 1] += eg * 3 / 16; next[bk + 2] += eb * 3 / 16;
      next[e] += er * 5 / 16; next[e + 1] += eg * 5 / 16; next[e + 2] += eb * 5 / 16;
      next[f] += er / 16; next[f + 1] += eg / 16; next[f + 2] += eb / 16;
    }
    [cur, next] = [next, cur];
    next.fill(0);
  }
  return out;
}
