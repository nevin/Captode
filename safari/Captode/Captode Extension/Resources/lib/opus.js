// Opus packets: what an export needs beyond copying them as they are.

/** 20 ms of silence: a CELT-only, mono Opus packet (decoders turn it into as many channels as the stream has). */
export const SILENCE = new Uint8Array([0xf8, 0xff, 0xfe]);
export const SILENCE_US = 20000;

/**
 * Fills gaps between Opus packets (`{ timestamp, duration }`, µs), such as the one an
 * inserted slide leaves, with silent packets. Players and decoders go by the packets
 * rather than their times, and would otherwise play the sound after a gap too early.
 * Gaps under 20 ms are left: recordings have those anyway.
 */
export function fillOpusGaps(frames) {
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    out.push(f);
    const next = frames[i + 1];
    if (!next) break;
    let t = f.timestamp + f.duration;
    for (; next.timestamp - t >= SILENCE_US; t += SILENCE_US) out.push({ timestamp: t, duration: SILENCE_US, key: true, data: SILENCE });
  }
  return out;
}
