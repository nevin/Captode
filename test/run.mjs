// Runs Captode's browser tests: node test/run.mjs [name-filter]
// Each test/*.test.mjs exports `tests` ({ name: async (env) => {} }) and may
// export `setup(env)`; every file gets its own Chrome with the extension loaded.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serveSite, Failure } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
const site = await serveSite();
let passed = 0;
const failed = [];

for (const file of files) {
  const mod = await import(join(here, file));
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
        failed.push(`${file} › ${name}`);
        console.log(`  ✗ ${name}\n      ${e instanceof Failure ? e.message : e.stack}`);
      }
    }
  } finally {
    await env.close();
  }
}
site.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log(failed.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
