// Works out the difference between two images off the page's thread.
// In:  { a: ImageBitmap, b: ImageBitmap (B already in A's space), tol }
// Out: { type: 'progress', f } … then { type: 'done', image: ImageBitmap, changed, box }

self.onmessage = ({ data: { a, b, tol } }) => {
  const W = a.width, H = a.height;
  const ca = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
  const cb = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
  ca.drawImage(a, 0, 0);
  cb.drawImage(b, 0, 0);
  a.close();
  b.close();
  const out = new OffscreenCanvas(W, H);
  const octx = out.getContext('2d');
  let changed = 0;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  // In bands, so memory stays small for very long captures.
  const band = Math.max(1, Math.floor(2e6 / W));
  for (let y = 0; y < H; y += band) {
    const h = Math.min(band, H - y);
    const pa = ca.getImageData(0, y, W, h).data;
    const pb = cb.getImageData(0, y, W, h).data;
    const img = octx.createImageData(W, h);
    const o = img.data;
    for (let i = 0; i < pa.length; i += 4) {
      // Where B has no pixels (outside it), it counts as different.
      const d = pb[i + 3] === 0 ? 255 : Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      if (d > tol) {
        o[i] = 255; o[i + 1] = 45; o[i + 2] = 135; o[i + 3] = 255;
        changed++;
        const p = i / 4, px = p % W, py = y + Math.floor(p / W);
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      } else {
        // A, faded towards white.
        const g = 0.299 * pa[i] + 0.587 * pa[i + 1] + 0.114 * pa[i + 2];
        o[i] = o[i + 1] = o[i + 2] = Math.round(255 - (255 - g) * 0.25);
        o[i + 3] = 255;
      }
    }
    octx.putImageData(img, 0, y);
    self.postMessage({ type: 'progress', f: (y + h) / H });
  }
  const box = x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
  if (box) {
    // Outline where the changes are.
    octx.strokeStyle = 'rgba(255,45,135,.9)';
    octx.lineWidth = Math.max(2, W / 600);
    octx.setLineDash([octx.lineWidth * 4, octx.lineWidth * 3]);
    octx.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 9, y1 - y0 + 9);
  }
  const image = out.transferToImageBitmap();
  self.postMessage({ type: 'done', image, changed, box }, [image]);
};
