// Marks exported images as sRGB, the colours the page was drawn in. Without a mark,
// apps choose for themselves: most assume sRGB, but some (design tools set to a wide
// gamut, some print and PDF workflows) assume their own colour space and show the
// colours shifted.
import { chunk } from './png.js';

const b64 = 'AAAB2AAAAAAEMAAAbW50clJHQiBYWVogB+AAAQABAAAAAAAAYWNzcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAPbWAAEAAAAA0y0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAAAkY3BydAAAARQAAABMd3RwdAAAAWAAAAAUclhZWgAAAXQAAAAUZ1hZWgAAAYgAAAAUYlhZWgAAAZwAAAAUclRSQwAAAbAAAAAoZ1RSQwAAAbAAAAAoYlRSQwAAAbAAAAAobWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAwAAAAHABOAG8AIABjAG8AcAB5AHIAaQBnAGgAdAAsACAAdQBzAGUAIABmAHIAZQBlAGwAeVhZWiAAAAAAAAD21gABAAAAANMtWFlaIAAAAAAAAG+iAAA49QAAA5BYWVogAAAAAAAAYpkAALeFAAAY2lhZWiAAAAAAAAAkoAAAD4QAALbPcGFyYQAAAAAABAAAAAJmZgAA8qcAAA1ZAAAT0AAAClsAAAAAAAAAAA==';

/** An ICC v4 sRGB profile (632 base64 characters, 472 bytes). */
export const SRGB_ICC = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const has = (bytes, type) => {
  for (let p = 8; p + 8 <= bytes.length;) {
    const len = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    const t = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (t === type) return true;
    if (t === 'IDAT') return false; // colour chunks come before the image data
    p += 12 + len;
  }
  return false;
};

/** A PNG with an sRGB chunk after its header, unless it already says its colours. */
export function tagPng(bytes) {
  if (has(bytes, 'sRGB') || has(bytes, 'iCCP')) return bytes;
  const at = 8 + 25; // signature, then IHDR (13 bytes of data)
  const tag = chunk('sRGB', new Uint8Array([0])); // rendering intent: perceptual
  const out = new Uint8Array(bytes.length + tag.length);
  out.set(bytes.subarray(0, at));
  out.set(tag, at);
  out.set(bytes.subarray(at), at + tag.length);
  return out;
}

/** A JPEG with the sRGB profile (an APP2 segment), unless it already has a profile. */
export function tagJpeg(bytes) {
  let p = 2;
  // Past the start marker and any JFIF/Exif segments, before anything else.
  while (p + 4 <= bytes.length && bytes[p] === 0xff && (bytes[p + 1] === 0xe0 || bytes[p + 1] === 0xe1)) {
    p += 2 + ((bytes[p + 2] << 8) | bytes[p + 3]);
  }
  for (let q = 2; q + 4 <= bytes.length && bytes[q] === 0xff && bytes[q + 1] >= 0xe0 && bytes[q + 1] <= 0xef;) {
    if (bytes[q + 1] === 0xe2 && String.fromCharCode(...bytes.subarray(q + 4, q + 15)) === 'ICC_PROFILE') return bytes;
    q += 2 + ((bytes[q + 2] << 8) | bytes[q + 3]);
  }
  const id = new TextEncoder().encode('ICC_PROFILE\0');
  const len = 2 + id.length + 2 + SRGB_ICC.length;
  const seg = new Uint8Array(2 + len);
  seg.set([0xff, 0xe2, len >> 8, len & 255]);
  seg.set(id, 4);
  seg.set([1, 1], 4 + id.length); // part 1 of 1
  seg.set(SRGB_ICC, 6 + id.length);
  const out = new Uint8Array(bytes.length + seg.length);
  out.set(bytes.subarray(0, p));
  out.set(seg, p);
  out.set(bytes.subarray(p), p + seg.length);
  return out;
}
