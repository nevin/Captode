// "Share for review": the dialog, and the single web page it downloads.

import { buildReviewPage } from './review-page.js';
import { encodeOffThread } from '../lib/encoder.js';
import { toast, openDialog } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import { blobToDataUrl } from '../lib/util.js';
import { stepAppearance } from '../lib/shapes.js';

const $ = (s) => document.querySelector(s);

function textElement(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function sourceUrl(raw, mode) {
  if (mode === 'full') return typeof raw === 'string' ? raw : '';
  if (mode !== 'clean' || typeof raw !== 'string') return '';
  try {
    const url = new URL(raw);
    url.username = url.password = url.search = url.hash = '';
    return url.href;
  } catch { return ''; }
}

/**
 * `ed`: `hasImage()`, `finishEditing()`, `objects()`, `meta()`, `padding()`,
 * `size()` ([w, h] with padding), `imageSize()` ([w, h] without), `preview()` (a thumbnail), `render()` (the
 * annotated image without a device frame) and `commit()` (keeps the notes as an edit).
 */
export function mountShare(ed) {
  const steps = () => ed.objects().filter((o) => o.type === 'step')
    .map((object, i) => ({ object, ...stepAppearance(object, i + 1) })).sort((a, b) => a.n - b.n);
  let list = [];

  function details() {
    const meta = ed.meta();
    const [iw, ih] = ed.imageSize();
    const labels = $('#sh-labels').checked ? ed.objects().filter((o) => o.type === 'text' && typeof o.text === 'string' && o.text.trim()).map((o) => o.text.trim()) : [];
    const facts = [
      [t('share_page'), sourceUrl(meta.url, $('#sh-url').value)],
      [t('share_captured'), new Date(meta.created || Date.now()).toLocaleString()],
      [t('editor_size'), meta.dpr ? t('share_size_ratio', [`${iw} × ${ih}`, Math.round(meta.dpr * 100) / 100]) : `${iw} × ${ih} px`],
      [t('share_browser'), navigator.userAgentData?.brands?.filter((b) => !/not.a.brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(', ') || ''],
    ].filter(([, value]) => value);
    return { labels, facts };
  }

  function updatePreview() {
    const { labels, facts } = details();
    $('#sh-facts').replaceChildren(...facts.flatMap(([label, value]) => [textElement('dt', label), textElement('dd', value)]));
    $('#sh-label-preview').replaceChildren(...labels.map((label) => textElement('li', label)));
    $('#sh-label-preview').hidden = !labels.length;
  }

  function open() {
    if (!ed.hasImage()) return;
    ed.finishEditing();
    $('#sh-title').value = $('#sh-title').value || ed.meta().title || t('popup_screenshot');
    list = steps();
    $('#sh-none').classList.toggle('hidden', !!list.length);
    $('#sh-steps').replaceChildren(...list.map(({ object, n, color }, i) => {
      const label = document.createElement('label');
      const badge = textElement('span', n);
      badge.className = 'n';
      badge.style.backgroundColor = color;
      const note = document.createElement('textarea');
      note.dataset.i = i;
      note.rows = 1;
      note.setAttribute('aria-label', t('share_note_label', n));
      note.placeholder = t('share_note_placeholder', n);
      note.value = object.note || '';
      label.append(badge, note);
      return label;
    }));
    $('#sh-url').value = 'none';
    $('#sh-labels').checked = false;
    const image = ed.preview();
    const canvas = $('#sh-image');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    updatePreview();
    openDialog($('#share'));
    $('#sh-title').focus();
  }

  async function save(e) {
    e.preventDefault();
    list.forEach(({ object }, i) => { object.note = $('#sh-steps').querySelector(`[data-i="${i}"]`).value.trim(); });
    ed.commit();
    $('#sh-go').disabled = true;
    try {
      // The annotated image without a device frame, as PNG: the page is for looking closely.
      const [W, H] = ed.size();
      const p = ed.padding();
      const title = $('#sh-title').value.trim() || t('popup_screenshot');
      const summary = $('#sh-summary').value.trim();
      const { labels, facts } = details();
      const markers = list.map(({ object, n, color }) => ({ n, x: (object.x + p) / W, y: (object.y + p) / H, color, note: object.note }));
      const c = await ed.render();
      const { blob } = await encodeOffThread(c, 'png', {}, 'export', 0);
      const html = buildReviewPage({
        title,
        summary,
        image: await blobToDataUrl(blob),
        width: c.width,
        height: c.height,
        steps: markers,
        labels,
        facts,
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = `${title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}-review.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      $('#share').close();
      toast(t('saved_file', a.download), { kind: 'success' });
    } catch (err) {
      toast(t('share_failed', err.message), { kind: 'error', ms: 5000 });
    } finally {
      $('#sh-go').disabled = false;
    }
  }

  $('#share-open').addEventListener('click', open);
  $('#share-form').addEventListener('submit', save);
  $('#sh-url').addEventListener('change', updatePreview);
  $('#sh-labels').addEventListener('change', updatePreview);
}
