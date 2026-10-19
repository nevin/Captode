// Colour spaces of recorded video. Chrome's recorder converts the screen's RGB to
// video's YUV with the BT.601 matrix and says so in each VP9 key frame, which the
// video player follows. WebCodecs' decoder ignores it and assumes BT.709, which
// shifts colours (pure green comes back 40 levels darker), so exports tell the
// decoder what the recording says.

// VP9's colour_space values (VP9 bitstream spec, 7.2.2).
const VP9_MATRIX = ['smpte170m', 'smpte170m', 'bt709', 'smpte170m', 'smpte240m', 'bt2020-ncl', null, 'rgb'];

/**
 * The colour space a VP9 key frame declares, or null if `data` isn't a key frame
 * with the sync code where it should be.
 */
export function vp9ColourSpace(data) {
  let bit = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  if (data.length < 6 || read(2) !== 2) return null; // frame_marker
  const profile = read(1) | (read(1) << 1);
  if (profile === 3) read(1);
  if (read(1)) return null; // show_existing_frame
  if (read(1) !== 0) return null; // not a key frame
  read(2); // show_frame, error_resilient_mode
  if (read(24) !== 0x498342) return null; // sync code
  if (profile >= 2) read(1); // bit depth
  const matrix = VP9_MATRIX[read(3)];
  if (!matrix || matrix === 'rgb') return null; // RGB video needs no conversion
  return { matrix, fullRange: !!read(1) };
}

/**
 * The colour space to decode `video` (from demuxWebm) with: its own when it says,
 * BT.601 for VP8 (the only one VP8 has), else null to leave it to the decoder.
 * Recordings are of screens, so the primaries and transfer are sRGB's.
 */
export function sourceColourSpace(video) {
  let found = null;
  if (video.codecId === 'V_VP9') {
    const key = video.frames.find((f) => f.key);
    found = key && vp9ColourSpace(key.data);
  } else if (video.codecId === 'V_VP8') {
    found = { matrix: 'smpte170m', fullRange: false };
  }
  return found && { primaries: 'bt709', transfer: 'iec61966-2-1', ...found };
}

// Code points for colour spaces in MP4 'colr' boxes and WebM Colour elements
// (ITU-T H.273), by WebCodecs name.
const PRIMARIES = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const TRANSFER = { bt709: 1, smpte170m: 6, linear: 8, 'iec61966-2-1': 13, pq: 16, hlg: 18 };
const MATRIX = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };

/**
 * The colour tag to write for video encoded from screen pictures: sRGB's primaries
 * and transfer, and the matrix and range the encoder used (from its decoder config;
 * Chrome's encoders use BT.709 when they don't say). Without a tag, players guess,
 * and QuickTime guesses a TV gamma that lightens and washes out screen recordings.
 */
export function outputColour(encoded) {
  return {
    primaries: PRIMARIES.bt709,
    transfer: TRANSFER['iec61966-2-1'],
    matrix: MATRIX[encoded?.matrix] ?? MATRIX.bt709,
    fullRange: !!encoded?.fullRange,
  };
}
