// The step-by-step guide page: a step for each click in a recording, with notes to edit,
// downloaded as a web page, a PDF or Markdown. Everything happens on the device.
import { getCapture, saveGuide } from '../lib/db.js';
import { t, localize } from '../lib/i18n.js';
import { toast, enhance } from '../lib/ui.js';
import { guideSteps, frameTime, drawMarker, stepPage, buildGuidePage, guideMarkdown, guideClipboard, stepAlt } from '../lib/guide.js';
import { pagesToPdf } from '../lib/formats.js';
import { zip } from '../lib/zip.js';
import { fileStem } from '../lib/filename.js';
import { getSettings } from '../lib/settings.js';
import { canTranslate, languageOptions, translateAll, translateError, languageName } from '../lib/translate.js';
import { once, blobToDataUrl } from '../lib/util.js';

localize();
enhance();

const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id');
const MAX_WIDTH = 1600; // pictures wider than this are scaled down

let title = '';
let steps = []; // [{ t, x, y, text, canvas, url }]
let created = 0;
let url = '';


/** The recording's frames at each step, each with its marker drawn. */
async function grabFrames(blob, list) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = URL.createObjectURL(blob);
  try {
    await once(v, 'loadedmetadata');
    for (const [i, s] of list.entries()) {
      v.currentTime = frameTime(s);
      await once(v, 'seeked');
      const scale = Math.min(1, MAX_WIDTH / v.videoWidth);
      const c = new OffscreenCanvas(Math.round(v.videoWidth * scale), Math.round(v.videoHeight * scale));
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, c.width, c.height);
      s.clean = c; // without a marker: numbers change when a step is removed
      s.canvas = marked(s, i + 1);
    }
  } finally {
    URL.revokeObjectURL(v.src);
    v.removeAttribute('src');
    v.load();
  }
}

function marked(s, n) {
  const c = new OffscreenCanvas(s.clean.width, s.clean.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(s.clean, 0, 0);
  drawMarker(ctx, s.x, s.y, n);
  return c;
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveGuide(id, { title, steps: steps.map(({ t: at, x, y, text }) => ({ t: at, x, y, text })) }).catch(() => {});
  }, 400);
}

let renders = 0;
/** Shows the steps; the list is swapped in whole, once every picture is ready. */
async function render() {
  const mine = ++renders;
  const list = $('#steps');
  const items = [];
  $('#empty').classList.toggle('hidden', steps.length > 0);
  for (const b of ['#copy', '#dl-page', '#dl-pdf', '#dl-md']) $(b).disabled = !steps.length;
  for (const [i, s] of steps.entries()) {
    s.canvas = marked(s, i + 1);
    const li = document.createElement('li');
    li.className = 'step';
    li.innerHTML = `<div class="head"><span class="n"></span><textarea rows="1"></textarea><div class="tools">
      <button class="btn ghost icon" data-act="up"><svg class="i" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button>
      <button class="btn ghost icon" data-act="down"><svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
      <button class="btn ghost icon" data-act="remove"><svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>
    </div></div><img alt="">`;
    li.querySelector('.n').textContent = String(i + 1);
    const note = li.querySelector('textarea');
    note.value = s.text;
    note.setAttribute('aria-label', t('guide_step_n', String(i + 1)));
    note.addEventListener('input', () => { s.text = note.value; save(); });
    const tips = { up: 'guide_move_up', down: 'guide_move_down', remove: 'guide_remove_step' };
    for (const b of li.querySelectorAll('[data-act]')) {
      const label = t(tips[b.dataset.act]);
      b.setAttribute('aria-label', label);
      b.dataset.tip = label;
      b.disabled = (b.dataset.act === 'up' && i === 0) || (b.dataset.act === 'down' && i === steps.length - 1);
      b.addEventListener('click', () => act(b.dataset.act, i));
    }
    const img = li.querySelector('img');
    img.alt = stepAlt(s.text, i + 1);
    img.src = URL.createObjectURL(await s.canvas.convertToBlob({ type: 'image/png' }));
    items.push(li);
  }
  if (mine !== renders) { for (const li of items) URL.revokeObjectURL(li.querySelector('img').src); return; } // a newer one is coming
  for (const img of list.querySelectorAll('img')) URL.revokeObjectURL(img.src);
  list.replaceChildren(...items);
  enhance(list);
}

async function act(what, i) {
  if (what === 'remove') {
    const [gone] = steps.splice(i, 1);
    await render();
    save();
    toast(t('guide_step_removed'), { ms: 6000, action: { label: t('editor_undo'), run: async () => { steps.splice(i, 0, gone); await render(); save(); } } });
    return;
  }
  const j = what === 'up' ? i - 1 : i + 1;
  [steps[i], steps[j]] = [steps[j], steps[i]];
  await render();
  save();
  $('#steps').children[j]?.querySelector(`[data-act="${what}"]`)?.focus();
}

// ---------- downloads ----------

async function stem() {
  return fileStem((await getSettings()).fileName, { title: title || 'guide', url, when: new Date(created || Date.now()) });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

const dataUrl = async (c, png = false) => {
  // WebP keeps screenshots sharp and small; PNG where the browser can't write WebP,
  // and for pasting: not every document or wiki takes WebP.
  let blob = png ? null : await c.convertToBlob({ type: 'image/webp', quality: 0.9 });
  if (blob?.type !== 'image/webp') blob = await c.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
};

async function busy(button, fn) {
  const label = button.textContent;
  for (const b of document.querySelectorAll('.actions .btn')) b.disabled = true;
  button.textContent = t('guide_working');
  try { await fn(); } catch (e) { toast(String(e?.message || e), { kind: 'error' }); } finally {
    button.textContent = label;
    for (const b of document.querySelectorAll('.actions .btn')) b.disabled = !steps.length;
  }
}

// Copied with its pictures, to paste into Google Docs, Notion, Confluence, Word or an email.
$('#copy').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const items = [];
  for (const s of steps) items.push({ text: s.text, image: await dataUrl(s.canvas, true), width: s.canvas.width, height: s.canvas.height });
  const { html, text } = guideClipboard({ title: title || t('guide_heading'), steps: items });
  // The clipboard can stall (another app holding it, say): don't leave the user waiting.
  await Promise.race([
    navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]),
    new Promise((_, reject) => setTimeout(() => reject(new Error(t('guide_copy_failed'))), 8000)),
  ]);
  toast(t('guide_copied'), { kind: 'success' });
}));

$('#dl-page').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const items = [];
  for (const s of steps) items.push({ text: s.text, image: await dataUrl(s.canvas), width: s.canvas.width, height: s.canvas.height });
  download(new Blob([buildGuidePage({ title: title || t('guide_heading'), steps: items })], { type: 'text/html' }), `${await stem()}.html`);
}));

$('#dl-pdf').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const pages = steps.map((s, i) => stepPage(s.canvas, i + 1, s.text, i === 0 ? title || t('guide_heading') : ''));
  download(await pagesToPdf(pages), `${await stem()}.pdf`);
}));

$('#dl-md').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const name = await stem();
  const files = steps.map((_, i) => `images/step-${String(i + 1).padStart(2, '0')}.png`);
  const md = guideMarkdown({ title: title || t('guide_heading'), steps, files });
  const entries = [{ name: `${name}/${name}.md`, data: new TextEncoder().encode(md) }];
  for (const [i, s] of steps.entries()) {
    entries.push({ name: `${name}/${files[i]}`, data: new Uint8Array(await (await s.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()) });
  }
  download(zip(entries), `${name}.zip`);
}));

// ---------- translating ----------

// Where the browser can't, the page says so rather than leaving the menu out silently.
if (!canTranslate) $('#translate-note').classList.remove('hidden');
if (canTranslate) {
  const sel = $('#translate');
  sel.innerHTML = languageOptions();
  sel.classList.remove('hidden');
  sel.addEventListener('change', async () => {
    const target = sel.value;
    if (!target || !steps.length) { sel.value = ''; return; }
    sel.disabled = true;
    const before = { title, texts: steps.map((s) => s.text) };
    toast(t('translate_working'), { ms: 3000 });
    try {
      const out = await translateAll([title, ...before.texts], target, (f) => toast(t('translate_download', String(Math.round(f * 100))), { ms: 2000 }));
      const put = (tl, texts) => {
        title = tl;
        $('#title').value = tl;
        steps.forEach((s, i) => { s.text = texts[i] ?? s.text; });
      };
      put(out[0], out.slice(1));
      await render();
      save();
      toast(t('translate_done', languageName(target)), { kind: 'success', ms: 6000, action: { label: t('editor_undo'), run: async () => { put(before.title, before.texts); await render(); save(); } } });
    } catch (e) {
      toast(translateError(e), { kind: 'error', ms: 6000 });
    } finally {
      sel.value = '';
      sel.disabled = false;
    }
  });
}

// ---------- start ----------

$('#title').addEventListener('input', (e) => { title = e.target.value; save(); });

const rec = id ? await getCapture(id) : null;
$('#loading').classList.add('hidden');
if (!rec?.blob?.type.startsWith('video/')) {
  $('#empty').classList.remove('hidden');
  $('#title').classList.add('hidden');
} else {
  created = rec.created || 0;
  url = rec.meta?.url || '';
  title = rec.guide?.title ?? rec.meta?.title ?? '';
  $('#title').value = title;
  $('#title').placeholder = t('guide_heading');
  if (title) document.title = `${title} — Captode`;
  steps = rec.guide?.steps?.length ? rec.guide.steps.map((s) => ({ ...s })) : guideSteps(rec.meta?.clicks, rec.meta?.duration || Infinity);
  $('#loading').classList.toggle('hidden', !steps.length);
  if (steps.length) await grabFrames(rec.blob, steps);
  $('#loading').classList.add('hidden');
  await render();
}
