// Encodes still images away from the page, so the editor stays responsive while
// a large PNG, GIF or PDF is being made.
import { fitImage } from './formats.js';

self.onmessage = async ({ data: { id, bitmap, format, options, maxBytes } }) => {
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
    bitmap.close();
    self.postMessage({ id, result: await fitImage(c, format, options, maxBytes) });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
