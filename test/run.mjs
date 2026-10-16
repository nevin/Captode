// Runs Captode's browser tests: node test/run.mjs [name-filter]
// Each test/*.test.mjs exports `tests` ({ name: async (env) => {} }) and may
// export `setup(env)`; every file gets its own Chrome with the extension loaded.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, serveSite, Failure, Skip } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
const site = await serveSite();
let passed = 0;
const failed = [];
const skipped = [];

for (const file of files) {
  const mod = await import(pathToFileURL(join(here, file)).href); // a file:// URL, so Windows paths work
  const names = Object.keys(mod.tests).filter((n) => `${file} ${n}`.includes(filter));
  if (!names.length) continue;
  console.log(`\n${file}`);
  const env = { ...(await launch()), site: site.url };
  try {
    if (mod.setup) Object.assign(env, await mod.setup(env));
    for (const name of names) {
      const t0 = Date.now();
      try {
        const note = await mod.tests[name](env);
        passed++;
        console.log(`  ✓ ${name} (${Date.now() - t0} ms)${note ? ` — ${note}` : ''}`);
      } catch (e) {
        if (e instanceof Skip) {
          skipped.push(`${file} › ${name}: ${e.message}`);
          console.log(`  – ${name} (skipped: ${e.message})`);
          continue;
        }
        failed.push(`${file} › ${name}`);
        console.log(`  ✗ ${name}\n      ${e instanceof Failure ? e.message : e.stack}`);
      }
    }
  } finally {
    await env.close();
  }
}
site.close();
console.log(`\n${passed} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
if (skipped.length) console.log(skipped.map((s) => `  – ${s}`).join('\n'));
if (failed.length) {
  console.log(failed.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
