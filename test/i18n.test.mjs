// Translations: every page in another language shows translated text, and no raw
// message key (such as "editor_quick_styles") ever reaches the screen.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, open, ok, recordClip } from './helpers.mjs';

const locales = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', '_locales');
const keys = Object.keys(JSON.parse(readFileSync(join(locales, 'en', 'messages.json'), 'utf8')));
const messages = (lang) => JSON.parse(readFileSync(join(locales, lang, 'messages.json'), 'utf8'));

/** Chrome's interface language: --lang on Windows, AppleLanguages on macOS, LANGUAGE on Linux. */
const languageArgs = (lang) => [`--lang=${lang}`, ...(process.platform === 'darwin' ? ['-AppleLanguages', `(${lang})`] : [])];

/** All text a person or screen reader would meet: content, titles, labels, placeholders. */
const pageText = (page) => page.evaluate(() => {
  const parts = [document.title, document.body.innerText];
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[data-tip],optgroup[label]')) {
    for (const a of ['title', 'aria-label', 'placeholder', 'data-tip', 'label']) if (el.getAttribute(a)) parts.push(el.getAttribute(a));
  }
  for (const o of document.querySelectorAll('option')) parts.push(o.textContent);
  return parts.join('\n');
});

/** Opens Captode's pages in `lang` and checks them. */
async function checkLanguage(lang) {
  const env = await launch({ args: languageArgs(lang), env: { LANGUAGE: lang } });
  const { browser, url } = env;
  const m = messages(lang);
  const leaks = [];
  const look = async (name, page) => {
    const text = await pageText(page);
    for (const k of keys) if (new RegExp(`\\b${k}\\b`).test(text)) leaks.push(`${name}: ${k}`);
    return text;
  };
  try {
    const lab = await open(browser, url('lab/lab.html'));
    ok(await lab.evaluate(() => chrome.i18n.getUILanguage()).then((l) => l.startsWith(lang.split('_')[0])), `Chrome is not running in ${lang}`);
    const [image, clip] = [
      await lab.evaluate(async () => {
        const { putCapture } = await import('/lib/db.js');
        const c = new OffscreenCanvas(1206, 2622);
        c.getContext('2d').fillRect(0, 0, 100, 100);
        return putCapture(await c.convertToBlob(), { title: 'Page', mode: 'visible', dpr: 3 });
      }),
      await recordClip(lab, { seconds: 1 }),
    ];

    const popup = await open(browser, url('popup/popup.html'), { width: 340, height: 700 });
    let text = await look('popup', popup);
    ok(text.includes(m.popup_choose_what_to_capture.message), `popup is not in ${lang}`);
    await popup.evaluate(() => document.querySelector('[data-kind="video"]').click());
    await look('popup (record)', popup);

    const settings = await open(browser, url('settings/settings.html'));
    text = await look('settings', settings);
    ok(text.includes(m.settings_theme.message), `settings are not in ${lang}`);

    const ed = await open(browser, url(`editor/editor.html?id=${image}&reopen=1`), { width: 1440, height: 900 });
    await ed.waitForFunction(() => /px/.test(document.querySelector('#doc-dims').textContent), { polling: 100 });
    text = await look('editor', ed);
    ok(text.includes(m.editor_quick_styles.message), `the editor is not in ${lang}`);
    for (const pane of ['adjust', 'review', 'export']) {
      await ed.evaluate((p) => document.querySelector(`[data-pane="${p}"]`).click(), pane);
      await ed.evaluate(() => { const d = document.querySelector('#device-panel [data-k="enabled"]'); if (d && !d.checked) d.click(); });
      await new Promise((r) => setTimeout(r, 600));
      await look(`editor (${pane})`, ed);
    }
    ok((await pageText(ed)).includes(m.dev_show.message), `the device panel is not in ${lang}`);

    const video = await open(browser, url(`video/video.html?id=${clip}`), { width: 1440, height: 900 });
    await video.waitForFunction(() => /fps/.test(document.querySelector('#dims').textContent), { polling: 100 });
    text = await look('video', video);
    ok(text.includes(m.video_trim.message), `the video page is not in ${lang}`);

    const cmp = await open(browser, url('compare/compare.html'), { width: 1440, height: 900 });
    text = await look('compare', cmp);
    ok(text.includes(m.compare_compare_two_images.message), `compare is not in ${lang}`);

    ok(!leaks.length, `untranslated keys on screen: ${[...new Set(leaks)].slice(0, 12).join(', ')}`);
  } finally {
    await env.close();
  }
}

export const tests = {
  async 'in German, every page is translated and no message key shows'() { await checkLanguage('de'); },
  async 'in Japanese, every page is translated and no message key shows'() { await checkLanguage('ja'); },
  async 'every language has every message, with its placeholders'() {
    const en = messages('en');
    for (const lang of ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt_BR', 'zh_CN']) {
      const m = messages(lang);
      for (const [k, { message }] of Object.entries(en)) {
        ok(m[k], `${lang} lacks ${k}`);
        const marks = (s) => [...s.matchAll(/\$\d|<\/?(kbd|b)>/g)].map((x) => x[0]).sort().join();
        ok(marks(m[k].message) === marks(message), `${lang} ${k}: placeholders differ`);
      }
    }
  },
};
