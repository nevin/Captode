// Runs still-image encoding in a worker. Requests that share a `lane` replace each
// other: starting a new one stops the old one, so a stale size estimate never
// holds up the current one.
import { fitImage } from './formats.js';

const lanes = new Map(); // lane → { worker, reject }
let nextId = 1;

function spawn() {
  return new Worker(new URL('./encode-worker.js', import.meta.url), { type: 'module' });
}

/**
 * Encodes `canvas` (an OffscreenCanvas or canvas element) as `format` with
 * `options` (see formats.encodeImage), within `maxBytes` if given (see
 * formats.fitImage). Resolves to `{ blob, width, height, fitted }`. Falls back to
 * the page when workers are not available.
 */
export async function encodeOffThread(canvas, format, options = {}, lane = 'default', maxBytes = 0) {
  if (typeof Worker === 'undefined') return fitImage(canvas, format, options, maxBytes);
  const prev = lanes.get(lane);
  if (prev) {
    prev.worker.terminate();
    prev.reject(Object.assign(new Error('superseded'), { superseded: true }));
  }
  const bitmap = await createImageBitmap(canvas);
  const worker = spawn();
  const id = nextId++;
  try {
    return await new Promise((resolve, reject) => {
      lanes.set(lane, { worker, reject });
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The encoder stopped'));
      worker.postMessage({ id, bitmap, format, options, maxBytes }, [bitmap]);
    });
  } finally {
    if (lanes.get(lane)?.worker === worker) lanes.delete(lane);
    worker.terminate();
  }
}
