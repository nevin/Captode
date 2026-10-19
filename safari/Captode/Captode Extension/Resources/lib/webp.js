// Animated WebP. The browser encodes each frame as a still WebP; this wraps those
// frames in the animation container (VP8X + ANIM + ANMF chunks). With `optimize`
// on, repeated frames are merged, changed frames store only the changed rectangle,
// and inside it pixels that haven't changed (give or take decoder noise) are left
// transparent so the previous frame shows through. Each frame is stored lossy or
// lossless, whichever is smaller: lossless often wins on flat UI content.

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
  /**
   * @param {number} [o.tolerance=3] change per channel (0–255) below which a pixel counts as
   *                                 unchanged; only used for opaque animations
   */
  constructor(width, height, { quality = 0.85, lossless = false, optimize = true, loop = 0, alpha = false, tolerance = 3 } = {}) {
    Object.assign(this, { width, height, quality: lossless ? 1 : quality, lossless, optimize, loop, alpha });
    // Leaving pixels transparent to show the frame below only works when the
    // animation itself has no transparency.
    this.tolerance = alpha ? 0 : tolerance;
    this.frames = [];
    this.prev = null;   // what each pixel was last stored as
    this.hasAlpha = alpha;
    this.losses = 0;    // frames in a row where lossless came out larger
  }

  /** Encodes RGBA pixels as a still WebP and returns its image chunks. */
  async encode(rgba, w, h, quality) {
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/webp', quality });
    return concat(imageChunks(await blob.arrayBuffer()));
  }

  /** Adds the current contents of `canvas` (width × height), shown for `delay` ms. */
  async addFrame(canvas, delay) {
    const W = this.width, H = this.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = ctx.getImageData(0, 0, W, H).data;
    let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1;
    const prev = this.optimize ? this.prev : null;
    let changed = null;

    if (prev) {
      const tol = this.tolerance;
      changed = new Uint8Array(W * H);
      x0 = W; y0 = H; x1 = -1; y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x, i = p * 4;
          const d = Math.max(Math.abs(rgba[i] - prev[i]), Math.abs(rgba[i + 1] - prev[i + 1]),
            Math.abs(rgba[i + 2] - prev[i + 2]), Math.abs(rgba[i + 3] - prev[i + 3]));
          if (d > tol) {
            changed[p] = 1;
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

    // The rectangle as it is, and (for opaque animations) with unchanged pixels
    // transparent so they blend away to the frame below.
    const plain = new Uint8ClampedArray(w * h * 4);
    const masked = changed && !this.alpha ? new Uint8ClampedArray(w * h * 4) : null;
    let kept = 0;
    for (let y = 0; y < h; y++) {
      plain.set(rgba.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + w) * 4), y * w * 4);
      if (!masked) continue;
      for (let x = 0; x < w; x++) {
        const p = (y0 + y) * W + x0 + x;
        if (changed[p]) masked.set(rgba.subarray(p * 4, p * 4 + 4), (y * w + x) * 4);
        else kept++;
      }
    }
    // Candidates: the rectangle at the chosen quality, and losslessly (never worse
    // to look at, and often smaller for flat UI). The masked rectangle is only tried
    // losslessly: lossy WebP stores colour at half resolution, so colour from the
    // transparent holes would bleed into the pixels around them.
    // Lossless keeps losing on noisy video, so after a few losses in a row it is
    // only tried now and then, to notice when the content changes.
    const tryLossless = this.lossless || this.losses < 3 || this.frames.length % 10 === 0;
    const tries = [this.encode(plain, w, h, this.quality).then((data) => ({ data, blend: false, lossy: !this.lossless }))];
    if (tryLossless && !this.lossless) tries.push(this.encode(plain, w, h, 1).then((data) => ({ data, blend: false })));
    if (tryLossless && masked && kept > w * h * 0.05) tries.push(this.encode(masked, w, h, 1).then((data) => ({ data, blend: true })));
    const best = (await Promise.all(tries)).reduce((a, b) => (b.data.length < a.data.length ? b : a));
    if (tries.length > 1) this.losses = best.lossy ? this.losses + 1 : 0;
    if (best.blend) this.hasAlpha = true;
    this.frames.push({ x: x0, y: y0, w, h, delay, data: best.data, blend: best.blend });

    // Remember what each pixel now shows: the whole rectangle when it replaced
    // what was there, only the changed pixels when it blended over it.
    if (!this.prev) {
      this.prev = new Uint8ClampedArray(rgba);
    } else if (!best.blend) {
      for (let y = y0; y <= y1; y++) this.prev.set(rgba.subarray((y * W + x0) * 4, (y * W + x0 + w) * 4), (y * W + x0) * 4);
    } else {
      for (let p = 0; p < W * H; p++) if (changed[p]) this.prev.set(rgba.subarray(p * 4, p * 4 + 4), p * 4);
    }
  }

  finish() {
    const W = this.width, H = this.height;
    const vp8x = new Uint8Array([0x02 | (this.hasAlpha ? 0x10 : 0), 0, 0, 0, ...u24(W - 1), ...u24(H - 1)]);
    const anim = new Uint8Array([0, 0, 0, 0, this.loop & 255, (this.loop >> 8) & 255]);
    const parts = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
    for (const f of this.frames) {
      const head = new Uint8Array([
        ...u24(f.x / 2), ...u24(f.y / 2), ...u24(f.w - 1), ...u24(f.h - 1),
        ...u24(Math.min(0xffffff, Math.round(f.delay))),
        // Masked frames blend over the frame below; others replace their rectangle.
        // No disposal either way.
        f.blend ? 0x00 : 0x02,
      ]);
      parts.push(chunk('ANMF', concat([head, f.data])));
    }
    const body = concat(parts);
    const header = new Uint8Array([...fourcc('RIFF'), ...u32(4 + body.length), ...fourcc('WEBP')]);
    return new Blob([header, body], { type: 'image/webp' });
  }
}
