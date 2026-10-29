// Step-by-step guides made from a recording: a step for each click, with the frame
// at that moment, a ring and a number where the click was, and a note to edit.
// Exported as a single web page, a PDF or Markdown, all made on the device.

import { t } from './i18n.js';
import { drawStep } from './shapes.js';
import { esc } from './util.js';

const ACCENT = '#5b4bff';
const lang = () => { try { return chrome.i18n.getUILanguage(); } catch { return 'en'; } };

/** A step's note to start with: what was clicked, when the recording knows. */
export function stepText(click) {
  const label = String(click.label || '').trim();
  if (!label) return t('guide_step_click');
  return t(click.field ? 'guide_step_field' : 'guide_step_click_label', label);
}

/**
 * The steps for `clicks` ([{ t, x, y, label?, field? }], recording seconds and
 * fractions of the picture) within [0, duration]: one for each click, a double click
 * (or clicks in quick succession on the same spot) counting once.
 */
export function guideSteps(clicks = [], duration = Infinity) {
  const list = clicks.filter((c) => c.t >= 0 && c.t <= duration).sort((a, b) => a.t - b.t);
  const steps = [];
  for (const c of list) {
    const last = steps[steps.length - 1];
    if (last && c.t - last.t < 0.6 && Math.hypot(c.x - last.x, c.y - last.y) < 0.03) continue;
    steps.push({ t: c.t, x: c.x, y: c.y, text: stepText(c) });
  }
  return steps;
}

/** When to take a step's picture: just before the click, showing what was clicked. */
export const frameTime = (step) => Math.max(0, step.t - 0.05);

/** Draws the ring and number for step `n` at (x, y), fractions of `ctx`'s canvas. */
export function drawMarker(ctx, x, y, n) {
  const { width: W, height: H } = ctx.canvas;
  const r = Math.max(14, Math.round(Math.min(W, H) * 0.03));
  const cx = x * W, cy = y * H;
  ctx.save();
  ctx.lineWidth = Math.max(3, r * 0.22);
  ctx.strokeStyle = '#fff';
  ctx.beginPath(); ctx.arc(cx, cy, r + ctx.lineWidth * 0.6, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = ACCENT;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // The number beside the ring, kept inside the picture: a step as the editor draws it.
  const br = Math.max(11, r * 0.75);
  const bx = Math.min(W - br - 2, Math.max(br + 2, cx + r * 0.95));
  const by = Math.min(H - br - 2, Math.max(br + 2, cy - r * 0.95));
  drawStep(ctx, bx, by, br * 2, n, ACCENT);
}

/** Lines of `text` that fit `width` in `ctx`'s font (the note's own line breaks kept). */
function wrap(ctx, text, width) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    // Word by word, or character by character for languages written without spaces.
    const parts = /\s/.test(para) ? para.split(/(\s+)/) : [...para];
    for (const w of parts) {
      const next = line + w;
      if (line && ctx.measureText(next).width > width) { lines.push(line.trimEnd()); line = w.trimStart(); } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * A page for the PDF: step `n`'s note above its picture (`image`, a canvas with the
 * marker drawn), and the guide's title above the first.
 */
export function stepPage(image, n, text, title = '') {
  const W = 1240, m = 56, iw = W - m * 2;
  const ih = Math.round(image.height * (iw / image.width));
  const font = (px, weight = 400) => `${weight} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const probe = new OffscreenCanvas(1, 1).getContext('2d');
  probe.font = font(30);
  const lines = wrap(probe, text, iw - 64);
  probe.font = font(44, 700);
  const titleLines = title ? wrap(probe, title, iw) : [];
  const head = (titleLines.length ? titleLines.length * 56 + 28 : 0);
  const H = m + head + Math.max(48, lines.length * 42) + 28 + ih + m;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  let y = m;
  ctx.fillStyle = '#17171c';
  ctx.font = font(44, 700);
  for (const l of titleLines) { ctx.fillText(l, m, y); y += 56; }
  if (titleLines.length) y += 28;
  ctx.fillStyle = ACCENT;
  ctx.beginPath(); ctx.arc(m + 22, y + 22, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = font(24, 700);
  ctx.textAlign = 'center';
  ctx.fillText(String(n), m + 22, y + 9);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#17171c';
  ctx.font = font(30);
  lines.forEach((l, i) => ctx.fillText(l, m + 64, y + 6 + i * 42));
  y += Math.max(48, lines.length * 42) + 28;
  ctx.drawImage(image, m, y, iw, ih);
  ctx.strokeStyle = '#e4e4ea';
  ctx.lineWidth = 2;
  ctx.strokeRect(m, y, iw, ih);
  return c;
}

/**
 * A picture's alternative text: what the step says (its first line, kept short), so
 * screen readers and pages that can't show the picture still tell the step.
 */
export function stepAlt(text, n) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!line) return t('guide_step_n', String(n));
  return line.length > 125 ? `${line.slice(0, 124).trimEnd()}…` : line;
}

/**
 * The guide for the clipboard, to paste into a document, wiki or email:
 * `{ html, text }`. `steps`: [{ text, image (a data: URL), width, height }].
 */
export function guideClipboard({ title, steps }) {
  const W = 720; // shown at most this wide where pasted; the picture keeps its pixels
  const items = steps.map((s, i) => {
    const w = Math.min(W, s.width), h = Math.round(s.height * (w / s.width));
    return `<li><p>${esc(s.text).replace(/\n/g, '<br>')}</p><p><img src="${s.image}" width="${w}" height="${h}" alt="${esc(stepAlt(s.text, i + 1))}"></p></li>`;
  }).join('');
  const html = `<meta charset="utf-8"><h1>${esc(title)}</h1><ol>${items}</ol>`;
  const text = `${title}\n\n${steps.map((s, i) => `${i + 1}. ${String(s.text).split('\n').join('\n   ')}`).join('\n\n')}\n`;
  return { html, text };
}

/** The guide as one web page that needs nothing else. `steps`: [{ text, image (a data: URL), width, height }]. */
export function buildGuidePage({ title, steps }) {
  const items = steps.map((s, i) => `<li>
  <div class="note"><span class="n">${i + 1}</span><p>${esc(s.text).replace(/\n/g, '<br>')}</p></div>
  <img src="${s.image}" width="${s.width}" height="${s.height}" alt="${esc(stepAlt(s.text, i + 1))}" loading="lazy">
</li>`).join('\n');
  return `<!doctype html>
<html lang="${esc(lang())}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Captode">
<title>${esc(title)}</title>
<style>
:root { --bg: #f6f6f9; --panel: #fff; --text: #17171c; --muted: #6b6b78; --line: #e4e4ea; --accent: ${ACCENT}; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #111116; --panel: #1a1a21; --text: #ececf1; --muted: #9a9aa8; --line: #2c2c36; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: -0.01em; }
.count { margin: 0 0 28px; color: var(--muted); }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 28px; }
li { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px; }
.note { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
.note p { margin: 2px 0 0; white-space: normal; overflow-wrap: anywhere; }
.n { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: #fff; font-weight: 700; }
img { display: block; width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--line); }
footer { text-align: center; padding: 0 16px 32px; color: var(--muted); font-size: 12px; }
@media print { body { background: #fff; } li { break-inside: avoid; border: 0; padding: 0; } }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="count">${esc(t('guide_n_steps', String(steps.length)))}</p>
<ol>
${items}
</ol>
</main>
<footer>${esc(t('page_made_with'))}</footer>
</body>
</html>
`;
}

/** The guide in Markdown, with each step's picture as `files[i]` beside it. */
export function guideMarkdown({ title, steps, files }) {
  const md = (s) => String(s).replace(/([\\`*_[\]#<>])/g, '\\$1');
  const body = steps.map((s, i) => {
    const text = md(s.text).split('\n').join('\n   ');
    return `${i + 1}. ${text}\n\n   ![${md(stepAlt(s.text, i + 1))}](${files[i]})\n`;
  }).join('\n');
  return `# ${md(title)}\n\n${body}`;
}
