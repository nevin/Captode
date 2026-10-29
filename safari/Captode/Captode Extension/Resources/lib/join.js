// Joining recordings and video files one after another into one recording (the
// video page's Clips). The result is a single WebM, so the preview, the edits and
// every export work on it as on any recording.
//
// A clip recorded the same way as the first one (same codec and size: another
// Captode recording, say) is copied as it is. Anything else is played through once
// and encoded to match, fitted inside the first clip's picture. Each clip starts
// with a key frame, so clips can later be moved or removed by copying alone.
//
// A piece is { blob, from, len }: `len` seconds of `blob` from `from`.

import { demuxWebm, muxWebm } from './webm.js';
import { SILENCE, SILENCE_US } from './opus.js';
import { sourceColourSpace, outputColour } from './video-colour.js';
import { once, wait } from './util.js';

/** Matroska video codecs WebCodecs can encode, as its codec strings. */
const ENCODE = { V_VP9: 'vp09.00.10.08', V_VP8: 'vp8', V_AV1: 'av01.0.04M.08' };

export class JoinError extends Error {
  /** `code`: 'unplayable' | 'unsupported' | 'cancelled'. */
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const msUs = (s) => Math.round(s * 1000) * 1000; // the muxer writes whole milliseconds

/** A hidden video element playing `blob`, with its duration found. */
async function openVideo(blob) {
  const v = document.createElement('video');
  v.className = 'work';
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  const url = URL.createObjectURL(blob);
  v.src = url;
  document.body.appendChild(v);
  const close = () => { v.remove(); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); };
  try {
    await new Promise((resolve, reject) => {
      v.addEventListener('loadedmetadata', resolve, { once: true });
      v.addEventListener('error', () => reject(new JoinError('unplayable')), { once: true });
    });
    // MediaRecorder writes WebM without a duration; seeking to the end finds it.
    if (!Number.isFinite(v.duration)) {
      v.currentTime = 1e9;
      await Promise.race([once(v, 'durationchange'), wait(4000)]);
      v.currentTime = 0;
      await Promise.race([once(v, 'seeked'), wait(4000)]);
    }
    if (!v.videoWidth || !(v.duration > 0) || !Number.isFinite(v.duration)) throw new JoinError('unplayable');
    return { v, close };
  } catch (e) {
    close();
    throw e;
  }
}

/** `{ duration, width, height }` of a video, or a JoinError('unplayable'). */
export async function probeVideo(blob) {
  const { v, close } = await openVideo(blob);
  const out = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  close();
  return out;
}

/** The file's tracks if it is a WebM with a picture, else null. */
async function readWebm(blob) {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (head[0] !== 0x1a || head[1] !== 0x45 || head[2] !== 0xdf || head[3] !== 0xa3) return null;
  try {
    const d = demuxWebm(await blob.arrayBuffer(), { views: true });
    return d.video?.frames.length ? d : null;
  } catch {
    return null;
  }
}

async function encodable(codec, width, height) {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return !!(await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 2e6, framerate: 30 })).supported;
  } catch {
    return false;
  }
}

/** What the joined video is encoded as: the first clip's codec and size when it can be. */
async function chooseSpec(first, size) {
  const v = first?.video;
  if (v && ENCODE[v.codecId]) return { codecId: v.codecId, codec: ENCODE[v.codecId], width: v.width, height: v.height };
  const [width, height] = size.map(even);
  for (const codecId of ['V_VP9', 'V_VP8']) {
    if (await encodable(ENCODE[codecId], width, height)) return { codecId, codec: ENCODE[codecId], width, height };
  }
  throw new JoinError('unsupported');
}

/** The frames of [lo, hi) µs, moved to start at `to` µs. */
const slice = (frames, lo, hi, to) => frames
  .filter((f) => f.timestamp >= lo - 500 && f.timestamp < hi - 500)
  .map((f) => ({ timestamp: Math.max(0, f.timestamp - lo + to), key: f.key, data: f.data }));

/**
 * Encodes [from, from + len) of `blob`, fitted inside the picture. Where the browser
 * says when each frame shows, it is played through at double speed (several times
 * quicker than stepping); else, or if playing stalls (a hidden tab), frame by frame.
 */
async function encodeVideo(blob, from, len, spec, fps, report, signal) {
  if (!(await encodable(spec.codec, spec.width, spec.height))) throw new JoinError('unsupported');
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    try {
      return await encodeWith(blob, from, len, spec, fps, report, signal, true);
    } catch (e) {
      if (e instanceof JoinError) throw e;
    }
  }
  return encodeWith(blob, from, len, spec, fps, report, signal, false);
}

class Stalled extends Error {}

async function encodeWith(blob, from, len, spec, fps, report, signal, playing) {
  const { v, close } = await openVideo(blob);
  const frames = [];
  let failure = null;
  const enc = new VideoEncoder({
    output: (c) => {
      const data = new Uint8Array(c.byteLength);
      c.copyTo(data);
      frames.push({ timestamp: c.timestamp, key: c.type === 'key', data });
    },
    error: (e) => { failure = e; },
  });
  try {
    const { width: W, height: H } = spec;
    enc.configure({ codec: spec.codec, width: W, height: H, framerate: fps, bitrate: Math.round(Math.min(12e6, Math.max(1e6, W * H * fps * 0.12))) });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const s = Math.min(W / v.videoWidth, H / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    const last = Math.min(v.duration, from + len) - 0.001;
    const count = Math.max(1, Math.round(len * fps));
    let i = 0; // the next output frame
    /** Encodes the frame showing as output frame i. */
    const put = () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      i++;
    };
    const seekTo = async (at) => {
      if (Math.abs(v.currentTime - at) <= 0.0005 && v.readyState >= 2) return;
      const done = once(v, 'seeked');
      v.currentTime = at;
      // A seek that never ends fails the join rather than leaving it waiting for good.
      await Promise.race([done, wait(5000)]);
      if (v.seeking) throw new JoinError('unplayable');
    };
    if (playing) {
      await seekTo(from);
      v.playbackRate = 2;
      await new Promise((resolve, reject) => {
        let seen = performance.now();
        let over = false;
        const stop = (e) => {
          if (over) return;
          over = true;
          clearInterval(watch);
          v.pause();
          if (e) reject(e); else resolve();
        };
        const watch = setInterval(() => { if (performance.now() - seen > 3000) stop(new Stalled('stalled')); }, 500);
        const tick = async (_now, md) => {
          if (over) return;
          seen = performance.now();
          if (signal?.aborted) return stop(new JoinError('cancelled'));
          if (failure) return stop(failure);
          // Every output frame due by now shows this frame (any skipped repeat the one before).
          while (i < count && from + i / fps <= md.mediaTime + 0.0005) put();
          report(i / count);
          if (i >= count || md.mediaTime >= last) return stop();
          if (enc.encodeQueueSize > 8) {
            v.pause();
            while (enc.encodeQueueSize > 2 && !failure) await wait(4);
            seen = performance.now();
            if (!over) v.play().catch((e) => stop(e));
          }
          v.requestVideoFrameCallback(tick);
        };
        v.addEventListener('ended', () => stop(), { once: true });
        v.requestVideoFrameCallback(tick);
        v.play().catch((e) => stop(new Stalled(String(e))));
      });
      // The end: the last frame stays.
      while (i < count) put();
    } else {
      while (i < count) {
        if (signal?.aborted) throw new JoinError('cancelled');
        if (failure) throw failure;
        await seekTo(Math.min(last, from + i / fps));
        put();
        while (enc.encodeQueueSize > 4 && !failure) await wait(4);
        report(i / count);
      }
    }
    await enc.flush();
    if (failure) throw failure;
    return frames;
  } finally {
    if (enc.state !== 'closed') enc.close();
    close();
  }
}

/**
 * The sound of [from, from + len) of `blob`, encoded as Opus: frames, or null when
 * it has none. `{ lost: true }` when it has sound this browser can't encode.
 */
async function encodeAudio(blob, from, len, channels) {
  let buf;
  try {
    buf = await new OfflineAudioContext(channels, 1, 48000).decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null; // no sound
  }
  const a = Math.round(from * 48000);
  const n = Math.min(buf.length - a, Math.round(len * 48000));
  if (n <= 0) return null;
  if (typeof AudioEncoder === 'undefined') return { lost: true };
  const frames = [];
  let failure = null;
  const enc = new AudioEncoder({
    output: (c) => {
      const data = new Uint8Array(c.byteLength);
      c.copyTo(data);
      frames.push({ timestamp: c.timestamp, key: true, data });
    },
    error: (e) => { failure = e; },
  });
  try {
    const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate: 128000 };
    if (!(await AudioEncoder.isConfigSupported(config)).supported) return { lost: true };
    enc.configure(config);
    for (let i = 0; i < n && !failure; i += 48000) {
      const k = Math.min(48000, n - i);
      const data = new Float32Array(k * channels);
      for (let ch = 0; ch < channels; ch++) data.set(buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1)).subarray(a + i, a + i + k), ch * k);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: k, numberOfChannels: channels, timestamp: Math.round((i * 1e6) / 48000), data });
      enc.encode(ad);
      ad.close();
    }
    await enc.flush();
    if (failure) throw failure;
    return frames;
  } catch {
    return { lost: true };
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
}

/** An Opus header (RFC 7845) for a track that has none to copy. */
function opusHead(channels) {
  const b = new Uint8Array(19);
  b.set([...'OpusHead'].map((c) => c.charCodeAt(0)));
  const d = new DataView(b.buffer);
  b[8] = 1;
  b[9] = channels;
  d.setUint16(10, 312, true); // pre-skip
  d.setUint32(12, 48000, true);
  return b;
}

/**
 * Joins `pieces` in order into one WebM. Returns `{ blob, lostSound }` (lostSound:
 * an added clip's sound couldn't be encoded here and was left out).
 */
export async function joinPieces(pieces, { fps = 30, onProgress = () => {}, signal } = {}) {
  const read = new Map();
  const webm = (blob) => {
    if (!read.has(blob)) read.set(blob, readWebm(blob));
    return read.get(blob);
  };
  const first = await webm(pieces[0].blob);
  const size = first ? [first.video.width, first.video.height] : await probeVideo(pieces[0].blob).then((p) => [p.width, p.height]);
  const spec = await chooseSpec(first, size);
  const firstAudio = first?.audio?.codecId === 'A_OPUS' ? first.audio : null;
  const channels = Math.min(2, Math.max(1, firstAudio?.channels || 2));

  const total = pieces.reduce((n, p) => n + p.len, 0) || 1;
  let done = 0;
  let offset = 0; // µs
  let lostSound = false;
  const out = [];
  for (const p of pieces) {
    if (signal?.aborted) throw new JoinError('cancelled');
    const d = await webm(p.blob);
    const lo = msUs(p.from), hi = msUs(p.from + p.len), len = hi - lo;
    const report = (f) => onProgress((done + f * p.len) / total);
    let video = null;
    if (d && d.video.codecId === spec.codecId && d.video.width === spec.width && d.video.height === spec.height) {
      const all = slice(d.video.frames, lo, hi, offset);
      const k = all.findIndex((f) => f.key);
      if (k === 0) video = all;
      else if (k > 0) {
        // It starts between key frames: up to the next one is encoded, the rest copied.
        const keyAt = (all[k].timestamp - offset + lo) / 1e6;
        const head = await encodeVideo(p.blob, p.from, keyAt - p.from, spec, fps, (f) => report(f * ((keyAt - p.from) / p.len)), signal);
        video = [...head.map((f) => ({ ...f, timestamp: f.timestamp + offset })).filter((f) => f.timestamp < all[k].timestamp), ...all.slice(k)];
      }
    }
    if (!video) video = (await encodeVideo(p.blob, p.from, p.len, spec, fps, report, signal)).map((f) => ({ ...f, timestamp: f.timestamp + offset }));
    let audio = null;
    if (d?.audio?.codecId === 'A_OPUS') audio = slice(d.audio.frames, lo, hi, offset);
    else if (!d || d.audio) {
      const a = await encodeAudio(p.blob, p.from, p.len, channels);
      if (a?.lost) lostSound = true;
      else if (a) audio = a.filter((f) => f.timestamp < len).map((f) => ({ ...f, timestamp: f.timestamp + offset }));
    }
    out.push({ video, audio, offset, len });
    offset += len;
    done += p.len;
    onProgress(done / total);
  }

  const withSound = out.some((o) => o.audio?.length);
  let audioFrames = [];
  if (withSound) {
    for (const o of out) {
      if (o.audio?.length) { audioFrames.push(...o.audio); continue; }
      // A clip without sound is silent rather than letting the next clip's sound play early.
      for (let t = o.offset; t < o.offset + o.len; t += SILENCE_US) audioFrames.push({ timestamp: t, key: true, data: SILENCE });
    }
  }
  // Tagged with the first clip's colours, as its frames are copied: untagged full-range
  // video stalls when seeked in Chrome.
  const source = first?.video;
  const colour = source && (source.colour || (() => { const c = sourceColourSpace(source); return c && outputColour(c); })());
  const blob = muxWebm({
    video: { codecId: spec.codecId, width: spec.width, height: spec.height, frames: out.flatMap((o) => o.video), ...(colour && { colour }) },
    audio: withSound ? {
      codecId: 'A_OPUS', sampleRate: 48000, channels,
      description: firstAudio?.description || opusHead(channels), frames: audioFrames,
    } : null,
  });
  audioFrames = null;
  return { blob, lostSound };
}

// ---------- video layers ----------

/** Matroska codecs the export worker decodes. */
const DECODES = new Set(['V_VP8', 'V_VP9', 'V_AV1', 'V_MPEG4/ISO/AVC']);

/**
 * A video to lay over the recording, as a WebM the export worker can read: a
 * Captode recording as it is, anything else encoded once (at most 1280 px, its
 * sound as Opus); only [from, from + len) of it is kept. Returns `{ blob, width,
 * height, duration, offset, len, sound }`: the layer plays `len` s of `blob` from
 * `offset`; sound: it has sound the export can mix in.
 */
export async function layerSource(blob, { from = 0, len = null, fps = 30, onProgress = () => {}, signal } = {}) {
  const info = await probeVideo(blob);
  len = Math.min(len ?? info.duration, info.duration - from);
  const d = await readWebm(blob);
  // As it is: the layer starts `offset` into it.
  if (d && DECODES.has(d.video.codecId)) return { blob, ...info, offset: from, len, sound: d.audio?.codecId === 'A_OPUS' && d.audio.frames.length > 0 };
  const k = Math.min(1, 1280 / Math.max(info.width, info.height));
  const [width, height] = [even(info.width * k), even(info.height * k)];
  let spec = null;
  for (const codecId of ['V_VP9', 'V_VP8']) {
    if (await encodable(ENCODE[codecId], width, height)) { spec = { codecId, codec: ENCODE[codecId], width, height }; break; }
  }
  if (!spec) throw new JoinError('unsupported');
  const frames = await encodeVideo(blob, from, len, spec, fps, onProgress, signal);
  const a = await encodeAudio(blob, from, len, 2);
  const audio = Array.isArray(a) && a.length ? { codecId: 'A_OPUS', sampleRate: 48000, channels: 2, description: opusHead(2), frames: a.filter((f) => f.timestamp < len * 1e6) } : null;
  return { blob: muxWebm({ video: { codecId: spec.codecId, width, height, frames }, audio }), width, height, duration: len, offset: 0, len, sound: !!audio };
}

// ---------- moving edits with their clips ----------

/**
 * Moves what is timed in the recording along with its clips. `moves`: [{ from, to, at }],
 * the part [from, to) of the old timeline now starting at `at`. A range is split at
 * the parts it covers; whatever was in no part (a removed clip) is left out. Things
 * marked `whole` (the whole recording) stay as they are.
 */
export function moveTimes({ edits = null, slides = [], clicks = [] }, moves) {
  const range = (r) => {
    if (r.whole) return [r];
    const out = [];
    for (const m of moves) {
      const a = Math.max(r.from, m.from), b = Math.min(r.to, m.to);
      if (b - a < 0.05) continue;
      const x = { ...r, id: out.length ? `${r.id}-${out.length}` : r.id, from: m.at + a - m.from, to: m.at + b - m.from };
      if (r.offset !== undefined) x.offset = r.offset + a - r.from; // a video layer carries on where it was
      out.push(x);
    }
    return out.sort((x, y) => x.from - y.from);
  };
  const list = (a) => (a || []).flatMap(range);
  const point = (t) => {
    const m = moves.find((x) => t >= x.from && t < x.to) || moves.find((x) => Math.abs(t - x.to) < 1e-3);
    return m ? m.at + t - m.from : null;
  };
  const e = edits && {
    ...edits,
    cuts: list(edits.cuts), speeds: list(edits.speeds), blurs: list(edits.blurs), zooms: list(edits.zooms),
    callouts: list(edits.callouts), captions: list(edits.captions), layers: list(edits.layers),
    audio: { ...edits.audio, mutes: list(edits.audio?.mutes) },
    chapters: (edits.chapters || []).flatMap((c) => { const at = point(c.at); return at === null ? [] : [{ ...c, at }]; }),
  };
  const s = (slides || []).flatMap((x) => {
    if (x.whole) return [x];
    const at = point(x.at);
    return at === null ? [] : [{ ...x, at: Math.round(at * 1000) / 1000 }];
  });
  const c = (clicks || []).flatMap((x) => {
    const t = point(x.t);
    return t === null ? [] : [{ ...x, t }];
  });
  return { edits: e, slides: s, clicks: c };
}

/**
 * Whether `blob` has to be encoded to be used: to join after `like` (null: as a
 * layer). Anything but a WebM the same as it (or, for a layer, one the export reads).
 */
export async function needsEncoding(blob, like = null) {
  const d = await readWebm(blob);
  if (!d) return true;
  if (!like) return !DECODES.has(d.video.codecId);
  const l = await readWebm(like);
  return !l || !ENCODE[l.video.codecId] || l.video.codecId !== d.video.codecId || l.video.width !== d.video.width || l.video.height !== d.video.height;
}

/** When the key frames of a WebM are (s), or [] for any other file. */
export async function keyTimes(blob) {
  const d = await readWebm(blob);
  return d ? d.video.frames.filter((f) => f.key).map((f) => f.timestamp / 1e6) : [];
}

/** The clips' start times on the joined timeline. */
export const clipStarts = (clips) => clips.reduce((a, c, i) => (a.push(i ? a[i - 1] + clips[i - 1].len : 0), a), []);

/**
 * A sound file (any the browser plays) as an audio-only WebM with Opus, for music
 * under the video. Returns `{ blob, duration }`, or a JoinError.
 */
export async function musicSource(blob) {
  let buf;
  try {
    buf = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new JoinError('unplayable');
  }
  const frames = await encodeAudio(blob, 0, buf.duration, 2);
  if (!Array.isArray(frames) || !frames.length) throw new JoinError('unsupported');
  return { blob: muxWebm({ video: null, audio: { codecId: 'A_OPUS', sampleRate: 48000, channels: 2, description: opusHead(2), frames } }), duration: buf.duration };
}
