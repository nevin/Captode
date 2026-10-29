// A short tour of the video page, shown once: a card beside each part in turn, with
// Back, Next and Skip. Esc ends it; the focus goes back where it was. "Tour" in the
// page's top row shows it again.

import { t } from '../lib/i18n.js';

const KEY = 'captode-video-tour';

/** Whether the tour has been seen (or can't be remembered, so isn't pressed on anyone). */
export function tourSeen() {
  try { return localStorage.getItem(KEY) === 'done'; } catch { return true; }
}

/**
 * Shows the tour. `steps`: [{ el() → the element to point at (skipped when missing or
 * hidden), title, text }].
 */
export function startTour(steps) {
  document.querySelector('.tour')?.remove();
  const list = steps.filter((s) => { const el = s.el(); return el && el.getClientRects().length; });
  if (!list.length) return;
  const back = document.activeElement;
  const card = document.createElement('div');
  card.className = 'tour';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-labelledby', 'tour-h');
  card.setAttribute('aria-describedby', 'tour-p');
  card.innerHTML = `<p class="tour-n muted small"></p><h3 id="tour-h"></h3><p id="tour-p"></p>
    <div class="tour-actions"><button type="button" class="btn ghost small" data-skip></button><span></span>
    <button type="button" class="btn small" data-back></button><button type="button" class="btn primary small" data-next></button></div>`;
  card.querySelector('[data-skip]').textContent = t('tour_skip');
  card.querySelector('[data-back]').textContent = t('tour_back');
  document.body.append(card);
  let i = 0, target = null;

  function place() {
    if (!target) return;
    const r = target.getBoundingClientRect(), c = card.getBoundingClientRect();
    const gap = 12, vw = innerWidth, vh = innerHeight;
    // Beside it where there's room (the inspector is on the right), else below or above.
    let x = r.left - c.width - gap, y = r.top;
    if (x < 8) {
      x = r.left; y = r.bottom + gap;
      if (y + c.height > vh - 8) y = r.top - c.height - gap;
      // A part as big as the window (the player): the card inside its top corner.
      if (y < 8) { x = r.left + 16; y = Math.max(r.top, 60) + 16; }
    }
    card.style.left = `${Math.round(Math.min(Math.max(8, x), vw - c.width - 8))}px`;
    card.style.top = `${Math.round(Math.min(Math.max(8, y), vh - c.height - 8))}px`;
  }

  function show(n) {
    i = n;
    target?.classList.remove('tour-target');
    const s = list[i];
    target = s.el();
    if (target.tagName === 'DETAILS') target.open = true;
    target.classList.add('tour-target');
    target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    card.querySelector('.tour-n').textContent = t('tour_step', [String(i + 1), String(list.length)]);
    card.querySelector('h3').textContent = s.title;
    card.querySelector('#tour-p').textContent = s.text;
    card.querySelector('[data-back]').hidden = i === 0;
    card.querySelector('[data-next]').textContent = i === list.length - 1 ? t('tour_done') : t('tour_next');
    place();
    card.querySelector('[data-next]').focus();
  }

  function end() {
    target?.classList.remove('tour-target');
    card.remove();
    removeEventListener('resize', place);
    removeEventListener('scroll', place, true);
    document.removeEventListener('keydown', key, true);
    try { localStorage.setItem(KEY, 'done'); } catch { /* shown again next time */ }
    back?.focus?.();
  }

  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
    else if (e.key === 'ArrowRight' && card.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); if (i < list.length - 1) show(i + 1); }
    else if (e.key === 'ArrowLeft' && card.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); if (i > 0) show(i - 1); }
  }

  card.querySelector('[data-next]').addEventListener('click', () => (i < list.length - 1 ? show(i + 1) : end()));
  card.querySelector('[data-back]').addEventListener('click', () => show(Math.max(0, i - 1)));
  card.querySelector('[data-skip]').addEventListener('click', end);
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  document.addEventListener('keydown', key, true);
  show(0);
}
