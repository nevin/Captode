// Exports a recording without playing it: the WebM is taken apart, decoded with
// WebCodecs, each output frame is drawn (in a device frame if asked) and encoded
// as MP4, WebM, GIF or WebP. It runs in a worker, as fast as the machine allows,
// and the page stays responsive.
//
// Messages in:  { type: 'start', job }   (see `run` for the job's fields)
// Messages out: { type: 'progress', f, text } | { type: 'preview', bitmap }
//               { type: 'done', blob } | { type: 'error', message, fallback }
import { demuxWebm, muxWebm } from '../lib/webm.js';
import { muxMp4 } from '../lib/mp4.js';
import { GifEncoder } from '../lib/gif.js';
import { WebpAnimEncoder } from '../lib/webp.js';
import { buildPalette } from '../lib/quantize.js';
import { WorkerPool } from '../lib/pool.js';
import { deviceRenderer, frameDrawer } from '../lib/device.js';
import { sourceColourSpace, outputColour } from '../lib/video-colour.js';

/** An error after which the page should fall back to its slower, simpler path. */
class Unsupported extends Error {}

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (f, text) => post({ type: 'progress', f, text });

self.onmessage = async ({ data }) => {
  if (data.type !== 'start') return;
  try {
    const blob = await run(data.job);
    post({ type: 'done', blob });
  } catch (e) {
    post({ type: 'error', message: e.message || String(e), fallback: e instanceof Unsupported });
  }
};

// ---------- decoding ----------

/**
 * Decodes the video and calls `onFrame(k, frame)` for output frames k = 0 … count-1,
 * at `fps` from `start` (µs). Each output frame is the source frame on screen at
 * that moment. `want(k)` can skip frames that aren't needed (to save drawing).
 */
async function forEachFrame(src, { start, fps, count, onFrame, want = () => true }) {
  const frames = src.video.frames;
  let i = 0;
  for (let j = 0; j < frames.length; j++) if (frames[j].key && frames[j].timestamp <= start) i = j;

  const queue = [];
  let wake = null;
  let failure = null;
  const decoder = new VideoDecoder({
    output: (f) => { queue.push(f); wake?.(); },
    error: (e) => { failure = e; wake?.(); },
  });
  decoder.configure(src.decoderConfig);

  const at = (k) => start + (k * 1e6) / fps;
  let k = 0;
  let cur = null;
  let flushed = false;
  let flushing = null;
  try {
    while (k < count) {
      while (i < frames.length && decoder.decodeQueueSize < 6 && queue.length < 6) {
        const f = frames[i++];
        decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.timestamp, data: f.data }));
      }
      if (i >= frames.length && !flushing) flushing = decoder.flush().then(() => { flushed = true; wake?.(); }, () => {});
      if (failure) throw failure;
      if (!queue.length) {
        if (flushed) break;
        await new Promise((r) => { wake = r; });
        wake = null;
        continue;
      }
      const f = queue.shift();
      while (k < count && at(k) < f.timestamp) {
        if (want(k)) await onFrame(k, cur || f);
        k++;
      }
      cur?.close();
      cur = f;
    }
    // The last source frame stays on screen to the end.
    while (k < count && cur) {
      if (want(k)) await onFrame(k, cur);
      k++;
    }
  } finally {
    cur?.close();
    for (const f of queue) f.close();
    if (decoder.state !== 'closed') decoder.close();
  }
}

/** Decodes key frames on their own, calling `onFrame` for each in order. */
async function decodeAlone(src, keys, onFrame) {
  const frames = [];
  let failure = null;
  const decoder = new VideoDecoder({ output: (f) => frames.push(f), error: (e) => { failure = e; } });
  decoder.configure(src.decoderConfig);
  for (const k of keys) decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: k.timestamp, data: k.data }));
  await decoder.flush();
  decoder.close();
  try {
    if (failure) throw failure;
    for (const f of frames) await onFrame(f);
  } finally {
    for (const f of frames) f.close();
  }
}

async function videoDecoderConfig(v) {
  if (!v || !v.codec) throw new Unsupported('This recording uses a video format Captode cannot decode here.');
  const config = { codec: v.codec, codedWidth: v.width, codedHeight: v.height };
  if (v.codecId === 'V_MPEG4/ISO/AVC' && v.description) config.description = v.description;
  // Without this, WebCodecs decodes Chrome's recordings with the wrong colours.
  const colorSpace = sourceColourSpace(v);
  if (colorSpace) config.colorSpace = colorSpace;
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Unsupported(`Cannot decode ${v.codecId}`);
  return config;
}

// ---------- encoding helpers ----------

/** Waits until the encoder has room, so frames don't pile up in memory. */
async function drain(encoder, max = 4) {
  while (encoder.encodeQueueSize > max) {
    await new Promise((r) => {
      encoder.addEventListener('dequeue', r, { once: true });
      setTimeout(r, 50);
    });
  }
}

async function pickConfig(candidates) {
  for (const c of candidates) {
    try {
      if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
    } catch { /* try the next */ }
  }
  return null;
}

function videoCandidates(format, w, h, fps, bitrate) {
  const base = { width: w, height: h, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality' };
  const big = w * h > 1920 * 1088;
  if (format === 'mp4') {
    // High profile first; the software fallback only does Constrained Baseline.
    const levels = big ? ['640033', '4d0033', '640034'] : ['640028', '4d0028', '640033'];
    return [
      ...levels.map((l) => ({ ...base, codec: `avc1.${l}`, avc: { format: 'avc' } })),
      { ...base, codec: big ? 'avc1.42e033' : 'avc1.42e028', avc: { format: 'avc' }, hardwareAcceleration: 'prefer-software' },
    ];
  }
  return [
    { ...base, codec: big ? 'vp09.00.51.08' : 'vp09.00.40.08' },
    { ...base, codec: 'vp8' },
  ];
}

/**
 * Audio for the output: Opus packets are copied into WebM as they are, and
 * re-encoded to AAC for MP4. Returns null when there is no audio to keep.
 */
async function exportAudio(src, format, start, end) {
  const a = src.audio;
  if (!a || a.codecId !== 'A_OPUS') return null;
  const packets = a.frames.filter((f) => f.timestamp >= start && f.timestamp < end);
  if (!packets.length) return null;

  if (format === 'webm') {
    return {
      codecId: 'A_OPUS', sampleRate: a.sampleRate, channels: a.channels, description: a.description,
      frames: packets.map((f) => ({ ...f, timestamp: f.timestamp - start, key: true })),
    };
  }

  const encConfig = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: Math.min(2, a.channels), bitrate: 128000 };
  if (!(await AudioEncoder.isConfigSupported(encConfig)).supported) {
    // No AAC encoder (Chrome on Linux): keep the original Opus audio. MP4 can carry
    // Opus, and Chrome, Firefox and Safari all play it.
    if (!a.description) throw new Unsupported('This browser cannot encode AAC audio.');
    const frames = packets.map((f, i) => {
      const next = packets[i + 1];
      const duration = next ? next.timestamp - f.timestamp : (i ? f.timestamp - packets[i - 1].timestamp : 20000);
      return { timestamp: f.timestamp - start, duration, key: true, data: f.data };
    });
    return { codec: 'opus', sampleRate: 48000, channels: a.channels, opusHead: a.description, frames };
  }
  const decConfig = { codec: 'opus', sampleRate: a.sampleRate, numberOfChannels: a.channels, description: a.description || undefined };
  if (!(await AudioDecoder.isConfigSupported(decConfig)).supported) throw new Unsupported('This browser cannot decode the recording\'s audio.');

  const out = [];
  let asc = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, md) => {
      if (md?.decoderConfig?.description) asc = new Uint8Array(md.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      out.push({ timestamp: chunk.timestamp, duration: chunk.duration, key: true, data });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(encConfig);
  const channels = encConfig.numberOfChannels;
  // MP4 sample tables have no start offsets, so any gap (audio usually starts a
  // little after the video) is filled with silence to keep sound and picture in sync.
  let expected = 0; // µs of audio written so far
  const length = end - start; // µs: audio stops where the video does
  const write = (planes, n, sampleRate) => {
    const room = Math.floor(((length - expected) * sampleRate) / 1e6);
    if (room <= 0) return;
    if (n > room) {
      // Keep the first `room` samples of each channel.
      const cut = new Float32Array(room * channels);
      for (let c = 0; c < channels; c++) cut.set(planes.subarray(c * n, c * n + room), c * room);
      planes = cut;
      n = room;
    }
    const re = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round(expected), data: planes });
    encoder.encode(re);
    re.close();
    expected += (n * 1e6) / sampleRate;
  };
  const decoder = new AudioDecoder({
    output: (ad) => {
      const n = ad.numberOfFrames;
      const rate = ad.sampleRate;
      const at = ad.timestamp - start;
      const gap = Math.round(((at - expected) * rate) / 1e6);
      if (gap > rate / 100) write(new Float32Array(gap * channels), gap, rate);
      const planes = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) {
        ad.copyTo(planes.subarray(c * n, (c + 1) * n), { planeIndex: Math.min(c, ad.numberOfChannels - 1), format: 'f32-planar' });
      }
      ad.close();
      write(planes, n, rate);
    },
    error: (e) => { failure = e; },
  });
  decoder.configure(decConfig);
  for (const f of packets) decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.timestamp, data: f.data }));
  await decoder.flush();
  await encoder.flush();
  decoder.close();
  encoder.close();
  if (failure) throw failure;
  if (!asc) throw new Unsupported('The AAC encoder gave no configuration.');
  return { sampleRate: encConfig.sampleRate, channels: encConfig.numberOfChannels, asc, bitrate: encConfig.bitrate, frames: out };
}

// ---------- the job ----------

/**
 * job: {
 *   blob, format ('mp4' | 'webm' | 'gif' | 'webp'),
 *   width, height, fps, start, end (seconds), device (options or null),
 *   video: { bitsPerPixel, audio }, gif: { colors, dither, lossy }, webp: { quality, lossless },
 *   optimize, tolerance, loop
 * }
 */
async function run(job) {
  if (typeof VideoDecoder === 'undefined') throw new Unsupported('WebCodecs is not available.');
  progress(0, 'Reading the recording…');
  let src;
  try {
    src = demuxWebm(await job.blob.arrayBuffer());
  } catch (e) {
    throw new Unsupported(e.message);
  }
  if (!src.video?.frames.length) throw new Unsupported('No video frames found.');
  src.decoderConfig = await videoDecoderConfig(src.video);

  const W = job.width, H = job.height, fps = job.fps;
  const start = Math.round(job.start * 1e6), end = Math.round(job.end * 1e6);
  const count = Math.max(1, Math.round(((end - start) / 1e6) * fps));
  const frameUs = 1e6 / fps;

  // The source size comes from the first decoded frame (MediaRecorder sometimes
  // leaves the track's pixel size out).
  const canvas = new OffscreenCanvas(W, H);
  // A GPU canvas, even for GIF and WebP, which read the pixels back: drawing a
  // decoded frame into a CPU canvas converts and scales it in software, which
  // took about 7 ms a frame, against well under 1 ms here plus a quicker read-back.
  const ctx = canvas.getContext('2d', { alpha: true });
  let draw = null;
  const paint = (frame) => {
    if (!draw) {
      const renderer = job.device ? deviceRenderer(job.device, frame.displayWidth, frame.displayHeight) : null;
      draw = frameDrawer({ width: W, height: H }, renderer, job.format === 'mp4' || job.format === 'webm');
    }
    ctx.clearRect(0, 0, W, H);
    draw(ctx, frame);
  };
  let lastPreview = 0;
  const preview = () => {
    const now = performance.now();
    if (now - lastPreview < 250) return;
    lastPreview = now;
    createImageBitmap(canvas).then((b) => post({ type: 'preview', bitmap: b }, [b]));
  };

  if (job.format === 'mp4' || job.format === 'webm') {
    const bitrate = Math.round(Math.min(40e6, Math.max(300e3, W * H * fps * job.video.bitsPerPixel)));
    const config = await pickConfig(videoCandidates(job.format, W, H, fps, bitrate));
    if (!config) throw new Unsupported(`This browser cannot encode ${job.format.toUpperCase()} at ${W} × ${H}.`);

    const audio = job.video.audio ? await exportAudio(src, job.format, start, end) : null;
    const chunks = [];
    let description = null;
    let encodedColour = null;
    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, md) => {
        if (md?.decoderConfig?.description) description = new Uint8Array(md.decoderConfig.description);
        if (md?.decoderConfig?.colorSpace) encodedColour = md.decoderConfig.colorSpace;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ timestamp: chunk.timestamp, duration: chunk.duration ?? frameUs, key: chunk.type === 'key', data });
      },
      error: (e) => { failure = e; },
    });
    encoder.configure(config);
    const keyEvery = Math.max(1, Math.round(fps * 2));
    await forEachFrame(src, {
      start, fps, count,
      onFrame: async (k, frame) => {
        if (failure) throw failure;
        paint(frame);
        const vf = new VideoFrame(canvas, { timestamp: Math.round(k * frameUs), duration: Math.round(frameUs), alpha: 'discard' });
        encoder.encode(vf, { keyFrame: k % keyEvery === 0 });
        vf.close();
        await drain(encoder);
        preview();
        progress((k + 1) / count, `Encoding frame ${k + 1} of ${count}`);
      },
    });
    progress(1, 'Finishing…');
    await encoder.flush();
    encoder.close();
    if (failure) throw failure;

    // Tagged, so every player shows the colours as they were on screen.
    const colour = outputColour(encodedColour);
    if (job.format === 'mp4') {
      if (!description) throw new Unsupported('The H.264 encoder gave no configuration.');
      return muxMp4({ video: { width: W, height: H, avcC: description, frames: chunks, colour }, audio });
    }
    return muxWebm({ video: { codecId: config.codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9', width: W, height: H, frames: chunks, colour }, audio });
  }

  // GIF and WebP
  const transparent = !!job.device && job.device.bg === 'none';
  let palette = null;
  if (job.format === 'gif') {
    // One palette for the whole clip, from frames spread across it.
    const parts = [];
    const sample = (frame) => {
      paint(frame);
      const px = ctx.getImageData(0, 0, W, H).data;
      const part = new Uint8ClampedArray(Math.ceil(px.length / 12) * 4);
      for (let i = 0, o = 0; i < px.length; i += 12, o += 4) part.set(px.subarray(i, i + 4), o);
      parts.push(part);
      progress(0, 'Choosing colours…');
    };
    // Key frames decode on their own, so when there are enough of them in range,
    // sample those instead of decoding the whole clip an extra time.
    const keys = src.video.frames.filter((f) => f.key && f.timestamp >= start && f.timestamp < end);
    if (keys.length >= 4) {
      const step = Math.max(1, keys.length / 16);
      const picks = [];
      for (let x = 0; x < keys.length && picks.length < 16; x += step) picks.push(keys[Math.floor(x)]);
      await decodeAlone(src, picks, sample);
    } else {
      const samples = Math.min(count, 16);
      const want = new Set(Array.from({ length: samples }, (_, n) => Math.floor(((n + 0.5) * count) / samples)));
      await forEachFrame(src, { start, fps, count, want: (k) => want.has(k), onFrame: async (k, frame) => sample(frame) });
    }
    const all = new Uint8ClampedArray(parts.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const part of parts) { all.set(part, o); o += part.length; }
    palette = buildPalette(all, Math.max(2, job.gif.colors - 1));
  }

  if (job.format === 'gif') return exportGif(src, { start, fps, count, frameUs, palette, transparent, paint, preview, ctx, W, H, job });

  const enc = new WebpAnimEncoder(W, H, {
    quality: job.webp.quality, lossless: job.webp.lossless, optimize: job.optimize, loop: job.loop, alpha: transparent, tolerance: job.tolerance,
  });
  await forEachFrame(src, {
    start, fps, count,
    onFrame: async (k, frame) => {
      paint(frame);
      await enc.addFrame(canvas, frameUs / 1000);
      preview();
      progress((k + 1) / count, `Encoding frame ${k + 1} of ${count}`);
    },
  });
  progress(1, 'Finishing…');
  return enc.finish();
}

/**
 * GIF on several cores: frames are drawn here in order, mapped to the palette and
 * compressed on a pool of workers, and compared with the frame before here (the
 * one step that has to go in order).
 */
async function exportGif(src, { start, fps, count, frameUs, palette, transparent, paint, preview, ctx, W, H, job }) {
  const pool = new WorkerPool(new URL('../lib/gif-worker.js', import.meta.url));
  try {
    await pool.broadcast({ op: 'palette', pal: palette });
    const enc = new GifEncoder(W, H, {
      palette, dither: job.gif.dither, optimize: job.optimize, transparent, loop: job.loop, tolerance: job.tolerance, lossy: job.gif.lossy,
      pool: {
        encode: ({ pal, ...rect }) => pool.run({ op: 'encode', job: rect }, rect.masked ? [rect.plain.buffer, rect.masked.buffer] : [rect.plain.buffer]),
      },
    });
    const { dither, transparentIndex } = enc.mapOptions();
    const mapped = []; // in frame order
    const limit = pool.workers.length * 3;
    const takeOne = async () => {
      const { idx, rgba } = await mapped.shift();
      enc.addMapped(idx, rgba, frameUs / 1000);
      // Don't let compression fall far behind, or frames pile up in memory.
      if (pool.load > limit * 2) await enc.frames[enc.frames.length - 1].result;
    };
    await forEachFrame(src, {
      start, fps, count,
      onFrame: async (k, frame) => {
        paint(frame);
        const rgba = ctx.getImageData(0, 0, W, H).data;
        preview();
        mapped.push(pool.run({ op: 'map', rgba, width: W, height: H, dither, transparentIndex }, [rgba.buffer]));
        while (mapped.length > limit) await takeOne();
        progress((k + 1) / count, `Encoding frame ${k + 1} of ${count}`);
      },
    });
    while (mapped.length) await takeOne();
    progress(1, 'Finishing…');
    return await enc.finish();
  } finally {
    pool.close();
  }
}
