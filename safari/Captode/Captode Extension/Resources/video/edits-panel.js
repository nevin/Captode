// The Edit, Crop, Background and Sound sections of the video page: parts cut out or
// sped up, zooms, blurred areas, callouts and muted parts, each a bar on the
// timeline and an item in the list; boxes and arrows are drawn on the picture. The
// drawing and timing live in lib/video-edits.js, shared with the export.
import {
  normaliseEdits, editId, clipMap, composer, calloutBox, RATES, CALLOUT_COLOURS, CALLOUT_KINDS, ASPECTS, LAYER_POSITIONS, CAPTION_FONTS, layerBox,
  parseSubtitles, matchSubtitles, withoutWords,
} from '../lib/video-edits.js';
import { findSilences } from '../lib/audio-levels.js';
import { toast } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import { canTranslate, languageOptions, languageChoices, translateAll, translateError, languageName } from '../lib/translate.js';

const $ = (s) => document.querySelector(s);
const EDGE_PX = 7; // how near a bar's ends a press resizes it
const HANDLE_PX = 7; // the half-size of a handle on the picture

// Each kind of timed edit: its list in the edits, colour, key and default length (s).
const KINDS = {
  cuts: { colour: '#e5484d', key: 'x', len: 1 },
  speeds: { colour: '#f59e0b', key: 'p', len: 3 },
  zooms: { colour: '#0090ff', key: 'z', len: 3 },
  blurs: { colour: '#8e4ec6', key: 'b', len: 3 },
  callouts: { colour: '#30a46c', key: 'c', len: 3 },
  mutes: { colour: '#64748b', key: 'm', len: 2 },
  captions: { colour: '#0ea5e9', key: 't', len: 3 },
  layers: { colour: '#d6409f', key: null, len: 5 }, // added from the Clips section, with its video
};
const SPATIAL = new Set(['zooms', 'blurs', 'callouts']);
const name = (kind) => t(`edit_kind_${kind}`);

/**
 * opts: {
 *   player, edits (as saved, or none), meta, duration(), trim() → { start, end },
 *   fmtTime(s), changed() after any change, save(edits), busy(), seek(t),
 *   levels() → the sound's loudness (lib/audio-levels.js) or null,
 *   saveDefault(part, value): new recordings start with this background or sound,
 *   addLayer(): asks for a video to lay over the picture
 * }
 */
export function mountEdits(opts) {
  const { player } = opts;
  let edits = normaliseEdits(opts.edits || {});
  let selected = null; // { kind, id }
  let cropping = false;
  let mark = null; // where a cut marked with ⇧X starts, until its end is marked
  const undo = [], redo = [];

  const list = (kind, e = edits) => (kind === 'mutes' ? e.audio.mutes : e[kind]);
  const item = () => (selected ? list(selected.kind).find((x) => x.id === selected.id) || null : null);
  const pct = (x) => (opts.duration() ? (x / opts.duration()) * 100 : 0) + '%';
  const round = (v) => Math.round(v * 10) / 10;
  const snapshot = () => JSON.stringify(edits);

  /** Makes a change: `fn` changes the edits; it can be undone. */
  // Changes in a row to the same thing (typing a caption, moving a slider) are undone
  // together, rather than a letter or a step at a time.
  // Each step kept is { s (the edits before it, as JSON), label (what it changed), at }.
  let group = null, groupAt = 0;
  function pushUndo(before, key = null, label = '') {
    const now = Date.now();
    if (!(key && key === group && now - groupAt < 1500)) { undo.push({ s: before, label, at: now }); if (undo.length > 100) undo.shift(); }
    redo.length = 0;
    group = key;
    groupAt = now;
  }
  function change(fn, { history = true, quiet = false, group: key = null } = {}) {
    if (opts.busy()) return;
    const before = snapshot();
    fn(edits);
    if (snapshot() === before) return;
    if (history) pushUndo(before, key, describeChange(JSON.parse(before), edits));
    after(quiet);
  }
  let saveTimer = 0;
  function after(quiet = false) {
    if (selected && !item()) selected = null;
    render(quiet);
    opts.changed();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }
  /** Saves now what is waiting to be saved (also when the page is closed or hidden). */
  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    opts.save(JSON.parse(snapshot()));
  }
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  function restore(from, to, steps = 1) {
    if (!from.length || opts.busy()) return;
    group = null;
    for (let i = 0; i < steps && from.length; i++) {
      const step = from.pop();
      to.push({ s: snapshot(), label: step.label, at: step.at });
      edits = normaliseEdits(JSON.parse(step.s));
    }
    after();
  }

  // ---------- history: every step, to go back (or forward) several at once ----------

  const NAMES = {
    cuts: 'edit_kind_cuts', speeds: 'edit_kind_speeds', zooms: 'edit_kind_zooms', blurs: 'edit_kind_blurs', callouts: 'edit_kind_callouts',
    captions: 'edit_kind_captions', layers: 'edit_kind_layers', chapters: 'chapters_title',
  };
  /** What a change did, in a few words: "Cut added", "Zoom changed", "Several changes". */
  function describeChange(a, b) {
    const said = [];
    const lists = { ...NAMES, mutes: 'edit_kind_mutes' };
    for (const [kind, key] of Object.entries(lists)) {
      const x = kind === 'mutes' ? a.audio?.mutes || [] : a[kind] || [], y = kind === 'mutes' ? b.audio.mutes : b[kind] || [];
      const before = new Map(x.map((e) => [e.id, JSON.stringify(e)])), after = new Map(y.map((e) => [e.id, JSON.stringify(e)]));
      let name = t(key);
      if (kind === 'layers') {
        const all = [...x, ...y];
        if (all.length && all.every((l) => l.kind === 'sound')) name = t('vo_label');
      }
      const added = [...after.keys()].filter((id) => !before.has(id)).length;
      const removed = [...before.keys()].filter((id) => !after.has(id)).length;
      const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)).length;
      const n = (k) => (k > 1 ? ` (${k})` : '');
      if (added) said.push(t('hist_added', name + n(added)));
      if (removed) said.push(t('hist_removed', name + n(removed)));
      if (changed && !added && !removed) said.push(t('hist_changed', name + n(changed)));
    }
    const { mutes: m1, ...audioA } = a.audio || {}, { mutes: m2, ...audioB } = b.audio;
    const parts = [['crop', 'edit_crop'], ['background', 'edit_background'], ['captionStyle', 'cap_style'], ['music', 'music_title'], ['rings', 'edit_rings'], ['subtitleTracks', 'subs_title']];
    for (const [k, key] of parts) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) said.push(t('hist_changed', t(key)));
    if (JSON.stringify(audioA) !== JSON.stringify(audioB)) said.push(t('hist_changed', t('edit_sound')));
    if (!said.length) return t('hist_edit');
    return said.length > 2 ? t('hist_several') : said.join(' · ');
  }

  const ago = (at) => {
    const s = Math.round((Date.now() - at) / 1000);
    return s < 60 ? t('hist_seconds', String(Math.max(1, s))) : t('hist_minutes', String(Math.round(s / 60)));
  };
  /**
   * The history, newest first: steps undone (faded, to redo), the steps made (the newest
   * is where things are now), and the start. Choosing one goes to just after it.
   */
  function renderHistory() {
    const el = $('#ed-hist');
    if (!el || el.classList.contains('hidden')) return;
    const rows = [];
    redo.forEach((step, i) => rows.push({ label: step.label, at: step.at, go: () => restore(redo, undo, redo.length - i), future: true }));
    for (let i = undo.length - 1; i >= 0; i--) {
      const step = undo[i], back = undo.length - 1 - i;
      rows.push({ label: step.label, at: step.at, now: back === 0, go: back ? () => restore(undo, redo, back) : null });
    }
    rows.push({ label: t('hist_start'), now: !undo.length, go: undo.length ? () => restore(undo, redo, undo.length) : null });
    const list = el.querySelector('.hist-list');
    list.replaceChildren(...rows.map((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `hist-row${r.now ? ' now' : ''}${r.future ? ' future' : ''}`;
      b.disabled = !!r.now;
      if (r.now) b.setAttribute('aria-current', 'step');
      b.innerHTML = '<span></span><small class="muted"></small>';
      b.firstChild.textContent = r.label;
      if (r.at) b.lastChild.textContent = ago(r.at);
      if (r.go) b.addEventListener('click', () => { r.go(); renderHistory(); });
      return b;
    }));
    el.querySelector('.hist-empty').classList.toggle('hidden', undo.length + redo.length > 0);
  }
  $('#ed-hist-open').addEventListener('click', () => {
    const el = $('#ed-hist');
    const open = el.classList.toggle('hidden') === false;
    $('#ed-hist-open').setAttribute('aria-expanded', String(open));
    if (open) { $('#edit-section').open = true; renderHistory(); el.querySelector('.hist-row:not(:disabled)')?.focus(); }
  });

  // ---------- adding ----------

  function add(kind, { len: wanted, ...fields } = {}) {
    if (kind === 'mutes' && !opts.meta.hasAudio) { toast(t('edit_no_sound')); return null; }
    if (kind === 'layers' && !fields.src && fields.kind !== 'text') { opts.addLayer?.(); return null; }
    const len = wanted || KINDS[kind].len;
    // Right after a drag across the timeline, the edit covers the part dragged across
    // (and the trim goes back to what it was); otherwise it starts at the playhead.
    const picked = opts.takePicked?.();
    const { start, end } = opts.trim();
    const at = Math.min(Math.max(player.currentTime, start), Math.max(start, end - 0.1));
    const base = picked
      ? { id: editId(), from: round(picked.from), to: round(Math.max(picked.to, picked.from + 0.1)) }
      : { id: editId(), from: round(at), to: round(Math.min(opts.duration(), at + len)) };
    if (base.to - base.from < 0.1) base.from = round(Math.max(0, base.to - len));
    const extra = {
      speeds: { rate: 2 },
      zooms: { x: 0.5, y: 0.5, scale: 2 },
      blurs: { x: 0.35, y: 0.4, w: 0.3, h: 0.12, mode: 'blur', strength: 5 },
      callouts: { kind: 'arrow', x1: 0.3, y1: 0.3, x2: 0.5, y2: 0.5, text: '', color: CALLOUT_COLOURS[0], size: 2 },
      captions: { text: '', size: 2 },
    }[kind] || {};
    const x = { ...base, ...extra, ...fields };
    change((e) => list(kind, e).push(x));
    select(kind, x.id);
    return x;
  }

  function remove(kind, id) {
    const x = list(kind).find((y) => y.id === id);
    if (!x) return;
    const copy = JSON.parse(JSON.stringify(x));
    change((e) => { const l = list(kind, e); l.splice(l.indexOf(l.find((y) => y.id === id)), 1); });
    // Undo here brings back this edit, whatever else was changed since.
    const back = () => {
      if (list(kind).some((y) => y.id === id)) return;
      change((e) => list(kind, e).push(copy));
      select(kind, id);
    };
    toast(t('edit_removed', name(kind)), { ms: 5000, action: { label: t('editor_undo'), run: back } });
  }

  function select(kind, id) {
    selected = kind ? { kind, id } : null;
    if (selected && SPATIAL.has(kind)) {
      cropping = false;
      const x = item();
      // Show a moment it is on.
      if (x && !x.whole && (player.currentTime < x.from || player.currentTime >= x.to)) opts.seek(x.from + Math.min(0.3, (x.to - x.from) / 2));
    }
    render();
  }

  /** Zooms in on each click recorded (tab recordings remember where they were). */
  function zoomOnClicks() {
    const clicks = (opts.meta.clicks || []).filter((c) => c.t >= 0 && c.t <= opts.duration()).sort((a, b) => a.t - b.t);
    if (!clicks.length) return;
    const groups = [];
    for (const c of clicks) {
      const g = groups.at(-1);
      // Clicks close together share one zoom, centred between them.
      if (g && c.t - g.to < 1.2 && Math.hypot(c.x - g.x, c.y - g.y) < 0.35) { g.to = c.t + 1.6; g.n++; g.x += (c.x - g.x) / g.n; g.y += (c.y - g.y) / g.n; }
      else groups.push({ from: Math.max(0, c.t - 0.5), to: c.t + 1.6, x: c.x, y: c.y, n: 1 });
    }
    // Zooms are centred in the crop's terms; clicks are in the recording's.
    const c = edits.crop || { x: 0, y: 0, w: 1, h: 1 };
    const inCrop = (v, a, l) => Math.min(1, Math.max(0, (v - a) / l));
    change((e) => {
      e.zooms = e.zooms.filter((z) => !z.auto);
      for (const g of groups) e.zooms.push({ id: editId(), from: round(g.from), to: round(Math.min(opts.duration(), g.to)), x: inCrop(g.x, c.x, c.w), y: inCrop(g.y, c.y, c.h), scale: 1.8, auto: true });
    });
    toast(t('edit_zoomed_clicks', String(groups.length)), { kind: 'success' });
  }

  /** Cuts the quiet parts of the kept part (found again each time, replacing the last ones found). */
  function cutSilences() {
    const { start, end } = opts.trim();
    const found = findSilences(opts.levels(), start, end);
    if (!found?.length) { toast(t('edit_no_silences')); return; }
    const prev = edits.cuts.filter((c) => c.silence).map((c) => ({ ...c }));
    const added = found.map((r) => ({ id: editId(), from: r.from, to: r.to, silence: true }));
    change((e) => {
      e.cuts = e.cuts.filter((c) => !c.silence);
      e.cuts.push(...added.map((c) => ({ ...c })));
    });
    const secs = found.reduce((n, r) => n + r.to - r.from, 0);
    // Undo here takes back these cuts (and puts back the ones found before), whatever else changed since.
    const back = () => change((e) => {
      const ids = new Set(added.map((c) => c.id));
      e.cuts = e.cuts.filter((c) => !ids.has(c.id));
      for (const c of prev) if (!e.cuts.some((y) => y.id === c.id)) e.cuts.push({ ...c });
    });
    toast(t('edit_silences_cut', [String(found.length), secs.toFixed(1)]), { kind: 'success', ms: 6000, action: { label: t('editor_undo'), run: back } });
  }

  /** ⇧X: the first press marks where a cut starts, the second where it ends. */
  function markCut() {
    const at = round(Math.max(0, Math.min(opts.duration(), player.currentTime)));
    if (mark === null) {
      mark = at;
      toast(t('edit_mark_started'), { ms: 4000 });
    } else {
      const from = Math.min(mark, at), to = Math.max(mark, at);
      mark = null;
      if (to - from >= 0.1) {
        const x = { id: editId(), from, to };
        change((e) => e.cuts.push(x));
        select('cuts', x.id);
      }
    }
    render();
  }

  /** Splits the chosen edit in two at the playhead. */
  function split() {
    const x = item();
    const at = round(player.currentTime);
    if (!x || x.whole || at < x.from + 0.1 || at > x.to - 0.1) return;
    const kind = selected.kind;
    const copy = { ...JSON.parse(JSON.stringify(x)), id: editId(), from: at };
    if (kind === 'layers') copy.offset = x.offset + at - x.from; // carries on in its video
    change((e) => {
      const l = list(kind, e);
      l.find((y) => y.id === x.id).to = at;
      l.push(copy);
    });
    select(kind, copy.id);
  }

  /** The caption right after `x` (starting where it ends, or later), if any. */
  const nextCaption = (x) => edits.captions.filter((c) => c.id !== x.id && c.from >= x.to - 0.05).sort((a, b) => a.from - b.from)[0] || null;
  /** Joins the chosen caption with the next: one caption over both, its words then theirs. */
  function joinCaption() {
    const x = item();
    const n = x && nextCaption(x);
    if (!n) return;
    change((e) => {
      const a = e.captions.find((c) => c.id === x.id);
      a.to = n.to;
      a.text = `${a.text.trim()} ${n.text.trim()}`.trim().slice(0, 300);
      e.captions = e.captions.filter((c) => c.id !== n.id);
    });
  }

  // ---------- the list and the item's form ----------

  const timed = () => Object.keys(KINDS).flatMap((kind) => list(kind).map((x) => ({ kind, x }))).sort((a, b) => a.x.from - b.x.from);

  function describe(kind, x) {
    const when = x.whole ? t('edit_whole') : `${opts.fmtTime(x.from)}–${opts.fmtTime(x.to)}`;
    const what = {
      speeds: () => `${x.rate}×`,
      zooms: () => `${Math.round(x.scale * 10) / 10}×`,
      blurs: () => t(`edit_blur_${x.mode}`),
      callouts: () => (x.kind === 'text' && x.text.trim() ? `“${x.text.trim().slice(0, 24)}”` : x.kind === 'step' ? `${t('edit_callout_step')} ${x.text.trim() || '1'}` : t(`edit_callout_${x.kind}`)),
      captions: () => (x.text.trim() ? `“${x.text.trim().slice(0, 24)}”` : ''),
      layers: () => (x.kind === 'sound' ? t('vo_label') : x.kind === 'text' ? `“${(x.text || '').trim().slice(0, 24)}”` : `${x.kind === 'image' ? t('vlayer_picture') : ''}${x.kind === 'image' ? ' · ' : ''}${t(`vlayer_pos_${x.pos}`)}`),
    }[kind]?.() || '';
    return { when, what };
  }

  function renderList() {
    const el = $('#ed-list');
    el.textContent = '';
    const all = timed();
    $('#ed-count').textContent = all.length ? String(all.length) : '';
    if (!all.length) {
      const p = document.createElement('p');
      p.className = 'muted small ed-empty';
      p.textContent = t('edit_none');
      el.append(p);
    }
    const { start, end } = opts.trim();
    for (const { kind, x } of all) {
      const b = document.createElement('button');
      b.className = 'ed-item';
      b.setAttribute('role', 'option');
      const on = selected?.id === x.id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.classList.toggle('out', !x.whole && (x.to <= start || x.from >= end));
      const d = describe(kind, x);
      b.innerHTML = `<span class="ed-dot" style="background:${KINDS[kind].colour}"></span><span class="ed-name"><b></b><small></small></span>`;
      b.querySelector('b').textContent = d.what ? `${name(kind)} · ${d.what}` : name(kind);
      b.querySelector('small').textContent = d.when;
      b.addEventListener('click', () => select(on ? null : kind, x.id));
      el.append(b);
    }
  }

  const field = (label, html) => `<label class="field"><span>${label}</span>${html}</label>`;
  const seg = (k, options, v) => `<div class="seg" data-seg="${k}" role="radiogroup">${options.map(([val, label]) => `<button type="button" data-v="${val}" role="radio" aria-checked="${String(val) === String(v)}" class="${String(val) === String(v) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
  const timeField = (k, label, v) => field(label, `<div class="with-btn"><input type="number" data-k="${k}" min="0" step="0.1" value="${round(v)}"><button type="button" class="btn ghost icon" data-now="${k}" data-tip="${t('edit_at_playhead')}"><svg class="i" viewBox="0 0 24 24"><path d="M12 3v18M7 8l5-5 5 5"/></svg></button></div>`);

  function renderForm() {
    const el = $('#ed-item');
    const x = item();
    el.classList.toggle('hidden', !x);
    if (!x) { el.textContent = ''; return; }
    const kind = selected.kind;
    let html = `<div class="ed-head"><span class="ed-dot" style="background:${KINDS[kind].colour}"></span><b>${name(kind)}</b></div>`;
    if (!x.whole) html += `<div class="grid2">${timeField('from', t('edit_from'), x.from)}${timeField('to', t('edit_to'), x.to)}</div>`;
    if (kind === 'blurs' || kind === 'callouts') html += `<label class="toggle"><span>${t('edit_whole_toggle')}</span><input type="checkbox" data-k="whole" ${x.whole ? 'checked' : ''}></label>`;
    if (kind === 'speeds') {
      html += field(t('edit_speed'), seg('rate', RATES.map((r) => [r, `${r}×`]), x.rate));
      html += `<label class="toggle"><span>${t('edit_speed_ease')}</span><input type="checkbox" data-k="ease" ${x.ease ? 'checked' : ''}></label>`;
      html += `<p class="muted small">${t('edit_speed_hint')}</p>`;
    }
    if (kind === 'zooms') {
      html += field(`${t('edit_zoom')} <b>${Math.round(x.scale * 10) / 10}×</b>`, `<input type="range" data-k="scale" min="1.1" max="4" step="0.1" value="${x.scale}">`);
      if (opts.meta.moves?.length || x.follow) html += `<label class="toggle"><span>${t('zoom_follow')}<small>${t('zoom_follow_hint')}</small></span><input type="checkbox" data-k="follow" ${x.follow ? 'checked' : ''}></label>`;
      html += `<p class="muted small">${t('edit_zoom_hint')}</p>`;
    }
    if (kind === 'blurs') {
      html += field(t('edit_blur_style'), seg('mode', ['blur', 'pixelate', 'box'].map((m) => [m, t(`edit_blur_${m}`)]), x.mode));
      if (x.mode !== 'box') html += field(`${t('edit_strength')} <b>${x.strength}</b>`, `<input type="range" data-k="strength" min="1" max="10" step="1" value="${x.strength}">`);
      html += `<p class="muted small">${t('edit_draw_hint')}</p>`;
    }
    if (kind === 'callouts') {
      html += field(t('edit_callout_kind'), `<div class="seg seg-wrap" data-seg="kind" role="radiogroup">${CALLOUT_KINDS.map((k) => `<button type="button" data-v="${k}" role="radio" aria-checked="${k === x.kind}" class="${k === x.kind ? 'on' : ''}">${t(`edit_callout_${k}`)}</button>`).join('')}</div>`);
      if (x.kind === 'text') html += `<label class="field"><span>${t('edit_text')}</span><textarea rows="2" data-k="text" placeholder="${t('edit_text_placeholder')}"></textarea></label>`;
      if (x.kind === 'step') html += `<label class="field"><span>${t('edit_step_label')}</span><textarea rows="1" maxlength="3" data-k="text" placeholder="1"></textarea></label>`;
      if (x.kind !== 'spot') {
        html += `<div class="field"><span>${t('edit_colour')}</span><div class="swatches ed-colours">${CALLOUT_COLOURS.map((c) => `<button type="button" data-colour="${c}" aria-pressed="${c === x.color}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div></div>`;
        html += field(t('edit_size'), seg('size', [[1, 'S'], [2, 'M'], [3, 'L']], x.size));
      }
      html += `<p class="muted small">${t('edit_draw_hint')}</p>`;
    }
    if (kind === 'captions') {
      html += `<label class="field"><span>${t('edit_text')}</span><textarea rows="2" data-k="text" placeholder="${t('edit_caption_placeholder')}"></textarea></label>`;
      html += field(t('edit_size'), seg('size', [[1, 'S'], [2, 'M'], [3, 'L']], x.size));
      html += `<p class="muted small">${t('edit_caption_hint')}</p>`;
      // How every caption looks.
      const cs = edits.captionStyle;
      const on = (k, v) => `role="radio" aria-checked="${String(cs[k]) === String(v)}" class="${String(cs[k]) === String(v) ? 'on' : ''}"`;
      html += `<div class="ed-cap-style"><b>${t('cap_style')}</b>`;
      html += field(t('cap_font'), `<div class="seg" data-seg="cs-font" role="radiogroup">${Object.keys(CAPTION_FONTS).map((f) => `<button type="button" data-v="${f}" ${on('font', f)} title="${t(`cap_font_${f}`)}" aria-label="${t(`cap_font_${f}`)}" style="font-family:${CAPTION_FONTS[f].replace(/"/g, "'")}">Aa</button>`).join('')}</div>`);
      html += field(t('vlayer_text_colour'), `<div class="seg ed-swatches" data-seg="cs-color" role="radiogroup">${['#ffffff', '#000000', '#ffd60a', ...CALLOUT_COLOURS.filter((c) => !/^#(ffffff|000000|ffd60a)$/i.test(c)).slice(0, 4)].map((c) => `<button type="button" data-v="${c}" ${on('color', c)} aria-label="${c}" title="${c}"><span class="ed-swatch" style="background:${c}"></span></button>`).join('')}</div>`);
      html += field(t('cap_band'), `<div class="seg seg-wrap" data-seg="cs-band" role="radiogroup">${['dark', 'light', 'outline', 'none'].map((b) => `<button type="button" data-v="${b}" ${on('band', b)}>${t(`cap_band_${b}`)}</button>`).join('')}</div>`);
      html += field(t('cap_place'), `<div class="seg" data-seg="cs-place" role="radiogroup">${['bottom', 'middle', 'top'].map((b) => `<button type="button" data-v="${b}" ${on('place', b)}>${t(`thumb_${b}`)}</button>`).join('')}</div>`);
      html += `<label class="toggle"><span>${t('cap_highlight')}<small>${t('cap_highlight_hint')}</small></span><input type="checkbox" data-cs="highlight" ${cs.highlight ? 'checked' : ''}></label>`;
      html += `</div>`;
      const next = nextCaption(x);
      html += `<div class="row ed-actions"><button type="button" class="btn" data-join ${next ? '' : 'disabled'} data-tip="${t('cap_join_tip')}">${t('cap_join')}</button>${opts.reviewCaptions ? `<button type="button" class="btn" data-review data-tip="${t('cap_review_tip')}">${t('cap_review')}</button>` : ''}<button type="button" class="btn" data-fillers data-tip="${t('fillers_tip')}">${t('fillers_find')}</button></div>`;
      html += `<div class="row ed-actions"><button type="button" class="btn" data-subs="srt" data-tip="${t('edit_subtitles_tip')}">${t('edit_subtitles_srt')}</button><button type="button" class="btn" data-subs="vtt" data-tip="${t('edit_subtitles_tip')}">${t('edit_subtitles_vtt')}</button></div>`;
      if (canTranslate) html += `<label class="field"><span>${t('translate_captions')}</span><select data-translate>${languageOptions()}</select></label>`;
      else html += `<p class="muted small">${t('translate_not_here')}</p>`;
      // Subtitles in the file: the captions, and the same in other languages.
      html += `<div class="ed-cap-style"><b>${t('subs_title')}</b>`;
      html += `<label class="toggle"><span>${t('subs_burn')}<small>${t('subs_burn_hint')}</small></span><input type="checkbox" data-cs="burn" ${cs.burn ? 'checked' : ''}></label>`;
      html += `<label class="toggle"><span>${t('subs_embed')}<small>${t('subs_embed_hint')}</small></span><input type="checkbox" data-cs="embed" ${cs.embed ? 'checked' : ''}></label>`;
      html += `<label class="field"><span>${t('subs_lang')}</span><select data-sublang="">${languageChoices(cs.lang, t('subs_lang_none'))}</select></label>`;
      for (const tr of edits.subtitleTracks) {
        const n = edits.captions.filter((c) => tr.texts[c.id]?.trim()).length;
        html += `<div class="row sub-track"><select data-sublang="${tr.id}" aria-label="${t('subs_track_lang')}">${languageChoices(tr.lang === 'und' ? '' : tr.lang, t('subs_lang_none'))}</select><span class="muted small">${t('subs_track_count', [String(n), String(edits.captions.length)])}</span><button type="button" class="btn ghost icon" data-subdel="${tr.id}" aria-label="${t('subs_track_remove')}" title="${t('subs_track_remove')}"><svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`;
      }
      if (edits.subtitleTracks.length < 8) {
        html += `<div class="row ed-actions"><button type="button" class="btn" data-subfile data-tip="${t('subs_add_file_tip')}">${t('subs_add_file')}</button></div>`;
        if (canTranslate) html += `<label class="field"><span>${t('subs_add_translation')}</span><select data-subtranslate>${languageOptions()}</select></label>`;
      }
      html += `</div>`;
    }
    if (kind === 'layers' && x.kind === 'text') {
      html += `<label class="field"><span>${t('edit_text')}</span><textarea rows="2" data-k="text" placeholder="${t('vlayer_text_default')}"></textarea></label>`;
      html += field(t('vlayer_text_colour'), `<div class="seg ed-swatches" data-seg="color" role="radiogroup">${['#ffffff', '#000000', ...CALLOUT_COLOURS.filter((c) => !/^#(ffffff|000000)$/i.test(c)).slice(0, 5)].map((c) => `<button type="button" data-v="${c}" role="radio" aria-checked="${c === x.color}" class="${c === x.color ? 'on' : ''}" aria-label="${c}" title="${c}"><span class="ed-swatch" style="background:${c}"></span></button>`).join('')}</div>`);
      html += field(t('vlayer_text_bg'), seg('bg', [['dark', t('vlayer_bg_dark')], ['light', t('vlayer_bg_light')], ['none', t('vlayer_bg_none')]], x.bg));
    }
    if (kind === 'layers' && x.kind === 'sound') {
      html += field(`${t('vlayer_volume')} <b>${Math.round(x.volume * 100)}%</b>`, `<input type="range" data-k="volume" min="0" max="2" step="0.05" value="${x.volume}">`);
      html += field(`${t('vlayer_fade')} <b>${x.fade ? `${x.fade.toFixed(1)} s` : t('video_off')}</b>`, `<input type="range" data-k="fade" min="0" max="3" step="0.1" value="${x.fade}">`);
      html += `<p class="muted small">${t('vo_hint')}</p>`;
    } else if (kind === 'layers') {
      const arrows = { tl: '↖', bl: '↙', c: '●', tr: '↗', br: '↘' }; // left side, middle, right side
      html += field(t('vlayer_position'), `<div class="seg" data-seg="pos" role="radiogroup">${Object.keys(arrows).filter((p) => LAYER_POSITIONS.includes(p)).map((p) => `<button type="button" data-v="${p}" role="radio" aria-checked="${p === x.pos}" class="${p === x.pos ? 'on' : ''}" aria-label="${t(`vlayer_pos_${p}`)}" title="${t(`vlayer_pos_${p}`)}">${arrows[p]}</button>`).join('')}</div>`);
      html += field(`${t('edit_size')} <b>${Math.round(x.size * 100)}%</b>`, `<input type="range" data-k="size" min="0.1" max="1" step="0.05" value="${x.size}">`);
      html += field(t('vlayer_shape'), seg('shape', [['rect', t('vlayer_shape_rect')], ['circle', t('vlayer_shape_circle')]], x.shape));
      if ((x.kind || 'video') === 'video' && x.sound) html += field(`${t('vlayer_volume')} <b>${Math.round(x.volume * 100)}%</b>`, `<input type="range" data-k="volume" min="0" max="2" step="0.05" value="${x.volume}">`);
      html += field(`${t('vlayer_opacity')} <b>${Math.round(x.opacity * 100)}%</b>`, `<input type="range" data-k="opacity" min="0.1" max="1" step="0.05" value="${x.opacity}">`);
      html += field(`${t('vlayer_fade')} <b>${x.fade ? `${x.fade.toFixed(1)} s` : t('video_off')}</b>`, `<input type="range" data-k="fade" min="0" max="3" step="0.1" value="${x.fade}">`);
      const borders = ['none', '#ffffff', '#000000', ...CALLOUT_COLOURS.filter((c) => !/^#(ffffff|000000)$/i.test(c)).slice(0, 4)];
      html += field(t('vlayer_border'), `<div class="seg ed-swatches" data-seg="border" role="radiogroup">${borders.map((c) => `<button type="button" data-v="${c}" role="radio" aria-checked="${c === x.border}" class="${c === x.border ? 'on' : ''}" aria-label="${c === 'none' ? t('vlayer_border_none') : c}" title="${c === 'none' ? t('vlayer_border_none') : c}">${c === 'none' ? '∅' : `<span class="ed-swatch" style="background:${c}"></span>`}</button>`).join('')}</div>`);
      html += `<label class="toggle"><span>${t('vlayer_shadow')}</span><input type="checkbox" data-k="shadow" ${x.shadow ? 'checked' : ''}></label>`;
      html += `<label class="toggle"><span>${t('vlayer_move')}<small>${t('vlayer_move_hint')}</small></span><input type="checkbox" data-k="move" ${x.move ? 'checked' : ''}></label>`;
      if (x.move) html += `<div class="row ed-actions"><button type="button" class="btn" data-goto="start">${t('vlayer_go_start')}</button><button type="button" class="btn" data-goto="end">${t('vlayer_go_end')}</button></div>`;
      if ((x.kind || 'video') === 'video') html += field(t('vlayer_offset'), `<input type="number" data-k="offset" min="0" step="0.1" value="${round(x.offset)}">`);
      html += `<p class="muted small">${t('vlayer_hint')}</p>`;
    }
    if (kind === 'mutes') html += `<p class="muted small">${t('edit_mute_hint')}</p>`;
    if (kind === 'cuts') html += `<p class="muted small">${t('edit_cut_hint')}</p>`;
    const at = player.currentTime;
    const canSplit = !x.whole && at >= x.from + 0.1 && at <= x.to - 0.1;
    html += `<div class="row ed-actions">${x.whole ? '' : `<button type="button" class="btn" data-split ${canSplit ? '' : 'disabled'} data-tip="${t('edit_split_tip')}">${t('edit_split')}</button>`}<button type="button" class="btn danger" data-del>${t('edit_delete')}</button></div>`;
    el.innerHTML = html;
    const text = el.querySelector('[data-k="text"]');
    if (text) text.value = x.text;
  }

  // The form's controls change the chosen item.
  const form = $('#ed-item');
  const setField = (k, v, opt) => {
    const id = selected?.id, kind = selected?.kind;
    if (!id) return;
    change((e) => {
      const x = list(kind, e).find((y) => y.id === id);
      if (!x) return;
      if (k === 'from') {
        const from = Math.max(0, Math.min(v, x.to - 0.1));
        if (kind === 'layers') x.offset = Math.max(0, x.offset + from - x.from); // its picture stays where it was in time
        x.from = from;
      }
      else if (k === 'to') { x.to = Math.min(opts.duration(), Math.max(v, x.from + 0.1)); }
      else x[k] = v;
    }, { ...opt, group: opt?.quiet ? `${id}:${k}` : null });
  };
  form.addEventListener('input', (e) => {
    if (e.target.dataset.cs) { const k = e.target.dataset.cs; change((x) => { x.captionStyle[k] = e.target.checked; }); return; }
    const k = e.target.dataset.k;
    if (!k) return;
    if (k === 'move') return setMove(e.target.checked);
    if (e.target.type === 'checkbox') return setField(k, e.target.checked);
    if (e.target.tagName === 'TEXTAREA') return setField(k, e.target.value, { quiet: true });
    if (e.target.type === 'range') return setField(k, Number(e.target.value), { quiet: true });
  });
  form.addEventListener('change', (e) => {
    if (e.target.matches('[data-translate]')) { translateCaptions(e.target); return; }
    if (e.target.matches('[data-subtranslate]')) { translateTrack(e.target); return; }
    if (e.target.dataset.sublang !== undefined) {
      const id = e.target.dataset.sublang, lang = e.target.value;
      change((x) => {
        if (!id) x.captionStyle.lang = lang;
        else { const tr = x.subtitleTracks.find((y) => y.id === id); if (tr) tr.lang = lang || 'und'; }
      });
      return;
    }
    const k = e.target.dataset.k;
    if (k === 'from' || k === 'to') setField(k, Number(e.target.value) || 0);
    if (k === 'offset') setField(k, Math.max(0, Number(e.target.value) || 0));
    if (e.target.type === 'range') renderForm(); // the value in the label
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.del !== undefined) return remove(selected.kind, selected.id);
    if (b.dataset.split !== undefined) return split();
    if (b.dataset.now) return setField(b.dataset.now, round(player.currentTime));
    if (b.dataset.colour) return setField('color', b.dataset.colour);
    if (b.dataset.subs) return opts.downloadSubtitles?.(b.dataset.subs);
    if (b.dataset.subdel) return change((x) => { x.subtitleTracks = x.subtitleTracks.filter((y) => y.id !== b.dataset.subdel); });
    if (b.dataset.subfile !== undefined) return addTrackFile();
    if (b.dataset.goto) { const x = item(); if (x) opts.seek(b.dataset.goto === 'end' ? Math.max(x.from, x.to - 0.05) : x.from + 0.01); return; }
    if (b.dataset.join !== undefined) return joinCaption();
    if (b.dataset.review !== undefined) return opts.reviewCaptions?.();
    if (b.dataset.fillers !== undefined) return opts.findFillers?.();
    const s = b.closest('[data-seg]');
    if (s?.dataset.seg.startsWith('cs-') && b.dataset.v !== undefined) {
      const k = s.dataset.seg.slice(3);
      change((e) => { e.captionStyle[k] = b.dataset.v; });
      return;
    }
    if (s && b.dataset.v !== undefined) {
      const v = s.dataset.seg === 'rate' || s.dataset.seg === 'size' ? Number(b.dataset.v) : b.dataset.v;
      // A new step takes the next number.
      if (s.dataset.seg === 'kind' && v === 'step' && !/^\w{1,3}$/.test(item()?.text.trim() || '')) {
        setField('text', String(edits.callouts.filter((c) => c.kind === 'step').length + 1), { history: false, quiet: true });
      }
      setField(s.dataset.seg, v);
    }
  });

  /** Turns a layer's movement on (ending where it is now, to be dragged at its end) or off. */
  function setMove(on) {
    const id = selected?.id;
    const W = player.videoWidth || 1920, H = player.videoHeight || 1080;
    change((e) => {
      const l = e.layers.find((y) => y.id === id);
      if (!l) return;
      if (!on) { delete l.move; delete l.x2; delete l.y2; delete l.size2; return; }
      const b = layerBox({ ...l, move: false }, W, H);
      Object.assign(l, { move: true, x2: (b.x + b.w / 2) / W, y2: (b.y + b.h / 2) / H, size2: l.size });
    });
    const x = item();
    if (on && x) { opts.seek(Math.max(x.from, x.to - 0.05)); toast(t('vlayer_move_now'), { ms: 5000 }); }
  }

  /** A subtitle language from an SRT or WebVTT file (these captions, translated elsewhere, say). */
  function addTrackFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,.vtt,text/vtt,application/x-subrip';
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      let texts = {};
      try { texts = matchSubtitles(opts.cues?.() || [], parseSubtitles(await f.text())); } catch { /* not text */ }
      if (!Object.keys(texts).length) { toast(t('subs_file_failed'), { kind: 'error', ms: 6000 }); return; }
      // The language, when the file's name says it (talk.fr.srt).
      const lang = /[._-]([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.(srt|vtt)$/i.exec(f.name)?.[1] || 'und';
      change((x) => { x.subtitleTracks.push({ id: editId(), lang: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) ? lang : 'und', texts }); });
      toast(t('subs_file_added', String(Object.keys(texts).length)), { kind: 'success' });
    });
    input.click();
  }

  /** The captions in another language, kept beside them as a subtitle language. */
  async function translateTrack(select) {
    const target = select.value;
    if (!target) return;
    select.disabled = true;
    const list = edits.captions.filter((c) => c.text.trim());
    toast(t('translate_working'), { ms: 3000 });
    try {
      const out = await translateAll(list.map((c) => c.text), target, (f) => toast(t('translate_download', String(Math.round(f * 100))), { ms: 2000 }));
      const texts = Object.fromEntries(list.map((c, i) => [c.id, String(out[i] ?? '').slice(0, 300)]));
      change((e) => { e.subtitleTracks = [...e.subtitleTracks.filter((y) => y.lang !== target), { id: editId(), lang: target, texts }]; });
      toast(t('subs_translated', languageName(target)), { kind: 'success' });
    } catch (err) {
      toast(translateError(err), { kind: 'error', ms: 6000 });
    } finally {
      select.value = '';
      select.disabled = false;
    }
  }

  /** Every caption into the language chosen in `select`, as one change that can be undone. */
  async function translateCaptions(select) {
    const target = select.value;
    if (!target) return;
    select.disabled = true;
    const texts = edits.captions.map((c) => c.text);
    toast(t('translate_working'), { ms: 3000 });
    try {
      const out = await translateAll(texts, target, (f) => toast(t('translate_download', String(Math.round(f * 100))), { ms: 2000 }));
      change((e) => { e.captions.forEach((c, i) => { if (typeof out[i] === 'string') c.text = out[i].slice(0, 300); }); });
      toast(t('translate_done', languageName(target)), { kind: 'success' });
    } catch (err) {
      toast(translateError(err), { kind: 'error', ms: 6000 });
    } finally {
      select.value = '';
      select.disabled = false;
    }
  }

  // ---------- the timeline ----------

  function renderMarks() {
    const zones = $('#cut-zones');
    zones.textContent = '';
    for (const c of edits.cuts) {
      const z = document.createElement('div');
      z.className = 'cut-zone';
      z.style.left = pct(c.from);
      z.style.width = pct(Math.min(c.to, opts.duration()) - c.from);
      zones.append(z);
    }
    if (mark !== null) {
      const z = document.createElement('div');
      z.className = 'cut-zone pending';
      z.id = 'cut-pending';
      zones.append(z);
      placePending();
    }
    for (const s of edits.speeds) {
      const z = document.createElement('div');
      z.className = 'speed-zone';
      z.style.left = pct(s.from);
      z.style.width = pct(Math.min(s.to, opts.duration()) - s.from);
      z.textContent = `${s.rate}×`;
      zones.append(z);
    }
    const lane = $('#edit-marks');
    lane.textContent = '';
    // Rows, so bars that overlap in time don't cover each other.
    const ends = [];
    for (const { kind, x } of timed()) {
      if (x.whole) continue;
      let row = ends.findIndex((end) => end <= x.from);
      if (row < 0) { row = ends.length; ends.push(0); }
      ends[row] = x.to;
      const b = document.createElement('div');
      b.className = 'edit-mark';
      b.classList.toggle('on', selected?.id === x.id);
      b.style.left = pct(x.from);
      b.style.width = pct(Math.min(x.to, opts.duration()) - x.from);
      b.style.setProperty('--row', String(row));
      b.style.background = KINDS[kind].colour;
      b.dataset.kind = kind;
      b.dataset.id = x.id;
      b.title = `${name(kind)} · ${describe(kind, x).when}`;
      lane.append(b);
    }
    $('#timeline').style.setProperty('--edit-rows', String(ends.length || 1));
  }

  /** The cut being marked: from its start to the playhead. */
  function placePending() {
    const z = document.getElementById('cut-pending');
    if (!z || mark === null) return;
    const a = Math.min(mark, player.currentTime), b = Math.max(mark, player.currentTime);
    z.style.left = pct(a);
    z.style.width = pct(b - a);
  }

  // A bar: a press chooses it; dragging moves it, or one end near the ends.
  $('#edit-marks').addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('.edit-mark');
    if (!bar || opts.busy()) return;
    e.stopPropagation();
    e.preventDefault();
    const { kind, id } = bar.dataset;
    if (selected?.id !== id) select(kind, id);
    const x = list(kind).find((y) => y.id === id);
    const r = bar.getBoundingClientRect();
    const edge = Math.min(EDGE_PX, r.width / 3); // short bars can still be moved by their middle
    const mode = e.clientX - r.left < edge ? 'from' : r.right - e.clientX < edge ? 'to' : 'move';
    const track = $('#track').getBoundingClientRect();
    const timeAt = (cx) => ((cx - track.left) / track.width) * opts.duration();
    const t0 = timeAt(e.clientX), from = x.from, to = x.to, offset = x.offset;
    const before = snapshot();
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const d = timeAt(ev.clientX) - t0;
      const D = opts.duration();
      const target = list(kind).find((y) => y.id === id);
      if (!target) return;
      if (mode === 'from') {
        target.from = round(Math.max(0, Math.min(from + d, to - 0.1)));
        if (kind === 'layers') target.offset = Math.max(0, offset + target.from - from);
      }
      else if (mode === 'to') target.to = round(Math.min(D, Math.max(to + d, from + 0.1)));
      else { const len = to - from; target.from = round(Math.max(0, Math.min(D - len, from + d))); target.to = round(target.from + len); }
      opts.seek(mode === 'to' ? target.to : target.from);
      render(true);
      opts.changed();
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      if (snapshot() !== before) { pushUndo(before, null, describeChange(JSON.parse(before), edits)); after(); }
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });

  // ---------- on the picture ----------

  const layer = $('#fx-edit');
  /** Whether the picture shows the recording as it is, to draw on (a box, an arrow, the crop). */
  const editing = () => !!(player.videoWidth && !$('#player').classList.contains('hidden') && (cropping || (selected && SPATIAL.has(selected.kind))));

  /** Lays the layer exactly over the picture in the player. */
  function place() {
    const pr = player.getBoundingClientRect(), box = player.parentElement.getBoundingClientRect();
    const s = Math.min(pr.width / player.videoWidth, pr.height / player.videoHeight);
    const w = player.videoWidth * s, h = player.videoHeight * s;
    Object.assign(layer.style, { left: `${pr.left - box.left + (pr.width - w) / 2}px`, top: `${pr.top - box.top + (pr.height - h) / 2}px`, width: `${w}px`, height: `${h}px` });
    const W = Math.round(w * devicePixelRatio), H = Math.round(h * devicePixelRatio);
    if (layer.width !== W || layer.height !== H) { layer.width = W; layer.height = H; }
  }

  /** The handles of what is chosen, in recording fractions: [{ id, x, y }], and its box. */
  function shape() {
    if (cropping) {
      const c = edits.crop || { x: 0, y: 0, w: 1, h: 1 };
      return { kind: 'rect', box: c };
    }
    const x = item();
    if (!x) return null;
    if (selected.kind === 'blurs') return { kind: 'rect', box: x };
    if (selected.kind === 'zooms') {
      const c = edits.crop || { x: 0, y: 0, w: 1, h: 1 };
      const w = c.w / x.scale, h = c.h / x.scale;
      return { kind: 'rect', box: { x: c.x + x.x * c.w - w / 2, y: c.y + x.y * c.h - h / 2, w, h }, fixed: true };
    }
    if (x.kind === 'arrow') return { kind: 'line' };
    if (x.kind === 'text' || x.kind === 'step') return { kind: 'point' };
    return { kind: 'rect', box: calloutBox(x) };
  }

  let frameKey = '';
  let full = null;
  function drawLayer(force = false) {
    const on = editing();
    layer.classList.toggle('hidden', !on);
    if (!on) { frameKey = ''; return; }
    place();
    const key = `${player.currentTime}|${layer.width}|${snapshot()}|${selected?.id}|${cropping}`;
    if (!force && key === frameKey) return;
    frameKey = key;
    const ctx = layer.getContext('2d');
    const W = layer.width, H = layer.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // The picture with the blurs and callouts on now (and the one chosen, whenever it is), no crop or zoom.
    const x = item();
    const view = { ...edits, crop: null, zooms: [], background: { ...edits.background, on: false },
      blurs: edits.blurs.map((b) => (b.id === x?.id ? { ...b, whole: true } : b)),
      callouts: edits.callouts.map((c) => (c.id === x?.id ? { ...c, whole: true } : c)) };
    const map = clipMap(view, 0, opts.duration());
    const comp = composer(view, map, player.videoWidth, player.videoHeight);
    if (!full || full.width !== comp.width || full.height !== comp.height) full = new OffscreenCanvas(comp.width, comp.height);
    comp.draw(full.getContext('2d'), player, player.currentTime, map.outOf(player.currentTime));
    ctx.drawImage(full, 0, 0, W, H);
    // The crop: outside it is dimmed.
    if (edits.crop || cropping) {
      const c = edits.crop || { x: 0, y: 0, w: 1, h: 1 };
      ctx.fillStyle = cropping ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(c.x * W, c.y * H, c.w * W, c.h * H);
      ctx.fill('evenodd');
    }
    const s = shape();
    if (!s) return;
    const r = devicePixelRatio;
    ctx.lineWidth = 1.5 * r;
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([5 * r, 4 * r]);
    const knob = (px, py) => {
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#5b4bff';
      ctx.lineWidth = 2 * r;
      ctx.beginPath();
      ctx.arc(px, py, HANDLE_PX * r * 0.75, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };
    if (s.kind === 'rect') {
      const b = s.box;
      ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
      if (selected?.kind === 'zooms') {
        ctx.save();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0,144,255,0.12)';
        ctx.fillRect(b.x * W, b.y * H, b.w * W, b.h * H);
        ctx.restore();
      }
      for (const [px, py] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) knob(px * W, py * H);
    } else if (s.kind === 'line') {
      knob(x.x1 * W, x.y1 * H);
      knob(x.x2 * W, x.y2 * H);
    } else {
      knob(x.x1 * W, x.y1 * H);
    }
  }

  const toFrac = (e) => {
    const r = layer.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  /** What a press at `p` takes hold of: a handle, the body, or nothing (to draw anew). */
  function grab(p) {
    const s = shape();
    if (!s) return null;
    const r = layer.getBoundingClientRect();
    const near = (x, y) => Math.hypot((x - p.x) * r.width, (y - p.y) * r.height) <= HANDLE_PX + 4;
    const x = item();
    if (s.kind === 'line') {
      if (near(x.x2, x.y2)) return 'p2';
      if (near(x.x1, x.y1)) return 'p1';
      // Near the line itself: move it.
      const dx = x.x2 - x.x1, dy = x.y2 - x.y1;
      const len2 = (dx * r.width) ** 2 + (dy * r.height) ** 2 || 1;
      const u = Math.max(0, Math.min(1, (((p.x - x.x1) * r.width) * (dx * r.width) + ((p.y - x.y1) * r.height) * (dy * r.height)) / len2));
      return near(x.x1 + dx * u, x.y1 + dy * u) ? 'move' : null;
    }
    if (s.kind === 'point') {
      // The label's bubble reaches right and down from its point.
      return p.x >= x.x1 - 0.01 && p.y >= x.y1 - 0.01 && p.x <= x.x1 + 0.3 && p.y <= x.y1 + 0.12 ? 'move' : null;
    }
    const b = s.box;
    for (const [k, cx, cy] of [['tl', b.x, b.y], ['tr', b.x + b.w, b.y], ['bl', b.x, b.y + b.h], ['br', b.x + b.w, b.y + b.h]]) if (near(cx, cy)) return k;
    return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h ? 'move' : null;
  }

  /** Keeps a crop's box at the chosen shape (in pixels), from its fixed corner. */
  function aspectBox(b, anchor) {
    const ratio = ASPECTS[$('#crop-aspect .on')?.dataset.v];
    if (!ratio) return b;
    const W = player.videoWidth, H = player.videoHeight;
    let w = b.w * W, h = b.h * H;
    if (w / h > ratio) w = h * ratio; else h = w / ratio;
    const nw = w / W, nh = h / H;
    const x = anchor.x > b.x + b.w / 2 - 1e-9 ? anchor.x - nw : anchor.x;
    const y = anchor.y > b.y + b.h / 2 - 1e-9 ? anchor.y - nh : anchor.y;
    return { x, y, w: nw, h: nh };
  }

  /** Puts box `b` (recording fractions) into what is chosen. */
  function setBox(e, b, x) {
    const clampBox = (q) => {
      const w = Math.min(1, Math.max(0.02, q.w)), h = Math.min(1, Math.max(0.02, q.h));
      return { x: Math.min(1 - w, Math.max(0, q.x)), y: Math.min(1 - h, Math.max(0, q.y)), w, h };
    };
    if (cropping) { e.crop = clampBox(b); return; }
    const kind = selected.kind;
    if (kind === 'blurs') Object.assign(x, clampBox(b));
    else if (kind === 'zooms') {
      const c = e.crop || { x: 0, y: 0, w: 1, h: 1 };
      x.scale = Math.round(Math.min(4, Math.max(1.1, c.w / Math.max(0.01, b.w))) * 10) / 10;
      x.x = Math.min(1, Math.max(0, (b.x + b.w / 2 - c.x) / c.w));
      x.y = Math.min(1, Math.max(0, (b.y + b.h / 2 - c.y) / c.h));
    } else {
      const q = clampBox(b);
      Object.assign(x, { x1: q.x, y1: q.y, x2: q.x + q.w, y2: q.y + q.h });
    }
  }

  layer.addEventListener('pointerdown', (e) => {
    if (opts.busy()) return;
    if (!player.paused) player.pause();
    const p = toFrac(e);
    const what = grab(p);
    const s = shape();
    if (!s) return;
    layer.setPointerCapture(e.pointerId);
    const before = snapshot();
    const id = selected?.id, kind = selected?.kind;
    const live = () => (cropping ? null : list(kind).find((y) => y.id === id));
    const x0 = live();
    const start = x0 ? { ...x0 } : null;
    const box0 = s.box ? { ...s.box } : null;
    const zoomRatio = () => {
      const c = edits.crop || { x: 0, y: 0, w: 1, h: 1 };
      return (c.w * player.videoWidth) / (c.h * player.videoHeight);
    };
    const move = (ev) => {
      const q = toFrac(ev);
      const dx = q.x - p.x, dy = q.y - p.y;
      const x = live();
      if (s.kind === 'line') {
        if (what === 'p1') Object.assign(x, { x1: q.x, y1: q.y });
        else if (what === 'p2') Object.assign(x, { x2: q.x, y2: q.y });
        else if (what === 'move') Object.assign(x, { x1: start.x1 + dx, y1: start.y1 + dy, x2: start.x2 + dx, y2: start.y2 + dy });
        else Object.assign(x, { x1: p.x, y1: p.y, x2: q.x, y2: q.y }); // drawn anew
      } else if (s.kind === 'point') {
        Object.assign(x, what === 'move' ? { x1: Math.min(1, Math.max(0, start.x1 + dx)), y1: Math.min(1, Math.max(0, start.y1 + dy)) } : { x1: q.x, y1: q.y });
      } else {
        let b;
        if (what === 'move') b = { ...box0, x: box0.x + dx, y: box0.y + dy };
        else {
          // A corner (the opposite one stays), or a new box from the press.
          const anchor = what ? { x: what.includes('l') ? box0.x + box0.w : box0.x, y: what.includes('t') ? box0.y + box0.h : box0.y } : p;
          b = { x: Math.min(anchor.x, q.x), y: Math.min(anchor.y, q.y), w: Math.abs(q.x - anchor.x), h: Math.abs(q.y - anchor.y) };
          if (cropping) b = aspectBox(b, anchor);
          if (selected?.kind === 'zooms' && !cropping) {
            // A zoom keeps the picture's shape.
            const ratio = zoomRatio();
            const W = player.videoWidth, H = player.videoHeight;
            const w = Math.max(b.w * W, b.h * H * ratio);
            b = { ...b, w: w / W, h: w / ratio / H };
            if (anchor.x > q.x) b.x = anchor.x - b.w;
            if (anchor.y > q.y) b.y = anchor.y - b.h;
          }
        }
        if (b.w < 0.005 && b.h < 0.005) return;
        setBox(edits, b, x);
      }
      if (x) for (const k of ['x1', 'y1', 'x2', 'y2']) if (k in x) x[k] = Math.min(1, Math.max(0, x[k]));
      drawLayer(true);
      opts.changed();
    };
    const up = () => {
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', up);
      if (snapshot() !== before) { pushUndo(before, null, describeChange(JSON.parse(before), edits)); edits = normaliseEdits(edits); after(); }
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  });
  layer.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const g = grab(toFrac(e));
    layer.style.cursor = g === 'move' ? 'move' : g === 'tl' || g === 'br' ? 'nwse-resize' : g === 'tr' || g === 'bl' ? 'nesw-resize' : g ? 'grab' : 'crosshair';
  });

  // ---------- crop, background and sound ----------

  const bg = () => edits.background;
  function renderSettings() {
    $('#crop-on').checked = !!edits.crop || cropping;
    $('#crop-opts').classList.toggle('hidden', !$('#crop-on').checked);
    $('#crop-size').textContent = edits.crop ? `${Math.round(edits.crop.w * player.videoWidth)} × ${Math.round(edits.crop.h * player.videoHeight)}` : '';
    const b = bg();
    $('#bg-on').checked = b.on;
    $('#bg-opts').classList.toggle('hidden', !b.on);
    for (const btn of document.querySelectorAll('#bg-kind button')) { btn.classList.toggle('on', btn.dataset.v === b.kind); btn.setAttribute('aria-checked', String(btn.dataset.v === b.kind)); }
    $('#bg-c1').value = b.c1;
    $('#bg-c2').value = b.c2;
    $('#bg-c2').classList.toggle('hidden', b.kind !== 'gradient');
    $('#bg-padding').value = b.padding;
    $('#bg-padding-v').textContent = `${b.padding}%`;
    $('#bg-radius').value = b.radius;
    $('#bg-radius-v').textContent = `${b.radius}%`;
    $('#bg-shadow').checked = b.shadow;
    $('#bg-aspect').value = b.aspect;
    const a = edits.audio;
    $('#au-volume').value = Math.round(a.volume * 100);
    $('#au-volume-v').textContent = `${Math.round(a.volume * 100)}%`;
    $('#au-fade-in').value = String(a.fadeIn);
    $('#au-fade-out').value = String(a.fadeOut);
    $('#au-clean').checked = a.clean;
    $('#au-level').checked = a.level;
    for (const id of ['#au-clean-row', '#au-level-row']) $(id).classList.toggle('hidden', !opts.meta.hasAudio);
    const clicks = !!opts.meta.clicks?.length;
    $('#ed-autozoom').classList.toggle('hidden', !clicks);
    $('#ed-follow').classList.toggle('hidden', !opts.meta.moves?.length);
    $('#ed-silence').classList.toggle('hidden', !opts.meta.hasAudio);
    $('#ed-silence').disabled = !opts.levels?.();
    $('#ed-mark span').textContent = mark === null ? t('edit_mark') : t('edit_mark_end');
    $('#ed-mark').classList.toggle('on', mark !== null);
    $('#rings-row').classList.toggle('hidden', !clicks);
    $('#rings-on').checked = edits.rings.on;
    const sw = $('#rings-colours');
    sw.classList.toggle('hidden', !edits.rings.on);
    if (!sw.children.length) sw.innerHTML = CALLOUT_COLOURS.map((c) => `<button type="button" data-colour="${c}" style="background:${c}" aria-label="${c}"></button>`).join('');
    for (const b of sw.children) b.setAttribute('aria-pressed', String(b.dataset.colour === edits.rings.color));
  }

  $('#crop-on').addEventListener('change', (e) => {
    if (e.target.checked) {
      change((x) => { x.crop = x.crop || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }; });
      cropping = true;
      selected = null;
      $('#crop-section').open = true;
    } else {
      cropping = false;
      change((x) => { x.crop = null; });
    }
    render();
  });
  $('#crop-section').addEventListener('toggle', () => { cropping = $('#crop-section').open && !!edits.crop; if (cropping) selected = null; render(); });
  $('#crop-aspect').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of document.querySelectorAll('#crop-aspect button')) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }
    if (!edits.crop) return;
    cropping = true;
    selected = null;
    // Fit the shape inside the crop as it is, centred.
    const ratio = ASPECTS[b.dataset.v];
    if (ratio) {
      change((x) => {
        const c = x.crop, W = player.videoWidth, H = player.videoHeight;
        let w = c.w * W, h = c.h * H;
        if (w / h > ratio) w = h * ratio; else h = w / ratio;
        x.crop = { x: c.x + (c.w - w / W) / 2, y: c.y + (c.h - h / H) / 2, w: w / W, h: h / H };
      });
    }
    render();
  });
  $('#crop-reset').addEventListener('click', () => { cropping = false; change((x) => { x.crop = null; }); });

  $('#bg-on').addEventListener('change', (e) => change((x) => { x.background.on = e.target.checked; }));
  $('#bg-kind').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) change((x) => { x.background.kind = v; }); });
  for (const [id, k, num] of [['#bg-c1', 'c1'], ['#bg-c2', 'c2'], ['#bg-padding', 'padding', true], ['#bg-radius', 'radius', true], ['#bg-aspect', 'aspect']]) {
    $(id).addEventListener('input', (e) => change((x) => { x.background[k] = num ? Number(e.target.value) : e.target.value; }, { quiet: true, group: `bg:${k}` }));
  }
  $('#bg-shadow').addEventListener('change', (e) => change((x) => { x.background.shadow = e.target.checked; }));
  $('#au-volume').addEventListener('input', (e) => change((x) => { x.audio.volume = Number(e.target.value) / 100; }, { quiet: true, group: 'volume' }));
  $('#au-fade-in').addEventListener('change', (e) => change((x) => { x.audio.fadeIn = Number(e.target.value); }));
  $('#au-fade-out').addEventListener('change', (e) => change((x) => { x.audio.fadeOut = Number(e.target.value); }));
  $('#au-mute').addEventListener('click', () => add('mutes'));
  $('#rings-on').addEventListener('change', (e) => change((x) => { x.rings.on = e.target.checked; }));
  $('#rings-colours').addEventListener('click', (e) => { const c = e.target.closest('[data-colour]')?.dataset.colour; if (c) change((x) => { x.rings.color = c; }); });
  $('#bg-default').addEventListener('click', async () => {
    await opts.saveDefault('background', { ...edits.background });
    toast(t(edits.background.on ? 'edit_default_bg_saved' : 'edit_default_bg_none'), { kind: 'success' });
  });
  $('#au-default').addEventListener('click', async () => {
    const { volume, fadeIn, fadeOut } = edits.audio;
    await opts.saveDefault('audio', { volume, fadeIn, fadeOut });
    toast(t('edit_default_sound_saved'), { kind: 'success' });
  });

  // ---------- buttons and keys ----------

  $('#ed-add').addEventListener('click', (e) => {
    const kind = e.target.closest('[data-add]')?.dataset.add;
    if (kind === 'textlayer') {
      // Words over the picture, in the middle to start with, as long as a caption.
      add('layers', { kind: 'text', text: t('vlayer_text_default'), color: '#ffffff', bg: 'dark', border: 'none', shadow: true, size: 0.45, pos: 'c', shape: 'rect', aspect: 3, len: 3 });
    } else if (kind) add(kind);
  });
  $('#ed-autozoom').addEventListener('click', zoomOnClicks);
  // One zoom over the kept part that follows the pointer.
  $('#ed-follow').addEventListener('click', () => {
    const { start, end } = opts.trim();
    $('#edit-section').open = true;
    const x = { id: editId(), from: round(start), to: round(end), x: 0.5, y: 0.5, scale: 1.6, auto: false, follow: true };
    change((e) => { e.zooms = [...e.zooms.filter((z) => !z.follow), x]; });
    select('zooms', x.id);
    toast(t('zoom_follow_added'), { kind: 'success' });
  });
  $('#au-clean').addEventListener('change', (e) => change((x) => { x.audio.clean = e.target.checked; }));
  $('#au-level').addEventListener('change', (e) => change((x) => { x.audio.level = e.target.checked; }));
  $('#ed-silence').addEventListener('click', cutSilences);
  $('#ed-mark').addEventListener('click', markCut);
  $('#ed-undo').addEventListener('click', () => restore(undo, redo));
  $('#ed-redo').addEventListener('click', () => restore(redo, undo));

  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable || opts.busy()) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) restore(redo, undo); else restore(undo, redo);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (k === 'x' && e.shiftKey) { e.preventDefault(); $('#edit-section').open = true; markCut(); return; }
    const kind = Object.keys(KINDS).find((x) => KINDS[x].key === k);
    if (kind) { e.preventDefault(); $('#edit-section').open = true; add(kind); return; }
    if ((k === 'delete' || k === 'backspace') && selected) { e.preventDefault(); remove(selected.kind, selected.id); return; }
    // Enter splits the chosen edit at the playhead (not while a button has the focus).
    if (k === 'enter' && selected && !e.target.closest('button, a, summary')) { e.preventDefault(); split(); return; }
    if (k === 'escape' && (selected || cropping || mark !== null)) { selected = null; cropping = false; mark = null; render(); }
  });
  addEventListener('resize', () => drawLayer(true));
  player.addEventListener('seeked', () => drawLayer());

  function render(quiet = false) {
    renderList();
    if (!quiet) renderForm();
    renderMarks();
    renderSettings();
    $('#ed-undo').disabled = !undo.length;
    $('#ed-redo').disabled = !redo.length;
    $('#ed-hist-open').disabled = !undo.length && !redo.length;
    renderHistory();
    drawLayer(true);
  }

  render();
  return {
    get: () => edits,
    /** Adds an edit of `kind` (as its button does), with any `fields` given. */
    add: (kind, fields) => add(kind, fields),
    /** Where each moment of the kept part plays. */
    map: () => { const { start, end } = opts.trim(); return clipMap(edits, start, end); },
    editing,
    refresh: () => { renderMarks(); renderList(); },
    redraw: () => {
      drawLayer();
      placePending();
      // Split is offered while the playhead is inside the chosen edit.
      const b = form.querySelector('[data-split]');
      const x = item();
      if (b && x) b.disabled = !(player.currentTime >= x.from + 0.1 && player.currentTime <= x.to - 0.1);
    },
    /** Once the sound's loudness is known. */
    soundReady: () => renderSettings(),
    /** After the recording's size is known. */
    ready: () => render(),
    /** Changes the music (null: none); it can be undone. `quiet`: a slider moving. */
    setMusic: (m, quiet = false) => change((e) => { e.music = m ? { ...(e.music || {}), ...m } : null; }, { quiet, group: quiet ? 'music' : null }),
    /** Changes a caption's words (`quiet`: typing, undone as one step). */
    setCaption: (id, patch, quiet = false) => change((e) => { const c = e.captions.find((x) => x.id === id); if (c) Object.assign(c, patch); }, { quiet, group: quiet ? `${id}:review` : null }),
    /** Chooses a caption, as clicking it does. */
    chooseCaption: (id) => select('captions', id),
    /** Adds captions ([{ from, to, text }]) in one step to undo. */
    addCaptions: (list) => change((e) => { for (const c of list) e.captions.push({ id: editId(), from: c.from, to: c.to, text: String(c.text).slice(0, 300), size: 2 }); }),
    /** Puts `list` in place of the chapters; it can be undone. */
    setChapters: (list, quiet = false) => change((e) => { e.chapters = list; }, { quiet, group: quiet ? 'chapters' : null }),
    /** Changes the background (for a platform's shape); it can be undone. */
    setBackground: (patch) => change((e) => { Object.assign(e.background, patch); }),
    /** Adds a zoom at each recorded click, as Zoom in on clicks does. */
    zoomOnClicks: () => zoomOnClicks(),
    /** Chooses an edit, as clicking it in the list does. */
    choose: (kind, id) => select(kind, id),
    /** Puts a brand kit's look on the video: how captions look, and the background (not its shape). */
    setLook(look) {
      const n = normaliseEdits({ captionStyle: look?.captionStyle || {}, background: look?.background || {} });
      change((e) => {
        if (look?.captionStyle) for (const k of ['font', 'color', 'band', 'place', 'highlight', 'hcolor']) e.captionStyle[k] = n.captionStyle[k];
        if (look?.background) Object.assign(e.background, { ...n.background, aspect: e.background.aspect });
      });
    },
    /** Changes how every caption looks (it can be undone). */
    setCaptionStyle: (patch) => change((e) => { Object.assign(e.captionStyle, patch); }),
    /** Turns the rings at clicks on or off. */
    setRings: (on) => change((e) => { e.rings.on = on; }),
    /** Adds layers (voiceover pieces, say) as one change that can be undone. */
    addLayers(list) {
      const made = list.map((f) => ({ id: editId(), ...f }));
      change((e) => { e.layers.push(...made); });
      if (made[0]) select('layers', made[0].id);
      return made;
    },
    /**
     * Cuts out filler words: `cuts` [{ from, to }] and `words` { [caption id]: Set of word
     * numbers } taken out of the captions, as one change that can be undone.
     */
    cutFillers(cuts, words) {
      change((e) => {
        for (const c of cuts) e.cuts.push({ id: editId(), from: round(c.from), to: round(c.to) });
        for (const c of e.captions) if (words[c.id]) c.text = withoutWords(c.text, words[c.id]);
        e.captions = e.captions.filter((c) => c.text.trim());
      });
    },
    /** The chosen edit, when it is one of `kind`. */
    chosen: (kind) => (selected?.kind === kind ? item() : null),
    /** Changes a layer as it is dragged on the picture: one step to undo; `done` shows the form again. */
    placeLayer(id, fields, done = false) {
      if (done) { renderForm(); return; }
      change((e) => { const l = e.layers.find((y) => y.id === id); if (l) Object.assign(l, fields); }, { quiet: true, group: `${id}:place` });
    },
    /** Puts `raw` in place of the edits (it can be undone). */
    replace: (raw) => change((e) => { Object.assign(e, normaliseEdits(raw)); }),
  };
}
