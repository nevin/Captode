// Animated GIF encoder. With `optimize` on, frames that look the same as the one
// before are merged into it. With a shared palette as well, each frame stores only
// the rectangle that changed, with unchanged pixels transparent, and a pixel keeps
// its previous colour when that is within a hair of the best match, so video noise
// doesn't count as change. Dithered animations use an ordered pattern, which stays
// put from frame to frame where error diffusion would ripple across the image.
//
// `lossy` (0–100) lets the compressor reuse a nearby colour where that continues a
// run it already knows, the technique behind gifsicle's --lossy: often 30–50%
// smaller for a small, spread-out change in colour.
//
// The work per frame splits into stages: mapping pixels to the palette and
// compressing are independent between frames, so they can run on a pool of
// workers (see gif-worker.js); comparing each frame with the one before is not.
import { buildPalette, mapPixels, WR, WG, WB } from './quantize.js';

class Bytes {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.len = 0; }
  grow(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(v) { this.grow(1); this.buf[this.len++] = v; }
  u16(v) { this.byte(v & 255); this.byte((v >> 8) & 255); }
  bytes(a) { this.grow(a.length); this.buf.set(a, this.len); this.len += a.length; }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  data() { return this.buf.subarray(0, this.len); }
}

// ---------- LZW ----------

const table = new Int16Array(4096 * 256); // (prefix code, pixel) → code
const firstChild = new Int16Array(4096);  // each code's children, as linked lists,
const nextSibling = new Int16Array(4096); // for finding near matches when lossy
const pixelOf = new Uint8Array(4096);

/** How far apart two palette colours may be for lossy compression to swap them. */
export function lossyLimit(level) {
  const perChannel = level * 0.35; // 100 → about 35 levels out of 255
  return perChannel * perChannel * (WR + WG + WB);
}

const distCache = new WeakMap();
/** Weighted squared distances between every pair of palette colours. */
function paletteDistances(pal) {
  let d = distCache.get(pal);
  if (d) return d;
  const n = pal.length / 3;
  d = new Float32Array(256 * 256).fill(Infinity);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const dr = pal[a * 3] - pal[b * 3], dg = pal[a * 3 + 1] - pal[b * 3 + 1], db = pal[a * 3 + 2] - pal[b * 3 + 2];
      d[a * 256 + b] = dr * dr * WR + dg * dg * WG + db * db * WB;
    }
  }
  distCache.set(pal, d);
  return d;
}

/**
 * LZW-compresses palette `indices` as GIF image data. With `lossy`
 * (`{ limit, dist, keep }`), a pixel may take the colour of a known continuation
 * when the two are within `limit`; `keep` is an index that must never change (the
 * transparent one). The indices are updated to what the data decodes to.
 */
export function lzw(indices, minCodeSize, lossy = null) {
  const out = new Bytes(indices.length + 1024);
  out.byte(minCodeSize);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const reset = () => {
    table.fill(-1);
    if (lossy) firstChild.fill(-1);
  };
  reset();

  let acc = 0, bits = 0;
  const block = new Uint8Array(255);
  let blen = 0;
  const flushByte = (b) => {
    block[blen++] = b;
    if (blen === 255) { out.byte(255); out.bytes(block); blen = 0; }
  };
  const emit = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) { flushByte(acc & 255); acc >>>= 8; bits -= 8; }
  };

  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const c = table[key];
    if (c >= 0) { prefix = c; continue; }
    if (lossy && k !== lossy.keep) {
      // Continue the run with the nearest known colour, if it's near enough.
      let best = -1, bestD = lossy.limit;
      for (let ch = firstChild[prefix]; ch >= 0; ch = nextSibling[ch]) {
        const kk = pixelOf[ch];
        if (kk === lossy.keep) continue;
        const d = lossy.dist[k * 256 + kk];
        if (d <= bestD) { bestD = d; best = ch; }
      }
      if (best >= 0) {
        indices[i] = pixelOf[best];
        prefix = best;
        continue;
      }
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      reset();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table[key] = next;
      if (lossy) {
        pixelOf[next] = k;
        nextSibling[next] = firstChild[prefix];
        firstChild[prefix] = next;
      }
      next++;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) flushByte(acc & 255);
  if (blen) { out.byte(blen); out.bytes(block.subarray(0, blen)); }
  out.byte(0);
  return out.data().slice();
}

/**
 * Compresses one frame's rectangle: `plain` indices, and optionally `masked` ones
 * (unchanged pixels set to `trans`). Both show the same picture; the smaller wins.
 * Returns `{ data, useMask }`.
 */
export function encodeRect({ plain, masked = null, minCodeSize, trans, lossy = 0, pal = null }) {
  const opts = lossy > 0 && pal ? { limit: lossyLimit(lossy), dist: paletteDistances(pal), keep: trans } : null;
  let data = lzw(plain, minCodeSize, opts);
  let useMask = false;
  if (masked) {
    const m = lzw(masked, minCodeSize, opts);
    if (m.length < data.length) { data = m; useMask = true; }
  }
  return { data, useMask };
}

// ---------- encoder ----------

export class GifEncoder {
  /**
   * @param {object} o
   * @param {number} [o.colors=256]   palette size per frame, 2–256 (when no `palette` is given)
   * @param {Uint8Array} [o.palette]  one palette (RGB triples, at most 255 colours) for every frame
   * @param {boolean} [o.optimize=true] merge repeated frames; with a shared palette, also store
   *                                   only the pixels that change
   * @param {boolean} [o.dither=false]
   * @param {boolean} [o.transparent=false] keep transparent pixels
   * @param {number} [o.loop=0] 0 loops forever
   * @param {number} [o.tolerance=2.5] how far (in 0–255 levels per channel) a pixel may drift
   *                                   from the best match to keep last frame's colour; 0 is exact
   * @param {number} [o.lossy=0] 0–100: how far colours may shift to compress better
   * @param {{ encode(job): Promise<{data, useMask}> }} [o.pool] runs compression elsewhere
   */
  constructor(width, height, { colors = 256, palette = null, optimize = true, dither = false, transparent = false, loop = 0, tolerance = 2.5, lossy = 0, pool = null } = {}) {
    Object.assign(this, { width, height, colors, palette, optimize, dither, transparent, loop, lossy, pool });
    this.slack = tolerance * tolerance * (WR + WG + WB);
    this.frames = [];
    this.prev = null;     // previous frame's palette indices
  }

  /** How `mapPixels` should be called for this encoder (for mapping on a worker). */
  mapOptions() {
    const pal = this.palette;
    const animated = !!pal && this.optimize;
    return {
      pal,
      dither: this.dither && animated ? 'ordered' : this.dither,
      transparentIndex: this.transparent ? pal.length / 3 : -1,
    };
  }

  /** Adds RGBA pixels (width × height) shown for `delay` milliseconds. */
  addFrame(rgba, delay) {
    // A shared palette keeps colours stable from frame to frame. Without one, each
    // frame gets its own, with a slot kept free for transparency.
    const pal = this.palette || buildPalette(rgba, Math.max(2, this.colors - 1));
    const trans = pal.length / 3;
    const animated = !!this.palette && this.optimize;
    const dither = this.dither && animated ? 'ordered' : this.dither;
    const idx = mapPixels(rgba, this.width, this.height, pal, { dither, transparentIndex: this.transparent ? trans : -1 });
    this.addMapped(idx, rgba, delay, pal);
  }

  /** Adds a frame already mapped to the palette (`idx`), with its RGBA source. */
  addMapped(idx, rgba, delay, pal = this.palette) {
    const { width: W, height: H } = this;
    const trans = pal.length / 3;
    const animated = !!this.palette && this.optimize;

    let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
    const prev = this.optimize ? this.prev : null;
    if (prev && animated && this.slack > 0) {
      // Keep last frame's colour where it is as good a match, give or take the
      // tolerance: decoder noise then leaves still areas untouched.
      const err = (i, c) => {
        const dr = rgba[i] - pal[c * 3], dg = rgba[i + 1] - pal[c * 3 + 1], db = rgba[i + 2] - pal[c * 3 + 2];
        return dr * dr * WR + dg * dg * WG + db * db * WB;
      };
      for (let p = 0; p < idx.length; p++) {
        const a = idx[p], b = prev[p];
        if (a !== b && a !== trans && b !== trans && err(p * 4, b) <= err(p * 4, a) + this.slack) idx[p] = b;
      }
    }
    if (prev) {
      // Compare what is shown, not the source pixels: noise too small to change
      // a pixel's colour in the GIF is not a change.
      x0 = W; y0 = H; x1 = -1; y1 = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          if (idx[row + x] !== prev[row + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
          }
        }
      }
      if (x1 < 0) { // nothing changed: show the previous frame for longer
        this.frames[this.frames.length - 1].delay += delay;
        return;
      }
      // Frames are stored whole when the palette changes from frame to frame, or when
      // transparent GIFs clear each frame before the next.
      if (this.transparent || !this.palette) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
    }
    const diff = !!prev && !this.transparent && !!this.palette;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const plain = new Uint8Array(w * h);
    const masked = diff ? new Uint8Array(w * h) : null;
    for (let y = 0; y < h; y++) {
      const row = (y0 + y) * W + x0;
      for (let x = 0; x < w; x++) {
        const p = row + x;
        plain[y * w + x] = idx[p];
        // Unchanged pixels are transparent, so the previous frame shows through as it was.
        if (masked) masked[y * w + x] = idx[p] === prev[p] ? trans : idx[p];
      }
    }

    const bitsNeeded = Math.max(1, Math.ceil(Math.log2(trans + 1)));
    const colourTable = new Uint8Array(3 << bitsNeeded);
    colourTable.set(pal);
    // Lossy changes stay within the limit of each pixel's own colour, and later
    // frames are compared with these exact indices, so errors don't build up.
    const job = { plain, masked, minCodeSize: Math.max(2, bitsNeeded), trans, lossy: this.lossy, pal };
    const result = this.pool ? this.pool.encode(job) : encodeRect(job);
    this.frames.push({ x: x0, y: y0, w, h, delay, table: colourTable, bitsNeeded, trans, result });
    this.prev = idx;
  }

  async finish() {
    const out = new Bytes(1 << 20);
    out.str('GIF89a');
    out.u16(this.width);
    out.u16(this.height);
    out.byte(0x70); // no global colour table, 8-bit colour resolution
    out.byte(0);
    out.byte(0);
    // Loop forever (or `loop` times)
    out.bytes([0x21, 0xff, 0x0b]);
    out.str('NETSCAPE2.0');
    out.bytes([0x03, 0x01]);
    out.u16(this.loop);
    out.byte(0);

    let t = 0; // keep rounding error from building up across frames
    for (const f of this.frames) {
      const { data, useMask } = await f.result;
      const transIndex = useMask || this.transparent ? f.trans : -1;
      const start = Math.round(t / 10);
      t += f.delay;
      const cs = Math.max(2, Math.round(t / 10) - start);
      out.bytes([0x21, 0xf9, 0x04, ((this.transparent ? 2 : 1) << 2) | (transIndex >= 0 ? 1 : 0)]);
      out.u16(cs);
      out.byte(transIndex >= 0 ? transIndex : 0);
      out.byte(0);
      out.byte(0x2c);
      out.u16(f.x);
      out.u16(f.y);
      out.u16(f.w);
      out.u16(f.h);
      out.byte(0x80 | (f.bitsNeeded - 1));
      out.bytes(f.table);
      out.bytes(data);
    }
    out.byte(0x3b);
    return new Blob([out.data()], { type: 'image/gif' });
  }
}
