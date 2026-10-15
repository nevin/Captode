// Animated GIF encoder. With `optimize` on, frames that look the same as the one
// before are merged into it. With a shared palette as well, each frame stores only
// the rectangle that changed, with unchanged pixels transparent. The result shows
// exactly the same pixels as encoding every frame in full: lossless, but smaller.
import { buildPalette, mapPixels } from './quantize.js';

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

const table = new Int16Array(4096 * 256);

function lzw(indices, minCodeSize, out) {
  out.byte(minCodeSize);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  table.fill(-1);

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
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      table.fill(-1);
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table[key] = next++;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) flushByte(acc & 255);
  if (blen) { out.byte(blen); out.bytes(block.subarray(0, blen)); }
  out.byte(0);
}

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
   */
  constructor(width, height, { colors = 256, palette = null, optimize = true, dither = false, transparent = false, loop = 0 } = {}) {
    Object.assign(this, { width, height, colors, palette, optimize, dither, transparent, loop });
    this.frames = [];
    this.prev = null;     // previous frame's palette indices
  }

  /** Adds RGBA pixels (width × height) shown for `delay` milliseconds. */
  addFrame(rgba, delay) {
    const { width: W, height: H } = this;
    // A shared palette keeps colours stable from frame to frame. Without one, each
    // frame gets its own, with a slot kept free for transparency.
    const pal = this.palette || buildPalette(rgba, Math.max(2, this.colors - 1));
    const trans = pal.length / 3;
    const idx = mapPixels(rgba, W, H, pal, { dither: this.dither, transparentIndex: this.transparent ? trans : -1 });

    let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
    const prev = this.optimize ? this.prev : null;
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
    const table = new Uint8Array(3 << bitsNeeded);
    table.set(pal);
    const encode = (indices) => {
      const bytes = new Bytes(w * h + 1024);
      lzw(indices, Math.max(2, bitsNeeded), bytes);
      return bytes.data().slice();
    };
    // Both versions show the same pixels; keep whichever compresses better.
    let data = encode(plain);
    let useMask = false;
    if (masked) {
      const m = encode(masked);
      if (m.length < data.length) { data = m; useMask = true; }
    }
    this.frames.push({
      x: x0, y: y0, w, h, delay, table, bitsNeeded,
      transIndex: useMask || this.transparent ? trans : -1,
      disposal: this.transparent ? 2 : 1,
      data,
    });
    this.prev = idx;
  }

  finish() {
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
      const start = Math.round(t / 10);
      t += f.delay;
      const cs = Math.max(2, Math.round(t / 10) - start);
      out.bytes([0x21, 0xf9, 0x04, (f.disposal << 2) | (f.transIndex >= 0 ? 1 : 0)]);
      out.u16(cs);
      out.byte(f.transIndex >= 0 ? f.transIndex : 0);
      out.byte(0);
      out.byte(0x2c);
      out.u16(f.x);
      out.u16(f.y);
      out.u16(f.w);
      out.u16(f.h);
      out.byte(0x80 | (f.bitsNeeded - 1));
      out.bytes(f.table);
      out.bytes(f.data);
    }
    out.byte(0x3b);
    return new Blob([out.data()], { type: 'image/gif' });
  }
}
