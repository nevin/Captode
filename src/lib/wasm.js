// Stronger compressors compiled to WebAssembly (see src/vendor): oxipng for
// lossless PNG and MozJPEG for JPEG. They load on first use, and each function
// resolves to null when its codec can't run, so callers can fall back.

let oxipngReady = null;
let mozjpegReady = null;

function loadOxipng() {
  oxipngReady ||= import('../vendor/oxipng/squoosh_oxipng.js')
    .then(async (m) => { await m.default(); return m; })
    .catch(() => null);
  return oxipngReady;
}

function loadMozjpeg() {
  mozjpegReady ||= import('../vendor/mozjpeg/mozjpeg_enc.js')
    .then((m) => m.default({ noInitialRun: true }))
    .catch(() => null);
  return mozjpegReady;
}

/**
 * Losslessly recompresses a PNG (bytes) with oxipng. `level` 1–6 trades time for
 * size. Returns the new bytes, or null.
 */
export async function oxipng(bytes, level = 2) {
  const m = await loadOxipng();
  if (!m) return null;
  try {
    return m.optimise(new Uint8Array(bytes), level, false, false);
  } catch {
    return null;
  }
}

const MOZJPEG_DEFAULTS = {
  quality: 75, baseline: false, arithmetic: false, progressive: true, optimize_coding: true, smoothing: 0,
  color_space: 3, quant_table: 3, trellis_multipass: false, trellis_opt_zero: false, trellis_opt_table: false,
  trellis_loops: 1, auto_subsample: true, chroma_subsample: 2, separate_chroma_quality: false, chroma_quality: 75,
};

/**
 * Encodes opaque RGBA pixels as JPEG with MozJPEG. `quality` is 0–1, as for the
 * browser's encoder. `progressive: false` makes baseline files (for PDF pages).
 * Returns the bytes, or null.
 */
export async function mozjpeg(rgba, width, height, { quality = 0.85, progressive = true } = {}) {
  const m = await loadMozjpeg();
  if (!m) return null;
  try {
    const q = Math.round(Math.min(1, Math.max(0, quality)) * 100);
    const out = m.encode(rgba, width, height, { ...MOZJPEG_DEFAULTS, quality: q, chroma_quality: q, progressive, baseline: !progressive });
    return new Uint8Array(out); // copy out of the module's memory
  } catch {
    return null;
  }
}
