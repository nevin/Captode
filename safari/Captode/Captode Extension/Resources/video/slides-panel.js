// The Slides section of the video page: the recording's slides in a list, a form for
// the one chosen, a marker for each on the timeline, and the slide itself over the
// player while it is being edited or when playback reaches it. Overlays show over the
// recording as it plays. Drawing, timing and export live in lib/slides.js.
import { THEMES, STYLE_KEYS, newSlide, drawSlide, slideImages, loadFontFile, isOverlay, overlaySchedule, overlaysAt, portable, cleanFields, slidesFile, readSlidesFile } from '../lib/slides.js';
import { mountPresets } from '../lib/presets.js';
import { toast } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

const $ = (s) => document.querySelector(s);
const STYLE_STORE = 'slideStyle';
const MARK_MIN_PX = 18; // the narrowest a marker is drawn (.slide-mark's min-width)
const EDGE_PX = 7; // how near an overlay bar's right edge a press resizes it (.slide-mark.overlay::after)

/**
 * opts: {
 *   player, slides (as saved, or none), duration(), trim() → { start, end }, clip() (lib/video-edits.js clipMap),
 *   size() → [width, height] of the exported picture, fmtTime(s),
 *   changed() after any change (estimates, a stale export), save(slides), busy()
 * }
 */
export function mountSlides(opts) {
  const { player } = opts;
  // Fill in anything a slide saved by an older version lacks.
  let slides = (opts.slides || []).map((s) => newSlide(s.at, s));
  let selected = null; // the chosen slide's id
  let shown = null; // { s, present, timers } while a slide is over the player
  let skipAt = null; // the moment of a slide just presented, so carrying on doesn't show it again
  let selfSeek = false;

  const view = $('#slide-view');
  const editor = $('#slide-editor');
  const sel = () => slides.find((s) => s.id === selected) || null;
  const byTime = () => [...slides].sort((a, b) => a.at - b.at);
  const number = (s) => byTime().indexOf(s) + 1;
  const inTrim = (s) => { const { start, end } = opts.trim(); return s.at >= start - 1e-3 && s.at <= end + 1e-3; };
  const pct = (x) => (opts.duration() ? (x / opts.duration()) * 100 : 0) + '%';

  // ---------- drawing ----------

  /** Draws `s` into `canvas` at `scale` of the output size (the layout is the same at any size). */
  async function paint(canvas, s, maxSide) {
    const [W, H] = opts.size();
    if (!W || !H) return;
    const k = Math.min(1, maxSide / Math.max(W, H));
    const imgs = await slideImages(s);
    canvas.width = Math.max(1, Math.round(W * k));
    canvas.height = Math.max(1, Math.round(H * k));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    return { k, rects: drawSlide(ctx, s, W, H, imgs) };
  }

  let viewToken = 0;
  async function drawView() {
    if (!shown) return;
    const token = ++viewToken;
    const c = new OffscreenCanvas(1, 1);
    const laid = await paint(c, shown.s, 1920);
    if (token !== viewToken || !shown) return;
    view.width = c.width;
    view.height = c.height;
    // Drawn into a copy first, so outlines can come and go (redecorate) without drawing it all again.
    viewFrame = new OffscreenCanvas(c.width, c.height);
    viewLayout = shown.present ? null : laid;
    const ctx = viewFrame.getContext('2d');
    // An overlay being edited shows over the others on at its moment (which all started
    // before it, so are drawn under it in the export too).
    if (isOverlay(shown.s) && !shown.present) {
      for (const x of overlaysNow(shown.s.at)) {
        if (x.id === shown.s.id) continue;
        ctx.globalAlpha = x.a;
        ctx.drawImage(x.canvas, x.dx * x.canvas.width, 0);
      }
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(c, 0, 0);
    redecorate();
  }

  // ---------- moving the logo and the words on the preview ----------
  // On the slide being edited: drag the logo or the words to move them, or the corner
  // of either to resize. Both snap to the middle of the picture. The outlines are only
  // drawn here, never exported.

  let viewFrame = null; // the view as drawn, without outlines
  let viewLayout = null; // { k, rects: { logo, text } } while editing, in output pixels
  const pointer = { hover: null, drag: null, guides: [], noClick: false };

  /** The view again: the slide as drawn, and the outlines and guides of what is pointed at or dragged. */
  function redecorate() {
    if (!viewFrame) return;
    const ctx = view.getContext('2d');
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(viewFrame, 0, 0);
    if (!viewLayout || !shown || shown.present) return;
    const { k, rects } = viewLayout;
    const [W, H] = opts.size();
    const box = view.getBoundingClientRect();
    if (!box.width) return;
    const px = W / box.width; // one CSS pixel, in output pixels
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = '#ff3fb4';
    ctx.setLineDash([6 * px, 5 * px]);
    for (const g of pointer.guides) {
      ctx.beginPath();
      if ('x' in g) { ctx.moveTo(g.x, 0); ctx.lineTo(g.x, H); } else { ctx.moveTo(0, g.y); ctx.lineTo(W, g.y); }
      ctx.stroke();
    }
    const r = rects[pointer.drag?.what || pointer.hover];
    if (r) {
      ctx.strokeStyle = '#7a6cff';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      const h = 9 * px;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(r.x + r.w - h / 2, r.y + r.h - h / 2, h, h);
      ctx.strokeRect(r.x + r.w - h / 2, r.y + r.h - h / 2, h, h);
    }
    ctx.restore();
  }

  /** Where the pointer is on the slide, in output pixels; `unit` is one CSS pixel there. */
  function onSlide(e) {
    const box = view.getBoundingClientRect();
    const [W, H] = opts.size();
    return { x: ((e.clientX - box.left) / box.width) * W, y: ((e.clientY - box.top) / box.height) * H, unit: W / box.width };
  }

  /** What is at `p`: `{ what: 'logo' | 'text', resize }`, the logo first (it is drawn on top). */
  function hitAt(p) {
    if (!viewLayout || !shown || shown.present) return null;
    const near = 10 * p.unit;
    for (const what of ['logo', 'text']) {
      const r = viewLayout.rects[what];
      if (r && Math.abs(p.x - (r.x + r.w)) <= near && Math.abs(p.y - (r.y + r.h)) <= near) return { what, resize: true };
    }
    for (const what of ['logo', 'text']) {
      const r = viewLayout.rects[what];
      if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return { what, resize: false };
    }
    return null;
  }

  view.addEventListener('pointerdown', (e) => {
    if (opts.busy()) return;
    const p = onSlide(e);
    const h = hitAt(p);
    if (!h) return; // a click on the rest plays, as on the player
    e.preventDefault();
    view.setPointerCapture(e.pointerId);
    const s = shown.s;
    pointer.drag = {
      ...h, s, p0: p, moved: false, r: { ...viewLayout.rects[h.what] },
      size0: h.what === 'logo' ? s.logoSize : s.textSize || 100, at0: { x: 0, y: 0, ...s.textAt },
    };
  });
  view.addEventListener('pointermove', (e) => {
    const p = onSlide(e);
    const d = pointer.drag;
    if (!d) {
      const h = hitAt(p);
      view.style.cursor = h ? (h.resize ? 'nwse-resize' : 'move') : '';
      if ((h?.what || null) !== pointer.hover) { pointer.hover = h?.what || null; redecorate(); }
      return;
    }
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    if (!d.moved && Math.hypot(dx, dy) < 3 * p.unit) return;
    d.moved = true;
    const [W, H] = opts.size();
    pointer.guides = [];
    if (d.resize) {
      // Larger or smaller in proportion, by whichever way the corner moved further.
      const grow = Math.max((d.r.w + dx) / d.r.w, (d.r.h + dy) / d.r.h);
      if (d.what === 'logo') update({ logoSize: Math.round(Math.max(2, Math.min(40, d.size0 * grow))) }, { thumbs: false });
      else update({ textSize: Math.round(Math.max(50, Math.min(200, d.size0 * grow)) / 5) * 5 }, { thumbs: false });
      return;
    }
    const snap = 8 * p.unit;
    const cx0 = d.r.x + d.r.w / 2, cy0 = d.r.y + d.r.h / 2;
    let cx = cx0 + dx, cy = cy0 + dy;
    if (Math.abs(cx - W / 2) < snap) { cx = W / 2; pointer.guides.push({ x: W / 2 }); }
    if (Math.abs(cy - H / 2) < snap) { cy = H / 2; pointer.guides.push({ y: H / 2 }); }
    const round = (v) => Math.round(v * 1e4) / 1e4;
    if (d.what === 'logo') update({ logoAt: { x: round(cx / W), y: round(cy / H) } }, { thumbs: false });
    else update({ textAt: { x: round(d.at0.x + (cx - cx0) / W), y: round(d.at0.y + (cy - cy0) / H) } }, { thumbs: false });
  });
  const endDrag = () => {
    const d = pointer.drag;
    if (!d) return;
    pointer.drag = null;
    pointer.guides = [];
    if (d.moved) { pointer.noClick = true; updateThumb(d.s); }
    redecorate();
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('pointerleave', () => { if (!pointer.drag && pointer.hover) { pointer.hover = null; redecorate(); } });
  // A double click on the words goes to their fields.
  view.addEventListener('dblclick', (e) => { if (hitAt(onSlide(e))?.what === 'text') $('#sl-title').focus(); });

  // ---------- overlays over the playing recording ----------

  const liveArt = new Map(); // slide id -> { canvas, stale }, each drawn once
  let liveKey = ''; // what the view shows now, so it is only redrawn when that changes

  /** Overlay `s` drawn at the output size; until a fresh drawing is ready, the one before. */
  function liveCanvas(s) {
    let art = liveArt.get(s.id);
    if (!art || art.stale) {
      art = { canvas: art?.canvas || null, stale: false };
      liveArt.set(s.id, art);
      const next = new OffscreenCanvas(1, 1);
      paint(next, s, 1920).then(() => {
        if (liveArt.get(s.id) !== art) return;
        art.canvas = next;
        liveKey = '';
        if (shown && !shown.present && isOverlay(shown.s)) drawView(); // one it is shown with
      });
    }
    return art.canvas;
  }

  /** After a change: the overlay `s` (or every one) is drawn again. */
  function forget(s) {
    for (const [id, art] of liveArt) if (!s || id === s.id) art.stale = true;
    liveKey = '';
  }

  /** The overlays on at time `now` (within the kept part), drawn and ready: `[{ id, canvas, a, dx }]`. */
  function overlaysNow(now) {
    const { start, end } = opts.trim();
    const fps = 60; // steps of the fades
    if (now > end + 1e-3) return [];
    const map = opts.clip?.(); // with parts cut or sped up, an overlay goes by where it plays
    return overlaysAt(overlaySchedule(slides, start, end, fps, map), (map ? map.outOf(now) : now - start) * fps, fps)
      .map(({ e, a, dx }) => ({ id: e.s.id, canvas: liveCanvas(e.s), a, dx }))
      .filter((x) => x.canvas);
  }

  /** The overlays at the playhead, in the view; it is theirs whenever no slide has it. */
  function drawLive() {
    if (shown) return;
    const on = $('#player').classList.contains('hidden') ? [] : overlaysNow(player.currentTime);
    // One overlay is faded by the view's style, so it is only drawn again while it moves
    // (sliding in stays inside the picture); several are drawn together as they change.
    const one = on.length === 1 ? on[0] : null;
    const key = one ? `${one.id}:${one.dx.toFixed(3)}` : on.map((x) => `${x.id}:${x.a.toFixed(2)}:${x.dx.toFixed(3)}`).join() || 'none';
    view.style.opacity = String(one ? one.a : 1);
    if (key === liveKey) return;
    liveKey = key;
    view.classList.toggle('hidden', !on.length);
    if (!on.length) return;
    view.width = on[0].canvas.width;
    view.height = on[0].canvas.height;
    view.style.transition = 'none';
    const ctx = view.getContext('2d');
    for (const x of on) {
      ctx.globalAlpha = one ? 1 : x.a;
      ctx.drawImage(x.canvas, x.dx * x.canvas.width, 0);
    }
    ctx.globalAlpha = 1;
  }

  function show(s, present = false) {
    clearTimers();
    liveKey = '';
    shown = { s, present, timers: [] };
    view.classList.remove('hidden');
    view.style.transition = 'none';
    view.style.opacity = present && s.fade ? '0' : '1';
    drawView().then(() => {
      if (!(present && s.fade) || shown?.s !== s) return;
      view.style.transition = 'opacity .4s';
      view.style.opacity = '1';
    });
    const label = $('#preview-label');
    label.textContent = t('slides_of', [number(s), slides.length]);
    label.classList.remove('hidden');
  }

  function hide() {
    clearTimers();
    if (!shown) return;
    shown = null;
    liveKey = '';
    viewFrame = viewLayout = null;
    pointer.hover = pointer.drag = null;
    view.style.cursor = '';
    view.classList.add('hidden');
    if (!$('#player').classList.contains('hidden')) $('#preview-label').classList.add('hidden');
  }

  function clearTimers() {
    for (const id of shown?.timers || []) clearTimeout(id);
  }

  /** Shows the chosen slide on the paused player, at its moment. */
  function preview(s) {
    player.pause();
    if (Math.abs(player.currentTime - s.at) > 1e-3) {
      selfSeek = true;
      player.currentTime = s.at;
    }
    show(s);
  }

  /** During playback: shows these (inserted) slides in turn, the recording waiting, then carries on. */
  function present(queue) {
    const [s, ...rest] = queue;
    player.pause();
    skipAt = s.at;
    show(s, true);
    const ms = s.duration * 1000;
    if (s.fade && ms > 1200) shown.timers.push(setTimeout(() => { view.style.transition = 'opacity .4s'; view.style.opacity = '0'; }, ms - 400));
    shown.timers.push(setTimeout(() => {
      if (rest.length) return present(rest);
      hide();
      if (s.at < opts.trim().end - 0.05) player.play();
    }, ms));
  }

  const dueAt = (a, b) => slides
    .filter((s) => !isOverlay(s) && s.at > a && s.at <= b + 1e-3 && s.at !== skipAt && inTrim(s))
    .sort((x, y) => x.at - y.at);
  const sameTime = (list) => list.filter((s) => Math.abs(s.at - list[0].at) < 1e-3);

  // Playback reaching a slide (including the end of the trimmed part, where the page pauses).
  let last = player.currentTime;
  let wasPlaying = false;
  (function watch() {
    const now = player.currentTime;
    if (skipAt !== null && Math.abs(now - skipAt) > 0.1) skipAt = null;
    if (wasPlaying && !shown?.present && now > last && now - last < 0.5 && !opts.busy()) {
      const due = dueAt(last, now);
      if (due.length) present(sameTime(due));
    }
    last = now;
    wasPlaying = !player.paused;
    drawLive();
    requestAnimationFrame(watch);
  })();
  // Starting from a slide's own moment (such as one at the start) shows it first.
  player.addEventListener('play', () => {
    if (shown?.present) return;
    hide();
    const here = slides.filter((s) => !isOverlay(s) && Math.abs(s.at - player.currentTime) < 0.02 && s.at !== skipAt && inTrim(s)).sort((a, b) => a.at - b.at);
    if (here.length) present(here);
  });
  player.addEventListener('seeking', () => {
    if (selfSeek) { selfSeek = false; return; }
    if (!shown?.present) { hide(); skipAt = null; }
  });
  // Like a click on the player: plays from here (this slide first), or carries on. Not
  // after moving something on it, nor on the logo or the words while editing.
  view.addEventListener('click', (e) => {
    if (pointer.noClick) { pointer.noClick = false; return; }
    if (hitAt(onSlide(e))) return;
    player.click();
  });

  /** Ends a slide being presented, and playback carries on. */
  function skip() {
    if (!shown?.present) return false;
    const at = shown.s.at;
    hide();
    skipAt = at;
    if (at < opts.trim().end - 0.05) player.play();
    return true;
  }

  // ---------- the list and the markers ----------

  function renderList() {
    $('#slide-export').disabled = !slides.length;
    const list = $('#slide-list');
    list.textContent = '';
    $('#slide-count').textContent = slides.length ? String(slides.length) : '';
    if (!slides.length) {
      const p = document.createElement('p');
      p.className = 'muted small slide-empty';
      p.textContent = t('slides_empty');
      list.append(p);
    }
    for (const s of byTime()) {
      const item = document.createElement('div');
      item.className = 'slide-item';
      item.dataset.id = s.id;
      item.setAttribute('role', 'option');
      item.tabIndex = 0;
      item.innerHTML = '<canvas class="slide-thumb"></canvas><span class="slide-name"><b></b><small></small></span>';
      paint(item.querySelector('canvas'), s, 72 * devicePixelRatio);
      list.append(item);
    }
    syncItems();
    renderMarks();
  }

  /** The list's words and states, without redrawing thumbnails. */
  function syncItems() {
    for (const item of document.querySelectorAll('#slide-list .slide-item')) {
      const s = slides.find((x) => x.id === item.dataset.id);
      if (!s) continue;
      const on = s.id === selected;
      item.classList.toggle('on', on);
      item.classList.toggle('overlay', isOverlay(s));
      item.setAttribute('aria-selected', String(on));
      item.classList.toggle('out', !inTrim(s));
      item.querySelector('b').textContent = s.title.trim() || t('slides_untitled', number(s));
      item.querySelector('small').textContent = inTrim(s)
        ? t('slides_when', [opts.fmtTime(s.at), formatSeconds(s.duration)])
        : t('slides_outside');
    }
  }

  function renderMarks() {
    const marks = $('#slide-marks');
    marks.textContent = '';
    for (const s of byTime()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slide-mark';
      b.dataset.id = s.id;
      b.textContent = number(s);
      marks.append(b);
    }
    syncMarks();
  }

  /**
   * A row under the timeline for each overlay, so overlapping bars can each be grabbed:
   * the first row whose bars have ended by the time it starts. Map of id -> row.
   */
  function overlayRows() {
    const width = $('#track').getBoundingClientRect().width;
    const minLen = width ? (MARK_MIN_PX / width) * opts.duration() : 0; // a bar is never shorter than this
    const ends = []; // each row's last end
    const rows = new Map();
    for (const s of byTime().filter(isOverlay)) {
      let row = ends.findIndex((end) => end <= s.at + 1e-3);
      if (row < 0) row = ends.length;
      ends[row] = s.at + Math.max(s.duration, minLen);
      rows.set(s.id, row);
    }
    $('#timeline').style.setProperty('--slide-rows', String(Math.max(0, ends.length - 1)));
    return rows;
  }

  function syncMarks() {
    const rows = overlayRows();
    for (const b of document.querySelectorAll('#slide-marks .slide-mark')) {
      const s = slides.find((x) => x.id === b.dataset.id);
      if (!s) continue;
      const overlay = isOverlay(s);
      b.style.left = pct(s.at);
      b.style.setProperty('--row', String(rows.get(s.id) || 0));
      // An overlay's marker is a bar as long as it shows.
      b.style.width = overlay ? pct(Math.min(s.duration, opts.duration() - s.at)) : '';
      b.classList.toggle('overlay', overlay);
      // An inserted slide adds its time to the export: shown on its marker.
      if (overlay) delete b.dataset.adds;
      else b.dataset.adds = t('slides_adds', formatSeconds(s.duration));
      b.classList.toggle('on', s.id === selected);
      b.classList.toggle('out', !inTrim(s));
      const when = overlay ? `${opts.fmtTime(s.at)}–${opts.fmtTime(s.at + s.duration)}` : opts.fmtTime(s.at);
      b.setAttribute('aria-label', `${s.title.trim() || t('slides_untitled', number(s))} · ${when}`);
    }
  }

  function updateThumb(s) {
    const c = document.querySelector(`#slide-list .slide-item[data-id="${s.id}"] canvas`);
    if (c) paint(c, s, 72 * devicePixelRatio);
  }

  $('#slide-list').addEventListener('click', (e) => {
    const id = e.target.closest('.slide-item')?.dataset.id;
    if (id) select(id);
  });
  $('#slide-list').addEventListener('keydown', (e) => {
    const item = e.target.closest('.slide-item');
    if (!item) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(item.dataset.id); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(item.dataset.id); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      (e.key === 'ArrowDown' ? item.nextElementSibling : item.previousElementSibling)?.focus();
    }
  });

  // A marker: a click chooses its slide, a drag moves it along the recording. The
  // right edge of an overlay's bar is dragged to change how long it shows.
  $('#slide-marks').addEventListener('pointerdown', (e) => {
    const mark = e.target.closest('.slide-mark');
    if (!mark || opts.busy()) return;
    e.stopPropagation(); // not a click on the timeline itself
    e.preventDefault();
    const s = slides.find((x) => x.id === mark.dataset.id);
    const track = $('#track').getBoundingClientRect();
    const x0 = e.clientX;
    const timeAt = (x) => ((x - track.left) / track.width) * opts.duration();
    const edge = isOverlay(s) && x0 >= mark.getBoundingClientRect().right - EDGE_PX;
    // Where on the marker it was held (an overlay's bar is long), from its start or its end.
    const grab = (edge ? s.at + s.duration : s.at) - timeAt(x0);
    let moved = false;
    mark.setPointerCapture(e.pointerId);
    if (selected !== s.id) select(s.id);
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const t = timeAt(ev.clientX) + grab;
      if (edge) update({ duration: Math.round(clampNum('duration', t - s.at, s.mode) * 10) / 10 }, { thumbs: false });
      else update({ at: Math.round(Math.max(0, Math.min(opts.duration(), t)) * 10) / 10 }, { thumbs: false });
    };
    const up = () => {
      mark.removeEventListener('pointermove', move);
      mark.removeEventListener('pointerup', up);
      mark.removeEventListener('pointercancel', up);
      if (moved) renderList();
      mark.focus();
    };
    mark.addEventListener('pointermove', move);
    mark.addEventListener('pointerup', up);
    mark.addEventListener('pointercancel', up);
  });
  $('#slide-marks').addEventListener('keydown', (e) => {
    const mark = e.target.closest('.slide-mark');
    if (!mark) return;
    const s = slides.find((x) => x.id === mark.dataset.id);
    const step = e.shiftKey ? 1 : 0.1;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); select(s.id); return; }
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (selected !== s.id) select(s.id);
    // With Alt, an overlay's arrows change how long it shows, as dragging its right edge does.
    if (e.altKey && isOverlay(s)) update({ duration: Math.round(clampNum('duration', s.duration + d, s.mode) * 10) / 10 });
    else update({ at: Math.round(Math.max(0, Math.min(opts.duration(), s.at + d)) * 10) / 10 });
    document.querySelector(`#slide-marks .slide-mark[data-id="${s.id}"]`)?.focus();
  });

  // ---------- the form ----------

  function select(id) {
    selected = id;
    const s = sel();
    editor.classList.toggle('hidden', !s);
    syncItems();
    syncMarks();
    if (!s) { hide(); return; }
    kits?.clear(); // a kit was applied to the slide chosen before
    fillForm();
    preview(s);
  }

  // ---------- brand kits: styles kept by name ----------
  // Saved like export presets. A kit holds a slide's style, with its logo, font file and
  // background picture (each up to 3 MB); choosing one puts that style on the chosen slide.

  let kits = null;
  mountPresets($('#sl-kits'), {
    kind: 'slideKit',
    watch: editor,
    words: {
      label: t('slides_kit'), custom: t('slides_kit_none'), yours: t('slides_kit_yours'), saveCurrent: t('slides_kit_save'),
      placeholder: t('slides_kit_name'), name: t('slides_kit_name'), delete: t('slides_kit_delete'), deleted: (n) => t('slides_kit_deleted', n),
    },
    capture: async () => {
      const s = sel();
      return { style: await portable(Object.fromEntries(STYLE_KEYS.map((k) => [k, s?.[k] ?? null])), { maxBlob: 3e6 }) };
    },
    apply: async (p) => { if (sel()) update(await cleanFields(p.style)); },
  }).then((k) => { kits = k; });

  // ---------- slides to and from a file ----------

  $('#slide-export').addEventListener('click', async () => {
    if (!slides.length) return;
    const blob = new Blob([JSON.stringify(await slidesFile(byTime()))], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'captode-slides.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  });
  $('#slide-import').addEventListener('click', () => { $('#slide-import-file').value = ''; $('#slide-import-file').click(); });
  $('#slide-import-file').addEventListener('change', async () => {
    const f = $('#slide-import-file').files[0];
    if (!f || opts.busy()) return;
    let list = null;
    try { list = await readSlidesFile(JSON.parse(await f.text())); } catch { /* not JSON */ }
    if (!list?.length) { toast(t('slides_import_failed'), { kind: 'error' }); return; }
    // Added to these, at their own moments, kept within this recording.
    const added = list.map((fields) => {
      const s = newSlide(0, fields);
      s.at = Math.round(Math.max(0, Math.min(opts.duration(), s.at)) * 10) / 10;
      return s;
    });
    slides.push(...added);
    followTrim();
    renderList();
    select(added[0].id);
    changed();
    toast(t('slides_imported', added.length), { kind: 'success' });
  });

  function fillForm() {
    const s = sel();
    if (!s) return;
    for (const el of editor.querySelectorAll('[data-k]')) {
      const v = s[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (document.activeElement !== el) el.value = el.dataset.k === 'at' ? v.toFixed(1) : v ?? '';
    }
    for (const b of document.querySelectorAll('#sl-themes button')) b.setAttribute('aria-pressed', String(b.dataset.theme === s.theme));
    for (const [group, key] of [['#sl-mode', 'mode'], ['#sl-layout', 'layout'], ['#sl-bg', 'bgKind']]) {
      for (const b of document.querySelectorAll(`${group} button`)) {
        const on = b.dataset.v === s[key];
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
    }
    for (const el of editor.querySelectorAll('[data-bg]')) el.classList.toggle('hidden', !el.dataset.bg.split(' ').includes(s.bgKind));
    // An overlay has no background, and may have a band behind its words instead.
    const overlay = isOverlay(s);
    $('#sl-mode-hint').textContent = t(overlay ? 'slides_mode_overlay_hint' : 'slides_mode_insert_hint');
    $('#sl-bg-opts').classList.toggle('hidden', overlay);
    $('#sl-band-f').classList.toggle('hidden', !overlay);
    $('#sl-whole-f').classList.toggle('hidden', !overlay);
    $('#sl-slide-in-f').classList.toggle('hidden', !overlay);
    for (const el of editor.querySelectorAll('[data-k="at"], [data-k="duration"], #sl-at-set')) el.disabled = overlay && s.whole;
    $('#sl-band-opts').classList.toggle('hidden', !(overlay && s.band));
    $('#sl-band-opacity-v').textContent = `${s.bandOpacity}%`;
    editor.querySelector('[data-k="duration"]').max = String(maxDuration(s.mode));
    $('#sl-picture-f').classList.toggle('hidden', s.layout !== 'split');
    $('#sl-logo-opts').classList.toggle('hidden', !s.logo);
    $('#sl-logo-size-v').textContent = `${s.logoSize}%`;
    // Dragged on the slide: the logo's place is its own, not one of the corners.
    if (document.activeElement !== editor.querySelector('[data-k="logoPos"]')) editor.querySelector('[data-k="logoPos"]').value = s.logoAt ? 'custom' : s.logoPos;
    $('#sl-text-size-v').textContent = `${s.textSize}%`;
    // A font file of the user's own is listed by its name, once there is one.
    const custom = $('#sl-font-custom');
    custom.textContent = s.fontName || 'Custom';
    custom.hidden = !s.fontFile;
    const fontSelect = editor.querySelector('[data-k="font"]');
    if (document.activeElement !== fontSelect) fontSelect.value = s.font === 'custom' && !s.fontFile ? 'sans' : s.font;
    $('#sl-text-reset').classList.toggle('hidden', !s.textAt && s.textSize === 100);
    $('#sl-dim-v').textContent = `${s.bgDim}%`;
    for (const f of editor.querySelectorAll('.img-field')) {
      const blob = s[f.dataset.img];
      const thumb = f.querySelector('.img-thumb');
      if (thumb.dataset.src) URL.revokeObjectURL(thumb.dataset.src);
      thumb.dataset.src = blob ? URL.createObjectURL(blob) : '';
      thumb.style.backgroundImage = blob ? `url("${thumb.dataset.src}")` : '';
      thumb.classList.toggle('empty', !blob);
      f.querySelector('[data-clear]').classList.toggle('hidden', !blob);
    }
  }

  /** The kept part, as an overlay over all of it has it. */
  function wholeSpan() {
    const { start, end } = opts.trim();
    return { at: Math.round(start * 10) / 10, duration: Math.max(0.5, Math.round((end - start) * 10) / 10) };
  }

  /** Overlays over the whole recording follow the trim. Returns whether any moved. */
  function followTrim() {
    const span = wholeSpan();
    let moved = false;
    for (const s of slides) {
      if (!s.whole || (s.at === span.at && s.duration === span.duration)) continue;
      Object.assign(s, span);
      moved = true;
    }
    return moved;
  }

  /** Changes the chosen slide. */
  function update(patch, { thumbs = true } = {}) {
    const s = sel();
    if (!s) return;
    // Over the whole recording: its time is the trim's. Moving it by hand ends that.
    if (patch.whole) Object.assign(patch, wholeSpan());
    else if (('at' in patch || 'duration' in patch) && !('whole' in patch)) patch.whole = false;
    Object.assign(s, patch);
    if (Object.keys(patch).some((k) => k !== 'at' && k !== 'duration' && k !== 'whole')) forget(s);
    fillForm();
    if (thumbs) updateThumb(s);
    syncItems();
    syncMarks();
    if (shown?.s === s && !shown.present) {
      if ('at' in patch) preview(s);
      else drawView();
    }
    if (STYLE_KEYS.some((k) => k in patch)) rememberStyle(s);
    changed();
  }

  function changed() {
    opts.changed();
    clearTimeout(changed.timer);
    changed.timer = setTimeout(() => opts.save(slides.map((s) => ({ ...s }))), 400);
  }

  // An overlay can last the whole recording; an inserted slide up to a minute.
  const maxDuration = (mode) => (mode === 'overlay' ? Math.max(60, Math.ceil(opts.duration())) : 60);
  const clampNum = (k, v, mode = sel()?.mode) => {
    if (k === 'at') return Math.max(0, Math.min(opts.duration(), v));
    if (k === 'duration') return Math.max(0.5, Math.min(maxDuration(mode), v));
    return v;
  };

  editor.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'number' || e.target.type === 'range') {
      if (e.target.value === '' || !Number.isFinite(Number(v))) return;
      v = clampNum(k, Number(v));
    }
    if (k === 'logoPos') { if (v !== 'custom') update({ logoPos: v, logoAt: null }); return; }
    if (k === 'font' && (v.startsWith('__') || v.startsWith('local:'))) { chooseFont(e.target, v); return; }
    update({ [k]: v }, { thumbs: k !== 'at' && k !== 'duration' && k !== 'whole' });
    if (k === 'at' || k === 'whole') renderList();
  });
  // Typed numbers out of range are put right once the field is left.
  editor.addEventListener('change', (e) => { if (e.target.dataset.k === 'at' || e.target.dataset.k === 'duration') fillForm(); });
  // Slides keep their own changes: not a change of export preset, nor of the export settings.
  for (const ev of ['input', 'change']) $('#slides-section').addEventListener(ev, (e) => e.stopPropagation());

  $('#sl-themes').addEventListener('click', (e) => {
    const name = e.target.closest('[data-theme]')?.dataset.theme;
    if (!name) return;
    const s = sel();
    // A background picture stays the background when the theme changes.
    const keepImage = s?.bgKind === 'image' && s.bgImage;
    update({ theme: name, ...THEMES[name], bandColor: THEMES[name].bg1, ...(keepImage ? { bgKind: 'image' } : {}) });
  });
  for (const [group, key] of [['#sl-layout', 'layout'], ['#sl-bg', 'bgKind']]) {
    $(group).addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (v) update({ [key]: v });
    });
  }
  $('#sl-mode').addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v && v !== sel().mode) update({ mode: v, duration: clampNum('duration', sel().duration, v) });
  });
  // ---------- fonts of the user's own ----------

  let localFonts = null; // family -> [FontData], once the browser has listed them

  /** The font list's other choices: upload a file, list the computer's fonts, or one of those. */
  async function chooseFont(select, v) {
    const s = sel();
    select.value = s.font === 'custom' && !s.fontFile ? 'sans' : s.font; // until a font is in hand
    if (v === '__upload') { $('#sl-font-file').value = ''; $('#sl-font-file').click(); return; }
    if (v === '__local') { await listLocalFonts(); return; }
    // A font on this computer: its regular style, copied, so the export has it too.
    const family = v.slice('local:'.length);
    const faces = localFonts?.get(family) || [];
    const face = faces.find((f) => /^(regular|book|normal|roman)$/i.test(f.style)) || faces[0];
    if (!face) return;
    try { await setFont(await face.blob(), family); } catch { toast(t('slides_font_failed'), { kind: 'error' }); }
  }

  async function listLocalFonts() {
    if (!window.queryLocalFonts) { toast(t('fonts_unavailable'), { kind: 'error' }); return; }
    try {
      localFonts = new Map();
      for (const f of await window.queryLocalFonts()) {
        if (!localFonts.has(f.family)) localFonts.set(f.family, []);
        localFonts.get(f.family).push(f);
      }
    } catch {
      toast(t('fonts_denied'), { kind: 'error' });
      return;
    }
    const group = $('#sl-font-local');
    group.textContent = '';
    for (const family of [...localFonts.keys()].sort((a, b) => a.localeCompare(b))) group.append(new Option(family, `local:${family}`));
    group.hidden = !localFonts.size;
    $('#sl-font-local-ask').hidden = !!localFonts.size;
    toast(t('fonts_added', localFonts.size), { kind: 'success' });
  }

  async function setFont(blob, name) {
    if (!(await loadFontFile(blob))) { toast(t('slides_font_failed'), { kind: 'error' }); return; }
    update({ font: 'custom', fontFile: blob, fontName: name });
  }

  $('#sl-font-file').addEventListener('change', () => {
    const f = $('#sl-font-file').files[0];
    if (f) setFont(f, f.name.replace(/\.[^.]+$/, ''));
  });

  $('#sl-text-reset').addEventListener('click', () => update({ textAt: null, textSize: 100 }));
  $('#sl-at-set').addEventListener('click', () => update({ at: Math.round(player.currentTime * 10) / 10 }));

  // Pictures: chosen with a file picker or dropped on their field.
  const file = $('#sl-file');
  editor.addEventListener('click', (e) => {
    const f = e.target.closest('.img-field');
    if (!f) return;
    if (e.target.closest('[data-pick]')) { file.dataset.target = f.dataset.img; file.value = ''; file.click(); }
    else if (e.target.closest('[data-clear]')) setImage(f.dataset.img, null);
  });
  file.addEventListener('change', () => { if (file.files[0]) setImage(file.dataset.target, file.files[0]); });
  for (const f of editor.querySelectorAll('.img-field')) {
    f.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); f.classList.add('drop'); } });
    f.addEventListener('dragleave', () => f.classList.remove('drop'));
    f.addEventListener('drop', (e) => {
      e.preventDefault();
      f.classList.remove('drop');
      const img = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
      if (img) setImage(f.dataset.img, img);
    });
  }

  async function setImage(k, f) {
    if (!f) { update({ [k]: null }); return; }
    const blob = await usableImage(f);
    if (!blob) { toast(t('slides_image_failed'), { kind: 'error' }); return; }
    const patch = { [k]: blob };
    if (k === 'bgImage') patch.bgKind = 'image';
    if (k === 'picture') patch.layout = 'split';
    update(patch);
  }

  // ---------- adding and removing ----------

  function add(at = player.currentTime) {
    if (opts.busy()) return;
    const from = sel() || byTime().at(-1);
    const style = from ? Object.fromEntries(STYLE_KEYS.map((k) => [k, from[k]])) : remembered;
    const s = newSlide(Math.round(Math.max(0, Math.min(opts.duration(), at)) * 10) / 10, style || {});
    slides.push(s);
    $('#slides-section').open = true;
    renderList();
    select(s.id);
    changed();
    $('#sl-title').focus();
  }

  function remove(id = selected) {
    const i = slides.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [gone] = slides.splice(i, 1);
    liveArt.delete(gone.id);
    if (shown?.s === gone) hide();
    if (selected === id) { selected = null; editor.classList.add('hidden'); }
    renderList();
    changed();
    toast(t('slides_deleted'), { ms: 6000, action: { label: t('editor_undo'), run: () => { slides.splice(i, 0, gone); renderList(); select(gone.id); changed(); } } });
  }

  $('#slide-add').addEventListener('click', () => add());
  $('#sl-del').addEventListener('click', () => remove());
  $('#sl-dup').addEventListener('click', () => {
    const s = sel();
    if (!s) return;
    const copy = { ...s, id: newSlide(0).id };
    slides.push(copy);
    renderList();
    select(copy.id);
    changed();
  });

  // ---------- the style carried to new slides, between recordings ----------

  let remembered = null;
  (async () => {
    try {
      const saved = (await chrome.storage.local.get(STYLE_STORE))[STYLE_STORE];
      if (!saved) return;
      const blob = async (url) => (url ? (await fetch(url)).blob() : null);
      remembered = { ...saved, logo: await blob(saved.logo), fontFile: await blob(saved.fontFile), bgImage: null };
      if (remembered.font === 'custom' && !remembered.fontFile) remembered.font = 'sans';
      if (remembered.bgKind === 'image') remembered.bgKind = THEMES[remembered.theme]?.bgKind || 'solid';
    } catch { /* outside the extension, or nothing usable */ }
    syncForget();
  })();

  function syncForget() { $('#slide-forget').classList.toggle('hidden', !remembered); }

  // Forgetting the saved style (and logo): new slides in later recordings start plain.
  $('#slide-forget').addEventListener('click', async () => {
    clearTimeout(rememberStyle.timer);
    let saved = null;
    try {
      saved = (await chrome.storage.local.get(STYLE_STORE))[STYLE_STORE] || null;
      await chrome.storage.local.remove(STYLE_STORE);
    } catch { /* outside the extension */ }
    const was = remembered;
    remembered = null;
    syncForget();
    toast(t('slides_forgotten'), {
      ms: 6000,
      action: {
        label: t('editor_undo'),
        run: async () => {
          remembered = was;
          syncForget();
          try { if (saved) await chrome.storage.local.set({ [STYLE_STORE]: saved }); } catch { /* outside the extension */ }
        },
      },
    });
  });

  async function rememberStyle(s) {
    clearTimeout(rememberStyle.timer);
    rememberStyle.timer = setTimeout(async () => {
      try {
        const style = Object.fromEntries(STYLE_KEYS.filter((k) => k !== 'bgImage' && k !== 'logo' && k !== 'fontFile').map((k) => [k, s[k]]));
        // So does a font file of the user's own, on the same terms.
        style.fontFile = s.fontFile && s.fontFile.size < 1.5e6 ? await dataUrl(s.fontFile) : null;
        // The logo goes along when it is small enough to keep in settings.
        style.logo = s.logo && s.logo.size < 1.5e6 ? await dataUrl(s.logo) : null;
        remembered = { ...style, logo: s.logo, fontFile: s.fontFile, bgImage: null };
        syncForget();
        await chrome.storage.local.set({ [STYLE_STORE]: style });
      } catch { /* outside the extension */ }
    }, 600);
  }

  // ---------- start ----------

  // Closed until there are slides, so trimming and exporting stay close at hand.
  $('#slides-section').open = slides.length > 0;
  renderList();
  return {
    all: () => slides,
    add,
    skip,
    hide,
    showing: () => !!shown,
    /** After the trim, the output size or the timeline's length changes. */
    refresh() {
      forget();
      if (followTrim()) {
        fillForm();
        if (shown && !shown.present && shown.s.whole) preview(shown.s);
        clearTimeout(changed.timer);
        changed.timer = setTimeout(() => opts.save(slides.map((s) => ({ ...s }))), 400);
      }
      syncItems();
      syncMarks();
      if (shown && !shown.present) drawView();
    },
    /** After the output's shape changes (a device frame, say): thumbnails too. */
    redraw() {
      forget();
      for (const s of slides) updateThumb(s);
      if (shown) drawView();
    },
  };
}

function formatSeconds(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * The picture as a Blob every context can decode: SVG (which workers can't draw)
 * becomes PNG. Null if it can't be read.
 */
async function usableImage(file) {
  if (file.type !== 'image/svg+xml') {
    try { (await createImageBitmap(file)).close(); return file; } catch { /* try it as an <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // SVGs without a size of their own are drawn at 1024 across.
    let w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    const k = Math.min(4, 2048 / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return await c.convertToBlob({ type: 'image/png' });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
