// GIF work that doesn't depend on other frames: mapping pixels to the palette,
// and compressing a frame's rectangle. Used through WorkerPool by the exporter.
import { mapPixels } from './quantize.js';
import { encodeRect } from './gif.js';

let palette = null; // the clip's palette, sent once

self.onmessage = ({ data }) => {
  const { id, op } = data;
  try {
    if (op === 'palette') {
      palette = data.pal;
      self.postMessage({ id, result: true });
    } else if (op === 'map') {
      const idx = mapPixels(data.rgba, data.width, data.height, palette, { dither: data.dither, transparentIndex: data.transparentIndex });
      // The pixels go back too: the exporter still needs them.
      self.postMessage({ id, result: { idx, rgba: data.rgba } }, [idx.buffer, data.rgba.buffer]);
    } else if (op === 'encode') {
      const r = encodeRect({ ...data.job, pal: palette });
      self.postMessage({ id, result: r }, [r.data.buffer]);
    }
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
