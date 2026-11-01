// The video page's keyboard shortcuts, listed in a dialog: "?" or the keyboard button
// in the top row opens it. Most labels are the matching buttons' tips without the key
// at their end, so they say the same as the buttons, in every language.

import { t } from '../lib/i18n.js';
import { enhance, openDialog } from '../lib/ui.js';

const $ = (s) => document.querySelector(s);

/** A tip such as "Leave out a part  X", without its key. */
const tip = (key) => t(key).split(/\s{2,}/)[0];
/** One whose key is its last word, after a single space ("Play or pause Space"). */
const lastOff = (key) => t(key).replace(/\s+\S+$/, '');

/** [heading] or [label, keys, { adv, when }]; keys are written as <kbd>s, '/' between pairs. */
function rows(ctx) {
  return [
    [t('vkeys_playing')],
    [lastOff('video_play_or_pause_space'), ['Space']],
    [t('vkeys_step'), ['←', '→']],
    [lastOff('video_start_at_the_playhead_i'), ['I']],
    [lastOff('video_end_at_the_playhead_o'), ['O']],
    [t('vkeys_zoom'), ['+', '−']],
    [tip('slides_add_tip'), ['S'], { adv: true, when: ctx.hasSlides }],
    [t('vkeys_frame'), ['F']],
    [t('editor_editing')],
    [tip('edit_add_cut_tip'), ['X']],
    [tip('edit_mark_tip'), ['⇧', 'X']],
    [tip('edit_add_caption_tip'), ['T']],
    [tip('edit_add_mute_tip'), ['M']],
    [tip('edit_add_speed_tip'), ['P'], { adv: true }],
    [tip('edit_add_zoom_tip'), ['Z'], { adv: true }],
    [tip('edit_add_blur_tip'), ['B'], { adv: true }],
    [tip('edit_add_callout_tip'), ['C'], { adv: true }],
    [t('edit_split_tip'), ['Enter']],
    [t('editor_delete_selection'), ['⌫']],
    [t('editor_deselect'), ['Esc']],
    [t('editor_undo'), ['⌘', 'Z']],
    [t('editor_redo'), ['⇧', '⌘', 'Z']],
    [t('vkeys_help'), ['?']],
  ];
}

/** ctx: { hasSlides() }. Wires "?" and the #keys-open button to the list. */
export function mountShortcuts(ctx) {
  function open() {
    $('#vkeys')?.remove();
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.id = 'vkeys';
    d.setAttribute('aria-labelledby', 'vkeys-h');
    d.innerHTML = `<div class="modal-head"><h2 id="vkeys-h"></h2><button type="button" class="btn ghost icon" data-close><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="modal-body keys"></div>`;
    d.querySelector('h2').textContent = t('editor_keyboard_shortcuts_2');
    const close = d.querySelector('[data-close]');
    close.dataset.tip = t('editor_close');
    const body = d.querySelector('.keys');
    for (const [label, keys, { adv = false, when } = {}] of rows(ctx)) {
      if (when && !when()) continue;
      if (!keys) {
        const h = document.createElement('h3');
        h.textContent = label;
        body.append(h);
        continue;
      }
      const row = document.createElement('div');
      if (adv) row.className = 'adv'; // hidden in Simple, like the tools themselves
      const name = document.createElement('span');
      name.textContent = label;
      const k = document.createElement('span');
      k.append(...keys.flatMap((key, i) => {
        const el = document.createElement('kbd');
        el.textContent = key;
        return i ? [' ', el] : [el];
      }));
      row.append(name, k);
      body.append(row);
    }
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    enhance(d); // ⌘ as Ctrl away from Macs, and the close button's name
    openDialog(d);
  }

  $('#keys-open')?.addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    open();
  });
  return { open };
}
