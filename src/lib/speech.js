// Captions from what is said in a recording, by the speech recognition built into the
// browser, on the device: `processLocally` makes it refuse to send any sound anywhere.
// The browser may first download its own language pack, as it does for its translator.
//
// This file is in the Chrome package only. Every other browser's package gets
// tools/speech-none.js in its place (see tools/targets.mjs), so they hold none of it.
//
// How: the recording's loudness (lib/audio-levels.js) shows where someone speaks; each
// stretch is played, silently, into the recogniser, and what it hears becomes captions
// spread over that stretch.

import { t } from './i18n.js';
import { toast } from './ui.js';
import { wait } from './util.js';

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

/** Whether this browser can recognise speech on the device. */
export const canTranscribe = typeof Recognition?.available === 'function' && 'processLocally' in (Recognition?.prototype || {});


/**
 * Where someone speaks in [start, end]: [{ from, to }] (s), from the loudness `levels`
 * ({ step, rms }). Pauses shorter than `gap` join stretches; stretches over `max` are
 * split where it is quietest; ones shorter than `min` are left out. `within`: the parts
 * kept ([{ from, to }]); only speech in them is used.
 */
export function speechParts(levels, start, end, { gap = 0.6, min = 0.35, max = 12, within = null } = {}) {
  if (!levels?.rms?.length) return [];
  const { step, rms } = levels;
  const peak = rms.reduce((m, v) => Math.max(m, v), 0);
  if (peak < 0.003) return [];
  const loud = Math.max(0.006, peak * 0.12);
  const raw = [];
  let open = null;
  for (let k = Math.floor(start / step); k * step < end && k < rms.length; k++) {
    const at = k * step;
    if (rms[k] >= loud) { if (!open) open = { from: at, to: at + step }; else open.to = at + step; }
    else if (open && at - open.to >= gap) { raw.push(open); open = null; }
  }
  if (open) raw.push(open);
  // Only where the export plays it.
  let parts = raw;
  if (within) {
    parts = raw.flatMap((p) => within.map((w) => ({ from: Math.max(p.from, w.from), to: Math.min(p.to, w.to) })).filter((x) => x.to - x.from > 0));
  }
  // Long stretches split at their quietest point, so captions stay short and timed.
  const out = [];
  const split = (p) => {
    if (p.to - p.from <= max) { out.push(p); return; }
    let best = p.from + max / 2, low = Infinity;
    for (let at = p.from + max * 0.4; at < Math.min(p.to - 1, p.from + max); at += step) {
      const v = rms[Math.floor(at / step)] ?? 0;
      if (v < low) { low = v; best = at; }
    }
    split({ from: p.from, to: best });
    split({ from: best, to: p.to });
  };
  for (const p of parts) split(p);
  return out.filter((p) => p.to - p.from >= min).map((p) => ({ from: Math.round(p.from * 100) / 100, to: Math.round(p.to * 100) / 100 }));
}

/**
 * `text` heard in [from, to] as captions of about `words` words, each lasting as long
 * as its share of the words.
 */
export function splitCaptions(text, from, to, { words = 9 } = {}) {
  const all = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!all.length) return [];
  const n = Math.ceil(all.length / words);
  const per = Math.ceil(all.length / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const part = all.slice(i * per, (i + 1) * per);
    if (!part.length) continue;
    const a = from + ((to - from) * (i * per)) / all.length;
    const b = from + ((to - from) * Math.min(all.length, (i + 1) * per)) / all.length;
    out.push({ from: Math.round(a * 100) / 100, to: Math.round(Math.max(b, a + 0.4) * 100) / 100, text: part.join(' ') });
  }
  return out;
}

/**
 * `text` heard in [from, to] as captions that break where the speaker pauses: the
 * stretch's shorter pauses (from `levels`) split it into phrases, the words are shared
 * out by how long each phrase is (people speak at about the same pace), and a caption
 * ends at a pause once it has a few words, or at `words` words at most.
 */
export function captionsAtPauses(text, from, to, levels, { words = 9 } = {}) {
  const all = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!all.length) return [];
  const phrases = levels ? speechParts(levels, from, to, { gap: 0.18, min: 0.05, max: Infinity }) : [];
  if (phrases.length < 2) return splitCaptions(text, from, to, { words });
  // Words per phrase, by its length; the rounding is evened out so they add up.
  const total = phrases.reduce((n, p) => n + p.to - p.from, 0);
  let given = 0;
  const counts = phrases.map((p, i) => {
    const want = i === phrases.length - 1 ? all.length - given : Math.round((all.length * (p.to - p.from)) / total);
    const n = Math.max(0, Math.min(all.length - given, want));
    given += n;
    return n;
  });
  // Group phrases into captions.
  const out = [];
  let k = 0, group = null;
  const close = () => {
    if (!group || !group.words.length) return;
    out.push(...splitCaptions(group.words.join(' '), group.from, group.to, { words }));
    group = null;
  };
  phrases.forEach((p, i) => {
    const mine = all.slice(k, k + counts[i]);
    k += counts[i];
    if (!mine.length) return;
    if (group && group.words.length + mine.length > words) close();
    if (!group) group = { from: p.from, to: p.to, words: [] };
    group.words.push(...mine);
    group.to = p.to;
    if (group.words.length >= 3) close(); // a pause after a few words: a caption of its own
  });
  close();
  return out;
}

/** 'available' | 'downloadable' | 'downloading' | 'unavailable' for `lang` on this device. */
export async function speechStatus(lang) {
  try {
    return await Recognition.available({ langs: [lang], processLocally: true });
  } catch {
    return 'unavailable';
  }
}

class SpeechError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** What is said in [from, to] of `buf`, played into a recogniser through `track`. */
async function hear(ctx, buf, dest, track, part, lang, signal) {
  const r = new Recognition();
  r.lang = lang;
  r.processLocally = true;
  r.continuous = true;
  r.interimResults = false;
  r.maxAlternatives = 1;
  const heard = [];
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard.push(e.results[i][0].transcript.trim());
  };
  let failure = null;
  const ended = new Promise((resolve) => {
    r.onend = resolve;
    r.onerror = (e) => {
      if (!['no-speech', 'aborted'].includes(e.error)) failure = new SpeechError(e.error);
      resolve();
    };
  });
  r.start(track);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(dest);
  const a = Math.max(0, part.from - 0.15);
  const len = Math.min(buf.duration - a, part.to + 0.3 - a);
  const played = new Promise((resolve) => { src.onended = resolve; });
  src.start(ctx.currentTime + 0.05, a, Math.max(0.05, len));
  await Promise.race([played, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
  if (signal?.aborted) { try { src.stop(); } catch { /* already over */ } r.abort(); throw new SpeechError('cancelled'); }
  await wait(400); // the last words
  r.stop();
  await Promise.race([ended, wait(6000)]);
  src.disconnect();
  if (failure) throw failure;
  return heard.filter(Boolean).join(' ');
}

/**
 * Captions for what is said in `parts` of `blob`: [{ from, to, text }]. Plays each part
 * once, at its own speed, without a sound out loud. `onProgress(f)` (0–1).
 */
export async function transcribe(blob, parts, { lang, levels = null, onProgress = () => {}, signal } = {}) {
  const ctx = new AudioContext();
  try {
    await ctx.resume();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const dest = ctx.createMediaStreamDestination(); // not to the speakers
    const track = dest.stream.getAudioTracks()[0];
    const total = parts.reduce((n, p) => n + p.to - p.from, 0) || 1;
    let done = 0;
    const out = [];
    for (const p of parts) {
      if (signal?.aborted) throw new SpeechError('cancelled');
      const text = await hear(ctx, buf, dest, track, p, lang, signal);
      out.push(...captionsAtPauses(text, p.from, p.to, levels));
      done += p.to - p.from;
      onProgress(done / total);
    }
    track.stop();
    return out;
  } finally {
    ctx.close().catch(() => {});
  }
}

// ---------- on the video page ----------

const LANGS = ['en-US', 'en-GB', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'pt-BR', 'nl-NL', 'pl-PL', 'sv-SE', 'tr-TR', 'ru-RU', 'hi-IN', 'ja-JP', 'ko-KR', 'zh-CN'];

/** Asks which language is spoken; resolves to its tag, or null. */
function askLanguage() {
  const names = new Intl.DisplayNames([navigator.language], { type: 'language' });
  const mine = navigator.language;
  const list = [...new Set([mine, ...LANGS])];
  const best = list.find((l) => l === mine) || list.find((l) => l.split('-')[0] === mine.split('-')[0]) || 'en-US';
  const d = document.createElement('dialog');
  d.className = 'modal confirm';
  d.innerHTML = `<div class="modal-body"><h2></h2><p class="muted"></p>
    <label class="field"><span></span><select></select></label>
    <div class="confirm-actions"><button type="button" class="btn" data-v="no"></button><button type="button" class="btn primary" data-v="yes"></button></div></div>`;
  d.querySelector('h2').textContent = t('speech_title');
  d.querySelector('p').textContent = t('speech_text');
  d.querySelector('.field span').textContent = t('speech_language');
  const sel = d.querySelector('select');
  for (const l of list) {
    const o = document.createElement('option');
    o.value = l;
    let label = l;
    try { label = `${names.of(l)} (${l})`; } catch { /* the tag alone */ }
    o.textContent = label;
    sel.append(o);
  }
  sel.value = best;
  d.querySelector('[data-v="no"]').textContent = t('clips_cancel');
  d.querySelector('[data-v="yes"]').textContent = t('speech_go');
  document.body.append(d);
  d.showModal();
  return new Promise((resolve) => {
    d.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      d.close();
      d.remove();
      resolve(b.dataset.v === 'yes' ? sel.value : null);
    });
    d.addEventListener('cancel', () => { d.remove(); resolve(null); });
  });
}

/**
 * Adds "Captions from speech" to the Edit section (after "Cut silent parts").
 * opts: { source() (the recording), hasAudio(), levels(), range() → { start, end },
 *   kept() → [{ from, to }] (the parts played at normal speed), busy(),
 *   run(label, fn(signal, progress)) (shows progress, with Cancel), addCaptions(list) }
 */
export function mountSpeech(opts) {
  if (!canTranscribe) return { sync() {} };
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ed-speech';
  b.id = 'ed-speech';
  b.dataset.tip = t('speech_tip');
  b.innerHTML = '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg><span></span>';
  b.querySelector('span').textContent = t('speech_button');
  document.querySelector('#ed-silence')?.after(b);
  const sync = () => { b.classList.toggle('hidden', !opts.hasAudio()); b.disabled = !opts.levels(); };

  b.addEventListener('click', async () => {
    if (opts.busy() || !opts.levels()) return;
    const lang = await askLanguage();
    if (!lang) return;
    let status = await speechStatus(lang);
    if (status === 'unavailable') { toast(t('speech_unavailable'), { kind: 'error', ms: 7000 }); return; }
    if (status !== 'available') {
      // The browser fetches its language pack once; Captode itself sends nothing.
      toast(t('speech_downloading'), { ms: 6000 });
      try {
        const ok = await Promise.race([Recognition.install({ langs: [lang], processLocally: true }), wait(300000).then(() => false)]);
        status = ok ? 'available' : await speechStatus(lang);
      } catch {
        status = 'unavailable';
      }
      if (status !== 'available') { toast(t('speech_unavailable'), { kind: 'error', ms: 7000 }); return; }
    }
    const { start, end } = opts.range();
    const parts = speechParts(opts.levels(), start, end, { within: opts.kept() });
    if (!parts.length) { toast(t('speech_none')); return; }
    try {
      const list = await opts.run(t('speech_working'), (signal, progress) => transcribe(opts.source(), parts, { lang, levels: opts.levels(), signal, onProgress: (f) => progress(f, t('speech_working')) }));
      if (!list) return;
      if (!list.length) { toast(t('speech_none')); return; }
      opts.addCaptions(list);
      toast(t('speech_done', String(list.length)), { kind: 'success', ms: 6000 });
    } catch (err) {
      if (err?.code === 'cancelled') return;
      console.warn('Captode: captions from speech failed:', err);
      toast(t(err?.code === 'language-not-supported' ? 'speech_unavailable' : 'speech_failed'), { kind: 'error', ms: 7000 });
    }
  });
  sync();
  return { sync };
}
