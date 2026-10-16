// WebM (Matroska) reading and writing: enough to take apart the files MediaRecorder
// makes and to write new ones from WebCodecs output.

// ---------- reading ----------

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa, SeekPreRoll: 0x56bb,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Colour: 0x55b0, MatrixCoefficients: 0x55b1, Range: 0x55b9, TransferCharacteristics: 0x55ba, Primaries: 0x55bb, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb,
  SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac, Cues: 0x1c53bb6b, CuePoint: 0xbb,
  CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1, TrackUID: 0x73c5,
  MuxingApp: 0x4d80, WritingApp: 0x5741, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
};

// Containers we step into rather than skip. Their sizes may be "unknown" (live
// recordings), so children are read in place until the data runs out.
const CONTAINERS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio, ID.Cluster, ID.BlockGroup]);

/** A video or audio codec string WebCodecs understands, from a Matroska CodecID. */
const CODECS = {
  V_VP8: 'vp8', V_VP9: 'vp09.00.10.08', V_AV1: 'av01.0.04M.08', 'V_MPEG4/ISO/AVC': 'avc1.42E01F',
  A_OPUS: 'opus', A_VORBIS: 'vorbis',
};

function readVint(b, p, keepMarker) {
  const first = b[p];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('Damaged WebM data');
  let v = keepMarker ? first : first & (0xff >> len);
  let unknown = v === (0xff >> len);
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[p + i];
    if (b[p + i] !== 0xff) unknown = false;
  }
  return { value: v, len, unknown: !keepMarker && unknown };
}

const readUint = (b, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };
const readFloat = (b, p, n) => {
  const v = new DataView(b.buffer, b.byteOffset + p, n);
  return n === 4 ? v.getFloat32(0) : v.getFloat64(0);
};
const readStr = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n)).replace(/\0+$/, '');

/**
 * Splits a WebM file into its tracks and their frames.
 * Returns `{ video, audio, duration }`: each track has `codec`, its settings and
 * `frames: [{ timestamp (µs), key, data }]` in file order.
 */
export function demuxWebm(buffer) {
  const b = new Uint8Array(buffer);
  let scale = 1e6; // nanoseconds per timecode tick
  let durationTicks = 0;
  const tracks = new Map();
  let track = null;
  let cluster = 0;
  let group = null;

  const addBlock = (p, end, simple) => {
    const tn = readVint(b, p, false);
    const t = tracks.get(tn.value);
    let q = p + tn.len;
    const rel = (b[q] << 24 >> 16) | b[q + 1]; // signed 16-bit
    const flags = b[q + 2];
    q += 3;
    if (flags & 0x06) throw new Error('Laced WebM blocks are not supported');
    if (!t) return null;
    const frame = { timestamp: Math.round(((cluster + rel) * scale) / 1000), key: simple ? !!(flags & 0x80) : true, data: b.slice(q, end) };
    t.frames.push(frame);
    return frame;
  };

  let p = 0;
  while (p < b.length) {
    if (p + 2 > b.length) break;
    const id = readVint(b, p, true);
    const size = readVint(b, p + id.len, false);
    const start = p + id.len + size.len;
    const end = size.unknown ? b.length : Math.min(b.length, start + size.value);
    if (CONTAINERS.has(id.value)) {
      if (id.value === ID.TrackEntry) {
        track = { number: 0, type: 0, codecId: '', private: null, width: 0, height: 0, sampleRate: 48000, channels: 1, frames: [] };
        // Read the entry's fields now; it is short and always has a known size.
        let q = start;
        while (q < end) {
          const cid = readVint(b, q, true);
          const cs = readVint(b, q + cid.len, false);
          const cstart = q + cid.len + cs.len;
          parseTrackField(track, cid.value, b, cstart, cs.value);
          q = cstart + cs.value;
        }
        if (track.number) tracks.set(track.number, track);
        p = end;
        continue;
      }
      if (id.value === ID.BlockGroup) group = { end };
      p = start;
      continue;
    }
    switch (id.value) {
      case ID.TimecodeScale: scale = readUint(b, start, size.value); break;
      case ID.Duration: durationTicks = readFloat(b, start, size.value); break;
      case ID.Timecode: cluster = readUint(b, start, size.value); break;
      case ID.SimpleBlock: addBlock(start, end, true); break;
      case ID.Block: if (group) group.frame = addBlock(start, end, false); break;
      case ID.ReferenceBlock: if (group?.frame) group.frame.key = false; break;
      default: break;
    }
    p = end;
  }

  const out = { video: null, audio: null, duration: (durationTicks * scale) / 1e9 };
  for (const t of tracks.values()) {
    const codec = CODECS[t.codecId];
    if (t.type === 1 && !out.video) {
      out.video = { codec, codecId: t.codecId, width: t.width, height: t.height, description: t.private, frames: t.frames };
    } else if (t.type === 2 && !out.audio) {
      out.audio = { codec, codecId: t.codecId, sampleRate: t.sampleRate, channels: t.channels, description: t.private, frames: t.frames };
    }
  }
  if (out.video && !out.duration) {
    const f = out.video.frames;
    out.duration = f.length ? (f[f.length - 1].timestamp - f[0].timestamp) / 1e6 : 0;
  }
  return out;
}

function parseTrackField(t, id, b, p, n) {
  switch (id) {
    case ID.TrackNumber: t.number = readUint(b, p, n); break;
    case ID.TrackType: t.type = readUint(b, p, n); break;
    case ID.CodecID: t.codecId = readStr(b, p, n); break;
    case ID.CodecPrivate: t.private = b.slice(p, p + n); break;
    case ID.Video:
    case ID.Audio: {
      let q = p;
      while (q < p + n) {
        const cid = readVint(b, q, true);
        const cs = readVint(b, q + cid.len, false);
        parseTrackField(t, cid.value, b, q + cid.len + cs.len, cs.value);
        q += cid.len + cs.len + cs.value;
      }
      break;
    }
    case ID.PixelWidth: t.width = readUint(b, p, n); break;
    case ID.PixelHeight: t.height = readUint(b, p, n); break;
    case ID.SamplingFrequency: t.sampleRate = readFloat(b, p, n); break;
    case ID.Channels: t.channels = readUint(b, p, n); break;
    default: break;
  }
}

// ---------- writing ----------

const enc = new TextEncoder();

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
  return out;
}

function sizeBytes(n, width = 0) {
  let len = width || 1;
  while (!width && n >= 2 ** (7 * len) - 1) len++;
  const out = new Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

const concat = (parts) => {
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of parts) { out.set(a, o); o += a.length; }
  return out;
};

/** An element: `body` is bytes, a string, a number (unsigned) or a list of elements. */
function el(id, body, { float = false, sizeWidth = 0, uintWidth = 0 } = {}) {
  let data;
  if (body instanceof Uint8Array) data = body;
  else if (Array.isArray(body)) data = concat(body);
  else if (typeof body === 'string') data = enc.encode(body);
  else if (float) { data = new Uint8Array(8); new DataView(data.buffer).setFloat64(0, body); }
  else {
    const bytes = [];
    for (let v = body; v > 0 || !bytes.length; v = Math.floor(v / 256)) bytes.unshift(v & 255);
    while (uintWidth && bytes.length < uintWidth) bytes.unshift(0);
    data = new Uint8Array(bytes);
  }
  return concat([new Uint8Array(idBytes(id)), new Uint8Array(sizeBytes(data.length, sizeWidth)), data]);
}

/**
 * Builds a WebM file from encoded chunks.
 * `video`: `{ codecId, width, height, frames, colour? }` (colour as for MP4); `audio` (optional):
 * `{ codecId, sampleRate, channels, description, frames }`. Frames are
 * `{ timestamp (µs), key, data }` in decode order.
 */
export function muxWebm({ video, audio = null }) {
  const ms = (us) => Math.round(us / 1000);
  const tracks = [
    el(ID.TrackEntry, [
      el(ID.TrackNumber, 1), el(ID.TrackUID, 1), el(ID.TrackType, 1), el(ID.CodecID, video.codecId),
      el(ID.Video, [el(ID.PixelWidth, video.width), el(ID.PixelHeight, video.height),
        ...(video.colour ? [el(ID.Colour, [
          el(ID.MatrixCoefficients, video.colour.matrix), el(ID.Range, video.colour.fullRange ? 2 : 1),
          el(ID.TransferCharacteristics, video.colour.transfer), el(ID.Primaries, video.colour.primaries),
        ])] : [])]),
    ]),
  ];
  if (audio) {
    tracks.push(el(ID.TrackEntry, [
      el(ID.TrackNumber, 2), el(ID.TrackUID, 2), el(ID.TrackType, 2), el(ID.CodecID, audio.codecId),
      ...(audio.description ? [el(ID.CodecPrivate, new Uint8Array(audio.description))] : []),
      ...(audio.codecId === 'A_OPUS' ? [el(ID.SeekPreRoll, 80_000_000)] : []),
      el(ID.Audio, [el(ID.SamplingFrequency, audio.sampleRate, { float: true }), el(ID.Channels, audio.channels)]),
    ]));
  }

  // Interleave both tracks by time, and start a new cluster at each video key
  // frame (and at least every 5 s, so relative block times fit in 16 bits).
  const all = video.frames.map((f) => ({ ...f, track: 1 }));
  if (audio) all.push(...audio.frames.map((f) => ({ ...f, key: true, track: 2 })));
  all.sort((a, b) => a.timestamp - b.timestamp || a.track - b.track);
  const clusters = [];
  let cur = null;
  for (const f of all) {
    const t = ms(f.timestamp);
    if (!cur || (f.track === 1 && f.key && t > cur.time) || t - cur.time > 5000) {
      cur = { time: t, blocks: [], key: f.track === 1 && f.key };
      clusters.push(cur);
    }
    const head = new Uint8Array([0x80 | f.track, ((t - cur.time) >> 8) & 255, (t - cur.time) & 255, f.key ? 0x80 : 0]);
    cur.blocks.push(el(ID.SimpleBlock, concat([head, f.data])));
  }
  const clusterBytes = clusters.map((c) => el(ID.Cluster, [el(ID.Timecode, c.time), ...c.blocks]));
  const last = all.length ? all[all.length - 1] : null;
  const durationMs = last ? ms(last.timestamp + (last.duration || 0)) : 0;

  const info = el(ID.Info, [
    el(ID.TimecodeScale, 1_000_000), el(ID.MuxingApp, 'Captode'), el(ID.WritingApp, 'Captode'),
    el(ID.Duration, durationMs, { float: true }),
  ]);
  const tracksEl = el(ID.Tracks, tracks);

  // Cues let players seek straight to key frames. Positions are written at a fixed
  // width so the layout can be worked out before the values are known.
  const seekHeadSize = (n) => el(ID.SeekHead, Array.from({ length: n }, () =>
    el(ID.Seek, [el(ID.SeekID, new Uint8Array(4)), el(ID.SeekPosition, 0, { uintWidth: 8 })]))).length;
  const shSize = seekHeadSize(3);
  const cueFor = (pos) => clusters
    .map((c, i) => [c, pos[i]])
    .filter(([c]) => c.key)
    .map(([c, at]) => el(ID.CuePoint, [el(ID.CueTime, c.time),
      el(ID.CueTrackPositions, [el(ID.CueTrack, 1), el(ID.CueClusterPosition, at, { uintWidth: 8 })])]));
  const cuesLen = el(ID.Cues, cueFor(clusters.map(() => 0))).length;
  const firstCluster = shSize + info.length + tracksEl.length + cuesLen;
  const positions = [];
  let at = firstCluster;
  for (const c of clusterBytes) { positions.push(at); at += c.length; }
  const cues = el(ID.Cues, cueFor(positions));
  const seek = (id, pos) => el(ID.Seek, [el(ID.SeekID, new Uint8Array(idBytes(id))), el(ID.SeekPosition, pos, { uintWidth: 8 })]);
  const seekHead = el(ID.SeekHead, [
    seek(ID.Info, shSize), seek(ID.Tracks, shSize + info.length), seek(ID.Cues, shSize + info.length + tracksEl.length),
  ]);

  const header = el(ID.EBML, [
    el(ID.EBMLVersion, 1), el(ID.EBMLReadVersion, 1), el(ID.EBMLMaxIDLength, 4), el(ID.EBMLMaxSizeLength, 8),
    el(ID.DocType, 'webm'), el(ID.DocTypeVersion, 4), el(ID.DocTypeReadVersion, 2),
  ]);
  const body = [seekHead, info, tracksEl, cues, ...clusterBytes];
  const bodyLen = body.reduce((n, a) => n + a.length, 0);
  const segHead = concat([new Uint8Array(idBytes(ID.Segment)), new Uint8Array(sizeBytes(bodyLen, 8))]);
  return new Blob([header, segHead, ...body], { type: audio ? 'video/webm' : 'video/webm' });
}
