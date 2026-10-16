// Shared set-up for Captode's browser tests: a copy of the extension that may
// capture the local test site, a small web server for that site, and Chrome.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serves test/site on a free port. Returns `{ url, close }`. */
export async function serveSite() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
  const server = createServer((req, res) => {
    const path = join(here, 'site', decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!path.startsWith(join(here, 'site')) || !existsSync(path)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(readFileSync(path));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * The extension as shipped, plus the test lab page and permission to capture the
 * local test site (the real extension relies on activeTab, which needs a click).
 */
function testCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'captode-ext-'));
  cpSync(join(root, 'src'), dir, { recursive: true });
  cpSync(join(here, 'lab'), join(dir, 'lab'), { recursive: true });
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions = ['<all_urls>'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

/**
 * Starts Chrome with the extension. Uses CHROME_PATH if set, else the browser
 * Puppeteer downloaded. Returns `{ browser, id, url(path), close() }`.
 */
// On a Mac whose display has gone to sleep, Chrome stops producing frames and screen
// captures never finish. Keep the display awake (and wake it) while tests run.
let awake = false;
function keepDisplayAwake() {
  if (awake || process.platform !== 'darwin') return;
  awake = true;
  try { spawn('caffeinate', ['-d', '-i', '-u', '-w', String(process.pid)], { stdio: 'ignore' }).unref(); } catch {}
}

const defaultFeatures = puppeteer.defaultArgs({ headless: true }).find((a) => a.startsWith('--disable-features='));

export async function launch({ scheme = 'light', args = [] } = {}) {
  keepDisplayAwake();
  const ext = testCopy();
  const profile = mkdtempSync(join(tmpdir(), 'captode-profile-'));
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    // Puppeteer already stops Chrome throttling background pages. Windows runners have no
    // visible desktop, so also skip Windows' occlusion check, added to Puppeteer's own list
    // of disabled features (a second --disable-features flag would replace that list).
    ignoreDefaultArgs: [defaultFeatures],
    args: ['--window-size=1280,900', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox',
      `${defaultFeatures},CalculateNativeWinOcclusion`, ...args,
      // Extra Chrome options for reproducing a runner's setup, e.g. --force-prefers-reduced-motion.
      ...(process.env.CHROME_ARGS || '').split(' ').filter(Boolean)],
    defaultViewport: null,
  });
  const id = await browser.installExtension(ext);
  browser.scheme = scheme;
  return {
    browser,
    id,
    url: (path) => `chrome-extension://${id}/${path}`,
    async close() {
      await browser.close().catch(() => {});
      rmSync(ext, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Opens an extension page (or any URL) in a new tab, logging its errors. */
// Every page the tests use behaves as if its window were focused, and waits are done
// from here rather than by a timer in the page. On CI runners (Windows especially) the
// browser window is never really focused: the clipboard then waits for focus, and the
// page's own timers can stall, so Puppeteer's in-page polling never saw a condition
// that was already true.
async function waitFor(page, fn, opts = {}, ...args) {
  const timeout = opts.timeout ?? 30000;
  const end = Date.now() + timeout;
  let last = null;
  for (;;) {
    // The page may still be loading (or navigating): an error then just means "not yet".
    const ok = await page.evaluate(fn, ...args).catch((e) => { last = e; return false; });
    if (ok) return ok;
    if (Date.now() > end) throw new Error(`Waiting failed: ${timeout}ms exceeded${last ? ` (last error: ${last.message})` : ''}`);
    await sleep(opts.polling ?? 100);
  }
}

export async function prepare(page) {
  if (page.__prepared) return page;
  page.__prepared = true;
  page.waitForFunction = (fn, opts, ...args) => waitFor(page, fn, opts, ...args);
  try { await (await page.createCDPSession()).send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
  return page;
}

export async function open(browser, url, { width = 1280, height = 900 } = {}) {
  const page = await prepare(await browser.newPage());
  page.on('pageerror', (e) => console.log(`    page error (${url}): ${e.message}`));
  await page.setViewport({ width, height });
  await page.goto(url);
  return page;
}

export async function waitForTab(browser, match, ms = 30000) {
  const t = await browser.waitForTarget((t) => t.type() === 'page' && match(t.url()), { timeout: ms });
  return prepare(await t.page());
}

/** Records a synthetic clip in the page and stores it as a capture. Returns its id. */
export async function recordClip(page, { seconds = 3, audio = false, width = 1280, height = 720 } = {}) {
  await page.bringToFront();
  return page.evaluate(async (seconds, audio, width, height) => {
    const { putCapture } = await import('/lib/db.js');
    const el = document.createElement('canvas'); el.width = width; el.height = height; document.body.append(el);
    const ctx = el.getContext('2d');
    const stream = el.captureStream(30);
    if (audio) {
      const ac = new AudioContext(); await ac.resume();
      const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
      d.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
    const rec = new MediaRecorder(stream, { mimeType: audio ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9', videoBitsPerSecond: 4e6, videoKeyFrameIntervalDuration: 2000 });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start(500);
    const t0 = performance.now();
    // Each frame shows its time in hundredths of a second as 12 black or white
    // blocks, which survive video compression, so tests can read the time back.
    await new Promise((res) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000;
        ctx.fillStyle = '#336'; ctx.fillRect(0, 0, width, height);
        const g = ctx.createLinearGradient(0, 0, width, 0); g.addColorStop(0, '#6a5cff'); g.addColorStop(1, '#ffb224');
        ctx.fillStyle = g; ctx.fillRect(0, 40, width, 120);
        const cs = Math.round(t * 100);
        for (let b = 0; b < 12; b++) { ctx.fillStyle = (cs >> b) & 1 ? '#fff' : '#000'; ctx.fillRect(40 + b * 100, 400, 90, 200); }
        ctx.fillStyle = '#5b4bff'; ctx.fillRect(100 + t * 120, 250, 120, 100);
        if (t < seconds) requestAnimationFrame(draw); else res();
      };
      draw();
    });
    rec.stop();
    await new Promise((r) => { rec.onstop = r; });
    return putCapture(new Blob(chunks, { type: 'video/webm' }), { fps: 30, duration: seconds, hasAudio: audio, title: 'Test clip' });
  }, seconds, audio, width, height);
}

// ---------- assertions ----------

export class Failure extends Error {}

export function ok(cond, message) {
  if (!cond) throw new Failure(message);
}

export function near(actual, expected, tolerance, message) {
  ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ± ${tolerance}, got ${actual}`);
}
