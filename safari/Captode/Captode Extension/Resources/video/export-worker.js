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
import { fillOpusGaps } from '../lib/opus.js';
import { GifEncoder } from '../lib/gif.js';
import { WebpAnimEncoder } from '../lib/webp.js';
import { buildPalette } from '../lib/quantize.js';
import { WorkerPool } from '../lib/pool.js';
import { deviceRenderer, frameDrawer } from '../lib/device.js';
import { sourceColourSpace, outputColour } from '../lib/video-colour.js';
import { slideSchedule, overlaySchedule, paintOverlays, frameOrder, slideAlpha, renderSlides, slideShift } from '../lib/slides.js';
import { normaliseEdits, clipMap, clipFrames, composer, backgroundRenderer, hasSpatial, touchesAudio, audioGain, layerTime, drawLayer, soundingLayers, layerAlpha, transitionPainter, textArt } from '../lib/video-edits.js';

/** An error after which the page should fall back to its slower, simpler path. */
class Unsupported extends Error {}

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
// `what`: a message key, or [key, ...values]; the page translates it (workers can't).
let lastFrameNote = 0;
const progress = (f, what) => {
  // Frame counts at most every 100 ms: one a frame kept the page busy redrawing.
  if (Array.isArray(what) && what[0] === 'export_frame' && what[1] < what[2]) {
    const now = performance.now();
    if (now - lastFrameNote < 100) return;
    lastFrameNote = now;
  }
  post({ type: 'progress', f, what });
};

self.onmessage = async ({ data }) => {
  if (data.type !== 'start') return;
  try {
    const blob = await run(data.job);
    post({ type: 'done', blob });
  } catch (e) {
    post({ type: 'error', message: e.message || String(e), fallback: e instanceof Unsupported });
  } finally {
    for (const c of cursors) c.close();
    cursors.clear();
  }
};

// ---------- decoding ----------

/**
 * Decodes the video and calls `onFrame(k, frame)` for output frames k = 0 … count-1,
 * at `fps` from `start` (µs), or at the recording's time `time(k)` (µs, never going
 * back) where parts are cut or sped up. Each output frame is the source frame on
 * screen at that moment. `want(k)` can skip frames that aren't needed (to save drawing).
 */
async function forEachFrame(src, { start, fps, count, onFrame, want = () => true, time = null }) {
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

  const at = time || ((k) => start + (k * 1e6) / fps);
  let k = 0;
  // Key frames, to jump over parts cut: frames before the last key frame at or before
  // the next moment shown are never seen, so they needn't be decoded.
  const keys = [];
  for (let j = 0; j < frames.length; j++) if (frames[j].key) keys.push(j);
  let kp = 0;
  const skip = () => {
    if (k >= count) return;
    const need = at(k);
    while (kp < keys.length && keys[kp] <= i) kp++;
    let j = -1;
    while (kp < keys.length && frames[keys[kp]].timestamp <= need) j = keys[kp++];
    if (j > i) i = j;
  };
  let cur = null;
  let flushed = false;
  let flushing = null;
  try {
    while (k < count) {
      while (i < frames.length && decoder.decodeQueueSize < 6 && queue.length < 6) {
        skip();
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

// ---------- video layers ----------

const cursors = new Set(); // the layers' decoders, closed when the job ends

/**
 * A layer's video, decoded as the export goes: `at(us)` is its frame on screen at
 * that time (asked in time order). Frames handed out are closed by the cursor.
 */
async function layerCursor(blob) {
  let src;
  try {
    src = demuxWebm(await blob.arrayBuffer(), { views: true });
  } catch (e) {
    throw new Unsupported(e.message);
  }
  if (!src.video?.frames.length) return null;
  src.decoderConfig = await videoDecoderConfig(src.video);
  const frames = src.video.frames;
  const keys = [];
  for (let j = 0; j < frames.length; j++) if (frames[j].key) keys.push(j);
  const queue = [];
  let wake = null, failure = null, flushing = null, flushed = false, cur = null, i = 0, kp = 0;
  const decoder = new VideoDecoder({
    output: (f) => { queue.push(f); wake?.(); },
    error: (e) => { failure = e; wake?.(); },
  });
  decoder.configure(src.decoderConfig);
  const c = {
    src,
    end: frames[frames.length - 1].timestamp + 1e6 / 30,
    async at(us) {
      // Frames before the last key frame at or before `us` are never shown: skip them.
      while (kp < keys.length && keys[kp] <= i) kp++;
      let j = -1;
      while (kp < keys.length && frames[keys[kp]].timestamp <= us) j = keys[kp++];
      if (j > i) i = j;
      for (;;) {
        if (failure) throw failure;
        while (queue.length && queue[0].timestamp <= us) { cur?.close(); cur = queue.shift(); }
        if (queue.length) return cur || queue[0];
        if (flushed) return cur;
        if (i < frames.length) {
          while (i < frames.length && decoder.decodeQueueSize < 6) {
            const f = frames[i++];
            decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.timestamp, data: f.data }));
          }
        } else if (!flushing) {
          flushing = decoder.flush().then(() => { flushed = true; wake?.(); }, () => { flushed = true; wake?.(); });
        }
        // Woken by a frame, or after a moment (a decoder can take more input before giving any).
        await Promise.race([new Promise((r) => { wake = r; }), new Promise((r) => setTimeout(r, 20))]);
        wake = null;
      }
    },
    close() {
      cur?.close();
      for (const f of queue) f.close();
      queue.length = 0;
      if (decoder.state !== 'closed') decoder.close();
    },
  };
  cursors.add(c);
  return c;
}

/** The edits' video layers: `seek(t)` finds their frames at recording time t (s), `draw` puts them over the output. */
async function openLayers(edits, sources) {
  const list = edits.layers.filter((l) => l.kind !== 'sound' && (l.kind === 'text' || sources?.[l.src])); // voiceovers are only heard
  const byId = new Map(); // video layers' cursors
  const art = new Map(); // pictures' and words' images
  // Layers showing the same moment of the same file at every time (the halves of a
  // split layer, copies of one) share a decoder; pictures of one file, one image.
  const cursorsBy = new Map(), images = new Map();
  for (const l of list) {
    if (l.kind === 'video') {
      const key = `${l.src}|${Math.round((l.offset - l.from) * 1000)}`;
      if (!cursorsBy.has(key)) cursorsBy.set(key, await layerCursor(sources[l.src]));
      byId.set(l.id, cursorsBy.get(key));
    } else if (l.kind === 'image') {
      if (!images.has(l.src)) images.set(l.src, await createImageBitmap(sources[l.src]).catch(() => null));
      art.set(l.id, images.get(l.src));
    } else art.set(l.id, textArt(l).canvas);
  }
  const shown = new Map();
  let now = 0;
  return {
    list,
    byId,
    art,
    async seek(t) {
      shown.clear();
      now = t;
      for (const l of list) {
        if (t < l.from || t >= l.to) continue;
        if (art.has(l.id)) { if (art.get(l.id)) shown.set(l.id, art.get(l.id)); continue; }
        const c = byId.get(l.id);
        if (!c) continue;
        const us = Math.round(layerTime(l, t) * 1e6);
        if (us > c.end) continue; // its video has ended
        const f = c.last?.us === us ? c.last.f : await c.at(us);
        c.last = { us, f };
        if (f) shown.set(l.id, f);
      }
    },
    draw(ctx, W, H) {
      for (const l of list) {
        const f = shown.get(l.id);
        if (f) drawLayer(ctx, l, f, W, H, now);
      }
    },
  };
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

/** An OpusHead (RFC 7845) for encoded Opus that came without one. */
function opusHead(channels, sampleRate, preSkip = 312) {
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  const v = new DataView(h.buffer);
  v.setUint16(10, preSkip, true);
  v.setUint32(12, sampleRate, true);
  return h;
}

async function supported(Codec, config) {
  try { return (await Codec.isConfigSupported(config)).supported; } catch { return false; }
}

/**
 * The sound of the video layers that have it, to mix into the output: `add(planes, n,
 * at, rate, channels)` adds what plays in the `n` samples a channel from output time
 * `at` (µs). Each layer's sound is decoded once, to mono, and plays where its picture
 * does (silent in sped-up parts and while a slide is on, as the recording's is).
 * `shift` and `slideAt` (µs, before slides) place it after the slides. Null when no
 * layer has sound to mix.
 */
/** A WebM's Opus sound, decoded: `{ rate, first (µs), planes: [Int16Array, …] }` (`mono`: one plane), or null. */
async function decodeOpus(blob, { lo = -Infinity, hi = Infinity, mono = false } = {}) {
  let a;
  try { a = demuxWebm(await blob.arrayBuffer(), { views: true }).audio; } catch { return null; }
  if (!a || a.codecId !== 'A_OPUS' || !a.frames.length) return null;
  const config = { codec: 'opus', sampleRate: a.sampleRate, numberOfChannels: a.channels, description: a.description || undefined };
  if (!(await supported(AudioDecoder, config))) return null;
  const chunks = [];
  let first = null, failure = null;
  const out = mono ? 1 : Math.min(2, a.channels);
  const decoder = new AudioDecoder({
    output: (ad) => {
      const n = ad.numberOfFrames, ch = ad.numberOfChannels;
      const plane = new Float32Array(n);
      const pcm = Array.from({ length: out }, () => new Int16Array(n));
      const sum = mono ? new Float32Array(n) : null;
      for (let c = 0; c < ch; c++) {
        ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        if (mono) for (let i = 0; i < n; i++) sum[i] += plane[i] / ch;
        else if (c < out) for (let i = 0; i < n; i++) pcm[c][i] = Math.max(-32768, Math.min(32767, Math.round(plane[i] * 32767)));
      }
      if (mono) for (let i = 0; i < n; i++) pcm[0][i] = Math.max(-32768, Math.min(32767, Math.round(sum[i] * 32767)));
      if (!mono && out === 2 && ch === 1) pcm[1].set(pcm[0]);
      if (first === null) first = ad.timestamp;
      chunks.push({ rate: ad.sampleRate, pcm });
      ad.close();
    },
    error: (e) => { failure = e; },
  });
  decoder.configure(config);
  for (const f of a.frames) if (f.timestamp >= lo && f.timestamp < hi) decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.timestamp, data: f.data }));
  await decoder.flush();
  decoder.close();
  if (failure || !chunks.length) return null;
  const total = chunks.reduce((n, c) => n + c.pcm[0].length, 0);
  const planes = Array.from({ length: out }, (_, c) => {
    const p = new Int16Array(total);
    let o = 0;
    for (const k of chunks) { p.set(k.pcm[c], o); o += k.pcm[c].length; }
    return p;
  });
  return { rate: chunks[0].rate, first, planes };
}

async function layerSound(edits, sources, map, shift, slideAt, length = 0) {
  if (typeof AudioDecoder === 'undefined') return null;
  const tracks = [];
  for (const l of soundingLayers(edits)) {
    const blob = sources?.[l.src];
    if (!blob) continue;
    const dec = await decodeOpus(blob, { lo: (l.offset - 0.1) * 1e6, hi: (l.offset + l.to - l.from + 0.1) * 1e6, mono: true });
    if (!dec) continue;
    const { rate, first } = dec;
    const pcm = dec.planes[0];
    // Where it plays: each part at normal speed it covers, split where slides go in.
    const segs = [];
    for (const part of map.parts) {
      if (part.rate !== 1) continue;
      const a0 = Math.max(part.from, l.from), b0 = Math.min(part.to, l.to);
      if (b0 <= a0) continue;
      const o0 = (part.out + a0 - part.from) * 1e6, o1 = o0 + (b0 - a0) * 1e6;
      const cuts = [o0, ...slideAt.filter((x) => x > o0 && x < o1), o1];
      for (let i = 0; i < cuts.length - 1; i++) {
        const by = shift(cuts[i]);
        segs.push({ out0: cuts[i] + by, out1: cuts[i + 1] + by, lt0: layerTime(l, a0 + (cuts[i] - o0) / 1e6) * 1e6 });
      }
    }
    tracks.push({ l, pcm, rate, first, vol: l.volume, segs });
  }
  // Music: under the whole output, from its start, quieter while anything else is heard.
  let music = null;
  const m = edits.music;
  if (m && sources?.[m.src]) {
    const dec = await decodeOpus(sources[m.src]);
    if (dec) music = { ...dec, len: dec.planes[0].length, m };
  }
  if (!tracks.length && !music) return null;
  let env = 0, duck = 1; // how loud the rest is, and how far the music is lowered
  return {
    add(planes, n, at, rate, channels) {
      const end = at + (n * 1e6) / rate;
      for (const tr of tracks) {
        for (const g of tr.segs) {
          if (g.out1 <= at || g.out0 >= end) continue;
          const i0 = Math.max(0, Math.ceil(((g.out0 - at) * rate) / 1e6)), i1 = Math.min(n, Math.ceil(((g.out1 - at) * rate) / 1e6));
          for (let i = i0; i < i1; i++) {
            const lt = g.lt0 + at + (i * 1e6) / rate - g.out0; // µs in the layer's video
            const k = Math.round(((lt - tr.first) * tr.rate) / 1e6);
            if (k < 0 || k >= tr.pcm.length) continue;
            const v = (tr.pcm[k] / 32767) * tr.vol * layerAlpha(tr.l, tr.l.from + lt / 1e6 - tr.l.offset, true);
            for (let c = 0; c < channels; c++) {
              const x = planes[c * n + i] + v;
              planes[c * n + i] = x > 1 ? 1 : x < -1 ? -1 : x;
            }
          }
        }
      }
      if (!music) return;
      const { m: mm, planes: mp, len, rate: mr } = music;
      const attack = 1 - Math.exp(-1 / (0.01 * rate)), release = 1 - Math.exp(-1 / (0.3 * rate));
      const fall = 1 - Math.exp(-1 / (0.08 * rate)), rise = 1 - Math.exp(-1 / (0.6 * rate));
      for (let i = 0; i < n; i++) {
        const u = (at + (i * 1e6) / rate) / 1e6; // output time (s)
        if (mm.duck) {
          let x = 0;
          for (let c = 0; c < channels; c++) x = Math.max(x, Math.abs(planes[c * n + i]));
          env += (x - env) * (x > env ? attack : release);
          const target = env > 0.03 ? 0.3 : 1;
          duck += (target - duck) * (target < duck ? fall : rise);
        }
        let k = Math.floor((u + mm.offset) * mr);
        if (mm.loop) k %= len;
        if (k < 0 || k >= len) continue;
        const fade = Math.min(1, mm.fadeIn ? u / mm.fadeIn : 1, mm.fadeOut && length ? (length / 1e6 - u) / mm.fadeOut : 1);
        const g = mm.volume * Math.max(0, fade) * (mm.duck ? duck : 1) / 32767;
        for (let c = 0; c < channels; c++) {
          const x = planes[c * n + i] + mp[Math.min(c, mp.length - 1)][k] * g;
          planes[c * n + i] = x > 1 ? 1 : x < -1 ? -1 : x;
        }
      }
    },
  };
}

/**
 * Audio for the output. Returns null when there is no audio to keep.
 * With no edits to the sound, Opus packets are copied into WebM as they are, and
 * re-encoded to AAC for MP4. With parts cut or the volume changed, the sound is
 * decoded, put together and encoded again (Opus for WebM, AAC for MP4).
 * `map` (lib/video-edits.js) is where each moment plays (sped-up parts are silent);
 * `shift(u)` how much later (µs) the sound at output time u plays, after the slides
 * before it; `length` (µs) how long the output is; `gain(t, u, part)` its loudness.
 */
async function exportAudio(src, format, { map, shift = () => 0, length, gain = null, mix = null }) {
  const a = src.audio?.codecId === 'A_OPUS' ? src.audio : null;
  const startUs = map.start * 1e6, endUs = map.end * 1e6;
  const packets = a ? a.frames.filter((f) => f.timestamp >= startUs && f.timestamp < endUs) : [];
  if (!packets.length && !mix) return null;
  const outUs = (t) => { const u = map.outOf(t / 1e6) * 1e6; return u + shift(u); };
  // The packets as they are, moved to their place in the output (those in parts cut
  // or sped up left out), with silence where a slide was put in (players would
  // otherwise close the gap and lose sync).
  const copied = () => fillOpusGaps(packets.flatMap((f, i) => {
    const part = map.partAt(f.timestamp / 1e6);
    if (!part || part.rate !== 1) return [];
    const next = packets[i + 1];
    const duration = next ? next.timestamp - f.timestamp : (i ? f.timestamp - packets[i - 1].timestamp : 20000);
    return [{ timestamp: Math.round(outUs(f.timestamp)), duration, key: true, data: f.data }];
  }));

  if (format === 'webm' && !gain && !mix) {
    return { codecId: 'A_OPUS', sampleRate: a.sampleRate, channels: a.channels, description: a.description, frames: copied() };
  }
  const channels = a ? Math.min(2, a.channels) : 2;
  const aac = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: channels, bitrate: 128000 };
  const opus = { codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate: 128000 };
  const decConfig = a && { codec: 'opus', sampleRate: a.sampleRate, numberOfChannels: a.channels, description: a.description || undefined };
  const canDecode = typeof AudioDecoder !== 'undefined' && (!a || await supported(AudioDecoder, decConfig));
  let encConfig = null;
  if (canDecode && typeof AudioEncoder !== 'undefined') {
    if (format === 'mp4' && await supported(AudioEncoder, aac)) encConfig = aac;
    else if (await supported(AudioEncoder, opus)) encConfig = opus;
  }
  if (!encConfig) {
    if (!packets.length) return null; // only layers' sound, and nothing to encode it with
    // Nothing here to encode with: the packets as they are (cuts kept; no volume changes, no layers' sound).
    if (format === 'webm') return { codecId: 'A_OPUS', sampleRate: a.sampleRate, channels: a.channels, description: a.description, frames: copied() };
    // MP4 can carry Opus, and Chrome, Firefox and Safari all play it.
    if (!a.description) throw new Unsupported('This browser cannot encode AAC audio.');
    return { codec: 'opus', sampleRate: 48000, channels: a.channels, opusHead: a.description, frames: copied() };
  }

  const out = [];
  let description = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, md) => {
      if (md?.decoderConfig?.description) description = new Uint8Array(md.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      out.push({ timestamp: chunk.timestamp, duration: chunk.duration, key: true, data });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(encConfig);
  // Sample tables have no start offsets, so any gap (audio usually starts a little
  // after the video, and slides leave gaps) is filled with silence to keep sound and
  // picture in sync.
  let expected = 0; // µs of audio written so far; it stops where the video does
  const write = (planes, n, sampleRate) => {
    const room = Math.floor(((length - expected) * sampleRate) / 1e6);
    if (room <= 0 || n <= 0) return;
    if (n > room) {
      // Keep the first `room` samples of each channel.
      const cut = new Float32Array(room * channels);
      for (let c = 0; c < channels; c++) cut.set(planes.subarray(c * n, c * n + room), c * room);
      planes = cut;
      n = room;
    }
    if (mix) mix.add(planes, n, expected, sampleRate, channels);
    const re = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round(expected), data: planes });
    encoder.encode(re);
    re.close();
    expected += (n * 1e6) / sampleRate;
  };
  /** `n` samples a channel that play from output time `at` (µs). */
  const place = (planes, n, at, rate) => {
    const gap = Math.round(((at - expected) * rate) / 1e6);
    if (gap > rate / 100) write(new Float32Array(gap * channels), gap, rate);
    else if (gap < -1) {
      // Overlaps what is written (rounding at a join): drop the overlap.
      const drop = Math.min(n, -gap);
      const rest = new Float32Array((n - drop) * channels);
      for (let c = 0; c < channels; c++) rest.set(planes.subarray(c * n + drop, (c + 1) * n), c * (n - drop));
      planes = rest;
      n -= drop;
    }
    write(planes, n, rate);
  };
  const decoder = new AudioDecoder({
    output: (ad) => {
      const n = ad.numberOfFrames;
      const rate = ad.sampleRate;
      const t0 = ad.timestamp / 1e6;
      const planes = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) {
        ad.copyTo(planes.subarray(c * n, (c + 1) * n), { planeIndex: Math.min(c, ad.numberOfChannels - 1), format: 'f32-planar' });
      }
      ad.close();
      // The samples in each part played at normal speed, in their place.
      for (const part of map.parts) {
        if (part.rate !== 1) continue;
        const i0 = Math.max(0, Math.ceil((part.from - t0) * rate - 1e-6)), i1 = Math.min(n, Math.ceil((part.to - t0) * rate - 1e-6));
        if (i1 <= i0) continue;
        const len = i1 - i0;
        const at = outUs((t0 + i0 / rate) * 1e6);
        const seg = new Float32Array(len * channels);
        for (let i = 0; i < len; i++) {
          const g = gain ? gain(t0 + (i0 + i) / rate, at / 1e6 + i / rate, part) : 1;
          for (let c = 0; c < channels; c++) {
            const v = planes[c * n + i0 + i] * g;
            seg[c * len + i] = v > 1 ? 1 : v < -1 ? -1 : v;
          }
        }
        place(seg, len, at, rate);
      }
    },
    error: (e) => { failure = e; },
  });
  if (packets.length) {
    decoder.configure(decConfig);
    for (const f of packets) decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.timestamp, data: f.data }));
    await decoder.flush();
  }
  // Layers' sound can go on after the recording's ends (or the recording has none).
  if (mix) while (expected < length - 1000 && !failure) write(new Float32Array(48000 * channels), 48000, 48000);
  await encoder.flush();
  if (decoder.state !== 'closed') decoder.close();
  encoder.close();
  if (failure) throw failure;
  if (encConfig === aac) {
    if (!description) throw new Unsupported('The AAC encoder gave no configuration.');
    return { sampleRate: aac.sampleRate, channels, asc: description, bitrate: aac.bitrate, frames: out };
  }
  const head = description?.length >= 19 ? description : opusHead(channels, 48000);
  if (format === 'webm') return { codecId: 'A_OPUS', sampleRate: 48000, channels, description: head, frames: out };
  return { codec: 'opus', sampleRate: 48000, channels, opusHead: head, frames: out };
}

// ---------- the job ----------

/**
 * job: {
 *   blob, format ('mp4' | 'webm' | 'gif' | 'webp'),
 *   width, height, fps, start, end (seconds), device (options or null),
 *   edits (lib/video-edits.js: parts cut or sped up, blurs, crop, zooms, callouts,
 *   background, sound),
 *   slides (see lib/slides.js; shown at their moments, the clip waiting meanwhile,
 *   or drawn over it for overlays),
 *   video: { bitsPerPixel, audio }, gif: { colors, dither, lossy }, webp: { quality, lossless },
 *   optimize, tolerance, loop
 * }
 */
async function run(job) {
  if (typeof VideoDecoder === 'undefined') throw new Unsupported('WebCodecs is not available.');
  progress(0, 'export_reading');
  let src;
  try {
    src = demuxWebm(await job.blob.arrayBuffer(), { views: true }); // frames point into the file: not held twice
  } catch (e) {
    throw new Unsupported(e.message);
  }
  if (!src.video?.frames.length) throw new Unsupported('No video frames found.');
  src.decoderConfig = await videoDecoderConfig(src.video);

  const W = job.width, H = job.height, fps = job.fps;
  const start = Math.round(job.start * 1e6), end = Math.round(job.end * 1e6);
  const edits = normaliseEdits(job.edits);
  const logo = job.logo?.blob ? { ...job.logo, bitmap: await createImageBitmap(job.logo.blob).catch(() => null) } : null;
  const map = clipMap(edits, job.start, job.end);
  const count = clipFrames(map, fps);
  const layers = await openLayers(edits, job.layerSources);
  const trans = transitionPainter(job.transitions || []);
  const frameUs = 1e6 / fps;
  // The recording's time (µs) shown on clip frame k.
  const time = (k) => Math.round(map.sourceAt(k / fps) * 1e6);
  // Output frames: the clip's, with each slide's put in before the clip frame it
  // goes with. `forEachFrame` still walks the clip; `outFrames` hands on the output
  // frames that go with each clip frame, numbered in the output.
  const schedule = slideSchedule(job.slides, job.start, job.end, fps, map);
  const order = frameOrder(schedule, count);
  const total = order.length;
  const slideArt = await renderSlides(schedule, W, H);
  // Overlays add no frames: they are drawn over the clip's own, by its frame number.
  const overlays = overlaySchedule(job.slides, job.start, job.end, fps, map);
  const overlayArt = await renderSlides(overlays, W, H);
  const outFrames = (onOut) => {
    let n = 0;
    return async (k, frame) => {
      while (n < total && order[n].k === k) { await onOut(n, order[n], frame); n++; }
    };
  };

  // The source size comes from the first decoded frame (MediaRecorder sometimes
  // leaves the track's pixel size out).
  const canvas = new OffscreenCanvas(W, H);
  // A GPU canvas, even for GIF and WebP, which read the pixels back: drawing a
  // decoded frame into a CPU canvas converts and scales it in software, which
  // took about 7 ms a frame, against well under 1 ms here plus a quicker read-back.
  const ctx = canvas.getContext('2d', { alpha: true });
  let draw = null;
  let comp = null, content = null, cctx = null;
  /** Draws `frame`, the recording at time t (s), shown at output time o (s, before slides). */
  const paint = (frame, t, o) => {
    if (!draw) {
      const sw = frame.displayWidth, sh = frame.displayHeight;
      if (hasSpatial(edits) || logo?.bitmap) {
        comp = composer(edits, map, sw, sh, job.clicks, logo?.bitmap ? logo : null, job.moves);
        content = new OffscreenCanvas(comp.width, comp.height);
        cctx = content.getContext('2d');
      }
      const cw = comp ? comp.width : sw, ch = comp ? comp.height : sh;
      const renderer = job.device ? deviceRenderer(job.device, cw, ch) : edits.background.on ? backgroundRenderer(edits.background, cw, ch) : null;
      draw = frameDrawer({ width: W, height: H }, renderer, job.format === 'mp4' || job.format === 'webm');
    }
    ctx.clearRect(0, 0, W, H);
    if (comp) {
      cctx.clearRect(0, 0, content.width, content.height);
      comp.draw(cctx, frame, t, o);
      draw(ctx, content);
    } else draw(ctx, frame);
    layers.draw(ctx, W, H);
    trans.apply(ctx, t, W, H);
  };
  /** Draws output frame `o` (from `order`): the clip's frame and its overlays, a slide, or a slide fading over them. */
  const paintOut = (o, frame) => {
    const a = o.slide ? slideAlpha(o.slide, o.j, fps) : 0;
    if (a < 1) {
      paint(frame, map.sourceAt(o.k / fps), o.k / fps);
      paintOverlays(ctx, overlays, overlayArt, o.k, fps);
    }
    if (a > 0) {
      ctx.globalAlpha = a;
      ctx.drawImage(slideArt.get(o.slide), 0, 0);
      ctx.globalAlpha = 1;
    }
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

    const shift = slideShift(schedule, fps);
    const mix = job.video.audio ? await layerSound(edits, job.layerSources, map, shift, schedule.map((e) => e.k * frameUs), Math.round(total * frameUs)) : null;
    const audio = job.video.audio
      ? await exportAudio(src, job.format, { map, shift, length: Math.round(total * frameUs), mix, gain: touchesAudio(edits) || !map.plain ? audioGain(edits, map, total / fps, job.audioCurve) : null })
      : null;
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
      start, fps, count, time,
      onFrame: outFrames(async (n, o, frame) => {
        if (failure) throw failure;
        await layers.seek(map.sourceAt(o.k / fps));
        paintOut(o, frame);
        const vf = new VideoFrame(canvas, { timestamp: Math.round(n * frameUs), duration: Math.round(frameUs), alpha: 'discard' });
        encoder.encode(vf, { keyFrame: n % keyEvery === 0 });
        vf.close();
        await drain(encoder);
        preview();
        progress((n + 1) / total, ['export_frame', n + 1, total]);
      }),
    });
    progress(1, 'export_finishing');
    await encoder.flush();
    encoder.close();
    if (failure) throw failure;

    // Tagged, so every player shows the colours as they were on screen.
    const colour = outputColour(encodedColour);
    if (job.format === 'mp4') {
      if (!description) throw new Unsupported('The H.264 encoder gave no configuration.');
      return muxMp4({ video: { width: W, height: H, avcC: description, frames: chunks, colour }, audio, chapters: job.chapters, subtitles: job.subtitles });
    }
    return muxWebm({ video: { codecId: config.codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9', width: W, height: H, frames: chunks, colour }, audio, chapters: job.chapters, subtitles: job.subtitles });
  }

  // GIF and WebP
  const transparent = !!job.device && job.device.bg === 'none';
  let palette = null;
  if (job.format === 'gif') {
    // One palette for the whole clip, from frames spread across it.
    const parts = [];
    const sample = (frame, k = null) => {
      const t = k === null ? frame.timestamp / 1e6 : map.sourceAt(k / fps);
      paint(frame, t, map.outOf(t));
      const px = ctx.getImageData(0, 0, W, H).data;
      const part = new Uint8ClampedArray(Math.ceil(px.length / 12) * 4);
      for (let i = 0, o = 0; i < px.length; i += 12, o += 4) part.set(px.subarray(i, i + 4), o);
      parts.push(part);
      progress(0, 'export_colours');
    };
    // Key frames decode on their own, so when there are enough of them in range,
    // sample those instead of decoding the whole clip an extra time.
    const keys = src.video.frames.filter((f) => f.key && f.timestamp >= start && f.timestamp < end && map.partAt(f.timestamp / 1e6));
    if (keys.length >= 4) {
      const step = Math.max(1, keys.length / 16);
      const picks = [];
      for (let x = 0; x < keys.length && picks.length < 16; x += step) picks.push(keys[Math.floor(x)]);
      await decodeAlone(src, picks, sample);
    } else {
      const samples = Math.min(count, 16);
      const want = new Set(Array.from({ length: samples }, (_, n) => Math.floor(((n + 0.5) * count) / samples)));
      await forEachFrame(src, { start, fps, count, time, want: (k) => want.has(k), onFrame: async (k, frame) => sample(frame, k) });
    }
    // The slides' colours belong in the palette too: overlays over the last frame sampled.
    const sampleCanvas = () => {
      const px = ctx.getImageData(0, 0, W, H).data;
      const part = new Uint8ClampedArray(Math.ceil(px.length / 12) * 4);
      for (let i = 0, q = 0; i < px.length; i += 12, q += 4) part.set(px.subarray(i, i + 4), q);
      parts.push(part);
    };
    for (const art of overlayArt.values()) {
      ctx.drawImage(art, 0, 0);
      sampleCanvas();
    }
    for (const art of slideArt.values()) {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(art, 0, 0);
      sampleCanvas();
    }
    // And each video layer's, from a key frame near its middle.
    for (const l of layers.list) {
      if (layers.art.get(l.id)) {
        ctx.clearRect(0, 0, W, H);
        drawLayer(ctx, l, layers.art.get(l.id), W, H, (l.from + l.to) / 2);
        sampleCanvas();
        continue;
      }
      const c = layers.byId.get(l.id);
      if (!c) continue;
      const mid = Math.min(c.end, layerTime(l, (l.from + l.to) / 2) * 1e6);
      const key = c.src.video.frames.filter((f) => f.key && f.timestamp <= mid).at(-1) || c.src.video.frames[0];
      await decodeAlone(c.src, [key], (f) => {
        ctx.clearRect(0, 0, W, H);
        drawLayer(ctx, l, f, W, H, (l.from + l.to) / 2);
        sampleCanvas();
      });
    }
    const all = new Uint8ClampedArray(parts.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const part of parts) { all.set(part, o); o += part.length; }
    palette = buildPalette(all, Math.max(2, job.gif.colors - 1));
  }

  if (job.format === 'gif') return exportGif(src, { start, fps, count, time, total, outFrames, frameUs, palette, transparent, paintOut, preview, ctx, W, H, job, layers, map });

  const enc = new WebpAnimEncoder(W, H, {
    quality: job.webp.quality, lossless: job.webp.lossless, optimize: job.optimize, loop: job.loop, alpha: transparent, tolerance: job.tolerance,
  });
  await forEachFrame(src, {
    start, fps, count, time,
    onFrame: outFrames(async (n, o, frame) => {
      await layers.seek(map.sourceAt(o.k / fps));
      paintOut(o, frame);
      await enc.addFrame(canvas, frameUs / 1000);
      preview();
      progress((n + 1) / total, ['export_frame', n + 1, total]);
    }),
  });
  progress(1, 'export_finishing');
  return enc.finish();
}

/**
 * GIF on several cores: frames are drawn here in order, mapped to the palette and
 * compressed on a pool of workers, and compared with the frame before here (the
 * one step that has to go in order).
 */
async function exportGif(src, { start, fps, count, time, total, outFrames, frameUs, palette, transparent, paintOut, preview, ctx, W, H, job, layers, map }) {
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
      start, fps, count, time,
      onFrame: outFrames(async (n, o, frame) => {
        await layers.seek(map.sourceAt(o.k / fps));
        paintOut(o, frame);
        const rgba = ctx.getImageData(0, 0, W, H).data;
        preview();
        mapped.push(pool.run({ op: 'map', rgba, width: W, height: H, dither, transparentIndex }, [rgba.buffer]));
        while (mapped.length > limit) await takeOne();
        progress((n + 1) / total, ['export_frame', n + 1, total]);
      }),
    });
    while (mapped.length) await takeOne();
    progress(1, 'export_finishing');
    return await enc.finish();
  } finally {
    pool.close();
  }
}
