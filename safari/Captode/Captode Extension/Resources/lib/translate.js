// Translating captions and guide notes with the translator built into the browser
// (Chrome's Translator API). It runs on the device: the browser fetches its own
// language model the first time, and nothing is sent anywhere by Captode. Where the
// browser has no translator (Firefox, Safari, older Chrome), it isn't offered.

import { t } from './i18n.js';
import { esc } from './util.js';

export const canTranslate = typeof globalThis.Translator?.create === 'function';

const LANGS = ['ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-Hant'];

/** `<option>`s for a "Translate into…" menu, named in the user's language. */
export function languageOptions() {
  let names = null;
  try { names = new Intl.DisplayNames([navigator.language], { type: 'language' }); } catch {}
  const list = LANGS.map((code) => [code, names?.of(code) || code]).sort((a, b) => a[1].localeCompare(b[1]));
  return `<option value="">${esc(t('translate_into'))}</option>${list.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join('')}`;
}

/**
 * `<option>`s for choosing the language something is in, `value` chosen; the first,
 * `none`, for not saying.
 */
export function languageChoices(value, none) {
  const codes = LANGS.includes(value) || !value || value === 'und' ? LANGS : [...LANGS, value];
  const list = codes.map((code) => [code, languageName(code)]).sort((a, b) => a[1].localeCompare(b[1]));
  return `<option value="">${esc(none)}</option>${list.map(([c, n]) => `<option value="${c}"${c === value ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
}

/** The language `text` is in, as the browser's detector sees it, else the user's own. */
async function sourceOf(text) {
  if (typeof globalThis.LanguageDetector?.create === 'function') {
    try {
      const d = await LanguageDetector.create();
      const [top] = await d.detect(text);
      d.destroy?.();
      if (top && top.detectedLanguage && top.detectedLanguage !== 'und' && top.confidence > 0.3) return top.detectedLanguage;
    } catch {}
  }
  return (navigator.language || 'en').split('-')[0];
}

/**
 * `texts` translated into `target`, in the same order (empty ones left alone).
 * Throws an Error whose message is 'same' (already in that language), 'unavailable'
 * (the browser can't translate between them) or the browser's own message.
 */
export async function translateAll(texts, target, onProgress) {
  const sample = texts.filter((s) => s.trim()).join('\n').slice(0, 2000);
  if (!sample) return texts;
  const source = await sourceOf(sample);
  if (source.split('-')[0] === target.split('-')[0] && source !== 'zh') throw new Error('same');
  const pair = { sourceLanguage: source, targetLanguage: target };
  if ((await Translator.availability(pair)) === 'unavailable') throw new Error('unavailable');
  const tr = await Translator.create({
    ...pair,
    monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded)); },
  });
  try {
    const out = [];
    for (const s of texts) out.push(s.trim() ? await tr.translate(s) : s);
    return out;
  } finally {
    tr.destroy?.();
  }
}

/** A message for a translateAll error. */
export function translateError(e) {
  if (e?.message === 'same') return t('translate_same');
  if (e?.message === 'unavailable') return t('translate_unavailable');
  return t('translate_failed', String(e?.message || e));
}

/** The name of language `code`, in the user's language. */
export function languageName(code) {
  try { return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) || code; } catch { return code; }
}
