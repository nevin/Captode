// Animated WebP. The browser encodes each frame as a still WebP; this wraps those
// frames in the animation container (VP8X + ANIM + ANMF chunks). With `optimize`
// on, repeated frames are merged and changed frames store only the changed rectangle.

const u24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const fourcc = (s) => [...s].map((c) => c.charCodeAt(0));

function chunk(id, payload) {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(fourcc(id), 0);
  out.set(u32(payload.length), 4);
  out.set(payload, 8);
  return out;
}

/** Returns the image chunks (VP8, VP8L, ALPH) of a still WebP file, with headers. */
function imageChunks(buf) {
  const v = new DataView(buf);
  const parts = [];
  let p = 12;
  while (p + 8 <= buf.byteLength) {
    const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    const size = v.getUint32(p + 4, true);
    const end = p + 8 + size + (size & 1);
    if (id === 'VP8 ' || id === 'VP8L' || id === 'ALPH') parts.push(new Uint8Array(buf, p, Math.min(end, buf.byteLength) - p));
    p = end;
  }
  return parts;
}

const concat = (arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

export class WebpAnimEncoder {
  constructor(width, height, { quality = 0.85, lossless = false, optimize = true, loop = 0, alpha = false } = {}) {
    Object.assign(this, { width, height, quality: lossless ? 1 : quality, optimize, loop, alpha });
    this.frames = [];
    this.prev = null;
    this.scratch = new OffscreenCanvas(1, 1);
  }

  /** Adds the current contents of `canvas` (width × height), shown for `delay` ms. */
  async addFrame(canvas, delay) {
    const W = this.width, H = this.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = ctx.getImageData(0, 0, W, H).data;
    let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;

    if (this.optimize && this.prev) {
      const a = new Uint32Array(rgba.buffer);
      const b = new Uint32Array(this.prev.buffer);
      x0 = W; y0 = H; x1 = -1; y1 = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          if (a[row + x] !== b[row + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
          }
        }
      }
      if (x1 < 0) {
        this.frames[this.frames.length - 1].delay += delay;
        return;
      }
      // Frame offsets are stored halved, so they must be even.
      x0 &= ~1;
      y0 &= ~1;
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const c = this.scratch;
    c.width = w;
    c.height = h;
    const sctx = c.getContext('2d');
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: this.quality });
    this.frames.push({ x: x0, y: y0, w, h, delay, data: concat(imageChunks(await blob.arrayBuffer())) });
    this.prev = rgba;
  }

  finish() {
    const W = this.width, H = this.height;
    const vp8x = new Uint8Array([0x02 | (this.alpha ? 0x10 : 0), 0, 0, 0, ...u24(W - 1), ...u24(H - 1)]);
    const anim = new Uint8Array([0, 0, 0, 0, this.loop & 255, (this.loop >> 8) & 255]);
    const parts = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
    for (const f of this.frames) {
      const head = new Uint8Array([
        ...u24(f.x / 2), ...u24(f.y / 2), ...u24(f.w - 1), ...u24(f.h - 1),
        ...u24(Math.min(0xffffff, Math.round(f.delay))),
        0x02, // replace the rectangle rather than blending into it; no disposal
      ]);
      parts.push(chunk('ANMF', concat([head, f.data])));
    }
    const body = concat(parts);
    const header = new Uint8Array([...fourcc('RIFF'), ...u32(4 + body.length), ...fourcc('WEBP')]);
    return new Blob([header, body], { type: 'image/webp' });
  }
}
