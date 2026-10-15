// Encodes still images away from the page, so the editor stays responsive while
// a large PNG, GIF or PDF is being made.
import { encodeImage } from './formats.js';

self.onmessage = async ({ data: { id, bitmap, format, options } }) => {
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await encodeImage(c, format, options);
    self.postMessage({ id, blob });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
