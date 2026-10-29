// "Share for review": the dialog, and the single web page it downloads.

import { buildReviewPage } from './review-page.js';
import { encodeOffThread } from '../lib/encoder.js';
import { toast, openDialog } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import { blobToDataUrl } from '../lib/util.js';

const $ = (s) => document.querySelector(s);


/**
 * `ed`: `hasImage()`, `finishEditing()`, `objects()`, `meta()`, `padding()`,
 * `size()` ([w, h] with padding), `imageSize()` ([w, h] without), `render()` (the
 * annotated image without a device frame) and `commit()` (keeps the notes as an edit).
 */
export function mountShare(ed) {
  const steps = () => ed.objects().filter((o) => o.type === 'step').sort((a, b) => a.n - b.n);

  function open() {
    if (!ed.hasImage()) return;
    ed.finishEditing();
    $('#sh-title').value = $('#sh-title').value || ed.meta().title || t('popup_screenshot');
    const list = steps();
    $('#sh-none').classList.toggle('hidden', !!list.length);
    $('#sh-steps').innerHTML = list.map((o, i) =>
      `<label><span class="n" style="background:${o.color}">${o.n}</span><textarea data-i="${i}" rows="1" aria-label="${t('share_note_label', o.n)}" placeholder="${t('share_note_placeholder', o.n)}"></textarea></label>`).join('');
    // Notes are kept on the steps, so they come back with the capture.
    list.forEach((o, i) => { $('#sh-steps').querySelector(`[data-i="${i}"]`).value = o.note || ''; });
    openDialog($('#share'));
    $('#sh-title').focus();
  }

  async function save(e) {
    e.preventDefault();
    const list = steps();
    list.forEach((o, i) => { o.note = $('#sh-steps').querySelector(`[data-i="${i}"]`).value.trim(); });
    ed.commit();
    $('#sh-go').disabled = true;
    try {
      // The annotated image without a device frame, as PNG: the page is for looking closely.
      const c = await ed.render();
      const { blob } = await encodeOffThread(c, 'png', {}, 'export', 0);
      const [W, H] = ed.size();
      const [iw, ih] = ed.imageSize();
      const meta = ed.meta();
      const p = ed.padding();
      const title = $('#sh-title').value.trim() || t('popup_screenshot');
      const html = buildReviewPage({
        title,
        summary: $('#sh-summary').value.trim(),
        image: await blobToDataUrl(blob),
        width: c.width,
        height: c.height,
        steps: list.map((o) => ({ n: o.n, x: (o.x + p) / W, y: (o.y + p) / H, color: o.color, note: o.note })),
        labels: ed.objects().filter((o) => o.type === 'text' && o.text.trim()).map((o) => o.text.trim()),
        facts: [
          [t('share_page'), meta.url || ''],
          [t('share_captured'), new Date(meta.created || Date.now()).toLocaleString()],
          [t('editor_size'), meta.dpr ? t('share_size_ratio', [`${iw} × ${ih}`, Math.round(meta.dpr * 100) / 100]) : `${iw} × ${ih} px`],
          [t('share_browser'), navigator.userAgentData?.brands?.filter((b) => !/not.a.brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(', ') || ''],
        ],
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
}
