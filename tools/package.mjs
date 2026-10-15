// Builds dist/tabreel-<version>.zip, ready to upload to the Chrome Web Store and
// Microsoft Edge Add-ons. Uses the system `zip` tool.
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
const out = join(root, 'dist', `tabreel-${version}.zip`);
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', '-X', out, '.', '-x', '*.DS_Store'], { cwd: join(root, 'src'), stdio: 'inherit' });
console.log('wrote', out);
