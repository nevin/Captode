// Helpers available to tests as `lab.*` inside the extension (so they can import
// Captode's modules): turning screenshots into canvases, and measuring quality.

export async function canvasFromPng(b64) {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0);
  return c;
}

export function pixels(c) {
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
}

/** Decodes an image blob to RGBA at `w` × `h`, over white. */
export async function decode(blob, w, h) {
  const bmp = await createImageBitmap(blob);
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

export function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const d = a[i + k] - b[i + k]; se += d * d; }
  const mse = se / ((a.length / 4) * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

/**
 * Mean SSIM on luma over 8×8 blocks: closer than PSNR to what people notice
 * (it doesn't punish fine dither noise the way PSNR does). 1 is identical.
 */
export function ssim(a, b, w, h) {
  const luma = (d) => {
    const y = new Float32Array(w * h);
    for (let p = 0; p < y.length; p++) y[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
    return y;
  };
  const x = luma(a), z = luma(b);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0;
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      let mx = 0, mz = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const p = (by + j) * w + bx + i; mx += x[p]; mz += z[p]; }
      mx /= 64; mz /= 64;
      let vx = 0, vz = 0, cv = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
        const p = (by + j) * w + bx + i;
        const dx = x[p] - mx, dz = z[p] - mz;
        vx += dx * dx; vz += dz * dz; cv += dx * dz;
      }
      vx /= 63; vz /= 63; cv /= 63;
      sum += ((2 * mx * mz + C1) * (2 * cv + C2)) / ((mx * mx + mz * mz + C1) * (vx + vz + C2));
      n++;
    }
  }
  return sum / n;
}

/** Reads the time (seconds) a test clip drew into a frame (see recordClip). */
export function frameTime(source) {
  const c = new OffscreenCanvas(1280, 720);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(source, 0, 0, 1280, 720);
  let v = 0;
  for (let b = 0; b < 12; b++) if (x.getImageData(85 + b * 100, 500, 1, 1).data[1] > 128) v |= 1 << b;
  return v / 100;
}

globalThis.lab = { canvasFromPng, pixels, decode, psnr, ssim, frameTime };
