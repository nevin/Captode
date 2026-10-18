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
import { leaks, targetModule } from '../tools/targets.mjs';

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

  async 'packages: none names another browser'() {
    const file = (name, text) => [name, Buffer.from(text)];
    ok(leaks('chrome', [file('lib/x.js', "const u = 'https://addons.mozilla.org/firefox/addon/captode/';")]).length === 1, 'another store in code');
    ok(leaks('firefox', [file('_locales/en/messages.json', '{"a":{"message":"Chrome protects its pages"}}')]).length === 1, 'another browser in what users read');
    ok(leaks('edge', [file('manifest.json', '{"minimum_chrome_version":"116"}')]).length === 0, "Chromium's manifest key is Edge's too");
    ok(leaks('firefox', [file('lib/x.js', '// Chrome draws this differently')]).length === 0, 'a code comment may explain a browser');
    // src/ holds Chrome's settings, as the Chrome package does, for loading unpacked.
    ok(readFileSync(join(root, 'src', 'lib', 'target.js'), 'utf8') === targetModule('chrome'), 'src/lib/target.js is out of date: node -e "import(\'./tools/targets.mjs\').then(m => process.stdout.write(m.targetModule(\'chrome\')))" > src/lib/target.js');
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
      // A change not yet committed goes into the one release commit, with the version.
      writeFileSync(join(s.dir, 'src', 'new-feature.js'), '// new\n');
      const commits = Number(s.git('rev-list', '--count', 'HEAD'));
      r = s.release('minor', '--skip-tests', '--message=A new feature');
      ok(!r.code && /Including 1 changed file/.test(r.out), r.out);
      ok(Number(s.git('rev-list', '--count', 'HEAD')) === commits + 1, 'one commit for the release');
      ok(s.git('show', '--name-only', '--format=', 'HEAD').split('\n').includes('src/new-feature.js'), 'the change is in the release commit');
      ok(s.git('log', '-1', '--format=%b') === 'A new feature', 'with the description given');
      ok(['src/manifest.json', 'package.json', 'package-lock.json'].every((f) => s.version(f) === '1.3.0'), 'version set in all three files');
      const lock = JSON.parse(readFileSync(join(s.dir, 'package-lock.json'), 'utf8'));
      ok(lock.packages[''].version === '1.3.0', 'and in the lock file\'s own entry');
      const zip = join(s.dir, 'dist', 'captode-1.3.0-chrome.zip');
      ok(existsSync(zip) && zippedManifest(zip)?.version === '1.3.0', 'the zip holds 1.3.0');
      // One build for each store: Chrome's manifest as written, Firefox's made from it.
      const cm = zippedManifest(zip), fm = zippedManifest(join(s.dir, 'dist', 'captode-1.3.0-firefox.zip'));
      ok(cm.background.service_worker && cm.permissions.includes('tabCapture') && !cm.browser_specific_settings, `Chrome manifest: ${JSON.stringify(cm.background)}`);
      ok(fm?.version === '1.3.0' && fm.background.scripts?.[0] === 'background.js' && !fm.background.service_worker
        && !fm.permissions.includes('tabCapture') && !fm.permissions.includes('offscreen') && !fm.minimum_chrome_version
        && fm.browser_specific_settings.gecko.id === 'captode@nevin.github.io'
        && fm.browser_specific_settings.gecko.data_collection_permissions.required[0] === 'none', `Firefox manifest: ${JSON.stringify(fm)}`);
      const em = zippedManifest(join(s.dir, 'dist', 'captode-1.3.0-edge.zip'));
      ok(em?.version === '1.3.0' && em.background.service_worker && em.permissions.includes('tabCapture'), `Edge manifest: ${JSON.stringify(em?.background)}`);
      const sm = JSON.parse(readFileSync(join(s.dir, 'dist', 'captode-1.3.0-safari', 'manifest.json'), 'utf8'));
      ok(sm.version === '1.3.0' && !sm.permissions.includes('tabCapture') && sm.browser_specific_settings.safari, `Safari manifest: ${JSON.stringify(sm.browser_specific_settings)}`);
      ok(existsSync(join(s.dir, 'dist', 'captode-1.3.0-source.zip')), 'and the source zip for addons.mozilla.org');
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
