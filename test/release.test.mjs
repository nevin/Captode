// The release script, run for real in a throwaway copy of the project: it refuses what
// Chrome or git would reject, and otherwise sets the version, builds the zip and tags.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { ok } from './helpers.mjs';
import { valid, compare, bump } from '../tools/release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A git repository holding Captode's files, with v1.2.0 tagged. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'captode-release-'));
  for (const p of ['src', 'tools', 'package.json', 'package-lock.json']) cpSync(join(root, p), join(dir, p), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  const set = (file, v) => { const p = join(dir, file); writeFileSync(p, readFileSync(p, 'utf8').replace(/^(\s*"version": )"[^"]*"/m, `$1"${v}"`)); };
  set('src/manifest.json', '1.2.0');
  set('package.json', '1.2.0');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('add', '-A');
  git('commit', '-qm', 'Start');
  git('tag', '-a', 'v1.2.0', '-m', 'Captode 1.2.0');
  const release = (...a) => {
    try {
      return { out: execFileSync(process.execPath, ['tools/release.mjs', ...a], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), code: 0 };
    } catch (e) {
      return { out: `${e.stdout}${e.stderr}`, code: e.status };
    }
  };
  return { dir, git, release, version: (file) => JSON.parse(readFileSync(join(dir, file), 'utf8')).version };
}

/** The manifest inside a zip built by tools/package.mjs. */
function zippedManifest(zip) {
  const buf = readFileSync(zip);
  for (let at = 0; buf.readUInt32LE(at) === 0x04034b50;) {
    const method = buf.readUInt16LE(at + 8), size = buf.readUInt32LE(at + 18), nameLen = buf.readUInt16LE(at + 26), extra = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 30, at + 30 + nameLen);
    const body = buf.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    if (name === 'manifest.json') return JSON.parse((method ? inflateRawSync(body) : body).toString());
    at += 30 + nameLen + extra + size;
  }
  return null;
}

export const tests = {
  async 'release: versions Chrome accepts, compared number by number'() {
    ok(valid('1.3.0') && valid('2') && valid('1.2.3.4') && !valid('1.2.3.4.5') && !valid('01.2') && !valid('1.70000') && !valid('v1.3'), 'valid');
    ok(compare('1.10.0', '1.9.9') > 0 && compare('1.2', '1.2.0') === 0 && compare('1.2.0', '1.2.1') < 0, 'compare');
    ok(bump('1.2.0', 'patch') === '1.2.1' && bump('1.2.3', 'minor') === '1.3.0' && bump('1.2.3', 'major') === '2.0.0', 'bump');
  },

  async 'release: refuses what Chrome or git would reject, and changes nothing'() {
    const s = sandbox();
    try {
      let r = s.release('1.2.0', '--skip-tests');
      ok(r.code && /already tagged/.test(r.out), `same version: ${r.out}`);
      r = s.release('1.1.9', '--skip-tests');
      ok(r.code && /not higher than the last release, 1\.2\.0/.test(r.out), `lower version: ${r.out}`);
      r = s.release('1.3.0.0.1', '--skip-tests');
      ok(r.code && /not a version Chrome accepts/.test(r.out), `bad version: ${r.out}`);
      writeFileSync(join(s.dir, 'src', 'stray.txt'), 'x');
      r = s.release('1.3.0', '--skip-tests');
      ok(r.code && /uncommitted changes/.test(r.out), `dirty tree: ${r.out}`);
      ok(s.version('src/manifest.json') === '1.2.0', 'nothing changed');
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  },

  async 'release: sets the version everywhere, builds the zip, commits and tags'() {
    const s = sandbox();
    try {
      let r = s.release('minor', '--dry-run');
      ok(!r.code && /Releasing Captode 1\.3\.0/.test(r.out) && s.version('src/manifest.json') === '1.2.0', `dry run: ${r.out}`);
      r = s.release('minor', '--skip-tests');
      ok(!r.code, r.out);
      ok(['src/manifest.json', 'package.json', 'package-lock.json'].every((f) => s.version(f) === '1.3.0'), 'version set in all three files');
      const lock = JSON.parse(readFileSync(join(s.dir, 'package-lock.json'), 'utf8'));
      ok(lock.packages[''].version === '1.3.0', 'and in the lock file\'s own entry');
      const zip = join(s.dir, 'dist', 'captode-1.3.0.zip');
      ok(existsSync(zip) && zippedManifest(zip)?.version === '1.3.0', 'the zip holds 1.3.0');
      ok(s.git('log', '-1', '--format=%s') === 'Captode 1.3.0' && s.git('describe', '--exact-match', 'HEAD') === 'v1.3.0', 'committed and tagged');
      ok(!s.git('status', '--porcelain'), 'nothing left over');
      // With the version already set in the manifest, releasing with no argument tags it.
      writeFileSync(join(s.dir, 'src', 'manifest.json'), readFileSync(join(s.dir, 'src', 'manifest.json'), 'utf8').replace('"1.3.0"', '"1.3.1"'));
      s.git('commit', '-qam', 'Start 1.3.1');
      r = s.release('--skip-tests');
      ok(!r.code && s.git('describe', '--exact-match', 'HEAD') === 'v1.3.1' && s.version('package.json') === '1.3.1', `current version: ${r.out}`);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  },
};
