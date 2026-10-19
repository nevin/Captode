// MP4 writer for WebCodecs output: H.264 video and, optionally, AAC or Opus audio.
// The index (moov) goes before the media data, so players can start straight away.

const enc = new TextEncoder();

const concat = (parts) => {
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of parts) { out.set(a, o); o += a.length; }
  return out;
};

const u8 = (v) => [v & 255];
const u16 = (v) => [(v >> 8) & 255, v & 255];
const u32 = (v) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
const s32 = (v) => u32(v >>> 0);
const str = (s) => [...enc.encode(s)];
const zeros = (n) => new Array(n).fill(0);

function box(type, ...parts) {
  const body = concat(parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
  return concat([new Uint8Array([...u32(8 + body.length), ...str(type)]), body]);
}
const full = (type, version, flags, ...parts) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);

const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

/** Run-length table of sample durations. */
function stts(durations) {
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  return full('stts', 0, 0, u32(runs.length), ...runs.map(([n, d]) => [...u32(n), ...u32(d)]));
}

/**
 * One track's sample tables. Samples are `{ timestamp (µs), duration (µs), key, data }`
 * in decode order; `timescale` is ticks per second.
 */
function sampleTables(samples, timescale, chunkOffset, sampleEntry, isVideo) {
  const tick = (us) => Math.round((us * timescale) / 1e6);
  // Decode times run in order; presentation times may not (B-frames), which
  // composition offsets (ctts) record.
  const pts = samples.map((s) => tick(s.timestamp));
  const dts = [...pts].sort((a, b) => a - b);
  const offsets = pts.map((p, i) => p - dts[i]);
  const durations = samples.map((s, i) => (i + 1 < samples.length ? dts[i + 1] - dts[i] : Math.max(1, tick(s.duration || 0))));
  const parts = [
    full('stsd', 0, 0, u32(1), sampleEntry),
    stts(durations),
  ];
  if (offsets.some((o) => o !== 0)) {
    parts.push(full('ctts', 1, 0, u32(offsets.length), ...offsets.map((o) => [...u32(1), ...s32(o)])));
  }
  if (isVideo && samples.some((s) => !s.key)) {
    const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    parts.push(full('stss', 0, 0, u32(keys.length), ...keys.map((k) => u32(k))));
  }
  parts.push(
    full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1)), // every sample in one chunk
    full('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))),
    full('stco', 0, 0, u32(1), u32(chunkOffset)),
  );
  const total = durations.reduce((a, b) => a + b, 0);
  return { stbl: box('stbl', ...parts), duration: total };
}

/** The colour tag (`{ primaries, transfer, matrix, fullRange }` as H.273 numbers). */
const colr = (c) => box('colr', str('nclx'), u16(c.primaries), u16(c.transfer), u16(c.matrix), u8(c.fullRange ? 0x80 : 0));

function avc1Entry(width, height, avcC, colour) {
  return box('avc1',
    zeros(6), u16(1), // reserved, data reference index
    zeros(16), u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), // 72 dpi, one frame per sample
    zeros(32), u16(0x0018), u16(0xffff),
    box('avcC', avcC),
    ...(colour ? [colr(colour)] : []));
}

/** An MPEG-4 descriptor: tag, length (four-byte form), body. */
const descriptor = (tag, body) => [tag, 0x80, 0x80, 0x80, body.length, ...body];

function mp4aEntry(sampleRate, channels, asc, bitrate) {
  const dsi = descriptor(0x05, [...asc]);
  const dcd = descriptor(0x04, [0x40, 0x15, 0, 0, 0, ...u32(bitrate), ...u32(bitrate), ...dsi]);
  const es = descriptor(0x03, [...u16(0), 0, ...dcd, ...descriptor(0x06, [0x02])]);
  return box('mp4a',
    zeros(6), u16(1),
    zeros(8), u16(channels), u16(16), zeros(4),
    u32(Math.round(sampleRate) * 65536),
    full('esds', 0, 0, es));
}

/**
 * The Opus sample entry, with its dOps box built from the stream's OpusHead
 * (little-endian there, big-endian in MP4).
 */
function opusEntry(channels, opusHead) {
  const h = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
  const family = h.getUint8(18);
  const dops = [
    0, h.getUint8(9), // version, output channels
    ...u16(h.getUint16(10, true)), // pre-skip
    ...u32(h.getUint32(12, true)), // input sample rate
    ...u16(h.getUint16(16, true)), // output gain
    family,
    ...(family ? [...new Uint8Array(opusHead.buffer, opusHead.byteOffset + 19, opusHead.byteLength - 19)] : []),
  ];
  return box('Opus',
    zeros(6), u16(1),
    zeros(8), u16(channels), u16(16), zeros(4),
    u32(48000 * 65536),
    box('dOps', dops));
}

/**
 * An edit list that starts the track `delay` (movie ticks) into the movie: used
 * when audio begins a little after the video and can't be padded with silence.
 */
function edts(delay, duration) {
  return box('edts', full('elst', 0, 0, u32(2),
    u32(delay), s32(-1), u16(1), u16(0), // empty edit: nothing plays for `delay`
    u32(duration), u32(0), u16(1), u16(0)));
}

function trak(id, kind, { width = 0, height = 0, timescale, stbl, mediaDuration, movieDuration, delay = 0 }) {
  const video = kind === 'video';
  return box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8),
      u16(0), u16(video ? 0 : 1), u16(video ? 0 : 0x0100), u16(0), MATRIX,
      u32(width * 65536), u32(height * 65536)),
    ...(delay > 0 ? [edts(delay, movieDuration)] : []),
    box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0)), // language "und"
      full('hdlr', 0, 0, u32(0), str(video ? 'vide' : 'soun'), zeros(12), str(video ? 'VideoHandler' : 'SoundHandler'), [0]),
      box('minf',
        video ? full('vmhd', 0, 1, zeros(8)) : full('smhd', 0, 0, zeros(4)),
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
        stbl)));
}

/**
 * Builds an MP4 from encoded chunks.
 * `video`: `{ width, height, avcC, frames, colour? }` (avcC is the encoder's decoder
 * description); `audio` (optional): AAC `{ sampleRate, channels, asc, bitrate, frames }`
 * or Opus `{ codec: 'opus', channels, opusHead, frames }`.
 */
export function muxMp4({ video, audio = null }) {
  // The frames go into the file as they are (a Blob copies its parts once), rather
  // than joined into one array first, which would hold the whole video twice more.
  const vData = video.frames.map((f) => f.data);
  const aData = audio ? audio.frames.map((f) => f.data) : [];
  const vLen = vData.reduce((n, d) => n + d.length, 0);
  const aLen = aData.reduce((n, d) => n + d.length, 0);
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const VTS = 90000;

  // The moov box's size doesn't depend on the chunk offsets' values, so build it
  // once to measure, then again with the real offsets.
  const build = (vOffset, aOffset) => {
    const v = sampleTables(video.frames, VTS, vOffset, avc1Entry(video.width, video.height, video.avcC, video.colour), true);
    const entry = audio?.codec === 'opus'
      ? opusEntry(audio.channels, audio.opusHead)
      : audio && mp4aEntry(audio.sampleRate, audio.channels, audio.asc, audio.bitrate);
    const a = audio ? sampleTables(audio.frames, audio.sampleRate, aOffset, entry, false) : null;
    // Sample tables start at zero; a later first sample becomes an edit-list delay.
    const aDelay = audio ? Math.round(Math.max(0, audio.frames[0]?.timestamp || 0) / 1000) : 0;
    const movieMs = Math.max(Math.round((v.duration / VTS) * 1000), a ? Math.round((a.duration / audio.sampleRate) * 1000) + aDelay : 0);
    const traks = [trak(1, 'video', { width: video.width, height: video.height, timescale: VTS, stbl: v.stbl, mediaDuration: v.duration, movieDuration: Math.round((v.duration / VTS) * 1000) })];
    if (a) traks.push(trak(2, 'audio', { timescale: audio.sampleRate, stbl: a.stbl, mediaDuration: a.duration, movieDuration: Math.round((a.duration / audio.sampleRate) * 1000), delay: aDelay }));
    return box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieMs), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(audio ? 3 : 2)),
      ...traks);
  };
  const moovLen = build(0, 0).length;
  const mdatStart = ftyp.length + moovLen + 8;
  const moov = build(mdatStart, mdatStart + vLen);
  const mdatHead = new Uint8Array([...u32(8 + vLen + aLen), ...str('mdat')]);
  return new Blob([ftyp, moov, mdatHead, ...vData, ...aData], { type: 'video/mp4' });
}
