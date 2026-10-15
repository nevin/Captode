// Draws the TabReel icon (capture brackets around a record dot on a violet-to-coral
// square) at every size the extension and the stores need. No dependencies.
//   node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const A = [0x7b, 0x5c, 0xff];
const B = [0xff, 0x4d, 0x6d];

// Signed distance to a rounded box centred at the origin.
function sdRoundBox(x, y, hw, hh, r) {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Coverage of one sample point, in a unit square from -1 to 1.
function sample(x, y) {
  const bg = sdRoundBox(x, y, 1, 1, 0.42) <= 0;
  if (!bg) return null;
  const t = (x + y + 2) / 4;
  let col = A.map((a, i) => a + (B[i] - a) * t);

  // Corner brackets
  const w = 0.11;     // stroke width
  const e = 0.58;     // bracket position
  const len = 0.3;    // arm length
  let white = false;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const px = x * sx, py = y * sy; // fold into the bottom-right corner
      const inH = py >= e - w && py <= e && px >= e - len && px <= e;
      const inV = px >= e - w && px <= e && py >= e - len && py <= e;
      if (inH || inV) white = true;
    }
  }
  // Record dot
  if (Math.hypot(x, y) <= 0.27) white = true;
  if (white) col = [255, 255, 255];
  return col;
}

function render(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const x = ((i + (si + 0.5) / ss) / size) * 2 - 1;
          const y = ((j + (sj + 0.5) / ss) / size) * 2 - 1;
          const c = sample(x * 1.02, y * 1.02);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = (j * size + i) * 4;
      const n = ss * ss;
      if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; }
      px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, size, px);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = (p, buf) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf); };
for (const s of [16, 32, 48, 128]) out(join(root, 'src/icons', `icon${s}.png`), render(s));
out(join(root, 'store/icon-300.png'), render(300));
out(join(root, 'docs/logo.png'), render(256));
console.log('icons written');
