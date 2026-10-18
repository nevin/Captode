// Captode in real Firefox, from the Firefox package's manifest and settings: it installs,
// offers only what Firefox can do, takes a full-page screenshot, and its pages open
// without errors. Needs Firefox for Puppeteer (npx puppeteer browsers install firefox@stable),
// or FIREFOX_PATH; skipped without it.
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestFor, targetModule } from '../tools/targets.mjs';
import { ok, near, Skip } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Firefox from FIREFOX_PATH, or the newest one Puppeteer downloaded. */
function firefox() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;
  const cache = join(homedir(), '.cache', 'puppeteer', 'firefox');
  if (!existsSync(cache)) return null;
  const dir = readdirSync(cache).sort().at(-1);
  const bin = { darwin: 'Firefox.app/Contents/MacOS/firefox', win32: 'firefox.exe' }[process.platform] || 'firefox';
  for (const sub of ['', 'firefox', 'core']) {
    const path = join(cache, dir, sub, bin);
    if (existsSync(path)) return path;
  }
  return null;
}

export const tests = {
  async 'Firefox: installs from its own package, offers what Firefox can do, and captures a full page'({ site }) {
    const exe = firefox();
    if (!exe) throw new Skip('Firefox for Puppeteer is not installed');
    // The Firefox package, plus permission to capture the test site (the real one relies on
    // activeTab, which needs a click) and the check page, opened by the background.
    const dir = mkdtempSync(join(tmpdir(), 'captode-firefox-'));
    cpSync(join(here, '..', 'src'), dir, { recursive: true });
    cpSync(join(here, 'firefox'), join(dir, 'firefox-check'), { recursive: true });
    const m = manifestFor('firefox', JSON.parse(readFileSync(join(here, '..', 'src', 'manifest.json'), 'utf8')));
    m.host_permissions = ['<all_urls>'];
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    writeFileSync(join(dir, 'lib', 'target.js'), targetModule('firefox'));

    let resolveReport;
    const reported = new Promise((r) => { resolveReport = r; });
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { res.end('ok'); resolveReport(JSON.parse(body)); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const report = `http://127.0.0.1:${server.address().port}/report`;
    const checkUrl = `firefox-check/check.html?site=${encodeURIComponent(site)}&report=${encodeURIComponent(report)}`;
    writeFileSync(join(dir, 'background.js'), `${readFileSync(join(dir, 'background.js'), 'utf8')}
setTimeout(() => chrome.tabs.create({ url: chrome.runtime.getURL(${JSON.stringify(checkUrl)}), active: false }), 1500);\n`);

    const browser = await puppeteer.launch({ browser: 'firefox', headless: true, executablePath: exe });
    try {
      const page = await browser.newPage();
      await page.goto(`${site}/long.html`);
      await browser.installExtension(dir);
      const r = await Promise.race([reported, new Promise((_, no) => setTimeout(() => no(new Error('no report from Firefox in 90 s')), 90000))]);
      ok(!r.errors.length, `errors: ${r.errors.join('; ')}`);
      ok(JSON.stringify(r.popup.tabModes) === '["screen"]' && r.popup.numbers === '1', `recording modes: ${JSON.stringify(r.popup)}`);
      ok(r.popup.cameraHidden && r.popup.sizeHidden && r.popup.inputsHidden && r.popup.share, `popup: ${JSON.stringify(r.popup)}`);
      ok(!r.capture.error, `capture: ${r.capture.error}`);
      near(r.capture.height / r.capture.dpr, r.page[0], 3, 'full page height');
      ok(r.settings.shortcuts.length === 5 && r.settings.changeShortcuts, `settings: ${JSON.stringify(r.settings)}`);
      ok(r.editor.tools > 10, 'editor tools');
      return `${r.capture.width} × ${r.capture.height}; shortcuts ${r.settings.shortcuts.join(', ')}`;
    } finally {
      await browser.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
