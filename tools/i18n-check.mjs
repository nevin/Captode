// Checks the translations in src/_locales: every language has every English
// message, keeps its $1… placeholders and <kbd>/<b> markup, and has nothing extra.
// Run: node tools/i18n-check.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', '_locales');
const read = (lang) => JSON.parse(readFileSync(join(dir, lang, 'messages.json'), 'utf8'));
const en = read('en');
const marks = (s) => [...s.matchAll(/\$\d|<\/?(kbd|b)>/g)].map((m) => m[0]).sort().join(' ');
let problems = 0;
const report = (msg) => { problems++; console.log(msg); };

for (const lang of readdirSync(dir).filter((l) => l !== 'en').sort()) {
  const m = read(lang);
  for (const [key, { message }] of Object.entries(en)) {
    if (!m[key]) { report(`${lang}: missing ${key}`); continue; }
    if (marks(m[key].message) !== marks(message)) report(`${lang}: ${key} has "${marks(m[key].message)}", English has "${marks(message)}"`);
  }
  for (const key of Object.keys(m)) if (!en[key]) report(`${lang}: ${key} is not an English message`);
  if (m.extName.message.length > 75) report(`${lang}: extName is over 75 characters`);
  if (m.extDescription.message.length > 132) report(`${lang}: extDescription is over 132 characters`);
  console.log(`${lang}: ${Object.keys(m).length} messages`);
}
if (problems) { console.log(`${problems} problems`); process.exit(1); }
console.log('All languages complete.');
