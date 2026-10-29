// Filler words ("um", "uh") on the video page: found in the captions, each listed with
// a button to hear it, and those ticked cut out of the video and the captions in one
// step. Where a word is said is estimated from its place in its caption, so each is
// checked by ear before it is cut.

import { findFillers } from '../lib/video-edits.js';
import { toast, openDialog } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

/**
 * ctx: { captions(), source() (the recording's Blob), fmtTime(s), cut(cuts, words) }
 * Returns { open() }.
 */
export function mountFillers(ctx) {
  let url = '';
  function open() {
    const found = findFillers(ctx.captions());
    if (!found.length) { toast(t('fillers_none')); return; }
    const d = document.createElement('dialog');
    d.className = 'modal cap-review';
    d.setAttribute('aria-labelledby', 'fillers-h');
    d.innerHTML = `<div class="modal-body"><h2 id="fillers-h"></h2><p class="muted small"></p><video playsinline></video><div class="cap-review-list"></div>
      <div class="confirm-actions"><button type="button" class="btn" data-close></button><button type="button" class="btn primary" data-cut></button></div></div>`;
    d.querySelector('h2').textContent = t('fillers_title', String(found.length));
    d.querySelector('p').textContent = t('fillers_hint');
    d.querySelector('[data-close]').textContent = t('settings_cancel');
    const cutButton = d.querySelector('[data-cut]');
    const v = d.querySelector('video');
    if (!url) url = URL.createObjectURL(ctx.source());
    v.src = url;
    let stopAt = Infinity;
    v.addEventListener('timeupdate', () => { if (v.currentTime >= stopAt) { v.pause(); stopAt = Infinity; } });
    const rows = d.querySelector('.cap-review-list');
    const boxes = found.map((f) => {
      const row = document.createElement('label');
      row.className = 'cap-review-row';
      row.innerHTML = '<input type="checkbox" checked><button type="button" class="btn ghost small tc"></button><span></span>';
      const b = row.querySelector('button');
      b.textContent = ctx.fmtTime(f.from);
      b.setAttribute('aria-label', `${t('cap_review_play')} ${ctx.fmtTime(f.from)}`);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        // A little either side, to hear it in its place.
        v.currentTime = Math.max(0, f.from - 0.6);
        stopAt = f.to + 0.6;
        v.play().catch(() => {});
      });
      row.querySelector('span').textContent = `“${f.word}”`;
      rows.append(row);
      return row.querySelector('input');
    });
    const sync = () => {
      const n = boxes.filter((x) => x.checked).length;
      cutButton.textContent = t('fillers_cut', String(n));
      cutButton.disabled = !n;
    };
    rows.addEventListener('change', sync);
    sync();
    cutButton.addEventListener('click', () => {
      const chosen = found.filter((_, i) => boxes[i].checked);
      const words = {};
      for (const f of chosen) (words[f.id] ||= new Set()).add(f.index);
      ctx.cut(chosen.map((f) => ({ from: f.from, to: f.to })), words);
      d.close();
      toast(t('fillers_done', String(chosen.length)), { kind: 'success' });
    });
    d.addEventListener('close', () => { v.pause(); v.removeAttribute('src'); v.load(); d.remove(); });
    document.body.append(d);
    openDialog(d);
  }
  return { open };
}
