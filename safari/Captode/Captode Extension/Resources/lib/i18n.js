// Translations, through Chrome's own system (_locales/<language>/messages.json): Chrome
// picks the language from the browser's setting, and falls back to English for
// anything not translated.
//
// Pages keep their English text in the HTML and mark what to translate:
//   data-i18n="key"           the element's own text (its first text, not its children's)
//   data-i18n-html="key"      its whole content, for text with <b>, <kbd> or links inside
//   data-i18n-title, data-i18n-aria-label, data-i18n-placeholder, data-i18n-tip,
//   data-i18n-label, data-i18n-alt: that attribute

/** The message for `key`, with `subs` for $1, $2…; `fallback` if there is none. */
export function t(key, subs, fallback = '') {
  let m = '';
  try { m = chrome.i18n.getMessage(key, subs == null ? undefined : [].concat(subs).map(String)); } catch { /* outside the extension */ }
  if (m) return m;
  if (!fallback) return key;
  return [].concat(subs ?? []).reduce((s, v, i) => s.replaceAll(`$${i + 1}`, v), fallback);
}

const ATTRS = ['title', 'aria-label', 'placeholder', 'tip', 'label', 'alt'];

/** Translates everything marked in `root`. */
export function localize(root = document) {
  let lang = 'en';
  try { lang = chrome.i18n.getUILanguage(); } catch {}
  if (root === document) document.documentElement.lang = lang;
  if (lang.startsWith('en')) return; // the HTML is in English already
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const m = t(el.dataset.i18n);
    if (m === el.dataset.i18n) continue;
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
    if (node) node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), m);
    else el.prepend(m);
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    const m = t(el.dataset.i18nHtml);
    if (m !== el.dataset.i18nHtml) el.innerHTML = m;
  }
  for (const a of ATTRS) {
    const data = `i18n${a.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`;
    const attr = a === 'tip' ? 'data-tip' : a;
    for (const el of root.querySelectorAll(`[data-i18n-${a}]`)) {
      const m = t(el.dataset[data]);
      if (m !== el.dataset[data]) el.setAttribute(attr, m);
    }
  }
}
