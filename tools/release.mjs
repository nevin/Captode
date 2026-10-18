// Makes a release in one commit: sets the version everywhere it is written, checks the
// translations, runs the tests, builds the packages for every browser (see
// tools/package.mjs) and checks the Firefox one with Mozilla's validator, then commits the
// version together with any changes not yet committed, and tags it.
//
//   npm run release                 release the version in src/manifest.json (if not tagged yet)
//   npm run release -- 1.3.1        or a given version
//   npm run release -- patch        or the next patch, minor or major version
//
// Options: --push (push the commit and tag), --skip-tests, --dry-run (say what would happen),
// --message="What changed" (the commit's description, under "Captode <version>").
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const wanted = args.find((a) => !a.startsWith('--'));
const message = args.find((a) => a.startsWith('--message='))?.slice('--message='.length).trim();

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', stdio: opts.show ? 'inherit' : 'pipe', shell: process.platform === 'win32' && cmd === 'npm' });
const git = (...a) => run('git', a).trim();
const fail = (msg) => { console.error(`release: ${msg}`); process.exit(1); };

/** Chrome's version format: one to four numbers, each 0–65535, no leading zeros. */
export const valid = (v) => /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(v) && v.split('.').every((n) => Number(n) <= 65535);
/** Compares two versions number by number: negative, zero or positive. */
export const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
/** The next patch, minor or major version after `v`. */
export const bump = (v, part) => {
  const [major = 0, minor = 0, patch = 0] = v.split('.').map(Number);
  return { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[part];
};

/** Sets the `version` field of a JSON file without reformatting the rest of it. */
function setVersion(file, version, { lock = false } = {}) {
  const path = join(root, file);
  let text = readFileSync(path, 'utf8');
  // package-lock.json repeats the project's version under packages[""].
  const pattern = lock ? /("name": "captode",\s*"version": )"[^"]*"/g : /^(\s*"version": )"[^"]*"/m;
  if (!pattern.test(text)) fail(`no version found in ${file}`);
  text = text.replace(pattern, `$1"${version}"`);
  if (JSON.parse(text).version !== version) fail(`could not set the version in ${file}`);
  return { path, text, original: readFileSync(path, 'utf8') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync(join(root, 'src', 'manifest.json'), 'utf8'));
  const current = manifest.version;
  const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean).map((t) => t.slice(1)).filter(valid);
  const latest = tags.sort(compare).at(-1) || '0';

  const version = !wanted ? current : ['patch', 'minor', 'major'].includes(wanted) ? bump(compare(current, latest) > 0 ? latest : current, wanted) : wanted;
  if (!valid(version)) fail(`"${version}" is not a version Chrome accepts (up to four numbers, like 1.3.0)`);
  if (tags.includes(version)) fail(`v${version} is already tagged; choose a higher version`);
  if (compare(version, latest) <= 0) fail(`${version} is not higher than the last release, ${latest}; Chrome only installs higher versions`);
  // Changes not committed yet go into the release commit, with the version.
  // Untrimmed: each line starts with two status columns, which may be spaces.
  const pending = run('git', ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).map((l) => l.slice(3));
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') fail('not on a branch');

  const files = [setVersion('src/manifest.json', version), setVersion('package.json', version)];
  if (existsSync(join(root, 'package-lock.json'))) files.push(setVersion('package-lock.json', version, { lock: true }));

  console.log(`Releasing Captode ${version} from ${branch} (last release: ${latest === '0' ? 'none' : latest}).`);
  if (pending.length) console.log(`Including ${pending.length} changed file${pending.length === 1 ? '' : 's'} in the release commit:\n  ${pending.join('\n  ')}`);
  if (flag('dry-run')) {
    console.log(`Would set the version in ${files.map((f) => f.path.slice(root.length + 1)).join(', ')}, check the translations,${flag('skip-tests') ? '' : ' run the tests,'} build the packages for every browser${flag('skip-tests') ? '' : ', check the Firefox one'}, commit "Captode ${version}", tag v${version}${flag('push') ? ' and push both' : ''}.`);
    process.exit(0);
  }

  for (const f of files) writeFileSync(f.path, f.text);
  try {
    run('npm', ['run', '-s', 'i18n'], { show: true });
    if (!flag('skip-tests')) run('npm', ['test'], { show: true });
    run('npm', ['run', '-s', 'package'], { show: true });
    if (!flag('skip-tests')) run('npm', ['run', '-s', 'lint:firefox'], { show: true });
  } catch {
    for (const f of files) writeFileSync(f.path, f.original); // other changes are left as they were
    fail('stopped; the version change was undone');
  }
  if (git('status', '--porcelain')) {
    git('add', '-A');
    git('commit', '-m', `Captode ${version}`, ...(message ? ['-m', message] : []));
  }
  git('tag', '-a', `v${version}`, '-m', `Captode ${version}`);
  console.log(`Tagged v${version}. In dist/: captode-${version}-chrome.zip for the Chrome Web Store, -edge.zip for Edge Add-ons, -firefox.zip (with -source.zip) for addons.mozilla.org, and the -safari folder for Xcode. See store/README.md.`);
  if (flag('push')) {
    git('push', 'origin', branch);
    git('push', 'origin', `v${version}`);
    console.log('Pushed the commit and the tag.');
  } else {
    console.log(`To publish the tag: git push origin ${branch} v${version}`);
  }
}
