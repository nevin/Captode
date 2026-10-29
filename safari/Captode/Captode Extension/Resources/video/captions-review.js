// Reviewing captions on the video page: every caption in one list, its words editable,
// with a small player above that plays the part each one covers, so wrong words (from
// Captions from speech, say) are quick to find and fix.

import { t } from '../lib/i18n.js';

/**
 * ctx: { captions() (sorted or not), setCaption(id, patch, quiet), source() (the
 *   recording's Blob), fmtTime(s), seek(t) }
 * Returns { open() }.
 */
export function mountCaptionReview(ctx) {
  let url = '';
  function open() {
    const list = [...ctx.captions()].sort((a, b) => a.from - b.from);
    if (!list.length) return;
    const d = document.createElement('dialog');
    d.className = 'modal cap-review';
    d.setAttribute('aria-labelledby', 'cap-review-h');
    d.innerHTML = `<div class="modal-body"><h2 id="cap-review-h"></h2><p class="muted small"></p><video playsinline></video><div class="cap-review-list"></div>
      <div class="confirm-actions"><button type="button" class="btn primary" data-close></button></div></div>`;
    d.querySelector('h2').textContent = t('cap_review');
    d.querySelector('p').textContent = t('cap_review_hint');
    d.querySelector('[data-close]').textContent = t('cap_review_done');
    const v = d.querySelector('video');
    if (!url) url = URL.createObjectURL(ctx.source());
    v.src = url;
    let stopAt = Infinity;
    v.addEventListener('timeupdate', () => { if (v.currentTime >= stopAt) { v.pause(); stopAt = Infinity; } });
    const rows = d.querySelector('.cap-review-list');
    for (const c of list) {
      const row = document.createElement('div');
      row.className = 'cap-review-row';
      row.innerHTML = '<button type="button" class="btn ghost small tc" data-play></button><textarea rows="1" maxlength="300"></textarea>';
      const b = row.querySelector('[data-play]');
      b.textContent = ctx.fmtTime(c.from);
      b.title = t('cap_review_play');
      b.setAttribute('aria-label', `${t('cap_review_play')} ${ctx.fmtTime(c.from)}`);
      const ta = row.querySelector('textarea');
      ta.value = c.text;
      ta.setAttribute('aria-label', `${t('edit_text')} ${ctx.fmtTime(c.from)}`);
      b.addEventListener('click', () => {
        v.currentTime = c.from;
        stopAt = c.to;
        v.play().catch(() => {});
        ctx.seek(c.from);
      });
      ta.addEventListener('input', () => ctx.setCaption(c.id, { text: ta.value.slice(0, 300) }, true));
      // Enter goes to the next caption (Shift+Enter for a new line).
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const next = row.nextElementSibling;
          if (next) { next.querySelector('textarea').focus(); next.querySelector('[data-play]').click(); }
        }
      });
      rows.append(row);
    }
    d.querySelector('[data-close]').addEventListener('click', () => d.close());
    d.addEventListener('close', () => { v.pause(); v.removeAttribute('src'); v.load(); d.remove(); });
    document.body.append(d);
    d.showModal();
    rows.querySelector('textarea')?.focus();
  }
  return { open };
}
