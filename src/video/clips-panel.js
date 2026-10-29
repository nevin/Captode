// The Clips section: other recordings and video files joined after this one, each
// shown on the timeline where it starts, or laid over the picture as a video layer
// (an edit, from the playhead). Joining (lib/join.js) and moving the edits along is
// the page's: `opts.rebuild(plan, done)`; so is adding a layer: `opts.addLayer(blob)`.

import { listCaptures, getCapture } from '../lib/db.js';
import { clipStarts, probeVideo, needsEncoding } from '../lib/join.js';
import { toast, confirmDialog } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

const ICONS = {
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  remove: '<path d="M18 6 6 18M6 6l12 12"/>',
};

/**
 * opts: { id, clips (as saved), name (the recording's), duration(), source() (its Blob),
 *         fmtTime, busy(), seek(at), now() (the playhead), rebuild({ pieces, moves, clips }, done),
 *         addLayer(blob, { from, len }), addImage(blob, name) (a picture as a layer), save(clips) (a change that needs no joining: a transition),
 *         canUndo(), undo() (the last joining undone) }
 */
export function mountClips(opts) {
  const $ = (s) => document.querySelector(s);
  const total = opts.duration();
  let clips = Array.isArray(opts.clips) ? opts.clips.filter((c) => c && c.len > 0) : [];
  // Clips that don't add up to the recording (it was changed some other way): one clip.
  if (clips.length < 2 || Math.abs(clips.reduce((n, c) => n + c.len, 0) - total) > 0.5) clips = [{ id: 'c0', name: opts.name, len: total }];
  const others = new Map(); // id → a recording offered in the list
  let where = 'after'; // what Add does: 'after' at the end, 'here' at the playhead, or 'top', over it

  function setMode(m) {
    where = ['top', 'here'].includes(m) ? m : 'after';
    for (const b of document.querySelectorAll('#clip-mode [data-v]')) {
      b.classList.toggle('on', b.dataset.v === where);
      b.setAttribute('aria-checked', String(b.dataset.v === where));
    }
    $('#clip-mode-hint').textContent = t({ top: 'clips_top_hint', here: 'clips_here_hint', after: 'clips_after_hint' }[where]);
    $('#clip-file-input').accept = where === 'top' ? 'video/*,image/*,.webm,.mp4,.mov,.mkv' : 'video/*,.webm,.mp4,.mov,.mkv';
    fillPicker();
  }

  /**
   * The pieces to join for `list` (clips here, in their new order, and any new ones),
   * and how times move. A clip here is { ...clip } or, for part of one, { ...clip, from }:
   * `from` (s into the timeline now) and `len` say which part.
   */
  function plan(list) {
    const old = clipStarts(clips);
    const pieces = [], moves = [];
    let at = 0;
    for (const c of list) {
      const i = clips.findIndex((x) => x.id === (c.of || c.id));
      if (i >= 0) {
        const from = c.from ?? old[i];
        const last = Math.abs(from + c.len - (old[i] + clips[i].len)) < 1e-6 && i === clips.length - 1;
        pieces.push({ blob: opts.source(), from, len: c.len });
        moves.push({ from, to: last ? Math.max(total, from + c.len) : from + c.len, at });
      } else pieces.push({ blob: c.blob, from: c.start || 0, len: c.len });
      at += c.len;
    }
    return { pieces, moves, clips: list.map(({ id, name, len, trans }) => ({ id, name, len, ...(trans && trans !== 'none' ? { trans } : {}) })) };
  }

  /**
   * `list` with `c` put in at the playhead, splitting the clip there. The part after
   * the playhead is copied from its next key frame; only up to it is encoded again.
   */
  function insertHere(c) {
    const starts = clipStarts(clips);
    const now = Math.round(opts.now() * 1000) / 1000;
    let i = clips.findIndex((x, j) => now >= starts[j] && now < starts[j] + x.len);
    if (i < 0) i = clips.length - 1;
    const list = [...clips];
    // Right at a clip's start or end: before or after it.
    if (now - starts[i] < 0.1 || starts[i] + clips[i].len - now < 0.1) {
      list.splice(now - starts[i] < 0.1 ? i : i + 1, 0, c);
      return list;
    }
    const a = { ...clips[i], len: Math.round((now - starts[i]) * 1000) / 1000, from: starts[i], of: clips[i].id };
    const b = { ...clips[i], id: `${clips[i].id}b${Date.now().toString(36)}`, of: clips[i].id, from: now, len: Math.round((starts[i] + clips[i].len - now) * 1000) / 1000, trans: 'none' };
    list.splice(i, 1, a, c, b);
    return list;
  }

  /**
   * Asks which part of `blob` to use (all of it to start with), and says how long
   * getting it ready takes when it has to be encoded. Resolves to { from, len } or null.
   */
  async function chooseRange(blob, name) {
    const info = await probeVideo(blob);
    const d = $('#clip-trim');
    const v = $('#clip-trim-video');
    const url = URL.createObjectURL(blob);
    v.src = url;
    $('#clip-trim-name').textContent = name;
    const start = $('#clip-trim-start'), end = $('#clip-trim-end');
    start.max = end.max = info.duration.toFixed(1);
    start.value = '0';
    end.value = info.duration.toFixed(1);
    const slow = await needsEncoding(blob, where === 'top' ? null : opts.source());
    const note = () => {
      const a = Math.max(0, Math.min(Number(start.value) || 0, info.duration)), b = Math.min(info.duration, Number(end.value) || info.duration);
      const len = Math.max(0, b - a);
      let text = t('clips_trim_len', opts.fmtTime(len));
      // Encoding goes at about twice real time where the browser plays it through, so a long file takes a while.
      if (slow && len > 60) text += ' ' + t('clips_trim_slow', String(Math.max(1, Math.round(len / 2 / 60))));
      $('#clip-trim-note').textContent = text;
      $('#clip-trim-ok').disabled = len < 0.2;
      return { from: a, len };
    };
    note();
    const onInput = () => note();
    start.addEventListener('input', onInput);
    end.addEventListener('input', onInput);
    const setFrom = (e) => {
      const c = e.target.closest('[data-close]');
      if (c && !c.disabled) { d.close(c.dataset.close); return; }
      const b = e.target.closest('[data-set]');
      if (!b) return;
      (b.dataset.set === 'start' ? start : end).value = v.currentTime.toFixed(1);
      note();
    };
    d.addEventListener('click', setFrom);
    d.showModal();
    const ok = await new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true }));
    const range = note();
    start.removeEventListener('input', onInput);
    end.removeEventListener('input', onInput);
    d.removeEventListener('click', setFrom);
    v.pause();
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
    if (!ok) return null;
    // Within a frame of the whole file: the whole file.
    return range.from < 0.02 && range.len > info.duration - 0.05 ? { from: 0, len: info.duration } : range;
  }

  async function add(blob, name) {
    if (opts.busy()) return;
    name = String(name || t('clips_untitled')).slice(0, 80);
    if (blob.type.startsWith('image/')) {
      if (where === 'top') opts.addImage(blob, name);
      else toast(t('clips_image_top'), { kind: 'error', ms: 5000 });
      return;
    }
    let range;
    try {
      range = await chooseRange(blob, name);
    } catch {
      toast(t('clips_unplayable'), { kind: 'error', ms: 5000 });
      return;
    }
    if (!range || opts.busy()) return;
    if (where === 'top') { opts.addLayer(blob, range); return; }
    const c = { id: `c${Date.now().toString(36)}`, name, start: range.from, len: Math.round(range.len * 1000) / 1000, blob };
    opts.rebuild(plan(where === 'here' ? insertHere(c) : [...clips, c]), 'clips_added');
  }

  function move(i, by) {
    const list = [...clips];
    const [c] = list.splice(i, 1);
    list.splice(i + by, 0, c);
    opts.rebuild(plan(list), 'clips_moved');
  }

  async function remove(i) {
    const ok = await confirmDialog({ title: t('clips_remove_title'), text: t('clips_remove_text', clips[i].name), confirm: t('clips_remove') });
    if (ok && !opts.busy()) opts.rebuild(plan(clips.filter((_, j) => j !== i)), 'clips_removed');
  }

  function iconButton(act, tip) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost icon';
    b.dataset.act = act;
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
    b.innerHTML = `<svg class="i" viewBox="0 0 24 24">${ICONS[act]}</svg>`;
    return b;
  }

  function render() {
    const many = clips.length > 1;
    const starts = clipStarts(clips);
    $('#clip-count').textContent = many ? String(clips.length) : '';
    const list = $('#clip-list');
    list.replaceChildren();
    list.classList.toggle('hidden', !many);
    clips.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'clip-item';
      row.dataset.i = i;
      row.tabIndex = 0;
      row.title = t('clips_go');
      const n = document.createElement('span');
      n.className = 'clip-n';
      n.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'clip-name';
      name.textContent = c.name;
      const len = document.createElement('span');
      len.className = 'clip-len';
      len.textContent = opts.fmtTime(c.len);
      const up = iconButton('up', t('clips_earlier'));
      up.disabled = i === 0;
      const down = iconButton('down', t('clips_later'));
      down.disabled = i === clips.length - 1;
      row.append(n, name, len, up, down, iconButton('remove', t('clips_remove')));
      list.append(row);
      if (i > 0) {
        // How it meets the clip before it.
        const tr = document.createElement('label');
        tr.className = 'clip-trans';
        tr.innerHTML = `<span>${t('clips_trans')}</span><select data-trans="${i}">${['none', 'fade', 'cross'].map((k) => `<option value="${k}">${t(`clips_trans_${k}`)}</option>`).join('')}</select>`;
        tr.querySelector('select').value = c.trans || 'none';
        list.append(tr);
      }
    });
    // Where each clip starts, on the timeline.
    const marks = $('#clip-marks');
    marks.replaceChildren();
    if (many) {
      starts.forEach((s, i) => {
        const m = document.createElement('div');
        m.className = 'clip-mark';
        m.style.left = `${(s / (total || 1)) * 100}%`;
        const n = document.createElement('span');
        n.textContent = String(i + 1);
        n.title = clips[i].name;
        m.append(n);
        marks.append(m);
      });
    }
  }

  async function fillPicker() {
    const pick = $('#clip-pick');
    // Screenshots too when laying something on top: a picture layer.
    const list = (await listCaptures(50)).filter((c) => (c.kind === 'video' || (where === 'top' && c.kind === 'image')) && c.id !== opts.id);
    const keep = pick.value; // the one chosen stays chosen
    others.clear();
    pick.replaceChildren();
    for (const c of list) {
      others.set(c.id, c);
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.kind === 'image' ? '🖼 ' : ''}${c.meta.title || t('clips_untitled')} · ${new Date(c.created).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
      pick.append(o);
    }
    if (others.has(keep)) pick.value = keep;
    $('#clip-add-row').classList.toggle('hidden', !list.length);
    $('#clip-add').dataset.tip = t({ top: 'clips_add_top_tip', here: 'clips_add_here_tip', after: 'clips_add_tip' }[where]);
    $('#clip-file').dataset.tip = t({ top: 'clips_add_file_top_tip', here: 'clips_add_file_here_tip', after: 'clips_add_file_tip' }[where]);
  }

  $('#clip-list').addEventListener('change', (e) => {
    const i = Number(e.target.dataset.trans);
    if (!i || opts.busy()) return;
    clips = clips.map((c, j) => (j === i ? { ...c, trans: e.target.value } : c));
    opts.save(clips.map(({ id, name, len, trans }) => ({ id, name, len, ...(trans && trans !== 'none' ? { trans } : {}) })));
  });
  $('#clip-undo').addEventListener('click', () => { if (!opts.busy()) opts.undo(); });
  $('#clip-list').addEventListener('click', (e) => {
    const row = e.target.closest('.clip-item');
    if (!row || opts.busy()) return;
    const i = Number(row.dataset.i);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'up') move(i, -1);
    else if (act === 'down') move(i, 1);
    else if (act === 'remove') remove(i);
    else opts.seek(clipStarts(clips)[i]);
  });
  $('#clip-list').addEventListener('keydown', (e) => {
    const row = e.target.closest('.clip-item');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); opts.seek(clipStarts(clips)[Number(row.dataset.i)]); }
  });
  $('#clip-add').addEventListener('click', async () => {
    const c = others.get($('#clip-pick').value);
    if (!c || opts.busy()) return;
    const rec = await getCapture(c.id);
    if (!rec?.blob) { toast(t('clips_unplayable'), { kind: 'error' }); fillPicker(); return; }
    add(rec.blob, rec.meta?.title);
  });
  $('#clip-file').addEventListener('click', () => { if (!opts.busy()) $('#clip-file-input').click(); });
  $('#clip-file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) add(file, file.name.replace(/\.[^.]+$/, ''));
  });
  $('#clip-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (b) setMode(b.dataset.v);
  });
  $('#clips-section').addEventListener('toggle', () => { if ($('#clips-section').open) fillPicker(); });

  $('#clips-section').open = clips.length > 1;
  $('#clip-undo').classList.toggle('hidden', !opts.canUndo());
  render();
  setMode('after');
  return {
    all: () => clips,
    /** Shows what Add does next: 'after' or 'top'. */
    mode: setMode,
  };
}
