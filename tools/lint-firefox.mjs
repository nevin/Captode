// Checks the Firefox package with addons-linter, the validator addons.mozilla.org runs on
// every upload. Fails on any error, and on any warning that isn't one of those reviewed:
//   UNSAFE_VAR_ASSIGNMENT: innerHTML with fixed markup, numbers and Captode's own
//     translations; text from pages, files or the user goes in as text (textContent,
//     .value, new Option) or escaped.
// Run after `npm run package`: npm run lint:firefox
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import linter from 'addons-linter';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'src', 'manifest.json'), 'utf8'));
const zip = join(root, 'dist', `captode-${version}-firefox.zip`);

const REVIEWED = [
  (m) => m.code === 'UNSAFE_VAR_ASSIGNMENT',
];

const result = await linter.createInstance({
  config: { _: [zip], logLevel: 'fatal', stack: false, pretty: false, warningsAsErrors: false, metadata: false, output: 'none', boring: false, selfHosted: false },
  runAsBinary: false,
}).run();

const problems = [...result.errors, ...result.warnings.filter((m) => !REVIEWED.some((ok) => ok(m)))];
for (const m of problems) console.error(`${m._type.toUpperCase()} ${m.code} ${m.file || ''}${m.line ? `:${m.line}` : ''}: ${m.message}`);
console.log(`addons-linter: ${result.errors.length} errors, ${result.warnings.length} warnings (${result.warnings.length - problems.length + result.errors.length} reviewed), ${result.notices.length} notices`);
process.exit(problems.length ? 1 : 0);
