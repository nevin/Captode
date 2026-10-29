// Video page: simple mode and its tour, notes where the browser lacks a feature, subtitles in more languages inside MP4 and WebM files, layers that move,
// moved with the keyboard, where the music starts, a check for room before keeping
// more, and intro and outro slides with a brand kit's look.
import { open, recordClip, ok, near, sleep } from './helpers.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A WAV file of a steady tone, `seconds` long; its path. */
function toneFile(seconds = 20, hz = 330) {
  const rate = 48000, n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2);
  const path = join(mkdtempSync(join(tmpdir(), 'captode-more-')), 'tone.wav');
  writeFileSync(path, b);
  return path;
}

export async function setup({ browser, url }) {
  const ctl = await open(browser, url('lab/lab.html'));
  await ctl.waitForFunction(() => globalThis.lab, { polling: 100 });
  const clip = await recordClip(ctl, { seconds: 4, audio: true });
  const video = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
  await video.bringToFront();
  await video.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
  return { video, ctl, clip };
}

/** Exports in `format` and returns the file's bytes as a string of Latin-1 characters, and the page's URL for it. */
async function exportAs(video, format) {
  await video.click(`#formats [data-f="${format}"]`);
  await video.waitForFunction(() => document.querySelector('#result').classList.contains('hidden'), { polling: 100 });
  await video.click('#convert');
  await video.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden') || /failed/i.test(document.querySelector('#status').textContent), { timeout: 120000, polling: 100 });
  const out = await video.evaluate(async () => {
    const b = new Uint8Array(await (await fetch(document.querySelector('#out-video').src)).arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return s;
  });
  await video.click('#redo-export').catch(() => {});
  return out;
}
const count = (s, word) => s.split(word).length - 1;

export const tests = {
  async 'simple mode: few tools at first, all once chosen or in use, and a tour once'({ video }) {
    await video.evaluate(() => { localStorage.removeItem('captode-video-mode'); localStorage.removeItem('captode-video-tour'); });
    await video.reload();
    await video.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
    const seen = (sel) => video.$eval(sel, (e) => e.getClientRects().length > 0);
    ok(await video.evaluate(() => document.body.classList.contains('simple')), 'simple at first');
    ok(!(await seen('#slides-section')) && !(await seen('[data-add="zooms"]')) && (await seen('[data-add="cuts"]')) && (await seen('[data-add="captions"]')) && (await seen('#convert')), 'only trimming, cuts, captions and export');
    await video.waitForSelector('.tour', { timeout: 5000 });
    const n = await video.$eval('.tour-n', (e) => e.textContent);
    ok(/1/.test(n), `the tour starts at its first step: ${n}`);
    for (let i = 0; i < 10 && await video.$('.tour'); i++) { await video.click('.tour [data-next]'); await sleep(60); }
    ok(!(await video.$('.tour')) && await video.evaluate(() => localStorage.getItem('captode-video-tour') === 'done'), 'the tour ends, and is remembered');
    // A tool used with its key (Z: a zoom) shows all the tools, without changing the choice kept.
    await video.evaluate(() => { document.activeElement?.blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true })); });
    await sleep(300);
    ok(await seen('#slides-section'), 'all tools shown once one is used');
    ok(await video.evaluate(() => localStorage.getItem('captode-video-mode') === null), 'not remembered as chosen');
    await video.evaluate(() => captodeEdits.replace({ ...captodeEdits.get(), zooms: [] }));
    await video.click('#ui-mode [data-v="advanced"]');
    ok(await video.evaluate(() => localStorage.getItem('captode-video-mode') === 'advanced'), 'All tools remembered when chosen');
  },

  async 'notes say when this browser lacks a feature'({ video }) {
    // Chrome for Testing has the speech button or a note in its place, never neither.
    ok(await video.evaluate(() => !!(document.querySelector('#ed-speech') || document.querySelector('#speech-note'))), 'speech: a button or a note');
    await video.evaluate(() => {
      captodeEdits.replace({ ...captodeEdits.get(), captions: [{ id: 'n0', from: 0.5, to: 1.5, text: 'Hi', size: 2 }] });
      captodeEdits.chooseCaption('n0');
    });
    await sleep(200);
    ok(await video.evaluate(() => !!document.querySelector('#ed-item [data-translate]') || /browser/i.test(document.querySelector('#ed-item').textContent)), 'translation: a menu or a note');
  },

  async 'subtitles: the captions and a second language as tracks in MP4 and WebM'({ video }) {
    await video.evaluate(() => {
      captodeEdits.replace({
        ...captodeEdits.get(),
        captions: [{ id: 'c0', from: 0.5, to: 1.5, text: 'Hello there', size: 2 }, { id: 'c1', from: 2, to: 3, text: 'Goodbye', size: 2 }],
        captionStyle: { ...captodeEdits.get().captionStyle, embed: true, burn: false, lang: 'en' },
        subtitleTracks: [{ id: 's1', lang: 'fr', texts: { c0: 'Bonjour', c1: 'Au revoir' } }],
      });
    });
    const mp4 = await exportAs(video, 'mp4');
    ok(count(mp4, 'tx3g') === 2 && count(mp4, 'sbtl') === 2, `two subtitle tracks in the MP4: ${count(mp4, 'tx3g')}, ${count(mp4, 'sbtl')}`);
    ok(mp4.includes('Hello there') && mp4.includes('Bonjour'), 'both languages\' words in the MP4');
    const webm = await exportAs(video, 'webm');
    ok(count(webm, 'S_TEXT/WEBVTT') === 2 && webm.includes('Au revoir') && webm.includes('fre'), 'two WebVTT tracks in the WebM, one French');
    // The video still plays, as players read it.
    const plays = await video.evaluate(async (s) => {
      const { demuxWebm } = await import('/lib/webm.js');
      const b = Uint8Array.from(s, (c) => c.charCodeAt(0));
      return demuxWebm(b.buffer).video.frames.length;
    }, webm);
    ok(plays > 30, `the WebM's video still reads: ${plays} frames`);
  },

  async 'subtitles: a file in another language follows the captions it lines up with'({ video }) {
    const r = await video.evaluate(async () => {
      const { parseSubtitles, matchSubtitles } = await import('/lib/video-edits.js');
      const file = parseSubtitles('1\n00:00:00,400 --> 00:00:01,600\nHola\n\n2\n00:00:02,000 --> 00:00:03,000\n<i>Adiós</i>\n');
      return matchSubtitles([{ id: 'c0', start: 0.5, end: 1.5 }, { id: 'c1', start: 2, end: 3 }], file);
    });
    ok(r.c0 === 'Hola' && r.c1 === 'Adiós', `matched by time: ${JSON.stringify(r)}`);
  },

  async 'layers: a moving layer glides to where it ends, and arrow keys move it'({ video }) {
    const box = await video.evaluate(async () => {
      const { layerBox } = await import('/lib/video-edits.js');
      const l = { from: 0, to: 2, pos: 'tl', size: 0.2, shape: 'rect', aspect: 2, kind: 'video', move: true, x2: 0.8, y2: 0.7, size2: 0.4 };
      return [0, 1, 2].map((t) => layerBox(l, 1000, 1000, t));
    });
    ok(box[0].x < 100 && box[0].w < 210, `starts in its corner: ${JSON.stringify(box[0])}`);
    near(box[2].x + box[2].w / 2, 800, 2, 'ends centred where it was set');
    ok(box[1].w > box[0].w && box[1].w < box[2].w, 'grows on the way');

    await video.evaluate(() => {
      const p = document.querySelector('#player');
      p.pause();
      p.currentTime = 0.5;
      captodeEdits.replace({ ...captodeEdits.get(), captions: [], layers: [{ id: 'L1', kind: 'text', text: 'Hi', from: 0, to: 3, pos: 'free', x: 0.5, y: 0.5, size: 0.3 }] });
      captodeEdits.choose('layers', 'L1');
    });
    await sleep(300);
    await video.evaluate(() => {
      const v = document.querySelector('#fx-view');
      for (let i = 0; i < 2; i++) v.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      v.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    });
    const l = await video.evaluate(() => captodeEdits.get().layers[0]);
    near(l.x, 0.6, 0.011, 'moved right by the arrow keys');
    near(l.size, 0.35, 0.001, 'bigger with +');
    // Turned into a moving one, its end is what changes in its second half.
    await video.evaluate(() => {
      captodeEdits.replace({ ...captodeEdits.get(), layers: [{ ...captodeEdits.get().layers[0], move: true, x2: 0.6, y2: 0.5, size2: 0.35 }] });
      captodeEdits.choose('layers', 'L1');
      document.querySelector('#player').currentTime = 2.9;
    });
    await sleep(300);
    await video.evaluate(() => document.querySelector('#fx-view').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true })));
    const m = await video.evaluate(() => captodeEdits.get().layers[0]);
    ok(Math.abs(m.y - 0.5) < 1e-6 && m.y2 > 0.52, `the end moved, not the start: ${JSON.stringify({ y: m.y, y2: m.y2 })}`);
    const mp4 = await exportAs(video, 'mp4');
    ok(mp4.length > 10000, 'a moving layer exports');
    await video.evaluate(() => captodeEdits.replace({ ...captodeEdits.get(), layers: [] }));
  },

  async 'storage: nothing more is kept when the browser is out of room'({ video }) {
    await video.evaluate(() => {
      document.querySelector('#sound-section').open = true;
      window.__estimate = navigator.storage.estimate;
      navigator.storage.estimate = async () => ({ usage: 1e9, quota: 1e9 + 1e6 });
    });
    const input = await video.$('#music-file');
    await input.uploadFile(toneFile(5));
    await video.waitForFunction(() => /room/i.test(document.querySelector('.toast')?.textContent || ''), { timeout: 10000, polling: 100 });
    ok(await video.evaluate(() => document.querySelector('#music-on').classList.contains('hidden')), 'no music added');
    await video.evaluate(() => { navigator.storage.estimate = window.__estimate; });
  },

  async 'music: where it starts, chosen on its waveform'({ video }) {
    await video.evaluate(() => { document.querySelector('#sound-section').open = true; });
    const input = await video.$('#music-file');
    await input.uploadFile(toneFile(20));
    await video.waitForFunction(() => !document.querySelector('#music-on').classList.contains('hidden'), { timeout: 30000, polling: 100 });
    await video.waitForFunction(() => document.querySelector('#music-wave').getAttribute('aria-valuemax') > 0, { timeout: 10000, polling: 100 });
    await video.focus('#music-wave');
    for (let i = 0; i < 3; i++) await video.keyboard.press('ArrowRight');
    await video.keyboard.down('Shift');
    await video.keyboard.press('ArrowRight');
    await video.keyboard.up('Shift');
    const m = await video.evaluate(() => captodeEdits.get().music);
    near(m.offset, 8, 0.01, 'three seconds, then five more');
    const box = await video.$eval('#music-wave', (c) => { const b = c.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    await video.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    near(await video.evaluate(() => captodeEdits.get().music.offset), 10, 0.3, 'clicked halfway along');
    await video.click('#music-remove');
  },

  async 'brand kit: its look on the video, and an intro and outro'({ video }) {
    await video.evaluate(() => captodeEdits.setLook({ captionStyle: { font: 'serif', band: 'light', lang: 'xx' }, background: { on: true, c1: '#112233', aspect: '9:16' } }));
    const e = await video.evaluate(() => captodeEdits.get());
    ok(e.captionStyle.font === 'serif' && e.captionStyle.band === 'light' && e.captionStyle.lang === 'en', `caption look taken, its language kept: ${JSON.stringify(e.captionStyle)}`);
    ok(e.background.on && e.background.c1 === '#112233' && e.background.aspect === 'auto', `background taken, not its shape: ${JSON.stringify(e.background)}`);
    await video.evaluate(() => { document.querySelector('#slides-section').open = true; });
    await video.$eval('#slide-bookends', (b) => b.scrollIntoView({ block: 'center' }));
    await video.click('#slide-bookends');
    await sleep(300);
    const n = await video.$$eval('#slide-list > *', (l) => l.length);
    ok(n === 2, `an intro and an outro: ${n}`);
  },

  async 'before exporting: a check names what will surprise, and Cancel stops'({ video }) {
    await video.evaluate(() => captodeEdits.replace({ ...captodeEdits.get(), captions: [{ id: 'k0', from: 0.5, to: 1.5, text: 'Hi', size: 2 }], captionStyle: { ...captodeEdits.get().captionStyle, burn: false } }));
    await video.click('#formats [data-f="gif"]');
    await video.click('#convert');
    await video.waitForSelector('dialog.confirm[open]', { timeout: 5000 });
    const text = await video.$eval('dialog.confirm[open] p', (p) => p.textContent);
    ok(/GIF/.test(text), `the check says why: ${text}`);
    await video.click('dialog.confirm[open] button[value="no"]');
    await sleep(300);
    ok(await video.evaluate(() => !document.querySelector('#cancel:not(.hidden)') && document.querySelector('#result').classList.contains('hidden')), 'nothing exported');
    await video.evaluate(() => captodeEdits.replace({ ...captodeEdits.get(), captions: [], captionStyle: { ...captodeEdits.get().captionStyle, burn: true } }));
  },

  async 'a rate link after a few exports, once'({ video }) {
    await video.evaluate(() => chrome.storage.local.set({ exportCount: 4, rateAsked: false }));
    await video.click('#formats [data-f="gif"]');
    await video.click('#convert');
    await video.waitForFunction(() => !document.querySelector('#result').classList.contains('hidden'), { timeout: 120000, polling: 100 });
    await video.waitForFunction(() => !document.querySelector('#rate').classList.contains('hidden'), { timeout: 5000, polling: 100 });
    ok(/^https:/.test(await video.$eval('#rate-link', (a) => a.href)), 'to the store page');
    await video.click('#rate-no');
    ok(await video.evaluate(async () => (await chrome.storage.local.get('rateAsked')).rateAsked === true), 'not asked again');
    await video.click('#redo-export').catch(() => {});
  },

  async 'templates: a tutorial in one click'({ video }) {
    await video.click('#templates [data-template="tutorial"]');
    await sleep(600);
    const e = await video.evaluate(() => captodeEdits.get());
    ok(e.chapters.length >= 1 && e.captionStyle.embed, `a chapter and subtitles: ${JSON.stringify({ c: e.chapters.length, embed: e.captionStyle.embed })}`);
    ok(await video.evaluate(() => document.querySelector('#formats [data-f="mp4"]').classList.contains('on')), 'MP4');
  },

  async 'an export cut short is offered again when the recording opens'({ video }) {
    await video.evaluate(() => localStorage.setItem(`captode-running-${new URLSearchParams(location.search).get('id')}`, JSON.stringify({ kind: 'export', at: Date.now() })));
    await video.reload();
    await video.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
    await video.waitForFunction(() => /finish/i.test(document.querySelector('.toast')?.textContent || ''), { timeout: 10000, polling: 100 });
    ok(await video.evaluate(() => !!document.querySelector('.toast .toast-action')), 'with Export again');
  },

  async 'voiceover: recorded while the video plays, kept as a voiceover, split at cuts'({ video }) {
    const pieces = await video.evaluate(async () => {
      const { clipMap, normaliseEdits } = await import('/lib/video-edits.js');
      const { voicePieces } = await import('/video/voiceover.js');
      return voicePieces(clipMap(normaliseEdits({ cuts: [{ id: 'x', from: 1, to: 2 }] }), 0, 4), 0.5, 2);
    });
    ok(pieces.length === 2 && Math.abs(pieces[1].from - 2) < 0.01 && Math.abs(pieces[1].offset - 0.5) < 0.01, `split where the cut is: ${JSON.stringify(pieces)}`);
    // A tone stands in for the microphone.
    await video.evaluate(() => {
      captodeEdits.replace({ ...captodeEdits.get(), cuts: [], layers: [] });
      navigator.mediaDevices.getUserMedia = async () => {
        const ac = new AudioContext(), o = ac.createOscillator(), d = ac.createMediaStreamDestination();
        o.connect(d); o.start();
        return d.stream;
      };
      const p = document.querySelector('#player'); p.pause(); p.currentTime = 0.5;
      document.querySelector('#sound-section').open = true;
    });
    await video.$eval('#vo-rec', (b) => b.scrollIntoView({ block: 'center' }));
    await video.click('#vo-rec');
    await sleep(1500);
    await video.click('#vo-rec');
    await video.waitForFunction(() => captodeEdits.get().layers.some((l) => l.kind === 'sound'), { timeout: 30000, polling: 200 });
    const l = await video.evaluate(() => captodeEdits.get().layers.find((x) => x.kind === 'sound'));
    near(l.from, 0.5, 0.2, 'where the voice started');
    ok(l.to - l.from > 0.8 && l.volume === 1, `about as long as spoken: ${JSON.stringify(l)}`);
    const mp4 = await exportAs(video, 'mp4');
    ok(mp4.length > 10000, 'exports with the voiceover');
    await video.evaluate(() => captodeEdits.replace({ ...captodeEdits.get(), layers: [] }));
  },

  async 'sound: background noise lowered between words, and the volume evened out'({ video }) {
    const g = await video.evaluate(async () => {
      const { soundCurve } = await import('/lib/video-edits.js');
      const rms = new Float32Array(200).map((_, i) => (i % 40 < 20 ? (i < 100 ? 0.05 : 0.2) : 0.001));
      const c = soundCurve({ step: 0.05, rms }, { clean: true, level: true });
      return [c.g[10], c.g[30], c.g[150]];
    });
    ok(g[1] < 0.4 && g[0] > 0.8 && g[2] < g[0], `quieter between words, loud speech brought down: ${g.map((x) => x.toFixed(2))}`);
    await video.evaluate(() => { document.querySelector('#sound-section').open = true; });
    await video.$eval('#au-clean', (b) => b.scrollIntoView({ block: 'center' }));
    await video.click('#au-clean');
    await video.click('#au-level');
    const a = await video.evaluate(() => captodeEdits.get().audio);
    ok(a.clean && a.level, 'both kept with the edits');
    const mp4 = await exportAs(video, 'mp4');
    ok(mp4.length > 10000, 'exports with the sound cleaned up');
    await video.click('#au-clean');
    await video.click('#au-level');
  },

  async 'zoom that follows the pointer'({ video }) {
    const v = await video.evaluate(async () => {
      const { pointerPath, viewAt, clipMap, normaliseEdits } = await import('/lib/video-edits.js');
      const e = normaliseEdits({ zooms: [{ id: 'z', from: 0, to: 10, scale: 2, follow: true }] });
      const path = pointerPath([{ t: 0, x: 0.2, y: 0.2 }, { t: 4, x: 0.8, y: 0.8 }]);
      const map = clipMap(e, 0, 10);
      return [viewAt(e, map, 2, 2, path), viewAt(e, map, 7, 7, path)];
    });
    ok(v[1].x > v[0].x + 0.2, `the view moves with the pointer: ${JSON.stringify(v)}`);
    ok(await video.$eval('#ed-follow', (b) => b.classList.contains('hidden')), 'not offered without a pointer recorded');
  },

  async 'filler words: found in the captions, heard, and cut in one step'({ video }) {
    await video.evaluate(() => {
      captodeEdits.replace({ ...captodeEdits.get(), cuts: [], captions: [{ id: 'f0', from: 0.5, to: 2.5, text: 'So um this is uh fine', size: 2 }] });
      captodeEdits.chooseCaption('f0');
      document.querySelector('#edit-section').open = true;
    });
    await sleep(200);
    await video.$eval('#ed-item [data-fillers]', (b) => b.scrollIntoView({ block: 'center' }));
    await video.click('#ed-item [data-fillers]');
    await video.waitForSelector('dialog.cap-review[open]', { timeout: 5000 });
    const n = await video.$$eval('dialog.cap-review[open] input[type=checkbox]', (l) => l.length);
    ok(n === 2, `both found: ${n}`);
    await video.click('dialog.cap-review[open] [data-cut]');
    await sleep(300);
    const e = await video.evaluate(() => captodeEdits.get());
    ok(e.cuts.length === 2 && e.captions[0].text === 'So this is fine', `cut, and out of the caption: ${JSON.stringify({ cuts: e.cuts.length, text: e.captions[0].text })}`);
    await video.evaluate(() => captodeEdits.replace({ ...captodeEdits.get(), cuts: [], captions: [] }));
  },

  async 'several exports at once, in the background'({ video }) {
    if (await video.$eval('#export-several', (b) => b.classList.contains('hidden'))) return 'no background exports in this browser';
    await video.click('#formats [data-f="mp4"]');
    await video.click('#export-several');
    await video.waitForSelector('dialog .several', { timeout: 5000 });
    const picked = await video.$$eval('dialog .several input:checked', (l) => l.map((i) => i.value));
    ok(picked.includes('mp4') && picked.includes('upright'), `this format and an upright copy, to start: ${picked}`);
    await video.click('dialog [data-go]');
    await video.waitForFunction(() => /2/.test(document.querySelector('.toast')?.textContent || ''), { timeout: 15000, polling: 100 });
    ok(await video.evaluate(() => document.querySelector('#formats [data-f="mp4"]').classList.contains('on')), 'the format chosen stays');
  },

  async 'the pointer is noted a few times a second while a tab is recorded, and nothing more'({ video }) {
    const sent = await video.evaluate(async () => {
      const { trackClicks } = await import('/content/page.js');
      const got = [];
      const real = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async (m) => { got.push(m); };
      trackClicks(true);
      for (let i = 0; i < 30; i++) {
        dispatchEvent(new PointerEvent('pointermove', { clientX: 10 + i * 20, clientY: 50, pointerType: 'mouse' }));
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 1100));
      trackClicks(false);
      chrome.runtime.sendMessage = real;
      return got.filter((m) => m.type === 'rec-moves');
    });
    const points = sent.flatMap((m) => m.points);
    ok(points.length >= 6 && points.length <= 12, `about ten a second: ${points.length}`);
    ok(points.every((p) => Object.keys(p).sort().join() === 'at,x,y'), 'only where and when');
  },

  async 'joined clips keep the recording\'s colour tag, so the newest Chrome can seek in them'({ ctl, clip }) {
    const r = await ctl.evaluate(async (id) => {
      const { getCapture } = await import('/lib/db.js');
      const { joinPieces } = await import('/lib/join.js');
      const { demuxWebm } = await import('/lib/webm.js');
      const rec = await getCapture(id);
      const { blob } = await joinPieces([{ blob: rec.blob, from: 0, len: 2 }, { blob: rec.blob, from: 0, len: 2 }], { fps: 30 });
      return { joined: demuxWebm(await blob.arrayBuffer()).video.colour || null };
    }, clip);
    ok(r.joined && Number.isFinite(r.joined.matrix), `the joined file is tagged: ${JSON.stringify(r)}`);
  },

  async 'history: every change listed, and several undone or redone at once'({ video }) {
    await video.evaluate(() => {
      document.querySelector('#edit-section').open = true;
      const p = document.querySelector('#player'); p.pause(); p.currentTime = 0.5;
      captodeEdits.add('cuts', { from: 0.5, to: 1 });
      captodeEdits.add('captions', { from: 1.5, to: 2.5, text: 'Hi' });
      captodeEdits.add('zooms', { from: 2, to: 3 });
    });
    await video.$eval('#ed-hist-open', (b) => b.scrollIntoView({ block: 'center' }));
    await video.click('#ed-hist-open');
    const rows = await video.$$eval('#ed-hist .hist-row', (l) => l.map((r) => [r.firstChild.textContent, r.classList.contains('now')]));
    const names = rows.map((r) => r[0]);
    ok(names[0] === 'Zoom added' && rows[0][1] && names.includes('Caption added') && names.includes('Cut added') && names.at(-1) === 'As recorded', `newest first: ${JSON.stringify(rows)}`);
    // Back two steps at once: just after the cut.
    await video.evaluate(() => [...document.querySelectorAll('#ed-hist .hist-row')].find((r) => r.firstChild.textContent === 'Cut added').click());
    let e = await video.evaluate(() => captodeEdits.get());
    ok(e.cuts.length === 1 && !e.captions.some((c) => c.text === 'Hi') && !e.zooms.length, 'the caption and zoom undone together');
    // And forward again, both at once.
    await video.evaluate(() => [...document.querySelectorAll('#ed-hist .hist-row.future')][0].click());
    e = await video.evaluate(() => captodeEdits.get());
    ok(e.zooms.length === 1 && e.captions.some((c) => c.text === 'Hi'), 'redone together');
    await video.click('#ed-hist-open');
    await video.evaluate(() => captodeEdits.replace({ ...captodeEdits.get(), cuts: [], captions: [], zooms: [] }));
  },
};

