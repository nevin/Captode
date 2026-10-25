// A small ZIP writer and reader: files are stored as they are (images and videos are
// compressed already), which every unzip tool and operating system opens. The reader
// reads only such stored files, as Captode writes them.
import { crc32 } from './png.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function build(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  // MS-DOS time and date, as ZIP stores them.
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of entries) {
    const name = enc.encode(f.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, f.crc, true);
    local.setUint32(18, f.size, true);
    local.setUint32(22, f.size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, f.crc, true);
    c.setUint32(20, f.size, true);
    c.setUint32(24, f.size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.size;
  }
  if (offset > 0xffffffff) throw new Error('Too large for a zip file (4 GB).');
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** `files`: [{ name, data: Uint8Array }]. Returns a Blob of type application/zip. */
export function zip(files) {
  return build(files.map((f) => ({ name: f.name, data: f.data, size: f.data.length, crc: crc32(f.data) })));
}

/**
 * As zip, but `data` may also be a Blob, read a piece at a time and not copied into
 * the zip (a long recording is hundreds of MB).
 */
export async function zipBlobs(files) {
  const entries = [];
  for (const f of files) {
    if (!(f.data instanceof Blob)) { entries.push({ name: f.name, data: f.data, size: f.data.length, crc: crc32(f.data) }); continue; }
    let crc = 0;
    for (let at = 0; at < f.data.size; at += 8 << 20) crc = crc32(new Uint8Array(await f.data.slice(at, at + (8 << 20)).arrayBuffer()), crc);
    entries.push({ name: f.name, data: f.data, size: f.data.size, crc });
  }
  return build(entries);
}

/**
 * The files in a zip of stored files: Map name → Blob (slices of `blob`, not copies).
 * Throws if it isn't a zip, or holds compressed or encrypted files.
 */
export async function unzip(blob) {
  const tail = new DataView(await blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const count = tail.getUint16(end + 10, true);
  const dirSize = tail.getUint32(end + 12, true);
  const dirAt = tail.getUint32(end + 16, true);
  if (dirAt + dirSize > blob.size) throw new Error('not a zip file');
  const dir = new DataView(await blob.slice(dirAt, dirAt + dirSize).arrayBuffer());
  const out = new Map();
  for (let i = 0, p = 0; i < count; i++) {
    if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== 0x02014b50) throw new Error('damaged zip file');
    const flags = dir.getUint16(p + 8, true), method = dir.getUint16(p + 10, true);
    const size = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true), extraLen = dir.getUint16(p + 30, true), noteLen = dir.getUint16(p + 32, true);
    const at = dir.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(dir.buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + noteLen;
    if (method !== 0 || flags & 1) throw new Error('compressed or encrypted zip');
    const head = new DataView(await blob.slice(at, at + 30).arrayBuffer());
    if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw new Error('damaged zip file');
    const start = at + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    if (start + size > blob.size) throw new Error('damaged zip file');
    out.set(name, blob.slice(start, start + size));
  }
  return out;
}
