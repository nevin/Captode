// Builds dist/captode-<version>.zip, ready to upload to the Chrome Web Store and
// Microsoft Edge Add-ons. Writes the zip itself (deflate from Node's zlib), so it
// works the same on Windows, macOS and Linux without a `zip` tool.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const { version } = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `captode-${version}.zip`);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})(src);

// A fixed timestamp keeps the zip identical from build to build.
const DOS_TIME = 0, DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;
const local = [];
const central = [];
let offset = 0;
for (const path of files) {
  const name = Buffer.from(relative(src, path).split(sep).join('/'));
  const data = readFileSync(path);
  const packed = deflateRawSync(data, { level: 9 });
  const stored = packed.length >= data.length; // don't deflate what doesn't shrink (e.g. PNG)
  const body = stored ? data : packed;
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(stored ? 0 : 8, 8);
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  local.push(head, name, body);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(stored ? 0 : 8, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += head.length + name.length + body.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`wrote ${out} (${files.length} files)`);
