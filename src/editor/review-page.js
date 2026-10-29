// "Share for review": a single HTML file with the annotated capture, a numbered
// note for each step, and where the capture came from. It needs nothing else to
// open (no server, no account), so it can be attached to a ticket or sent in chat.

import { t } from '../lib/i18n.js';
import { esc } from '../lib/util.js';

/** The language the page is written in. */
const lang = () => { try { return chrome.i18n.getUILanguage(); } catch { return 'en'; } };


/**
 * `image`: a data: URL. `steps`: [{ n, x, y (fractions of the image), color, note }].
 * `labels`: text written on the capture. `facts`: [[label, value]].
 */
export function buildReviewPage({ title, summary, image, width, height, steps, labels, facts }) {
  const markers = steps.map((s, i) =>
    `<a class="marker" href="#step-${i}" data-i="${i}" style="left:${(s.x * 100).toFixed(3)}%;top:${(s.y * 100).toFixed(3)}%;--c:${esc(s.color)}" aria-label="${esc(t('layer_step', s.n))}"></a>`).join('');
  const notes = steps.map((s, i) =>
    `<li id="step-${i}" data-i="${i}" tabindex="-1"><span class="n" style="--c:${esc(s.color)}">${esc(s.n)}</span><div>${s.note ? esc(s.note).replace(/\n/g, '<br>') : `<span class="muted">${esc(t('page_no_note'))}</span>`}</div></li>`).join('');
  const factRows = facts.filter(([, v]) => v).map(([k, v]) => {
    const value = /^https?:\/\//.test(v) ? `<a href="${esc(v)}" rel="noopener noreferrer">${esc(v)}</a>` : esc(v);
    return `<div><dt>${esc(k)}</dt><dd>${value}</dd></div>`;
  }).join('');
  return `<!doctype html>
<html lang="${esc(lang())}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Captode">
<title>${esc(title)}</title>
<style>
:root { --bg: #f6f6f9; --panel: #fff; --text: #17171c; --muted: #6b6b78; --line: #e4e4ea; --accent: #5b4bff; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #111116; --panel: #1a1a21; --text: #ececf1; --muted: #9a9aa8; --line: #2c2c36; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header { padding: 28px 32px 8px; max-width: 1400px; margin: 0 auto; }
h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -0.01em; }
.summary { margin: 0; max-width: 72ch; white-space: pre-wrap; }
main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; padding: 20px 32px 40px; max-width: 1400px; margin: 0 auto; align-items: start; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 16px; } header { padding: 20px 16px 4px; } }
figure { margin: 0; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.15); background: repeating-conic-gradient(rgba(127,127,127,.15) 0 25%, transparent 0 50%) 0 0 / 16px 16px; cursor: zoom-in; }
figure.full { cursor: zoom-out; overflow: auto; max-height: 85vh; }
figure .shot { position: relative; }
figure img { display: block; width: 100%; height: auto; }
figure.full .shot { width: ${width}px; }
.marker { position: absolute; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; outline: none; }
.marker.on, .marker:focus-visible { box-shadow: 0 0 0 3px #fff, 0 0 0 6px var(--c, var(--accent)); }
aside { position: sticky; top: 16px; display: grid; gap: 16px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
ol li { display: flex; gap: 10px; padding: 8px; margin: -8px; border-radius: 8px; outline: none; cursor: pointer; }
ol li.on { background: rgba(91,75,255,.1); }
.n { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--c, var(--accent)); color: #fff; font-size: 13px; font-weight: 700; }
.muted { color: var(--muted); }
ul.labels { margin: 0; padding-left: 18px; }
dl { margin: 0; display: grid; gap: 6px; font-size: 13px; }
dl div { display: grid; grid-template-columns: 96px 1fr; gap: 8px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
a { color: var(--accent); }
footer { text-align: center; padding: 0 16px 32px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  ${summary ? `<p class="summary">${esc(summary)}</p>` : ''}
</header>
<main>
  <figure id="fig" title="${esc(t('page_full_size'))}">
    <div class="shot">
      <img src="${image}" width="${width}" height="${height}" alt="${esc(summary ? `${title}: ${summary.split('\n')[0].slice(0, 160)}` : title)}">
      ${markers}
    </div>
  </figure>
  <aside>
    ${steps.length ? `<section><h2>${esc(t('page_steps'))}</h2><ol id="notes">${notes}</ol></section>` : ''}
    ${labels.length ? `<section><h2>${esc(t('page_labels'))}</h2><ul class="labels">${labels.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>` : ''}
    <section><h2>${esc(t('page_about'))}</h2><dl>${factRows}</dl></section>
  </aside>
</main>
<footer>${esc(t('page_made_with'))}</footer>
<script>
  // Steps and their markers light up together; the image toggles full size.
  const fig = document.getElementById('fig');
  const all = (i) => document.querySelectorAll('[data-i="' + i + '"]');
  let on = null;
  const show = (i) => {
    if (on !== null) all(on).forEach((e) => e.classList.remove('on'));
    on = i;
    all(i).forEach((e) => e.classList.add('on'));
  };
  document.querySelectorAll('ol li').forEach((li) => {
    li.addEventListener('click', () => { show(li.dataset.i); document.querySelector('.marker[data-i="' + li.dataset.i + '"]').scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  });
  document.querySelectorAll('.marker').forEach((m) => {
    m.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); show(m.dataset.i); const li = document.getElementById('step-' + m.dataset.i); li.focus({ preventScroll: true }); li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  });
  fig.addEventListener('click', (e) => { if (e.target.tagName === 'IMG') fig.classList.toggle('full'); });
</script>
</body>
</html>
`;
}
