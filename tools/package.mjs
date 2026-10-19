// Builds, in dist/, a package for each browser (see tools/targets.mjs):
//   captode-<version>-chrome.zip    Chrome Web Store
//   captode-<version>-edge.zip      Microsoft Edge Add-ons
//   captode-<version>-firefox.zip   addons.mozilla.org
//   captode-<version>-safari/       for Xcode's Safari web extension converter
//   captode-<version>-source.zip    the source, which addons.mozilla.org asks for (the
//                                   packages hold WebAssembly)
// Each holds only its own browser's manifest and settings; the build stops if one
// mentions another browser's store, ID or pages. Zips are written here (deflate from
// Node's zlib), so this works the same on Windows, macOS and Linux without a `zip` tool.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deflateRawSync, crc32 } from 'node:zlib';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, manifestFor, targetModule, leaks } from './targets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
const { version } = manifest;
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Every file under `dir`, sorted so zips come out the same each time. */
function walk(dir, files = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (SKIP.has(name)) continue;
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

/** Writes a zip of `entries` ([name, Buffer]) to dist/`file`. */
function writeZip(file, entries) {
  // A fixed timestamp keeps the zip identical from build to build.
  const DOS_TIME = 0, DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;
  const local = [];
  const central = [];
  let offset = 0;
  for (const [entryName, data] of entries) {
    const name = Buffer.from(entryName);
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
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  const out = join(root, 'dist', file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.concat([...local, ...central, end]));
  console.log(`wrote ${out} (${entries.length} files)`);
}

const files = walk(src).map((path) => [relative(src, path).split(sep).join('/'), readFileSync(path)]);
// The GPL goes with every copy of Captode: each package carries its licence.
files.push(['LICENSE', readFileSync(join(root, 'LICENSE'))]);
const only = process.argv[2]; // one browser, or all of them

let failed = false;
for (const [id, target] of Object.entries(TARGETS)) {
  if (only && only !== id) continue;
  const own = {
    'manifest.json': Buffer.from(`${JSON.stringify(manifestFor(id, manifest), null, 2)}\n`),
    'lib/target.js': Buffer.from(targetModule(id)),
  };
  // Files this browser's package replaces or leaves out (see tools/targets.mjs).
  for (const [name, from] of Object.entries(target.files?.replace || {})) own[name] = readFileSync(join(root, from));
  const drop = new Set(target.files?.drop || []);
  const pkg = files.filter(([name]) => !drop.has(name)).map(([name, data]) => [name, own[name] || data]);
  const found = leaks(id, pkg);
  if (found.length) {
    failed = true;
    for (const [name, what] of found) console.error(`${id}: ${name} mentions ${what}`);
    continue;
  }
  if (target.file) {
    writeZip(target.file(version), pkg);
  } else {
    const out = join(root, 'dist', target.folder(version));
    rmSync(out, { recursive: true, force: true });
    for (const [name, data] of pkg) {
      mkdirSync(dirname(join(out, name)), { recursive: true });
      writeFileSync(join(out, name), data);
    }
    console.log(`wrote ${out} (${pkg.length} files)`);
  }
}
if (failed) {
  console.error('package: a package mentions another browser; see above');
  process.exit(1);
}

// The source zip comes from the repository; a copy made from that zip has no git to ask.
if (!only && existsSync(join(root, '.git'))) {
  // The source: the files git tracks, as committed or changed, nothing downloaded or built.
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => f && existsSync(join(root, f)));
  writeZip(`captode-${version}-source.zip`, tracked.sort().map((f) => [f, readFileSync(join(root, f))]));
}
