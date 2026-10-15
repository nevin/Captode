// Runs still-image encoding in a worker. Requests that share a `lane` replace each
// other: starting a new one stops the old one, so a stale size estimate never
// holds up the current one.
import { encodeImage } from './formats.js';

const lanes = new Map(); // lane → { worker, reject }
let nextId = 1;

function spawn() {
  return new Worker(new URL('./encode-worker.js', import.meta.url), { type: 'module' });
}

/**
 * Encodes `canvas` (an OffscreenCanvas or canvas element) as `format` with
 * `options` (see formats.encodeImage). Falls back to the page when workers are
 * not available.
 */
export async function encodeOffThread(canvas, format, options = {}, lane = 'default') {
  if (typeof Worker === 'undefined') return encodeImage(canvas, format, options);
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
        else resolve(data.blob);
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The encoder stopped'));
      worker.postMessage({ id, bitmap, format, options }, [bitmap]);
    });
  } finally {
    if (lanes.get(lane)?.worker === worker) lanes.delete(lane);
    worker.terminate();
  }
}
