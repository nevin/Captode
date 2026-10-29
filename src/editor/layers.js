// The Annotations list, for the keyboard and screen readers: every annotation in
// words, front to back, chosen with the arrow keys and moved with Alt and the arrows.
// Changes elsewhere in the editor are announced through `announce`.

import { t } from '../lib/i18n.js';
import { esc } from '../lib/util.js';

const $ = (s) => document.querySelector(s);

/**
 * `ed`: the editor's side: `objects()`, `selection()` and `selected()` (current
 * values), `isSelected(o)`, `select(list)`, `bounds(o)`, `names` (tool names),
 * `changed()` after the selection changes, `move(dx, dy)` for the selection, and
 * `editText(o)`.
 */
export function createLayers(ed) {
  /** An annotation in words: what it is and where. */
  function describe(o) {
    const r = Math.round;
    if (o.type === 'text') {
      const words = (o.text || '').trim().replace(/\s+/g, ' ');
      const quoted = words.length > 60 ? words.slice(0, 59) + '…' : words || t('layer_empty');
      return t(o.tail ? 'layer_callout' : 'layer_text', quoted);
    }
    if (o.type === 'step') return o.note ? t('layer_step_note', [o.n, o.note]) : t('layer_step', o.n);
    if (o.type === 'line' || o.type === 'arrow') return t('layer_line', [ed.names[o.type], `${r(o.x1)}, ${r(o.y1)}`, `${r(o.x2)}, ${r(o.y2)}`]);
    const b = ed.bounds(o);
    return t('layer_shape', [ed.names[o.type] || o.type, `${r(b.w)} × ${r(b.h)}`, `${r(b.x)}, ${r(b.y)}`]);
  }

  /** Says something to screen readers, without showing it. */
  function announce(message) {
    const el = $('#announce');
    el.textContent = '';
    requestAnimationFrame(() => { el.textContent = message; });
  }
  let soon = 0;
  const announceSoon = (message) => { clearTimeout(soon); soon = setTimeout(() => announce(message), 500); };

  const list = () => [...ed.objects()].reverse(); // front first
  let active = 0;
  let sig = '';
  let frame = 0;

  /** Redraws the list when what it shows has changed (coalesced to a frame). */
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  function render() {
    const all = list();
    if (ed.selection().length && !ed.isSelected(all[active])) active = Math.max(0, all.findIndex(ed.isSelected));
    active = Math.min(active, Math.max(0, all.length - 1));
    const rows = all.map((o) => ({ text: describe(o), on: ed.isSelected(o), color: o.type === 'text' ? o.bg || o.color : o.color || '#888' }));
    const next = JSON.stringify(rows) + active;
    if (next === sig) return;
    sig = next;
    const ul = $('#layers');
    ul.innerHTML = rows.map((row, i) =>
      `<li role="option" id="layer-${i}" data-i="${i}" aria-selected="${row.on}" class="${i === active ? 'active' : ''}">` +
      `<span class="sw" style="background:${esc(row.color)}"></span><span>${esc(row.text)}</span></li>`).join('');
    if (all.length) ul.setAttribute('aria-activedescendant', `layer-${active}`);
    else ul.removeAttribute('aria-activedescendant');
    $('#layers-count').textContent = all.length ? `(${all.length})` : '';
  }

  function choose(i, { add = false, toggle = false } = {}) {
    const o = list()[i];
    if (!o) return;
    active = i;
    const sel = ed.selection();
    if (toggle) ed.select(ed.isSelected(o) ? sel.filter((x) => x !== o) : [...sel, o]);
    else if (add) ed.select([...new Set([...sel, o])]);
    else ed.select([o]);
    ed.changed();
    render();
    $(`#layer-${i}`)?.scrollIntoView({ block: 'nearest' });
  }

  $('#layers').addEventListener('click', (e) => {
    const li = e.target.closest('[role="option"]');
    if (li) choose(Number(li.dataset.i), { toggle: e.shiftKey || e.metaKey || e.ctrlKey });
  });
  $('#layers').addEventListener('focus', () => render());
  $('#layers').addEventListener('keydown', (e) => {
    const n = ed.objects().length;
    if (!n) return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.altKey && e.key.startsWith('Arrow')) {
      // Move what's selected.
      handled();
      if (!ed.selection().length) return;
      const s = e.shiftKey ? 10 : 1;
      ed.move(...{ ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key]);
      const b = ed.bounds(ed.selection()[0]);
      announceSoon(t('announce_moved', [Math.round(b.x), Math.round(b.y)]));
      return;
    }
    const to = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: n - 1 }[e.key];
    if (to !== undefined) {
      handled();
      choose(Math.max(0, Math.min(n - 1, to)), { add: e.shiftKey });
      return;
    }
    if (e.key === ' ') { handled(); choose(active, { toggle: true }); return; }
    if (e.key === 'Enter') {
      handled();
      choose(active);
      if (ed.selected()?.type === 'text') ed.editText(ed.selected());
    }
    // Delete, Escape, undo and the other shortcuts work as they do on the canvas.
  });

  return { schedule, render, describe, announce, announceSoon };
}
