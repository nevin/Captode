// Captions from speech: where someone speaks, captions timed over it, the whole flow on
// the video page (with a stand-in for the browser's recogniser, so nothing is
// downloaded), and that only Chrome's package holds any of it.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePackageIn } from '../tools/targets.mjs';
import { open, recordClip, ok, near, sleep } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// A recogniser that "hears" a fixed sentence for each stretch it is given.
const FAKE = () => {
  class FakeRecognition extends EventTarget {
    static available() { return Promise.resolve('available'); }
    static install() { return Promise.resolve(true); }
    constructor() { super(); this.processLocally = false; this.lang = ''; window.__heardWith = window.__heardWith || []; }
    start(track) {
      window.__heardWith.push({ local: this.processLocally, track: track?.kind, lang: this.lang });
      setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'hello there this is a test of captions from speech' }], { isFinal: true })] }), 50);
    }
    stop() { setTimeout(() => this.onend?.(), 10); }
    abort() { setTimeout(() => this.onend?.(), 10); }
  }
  FakeRecognition.prototype.processLocally = false;
  window.SpeechRecognition = FakeRecognition;
};

export async function setup({ browser, url }) {
  const ctl = await open(browser, url('lab/lab.html'));
  await ctl.waitForFunction(() => globalThis.lab, { polling: 100 });
  const clip = await recordClip(ctl, { seconds: 4, audio: true });
  return { ctl, clip };
}

export const tests = {
  async 'speech: stretches of speech, and captions timed over them'({ ctl }) {
    const r = await ctl.evaluate(async () => {
      const { speechParts, splitCaptions } = await import('/lib/speech.js');
      // 0.05 s steps: speech 1–3 s and 5–20 s, quiet between.
      const rms = Array.from({ length: 500 }, (_, k) => { const t = k * 0.05; return (t >= 1 && t < 3) || (t >= 5 && t < 20) ? 0.2 : 0.001; });
      return {
        parts: speechParts({ step: 0.05, rms }, 0, 25),
        kept: speechParts({ step: 0.05, rms }, 0, 25, { within: [{ from: 0, to: 2 }] }),
        caps: splitCaptions('one two three four five six seven eight nine ten eleven twelve', 10, 16),
      };
    });
    ok(r.parts.length === 3, `three stretches (the long one split): ${JSON.stringify(r.parts)}`);
    near(r.parts[0].from, 1, 0.06, 'first starts');
    near(r.parts[0].to, 3, 0.06, 'first ends');
    ok(r.parts.slice(1).every((p) => p.to - p.from <= 12), 'none over 12 s');
    ok(r.kept.length === 1 && r.kept[0].to <= 2, `only what is kept: ${JSON.stringify(r.kept)}`);
    ok(r.caps.length === 2 && r.caps[0].from === 10 && r.caps.at(-1).to === 16, `two captions over the stretch: ${JSON.stringify(r.caps)}`);
  },

  async 'speech: captions from what is said, recognised on the device'({ browser, url, clip }) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(FAKE);
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url(`video/video.html?id=${clip}`));
    await page.waitForFunction(() => /fps/.test(document.querySelector('#dims')?.textContent || ''), { polling: 100 });
    await page.waitForFunction(() => document.querySelector('#ed-speech') && !document.querySelector('#ed-speech').disabled, { polling: 100, timeout: 20000 });
    await page.evaluate(() => { document.querySelector('#sound-section').open = true; document.querySelector('#ed-speech').scrollIntoView({ block: 'center' }); });
    await page.click('#ed-speech');
    await page.waitForSelector('dialog.confirm[open] [data-v="yes"]');
    await page.click('dialog.confirm[open] [data-v="yes"]');
    await page.waitForFunction(() => captodeEdits.get().captions.length > 0, { timeout: 60000, polling: 200 });
    const r = await page.evaluate(() => ({ caps: captodeEdits.get().captions, heard: window.__heardWith }));
    ok(r.heard.length && r.heard.every((h) => h.local === true && h.track === 'audio'), `on the device, from the recording's sound: ${JSON.stringify(r.heard)}`);
    ok(r.caps.every((c) => c.text && c.to > c.from && c.from >= 0 && c.to <= 4.5), `timed captions: ${JSON.stringify(r.caps)}`);
    ok(r.caps.map((c) => c.text).join(' ').includes('hello there'), 'what was heard');
    // One step to undo.
    await page.evaluate(() => document.querySelector('#ed-undo').click());
    ok(await page.evaluate(() => captodeEdits.get().captions.length === 0), 'undone in one step');
    await page.close();
  },

  async 'speech: only Chrome\'s package has it'() {
    const root = join(here, '..');
    for (const id of ['chrome', 'edge', 'firefox', 'safari']) {
      const dir = mkdtempSync(join(tmpdir(), `captode-${id}-`));
      try {
        cpSync(join(root, 'src'), dir, { recursive: true });
        makePackageIn(id, dir, root);
        const code = readFileSync(join(dir, 'lib', 'speech.js'), 'utf8');
        const has = /processLocally/.test(code);
        ok(id === 'chrome' ? has : !has && /canTranscribe = false/.test(code), `${id}: ${has ? 'has' : 'has no'} speech recognition`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
};
