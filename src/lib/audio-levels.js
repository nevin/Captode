// How loud a recording's sound is over time, worked out on the device: for the
// waveform under the video page's timeline and for finding silent parts to cut.
import { demuxWebm } from './webm.js';

export const LEVEL_STEP = 0.05; // seconds a level covers

/**
 * The sound's loudness (RMS, 0–1) for each LEVEL_STEP seconds from the recording's
 * start: { step, rms: Float32Array }, or null when there is no sound or this browser
 * can't decode it. The sound is decoded a piece at a time and never kept whole, so
 * long recordings don't take much memory.
 */
export async function audioLevels(blob, { step = LEVEL_STEP } = {}) {
  try {
    if (blob.size > 1e9) return null; // too much to read into memory again
    const buffer = await blob.arrayBuffer();
    let src = null;
    try { src = demuxWebm(buffer, { views: true }); } catch { /* not WebM (Safari records MP4) */ }
    const a = src?.audio;
    if (a?.codecId === 'A_OPUS' && a.frames.length && typeof AudioDecoder !== 'undefined') {
      const levels = await decodeOpus(a, step);
      if (levels) return levels;
    }
    // Otherwise the browser's own decoder, which holds the whole sound at once, so
    // only for recordings up to about 10 minutes.
    if (blob.size > 200e6) return null;
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buf = await ctx.decodeAudioData(buffer);
    if (buf.duration > 600) return null;
    const acc = accumulator(buf.duration, step);
    for (let c = 0; c < buf.numberOfChannels; c++) acc.add(buf.getChannelData(c), 0, buf.sampleRate);
    return acc.done();
  } catch {
    return null;
  }
}

/** Sums of squares for each step, from planes of samples. */
function accumulator(seconds, step) {
  const n = Math.max(1, Math.ceil(seconds / step) + 1);
  let sum = new Float64Array(n), count = new Uint32Array(n);
  const grow = (m) => {
    if (m <= sum.length) return;
    const s = new Float64Array(m * 2), c = new Uint32Array(m * 2);
    s.set(sum); c.set(count);
    sum = s; count = c;
  };
  return {
    add(samples, t0, rate) {
      const per = step * rate;
      const first = t0 / step;
      grow(Math.ceil(first + samples.length / per) + 1);
      for (let i = 0; i < samples.length; i++) {
        const k = Math.floor(first + i / per);
        if (k < 0) continue;
        const v = samples[i];
        sum[k] += v * v;
        count[k]++;
      }
    },
    done() {
      let last = count.length - 1;
      while (last > 0 && !count[last]) last--;
      const rms = new Float32Array(last + 1);
      for (let k = 0; k <= last; k++) rms[k] = count[k] ? Math.sqrt(sum[k] / count[k]) : 0;
      return { step, rms };
    },
  };
}

async function decodeOpus(a, step) {
  const config = { codec: 'opus', sampleRate: a.sampleRate, numberOfChannels: a.channels, description: a.description || undefined };
  try { if (!(await AudioDecoder.isConfigSupported(config)).supported) return null; } catch { return null; }
  const last = a.frames[a.frames.length - 1].timestamp / 1e6;
  const acc = accumulator(last + 0.1, step);
  let failed = false;
  let plane = null;
  const decoder = new AudioDecoder({
    output: (ad) => {
      const n = ad.numberOfFrames;
      if (!plane || plane.length < n) plane = new Float32Array(n);
      const p = plane.subarray(0, n);
      // Every channel, so a sound on one side only still counts.
      for (let c = 0; c < ad.numberOfChannels; c++) {
        ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        acc.add(p, ad.timestamp / 1e6, ad.sampleRate);
      }
      ad.close();
    },
    error: () => { failed = true; },
  });
  decoder.configure(config);
  for (let i = 0; i < a.frames.length && !failed; i++) {
    const f = a.frames[i];
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.timestamp, data: f.data }));
    // A pause now and then, so the page stays responsive and decoded sound doesn't pile up.
    if (i % 200 === 199) await new Promise((r) => setTimeout(r));
  }
  try { await decoder.flush(); } catch { failed = true; }
  try { decoder.close(); } catch { /* closed by an error */ }
  return failed ? null : acc.done();
}

/**
 * The quiet stretches of [start, end] (seconds) at least `minLength` long, as
 * [{ from, to }] to cut, each leaving `pad` seconds of quiet either side (none at
 * the clip's own ends). Quiet is judged against this recording: well under its
 * usual loudness and near its background noise. Returns null when the sound is
 * silent throughout (nothing to tell apart).
 */
export function findSilences(levels, start, end, { minLength = 1, pad = 0.2 } = {}) {
  if (!levels?.rms.length) return null;
  const { step, rms } = levels;
  const k0 = Math.max(0, Math.floor(start / step)), k1 = Math.min(rms.length, Math.ceil(end / step));
  if (k1 - k0 < 2) return [];
  const sorted = Array.from(rms.subarray(k0, k1)).sort((x, y) => x - y);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const loud = q(0.95), floor = q(0.1);
  if (loud < 0.003) return null;
  const quiet = Math.min(loud * 0.3, Math.max(floor * 2.5, loud * 0.06, 0.002));
  const out = [];
  let from = null;
  const close = (k) => {
    if (from === null) return;
    const a = Math.max(start, from * step), b = Math.min(end, k * step);
    from = null;
    if (b - a < minLength) return;
    const x = a <= start + 1e-6 ? a : a + pad, y = b >= end - 1e-6 ? b : b - pad;
    if (y - x >= 0.1) out.push({ from: Math.round(x * 100) / 100, to: Math.round(y * 100) / 100 });
  };
  for (let k = k0; k < k1; k++) {
    if (rms[k] < quiet) { if (from === null) from = k; } else close(k);
  }
  close(k1);
  return out;
}
