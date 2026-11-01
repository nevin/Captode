// The video page: the recording, its timeline and trim, the panels around it, and
// starting up. Its parts live beside it: state.js (what they share), preview.js,
// export.js and joining.js (video layers and joined clips).

import { getCapture, putCapture, saveSlides, saveVideoEdits, saveTrim, deleteCapture, putExtras } from '../lib/db.js';
import { getSettings } from '../lib/settings.js';
import { fileStem } from '../lib/filename.js';
import { recall, remember, rememberControls } from '../lib/remember.js';
import { mountPresets } from '../lib/presets.js';
import { mountDevicePanel, frameDrawer } from '../lib/device.js';
import { toast, announce, enhance, fmtBytes, confirmDialog } from '../lib/ui.js';
import { mountShortcuts } from './shortcuts.js';
import { demuxWebm, muxWebm } from '../lib/webm.js';
import { sourceColourSpace, outputColour } from '../lib/video-colour.js';
import { contrastHtml, hexOf, measureLabel, measureText, edgeNear, measureFrom, drawMeasures } from '../lib/review.js';
import { t, localize } from '../lib/i18n.js';
import { slideSchedule, slideSeconds } from '../lib/slides.js';
import { mountSlides } from './slides-panel.js';
import { mountEdits } from './edits-panel.js';
import { mountClips } from './clips-panel.js';
import { mountSpeech } from '../lib/speech.js';
import { mountMusic } from './music.js';
import { mountChapters } from './chapters-panel.js';
import { mountTimelineZoom } from './timeline-zoom.js';
import { mountThumbnail } from './thumbnail.js';
import { mountCaptionReview } from './captions-review.js';
import { clipStarts } from '../lib/join.js';
import { normaliseEdits, clipFrames, composer, hasSpatial, shownLayersAt, layerBox } from '../lib/video-edits.js';
import { audioLevels } from '../lib/audio-levels.js';
import { mountCaptureTools } from '../lib/keep.js';
import { mountJobs } from '../lib/export-queue.js';
import { canQueueExports } from '../lib/platform.js';
import { getBrand, loadLogo } from '../lib/brand.js';
import { startTour, tourSeen } from './tour.js';
import { mountVoiceover } from './voiceover.js';
import { mountFillers } from './fillers.js';
import { S, $, player, captureId, ed, hasSound, useLogo, clip, RES, FPS, even, readableRes, fmtTime, loadDuration, trim, contentSize, outRenderer, plan } from './state.js';
import { previewSound, playRules, drawFx, drawWave, buildFilmstrip } from './preview.js';
import { convert, cutShort, roomFor, warnLowSpace, runWithProgress, exportStem, outputCues, downloadSubtitles, save } from './export.js';
import { layerVideos, addLayer, undoJoin, addImage, rebuild } from './joining.js';

localize();

function fillResolutions(reset = false) {
  S.device?.refresh();
  const [w, h] = contentSize();
  const r = outRenderer() || { width: w, height: h };
  const short = Math.min(r.width, r.height);
  const keep = reset ? '' : $('#res').value;
  // GIF and WebP start smaller than the recording to keep files light, but no smaller
  // than the size the text had on screen, so it stays readable.
  const readable = readableRes(short);
  S.readableAt = readable || even(short);
  const def = S.format === 'gif' || S.format === 'webp' ? readable : 0;
  const sizes = [...new Set([...RES.filter((p) => p < short), readable].filter(Boolean))].sort((a, b) => b - a);
  $('#res').innerHTML = `<option value="0" title="${even(r.width)} × ${even(r.height)}">${t('res_original', `${even(short)}p`)}</option>` +
    sizes.map((p) => `<option value="${p}">${p === readable ? t('res_readable', `${p}p`) : `${p}p`}</option>`).join('');
  const values = [...$('#res').options].map((o) => o.value);
  $('#res').value = values.includes(keep) && keep !== '' ? keep : values.includes(String(def)) ? String(def) : '0';
}

function fillFps(reset = false) {
  const max = Math.min(S.meta.fps || 30, S.format === 'gif' ? 50 : 60);
  const keep = reset ? 0 : Number($('#fps').value) || 0;
  const def = S.format === 'gif' ? Math.min(15, max) : S.format === 'webp' ? Math.min(20, max) : max;
  const list = FPS.filter((f) => f <= max);
  $('#fps').innerHTML = list.map((f) => `<option value="${f}">${f} fps</option>`).join('');
  $('#fps').value = String(list.includes(keep) && keep <= max ? keep : def);
}

export function syncUi() {
  for (const b of document.querySelectorAll('#formats button')) b.classList.toggle('on', b.dataset.f === S.format);
  $('#convert .dl-label').textContent = t('export_format', S.format.toUpperCase());
  for (const el of document.querySelectorAll('[data-for]')) el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(S.format));
  $('#w-quality-f').classList.toggle('hidden', $('#w-lossless').checked);
  $('#denoise-row').classList.toggle('hidden', !$('#optimize').checked);
  $('#w-quality-v').textContent = $('#w-quality').value + '%';
  $('#ed-picked').classList.toggle('hidden', !picked);
  if (picked) $('#ed-picked').textContent = t('video_picked_part', [fmtTime(picked.from), fmtTime(picked.to)]);
  const res = Number($('#res').value);
  $('#res-note').classList.toggle('hidden', !res || res >= S.readableAt);
  $('#v-quality-note').classList.toggle('hidden', Number($('#v-quality').value) >= 0.08);
  $('#g-lossy-v').textContent = Number($('#g-lossy').value) ? $('#g-lossy').value : t('video_off');
  const sound = hasSound();
  if (sound && $('#v-audio').disabled) $('#v-audio').checked = true; // a layer with sound was just added
  $('#v-audio').disabled = !sound;
  $('#v-audio-note').classList.toggle('hidden', sound);
  if (!sound) $('#v-audio').checked = false;
  drawTimeline();
  keepTrim();
  if (!player.videoWidth) return;
  const p = plan();
  const { start, end } = trim();
  // Parts cut or sped up shorten it; slides add their own time to the clip's.
  const map = clip();
  const schedule = slideSchedule(S.slides?.all(), start, end, p.fps, map);
  const frames = clipFrames(map, p.fps) + schedule.reduce((n, e) => n + e.frames, 0);
  const length = map.length + slideSeconds(schedule, p.fps);
  $('#dims').innerHTML = `<span>${t('video_dims', [`${p.width} × ${p.height}`, p.fps, frames])}</span><b>${length.toFixed(1)} s</b>`;
  // MP4 and WebM are encoded at a variable bitrate below this ceiling, so it is an
  // upper limit; screen recordings, mostly still, usually come out well under it.
  // GIF and WebP depend too much on the picture to guess.
  if (S.format === 'mp4' || S.format === 'webm') {
    const bitrate = Math.min(40e6, Math.max(300e3, p.width * p.height * p.fps * Number($('#v-quality').value)));
    const audio = $('#v-audio').checked && hasSound() ? 128e3 : 0;
    S.sizeEstimate = Math.round(((bitrate + audio) * length) / 8);
    $('#convert-size').textContent = t('video_size_up_to', fmtBytes(S.sizeEstimate));
  } else {
    S.sizeEstimate = 0;
    $('#convert-size').textContent = '';
  }
  stale();
}

// The part kept is saved with the recording, so it is still chosen when it is opened again.
let savedTrim = '';
let trimTimer = 0;
function trimKey() {
  const { start, end } = trim();
  return start <= 0.05 && end >= S.duration - 0.05 ? 'null' : JSON.stringify({ start: Number(start.toFixed(1)), end: Number(end.toFixed(1)) });
}
function keepTrim() {
  if (!S.duration || !captureId || !S.editor || S.leaving) return;
  const key = trimKey();
  if (key === savedTrim) return;
  savedTrim = key;
  clearTimeout(trimTimer);
  trimTimer = setTimeout(flushTrim, 300);
}
function flushTrim() {
  if (!trimTimer || S.leaving) return;
  clearTimeout(trimTimer);
  trimTimer = 0;
  saveTrim(captureId, JSON.parse(savedTrim)).catch(() => {});
}
addEventListener('pagehide', flushTrim);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushTrim(); });

/** Lets go of the last export's file, which can be as big as the recording. */
export function dropResult() {
  S.result = null;
  if (!S.resultUrl) return;
  $('#out-img').removeAttribute('src');
  $('#out-video').removeAttribute('src');
  $('#out-video').load();
  URL.revokeObjectURL(S.resultUrl);
  S.resultUrl = '';
}

export function stale() {
  if (S.busy) return;
  dropResult();
  $('#result').classList.add('hidden');
  $('#download').classList.add('hidden');
  $('#share-result').classList.add('hidden');
  $('#redo-export').classList.add('hidden');
  $('#convert').classList.remove('hidden');
  showPreview('player');
}

const PREVIEW_LABELS = { live: t('preview_converting'), 'out-img': t('preview_exported'), 'out-video': t('preview_exported') };

export function showPreview(which) {
  if (which !== 'player') S.slides?.hide();
  for (const id of ['player', 'live', 'out-img', 'out-video']) $('#' + id).classList.toggle('hidden', id !== which);
  $('#preview-label').textContent = PREVIEW_LABELS[which] || '';
  $('#preview-label').classList.toggle('hidden', !PREVIEW_LABELS[which]);
  $('#timeline').classList.toggle('hidden', which !== 'player');
}

/** Switches format, with that format's resolution and frame rate as last used. */
export async function setFormat(f) {
  S.format = f;
  remember('video', { format: f });
  fillResolutions(true);
  fillFps(true);
  syncUi();
  const per = (await recall('video')).controls?.[f] || {};
  for (const id of ['res', 'fps']) if ([...$('#' + id).options].some((o) => o.value === per[id])) $('#' + id).value = per[id];
  syncUi();
}
$('#formats').addEventListener('click', (e) => {
  const f = e.target.closest('button')?.dataset.f;
  if (!f || S.busy) return;
  setFormat(f);
  document.querySelector('.inspector').dispatchEvent(new Event('change')); // no longer a preset
});
document.querySelector('.inspector').addEventListener('input', (e) => {
  if (e.target.closest('#device-panel')) return; // handled by the panel's own callback
  syncUi();
});
// A part chosen by dragging across the timeline. It becomes the part to keep, unless an
// edit (Cut, Zoom, …) is added next: the edit then covers that part, and the trim goes
// back to what it was before the drag.
let picked = null;
function takePicked() {
  const p = picked;
  picked = null;
  if (!p) return null;
  [$('#t-start').value, $('#t-end').value] = p.before;
  syncUi();
  return { from: p.from, to: p.to };
}
/** Forgets the part dragged across: playing, exporting or Esc means it is the part to keep. */
export function forgetPicked() {
  if (!picked) return;
  picked = null;
  $('#ed-picked').classList.add('hidden');
}
for (const id of ['#t-start', '#t-end']) $(id).addEventListener('input', () => { picked = null; }, true);
// A start typed after the end (or an end before the start) is moved, and you're told.
function fixTrim(which) {
  const at = (v, d) => Math.max(0, Math.min(S.duration, Number.isFinite(v) ? v : d));
  let s = at(parseFloat($('#t-start').value), 0), e = at(parseFloat($('#t-end').value), S.duration);
  const wrong = e - s < 0.1;
  if (wrong) {
    if (which === 'start') s = Math.max(0, e - 0.1); else e = Math.min(S.duration, s + 0.1);
    if (e - s < 0.1) s = Math.max(0, e - 0.1);
  }
  $('#t-start').value = s.toFixed(1);
  $('#t-end').value = e.toFixed(1);
  if (wrong) toast(t('trim_fixed'));
  syncUi();
}
$('#t-start').addEventListener('change', () => fixTrim('start'));
$('#t-end').addEventListener('change', () => fixTrim('end'));
const setStart = (t) => { picked = null; if (S.busy) return; $('#t-start').value = Math.max(0, Math.min(t, trim().end - 0.1)).toFixed(1); syncUi(); };
const setEnd = (t) => { picked = null; if (S.busy) return; $('#t-end').value = Math.min(S.duration, Math.max(t, trim().start + 0.1)).toFixed(1); syncUi(); };
$('#t-start-set').addEventListener('click', () => setStart(player.currentTime));
$('#t-end-set').addEventListener('click', () => setEnd(player.currentTime));

// ---------- timeline ----------

const pct = (t) => (S.duration ? (t / S.duration) * 100 : 0) + '%';

function drawTimeline() {
  const { start, end } = trim();
  $('#h-start').style.left = pct(start);
  $('#h-end').style.left = pct(end);
  $('#range').style.left = pct(start);
  $('#range').style.width = `calc(${pct(end)} - ${pct(start)})`;
  $('#shade-l').style.width = pct(start);
  $('#shade-r').style.width = `calc(100% - ${pct(end)})`;
  // Inserted slides make the export longer than the part kept: the length with them, and what it's made of.
  const added = (S.slides?.all() || []).filter((s) => s.mode !== 'overlay' && s.at >= start - 1e-3 && s.at <= end + 1e-3).reduce((n, s) => n + s.duration, 0);
  const kept = clip().length; // without the parts cut, and sped-up parts shorter
  const none = S.duration > 0 && !clip().parts.length;
  $('#tc-len').textContent = none ? t('trim_all_cut') : added ? t('trim_with_slides', (kept + added).toFixed(1)) : t('trim_selected', kept.toFixed(1));
  $('#tc-len').classList.toggle('warn', none);
  $('#tc-len').title = added ? t('trim_with_slides_title', [kept.toFixed(1), added.toFixed(1)]) : '';
  // The length on the kept part itself, and each end's time on its handle.
  $('#range-len').style.left = `calc((${pct(start)} + ${pct(end)}) / 2)`;
  $('#range-len').textContent = `${(end - start).toFixed(1)} s`;
  $('#range-len').classList.toggle('hidden', end - start >= S.duration - 0.05);
  $('#h-start').dataset.time = fmtTime(start);
  $('#h-end').dataset.time = fmtTime(end);
  for (const [h, v] of [['#h-start', start], ['#h-end', end]]) {
    $(h).setAttribute('aria-valuemin', '0');
    $(h).setAttribute('aria-valuemax', S.duration.toFixed(1));
    $(h).setAttribute('aria-valuenow', v.toFixed(1));
    $(h).setAttribute('aria-valuetext', fmtTime(v));
  }
  S.slides?.refresh();
  S.editor?.refresh();
  drawPlayhead();
}

function drawPlayhead() {
  $('#playhead').style.left = pct(player.currentTime);
  $('#tc-now').textContent = fmtTime(player.currentTime);
}

function timeAt(e) {
  const r = $('#track').getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.duration;
}

// On the timeline: a click goes to that moment; a drag across it chooses the part to
// keep; the handles move one end; the playhead's knob scrubs.
$('#track').addEventListener('pointerdown', (e) => {
  if (!S.duration || S.busy) return;
  const handle = e.target.closest('.handle');
  const scrub = e.target.closest('#playhead');
  $('#track').setPointerCapture(e.pointerId);
  const from = timeAt(e), x0 = e.clientX;
  let selecting = false, sel = null;
  // Several drags in a row: the trim to go back to is the one before the first.
  const before = picked?.before || [$('#t-start').value, $('#t-end').value];
  picked = null;
  $('#ed-picked').classList.add('hidden');
  $('#track').classList.add('dragging');
  const move = (ev) => {
    const at = timeAt(ev);
    if (handle?.id === 'h-start') { setStart(at); player.currentTime = trim().start; }
    else if (handle?.id === 'h-end') { setEnd(at); player.currentTime = trim().end; }
    else if (scrub) player.currentTime = at;
    else if (selecting || Math.abs(ev.clientX - x0) > 4) {
      selecting = true;
      const [a, b] = [Math.min(from, at), Math.max(from, at)];
      $('#t-start').value = a.toFixed(1);
      $('#t-end').value = Math.max(b, a + 0.1).toFixed(1);
      sel = [a, Math.max(b, a + 0.1)];
      syncUi();
      player.currentTime = at;
    }
    drawPlayhead();
  };
  if (handle || scrub) move(e);
  const up = (ev) => {
    if (ev.type === 'pointerup' && !handle && !scrub && !selecting) { player.currentTime = timeAt(ev); drawPlayhead(); }
    if (selecting && sel) {
      picked = { from: sel[0], to: sel[1], before };
      syncUi();
    }
    $('#track').classList.remove('dragging');
    $('#track').removeEventListener('pointermove', move);
    $('#track').removeEventListener('pointerup', up);
    $('#track').removeEventListener('pointercancel', up);
  };
  $('#track').addEventListener('pointermove', move);
  $('#track').addEventListener('pointerup', up);
  $('#track').addEventListener('pointercancel', up);
});

for (const [id, set, get] of [['#h-start', setStart, () => trim().start], ['#h-end', setEnd, () => trim().end]]) {
  $(id).addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    set(get() + d);
    player.currentTime = get();
  });
}

function togglePlay() {
  if (S.busy || $('#player').classList.contains('hidden')) return;
  if (S.slides?.skip()) return; // a slide on screen during playback: carry on
  if (player.paused) {
    const map = clip();
    if (!map.parts.length) { toast(t('video_all_cut'), { kind: 'error' }); return; }
    forgetPicked();
    // From the start again at the end of the last part kept (a cut can take the rest).
    const { start } = trim();
    if (player.currentTime < start || player.currentTime >= map.parts.at(-1).to - 0.05) player.currentTime = start;
    previewSound();
    playRules();
    player.play();
  } else {
    player.pause();
  }
}
$('#play').addEventListener('click', togglePlay);
player.addEventListener('click', togglePlay);
$('#fx-view').addEventListener('click', () => { if (!layerDragged) togglePlay(); layerDragged = false; });

// A video layer on the picture: dragging it moves it anywhere, its lower-right corner resizes it.
// Near the middle or the edges' margin it snaps there, with a guide line showing.
let layerDragged = false;
let guides = []; // [{ x } | { y }] in the preview's pixels, while a layer is dragged
/**
 * How moving or resizing layer `l` at time `at` is saved: as where it starts, or, for
 * a moving layer in its second half, where it ends. `place({ x, y, size? })` → fields.
 */
function layerPlace(l, at) {
  const end = l.move && at > (l.from + l.to) / 2;
  return ({ x, y, size }) => (end
    ? { x2: x, y2: y, ...(size !== undefined ? { size2: size } : {}) }
    : { pos: 'free', x, y, ...(size !== undefined ? { size } : {}) });
}

/** Moves or resizes the chosen layer with the keyboard, on the preview: arrows (Shift: further), + and −. */
$('#fx-view').addEventListener('keydown', (e) => {
  if (S.busy || !S.editor) return;
  const at = player.currentTime;
  const chosen = S.editor.chosen?.('layers');
  const l = chosen?.kind === 'sound' ? null : chosen || shownLayersAt(ed(), at).at(-1);
  if (!l || at < l.from || at >= l.to) return;
  const c = $('#fx-view');
  const step = e.shiftKey ? 0.05 : 0.01;
  const b = layerBox(l, c.width, c.height, at);
  let x = (b.x + b.w / 2) / c.width, y = (b.y + b.h / 2) / c.height;
  let size = l.move && at > (l.from + l.to) / 2 ? l.size2 : l.size;
  if (e.key === 'ArrowLeft') x -= step;
  else if (e.key === 'ArrowRight') x += step;
  else if (e.key === 'ArrowUp') y -= step;
  else if (e.key === 'ArrowDown') y += step;
  else if (e.key === '+' || e.key === '=') size += 0.05;
  else if (e.key === '-' || e.key === '_') size -= 0.05;
  else return;
  e.preventDefault();
  e.stopPropagation(); // not also a seek or a timeline zoom
  if (!player.paused) player.pause();
  x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
  size = Math.round(Math.min(1, Math.max(0.1, size)) * 100) / 100;
  S.editor.placeLayer(l.id, layerPlace(l, at)({ x, y, size }));
  S.editor.placeLayer(l.id, null, true);
  announce(t('vlayer_moved', [String(Math.round(x * 100)), String(Math.round(y * 100)), String(Math.round(size * 100))]));
});

export function drawGuides(ctx) {
  if (!guides.length) return;
  ctx.save();
  ctx.strokeStyle = '#ff2bd6';
  ctx.lineWidth = Math.max(1, ctx.canvas.width / 640);
  ctx.setLineDash([6, 4]);
  for (const g of guides) {
    ctx.beginPath();
    if (g.x !== undefined) { ctx.moveTo(g.x, 0); ctx.lineTo(g.x, ctx.canvas.height); } else { ctx.moveTo(0, g.y); ctx.lineTo(ctx.canvas.width, g.y); }
    ctx.stroke();
  }
  ctx.restore();
}
$('#fx-view').addEventListener('pointerdown', (e) => {
  if (S.busy || !S.editor || !player.paused) return;
  const c = $('#fx-view');
  const r = c.getBoundingClientRect();
  const W = c.width, H = c.height;
  const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
  const now = player.currentTime;
  const hit = shownLayersAt(ed(), now).reverse().map((l) => ({ l, b: layerBox(l, W, H, now) }))
    .find(({ b }) => px >= b.x - 6 && px <= b.x + b.w + 6 && py >= b.y - 6 && py <= b.y + b.h + 6);
  if (!hit) return;
  e.preventDefault();
  const { l, b } = hit;
  S.editor.choose('layers', l.id);
  const corner = Math.hypot(px - (b.x + b.w), py - (b.y + b.h)) < Math.max(14, Math.min(b.w, b.h) * 0.2);
  const dx = px - (b.x + b.w / 2), dy = py - (b.y + b.h / 2);
  const m = Math.round(Math.min(W, H) * 0.03);
  // A moving layer: dragged in its second half, it is where it ends that changes.
  const place = layerPlace(l, now);
  c.setPointerCapture(e.pointerId);
  const move = (ev) => {
    layerDragged = true;
    const x = ((ev.clientX - r.left) / r.width) * W, y = ((ev.clientY - r.top) / r.height) * H;
    if (corner) {
      // Wider as the corner moves away from the box's top left.
      const size = Math.round(Math.min(1, Math.max(0.1, (x - b.x) / (W - 2 * m))) * 100) / 100;
      S.editor.placeLayer(l.id, place({ size, x: (b.x + ((W - 2 * m) * size) / 2) / W, y: (b.y + (b.h * ((W - 2 * m) * size)) / b.w / 2) / H }));
    } else {
      let cx = x - dx, cy = y - dy;
      const tol = (10 * W) / r.width; // 10 screen pixels
      guides = [];
      const snap = (v, half, size, axis) => {
        for (const [to, line] of [[size / 2, size / 2], [m + half, m], [size - m - half, size - m]]) {
          if (Math.abs(v - to) < tol) { guides.push({ [axis]: line }); return to; }
        }
        return v;
      };
      cx = snap(cx, b.w / 2, W, 'x');
      cy = snap(cy, b.h / 2, H, 'y');
      S.editor.placeLayer(l.id, place({ x: Math.min(1, Math.max(0, cx / W)), y: Math.min(1, Math.max(0, cy / H)) }));
      if (S.fx) S.fx.at = -1; // the guides change even when the layer doesn't
    }
  };
  const up = () => {
    guides = [];
    if (S.fx) S.fx.at = -1;
    c.removeEventListener('pointermove', move);
    c.removeEventListener('pointerup', up);
    c.removeEventListener('pointercancel', up);
    S.editor.placeLayer(l.id, null, true);
  };
  c.addEventListener('pointermove', move);
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
});
// The pointer shows where a layer can be moved or resized.
$('#fx-view').addEventListener('pointermove', (e) => {
  const c = e.currentTarget;
  if (e.buttons || !player.paused) return;
  const r = c.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * c.width, py = ((e.clientY - r.top) / r.height) * c.height;
  let cursor = '';
  for (const l of shownLayersAt(ed(), player.currentTime)) {
    const b = layerBox(l, c.width, c.height, player.currentTime);
    if (px < b.x || px > b.x + b.w || py < b.y || py > b.y + b.h) continue;
    cursor = Math.hypot(px - (b.x + b.w), py - (b.y + b.h)) < Math.max(14, Math.min(b.w, b.h) * 0.2) ? 'nwse-resize' : 'move';
  }
  c.style.cursor = cursor;
});
// Play only the trimmed part.
player.addEventListener('timeupdate', () => {
  if (!player.paused && player.currentTime >= trim().end) { player.pause(); player.currentTime = trim().end; }
  drawPlayhead();
});
for (const ev of ['play', 'pause']) {
  player.addEventListener(ev, () => {
    $('#play .play').classList.toggle('hidden', !player.paused);
    $('#play .pause').classList.toggle('hidden', player.paused);
  });
}
player.addEventListener('seeked', drawPlayhead);
(function tick() {
  if (!player.paused) { drawPlayhead(); playRules(); zoom.follow(); }
  if (S.editor) music.preview();
  if (S.editor) { drawFx(); S.editor.redraw(); } // once the page is set up
  requestAnimationFrame(tick);
})();

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === ' ' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
  else if (k === 'i') setStart(player.currentTime);
  else if (k === 'o') setEnd(player.currentTime);
  else if (k === 'f') frameToEditor();
  else if (k === 'escape') forgetPicked();
  else if (k === '=' || k === '+') zoom.zoomIn();
  else if (k === '-' || k === '_') zoom.zoomOut();
  else if (k === 's' && S.slides && !S.busy) { e.preventDefault(); S.slides.add(); }
  else if (k === 'arrowleft' && !e.target.closest('.handle')) { player.currentTime = Math.max(0, player.currentTime - (e.shiftKey ? 1 : 1 / (S.meta.fps || 30))); }
  else if (k === 'arrowright' && !e.target.closest('.handle')) { player.currentTime = Math.min(S.duration, player.currentTime + (e.shiftKey ? 1 : 1 / (S.meta.fps || 30))); }
});

/**
 * Deletes the recording, with its slides, from Captode's storage, after asking. An
 * export under way stops, and the page is replaced by the editor's start page, so
 * nothing of the recording stays in memory either.
 */
async function discard() {
  const id = new URLSearchParams(location.search).get('id');
  if (!S.source || !id) return;
  if (!(await confirmDialog({ title: t('discard_recording_title'), text: t('discard_text'), confirm: t('discard_confirm') }))) return;
  S.cancelled = true;
  S.abortWorker?.();
  S.busy = false; // leaving doesn't ask
  player.pause();
  await deleteCapture(id);
  location.replace('../editor/editor.html?discarded=recording');
}
$('#discard').addEventListener('click', discard);
/**
 * The recording as it was captured, with its colours written into the file (Chrome
 * leaves them out, so players other than Chrome's may guess them wrong). The video
 * and sound are copied as they are; if anything about the file is unexpected, the
 * original is saved untouched.
 */
async function taggedOriginal() {
  try {
    const src = demuxWebm(await S.source.arrayBuffer(), { views: true });
    const v = src.video;
    const colour = v && sourceColourSpace(v);
    if (!colour || !['V_VP9', 'V_VP8'].includes(v.codecId)) return S.source;
    const audio = src.audio?.codecId === 'A_OPUS'
      ? { ...src.audio, frames: src.audio.frames.map((f) => ({ ...f, key: true })) }
      : null;
    if (src.audio && !audio) return S.source; // a sound format the writer doesn't know
    return muxWebm({
      video: { codecId: v.codecId, width: v.width || player.videoWidth, height: v.height || player.videoHeight, frames: v.frames, colour: outputColour(colour) },
      audio,
    });
  } catch {
    return S.source;
  }
}
$('#dl-original').addEventListener('click', async () => {
  if (S.source) save(await taggedOriginal(), `captode-recording-${Date.now()}.webm`);
});

// ---------- review a frame ----------

// Measuring and colour picking on the paused frame, drawn on a layer over the player.
export const rv = { tool: 'off', frame: null, measures: [], drag: null, colours: [null, null], slot: 0 };
const rvRatio = () => ($('#rv-ratio').value === 'auto' ? S.meta.dpr || 1 : Number($('#rv-ratio').value));

/** The frame showing, at the video's own size, to read pixels from. */
function grabFrame() {
  const c = new OffscreenCanvas(player.videoWidth, player.videoHeight);
  c.getContext('2d', { willReadFrequently: true }).drawImage(player, 0, 0);
  rv.frame = c;
}

/** Lays the measuring layer exactly over the picture in the player. */
function placeOverlay() {
  const o = $('#rv-overlay');
  const pr = player.getBoundingClientRect(), box = player.parentElement.getBoundingClientRect();
  // The picture inside the player box (object-fit: contain).
  const s = Math.min(pr.width / player.videoWidth, pr.height / player.videoHeight);
  const w = player.videoWidth * s, h = player.videoHeight * s;
  Object.assign(o.style, { left: `${pr.left - box.left + (pr.width - w) / 2}px`, top: `${pr.top - box.top + (pr.height - h) / 2}px`, width: `${w}px`, height: `${h}px` });
  o.width = Math.round(w * devicePixelRatio);
  o.height = Math.round(h * devicePixelRatio);
  drawOverlay();
}

function drawOverlay() {
  const o = $('#rv-overlay');
  if (o.classList.contains('hidden')) return;
  const ctx = o.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  const k = o.width / player.videoWidth; // canvas pixels per video pixel
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const list = rv.drag ? [...rv.measures, rv.drag.m] : rv.measures;
  drawMeasures(ctx, list, devicePixelRatio / k, (m) => measureLabel(m, rvRatio()));
}

function setReviewTool(t) {
  rv.tool = t;
  for (const b of document.querySelectorAll('#rv-tools button')) {
    b.classList.toggle('on', b.dataset.rt === t);
    b.setAttribute('aria-checked', String(b.dataset.rt === t));
  }
  const on = t !== 'off' && player.videoWidth > 0;
  $('#rv-overlay').classList.toggle('hidden', !on);
  if (!on) return;
  if (!player.paused) player.pause();
  grabFrame();
  placeOverlay();
}

const toVideo = (e) => {
  const r = $('#rv-overlay').getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * player.videoWidth, y: ((e.clientY - r.top) / r.height) * player.videoHeight };
};
const frameEdge = (x, y, axis) => edgeNear((x0, y0, w, h) => rv.frame.getContext('2d').getImageData(x0, y0, w, h).data,
  rv.frame.width, rv.frame.height, x, y, axis, Math.max(2, Math.round((8 * player.videoWidth) / $('#rv-overlay').getBoundingClientRect().width)));

function showReview() {
  const last = rv.measures.at(-1);
  $('#rv-m').innerHTML = last ? `<b>${measureText(last, rvRatio())}</b>` : t('editor_no_measurements_yet');
  $('#rv-clear').disabled = !rv.measures.length;
  for (const b of document.querySelectorAll('#review-section .pick-slot')) {
    const i = Number(b.dataset.slot), c = rv.colours[i];
    b.classList.toggle('on', i === rv.slot);
    b.setAttribute('aria-checked', String(i === rv.slot));
    b.querySelector('.pick-swatch').style.background = c || '';
    b.querySelector('.pick-hex').textContent = c ? c.toUpperCase() : t('editor_not_picked');
  }
  const [a, b] = rv.colours;
  if (a && b) $('#rv-c').innerHTML = contrastHtml(a, b);
  else $('#rv-c').textContent = t('editor_pick_two_colours_to_check');
  const auto = S.meta.dpr ? `${Math.round(S.meta.dpr * 100) / 100}×` : '1×';
  $('#rv-ratio').options[0].textContent = t('automatic_value', auto);
}

$('#rv-tools').addEventListener('click', (e) => {
  const t = e.target.closest('[data-rt]')?.dataset.rt;
  if (t) setReviewTool(t);
});
$('#rv-overlay').addEventListener('pointerdown', (e) => {
  if (!rv.frame) return;
  const p = toVideo(e);
  if (rv.tool === 'pick') {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    rv.colours[rv.slot] = hexOf(rv.frame.getContext('2d').getImageData(x, y, 1, 1).data);
    if (!rv.colours[1 - rv.slot]) rv.slot = 1 - rv.slot;
    showReview();
    return;
  }
  $('#rv-overlay').setPointerCapture(e.pointerId);
  const start = { x: Math.round(p.x), y: Math.round(p.y) };
  rv.drag = { start, m: { x1: start.x, y1: start.y, x2: start.x, y2: start.y } };
});
$('#rv-overlay').addEventListener('pointermove', (e) => {
  if (!rv.drag) return;
  Object.assign(rv.drag.m, measureFrom(rv.drag.start, toVideo(e), { shift: e.shiftKey, free: e.altKey, snapAt: frameEdge }));
  drawOverlay();
  $('#rv-m').innerHTML = `<b>${measureText(rv.drag.m, rvRatio())}</b>`;
});
const endMeasure = () => {
  if (!rv.drag) return;
  const { m } = rv.drag;
  rv.drag = null;
  if (Math.hypot(m.x2 - m.x1, m.y2 - m.y1) >= 2) rv.measures = [...rv.measures, m].slice(-30);
  drawOverlay();
  showReview();
};
$('#rv-overlay').addEventListener('pointerup', endMeasure);
$('#rv-overlay').addEventListener('pointercancel', endMeasure);
for (const b of document.querySelectorAll('#review-section .pick-slot')) {
  b.addEventListener('click', () => { rv.slot = Number(b.dataset.slot); setReviewTool('pick'); showReview(); });
}
$('#rv-clear').addEventListener('click', () => {
  const kept = rv.measures;
  rv.measures = [];
  drawOverlay();
  showReview();
  toast(t('measures_cleared', kept.length), { ms: 6000, action: { label: t('editor_undo'), run: () => { rv.measures = kept; drawOverlay(); showReview(); } } });
});
$('#rv-ratio').addEventListener('input', () => { drawOverlay(); showReview(); });
// Playing hides the layer; a new frame (after seeking) is measured afresh.
player.addEventListener('play', () => { if (rv.tool !== 'off') setReviewTool('off'); });
player.addEventListener('seeked', () => { if (rv.tool !== 'off') { grabFrame(); rv.measures = []; drawOverlay(); showReview(); } });
addEventListener('resize', () => { if (rv.tool !== 'off') placeOverlay(); });

// ---------- the output's time ----------

/** Slides put in before recording time t (inclusive), in the trim. */
function slidesBefore(t) {
  const { start, end } = trim();
  return (S.slides?.all() || []).filter((s) => s.mode !== 'overlay' && s.at >= start - 1e-3 && s.at <= end + 1e-3 && s.at <= t);
}
/** When recording time t shows in the export (s): the parts kept before it, and the slides put in. */
const outputTime = (t) => clip().outOf(t) + slidesBefore(t).reduce((n, s) => n + s.duration, 0);
/** How long the export is (s). */
const outputLength = () => clip().length + slidesBefore(Infinity).reduce((n, s) => n + s.duration, 0);
/** Whether someone is heard at recording time t (from the sound's levels), to lower the music. */
export function speakingAt(t) {
  if (!S.levels) return false;
  const v = S.levels.rms[Math.floor(t / S.levels.step)] || 0;
  return v > 0.02;
}

// ---------- music ----------

export const music = mountMusic({
  ed, editor: () => S.editor, files: () => S.layerFiles, player, busy: () => S.busy,
  hasRoom: (bytes) => roomFor(bytes),
  addFile: async (src, blob) => { S.layerFiles = { ...S.layerFiles, [src]: blob }; await putExtras(captureId, { layerSources: S.layerFiles }); },
  run: (label, fn) => runWithProgress(label, fn), outputTime, outputLength, speakingAt, fmtTime,
});

// ---------- chapters ----------

export const chapters = mountChapters({
  ed, editor: () => S.editor, clip, player, duration: () => S.duration, busy: () => S.busy,
  outputTime, outputLength, fmtTime, save: (...a) => save(...a), exportStem: () => exportStem(),
});

// ---------- timeline zoom ----------

const zoom = mountTimelineZoom({ player, duration: () => S.duration });

// ---------- removing cut parts for good ----------

function syncApplyCuts() {
  $('#ed-apply-cuts').classList.toggle('hidden', !ed().cuts.length);
}
$('#ed-apply-cuts').addEventListener('click', async () => {
  if (S.busy || !S.source || !ed().cuts.length) return;
  if (!(await confirmDialog({ title: t('edit_apply_cuts_title'), text: t('edit_apply_cuts_text'), confirm: t('edit_apply_cuts'), danger: false }))) return;
  const D = S.duration;
  const cuts = ed().cuts.map((c) => [Math.max(0, c.from), Math.min(D, c.to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const kept = [];
  let at = 0;
  for (const [a, b] of cuts) { if (a > at + 0.02) kept.push([at, a]); at = Math.max(at, b); }
  if (D > at + 0.02) kept.push([at, D]);
  if (!kept.length) { toast(t('video_all_cut'), { kind: 'error' }); return; }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  let out = 0;
  const moves = kept.map(([a, b], i) => { const m = { from: a, to: i === kept.length - 1 ? Math.max(b, D) : b, at: out }; out += b - a; return m; });
  const pieces = kept.map(([a, b]) => ({ blob: S.source, from: r3(a), len: r3(b - a) }));
  // Each clip keeps what is left of it.
  const list = S.clips.all();
  const starts = clipStarts(list);
  const left = (a, b) => kept.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  const newClips = list.map((c, i) => ({ id: c.id, name: c.name, len: r3(left(starts[i], starts[i] + c.len)), ...(c.trans ? { trans: c.trans } : {}) })).filter((c) => c.len > 0.05);
  rebuild({ pieces, moves, clips: newClips }, 'edit_cuts_applied');
});

// ---------- the exported picture, here ----------

/** The frame at the playhead as the export draws it, W × H (device frame, edits and layers). */
async function composedFrame(W, H) {
  const e = ed();
  const p = plan();
  const t = player.currentTime;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  const map = clip();
  const comp = hasSpatial(e) || useLogo() ? composer(e, map, player.videoWidth, player.videoHeight, S.meta.clicks, useLogo(), S.meta.moves) : null;
  const draw = frameDrawer({ width: W, height: H }, p.renderer, true);
  if (comp) {
    const content = new OffscreenCanvas(comp.width, comp.height);
    comp.draw(content.getContext('2d'), player, t, map.outOf(t));
    draw(ctx, content);
  } else draw(ctx, player);
  const lv = layerVideos();
  try {
    await lv.seekAll(e, t);
    lv.draw(ctx, e, t, W, H);
  } finally {
    lv.close();
  }
  return c;
}

// ---------- freeze frame ----------

$('#freeze-add').addEventListener('click', async () => {
  if (S.busy || !S.slides || !player.videoWidth) return;
  player.pause();
  const p = plan();
  const frame = await composedFrame(p.width, p.height);
  S.slides.addFreeze(player.currentTime, await frame.convertToBlob({ type: 'image/png' }), 2);
  toast(t('freeze_added'), { kind: 'success' });
});

// ---------- made for a platform ----------

/** The resolution option nearest `short` (the shorter side) not above it, or the largest. */
function pickRes(short) {
  const opts = [...$('#res').options].map((o) => Number(o.value)).filter((v) => v > 0);
  const fit = opts.filter((v) => v <= short).sort((a, b) => b - a)[0] ?? Math.max(...opts);
  if (Number.isFinite(fit)) $('#res').value = String(fit);
}
$('#quick').addEventListener('click', async (e) => {
  const kind = e.target.closest('[data-quick]')?.dataset.quick;
  if (!kind || S.busy || !S.editor) return;
  await setFormat('mp4');
  const shape = { youtube: '16:9', shorts: '9:16', square: '1:1' }[kind];
  const bg = ed().background;
  const [w, h] = contentSize();
  const natural = Math.abs(w / h - { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }[shape]) < 0.02;
  // A background frames the picture in the platform's shape, unless it has it already.
  if (!natural) S.editor.setBackground({ on: true, aspect: shape });
  else if (bg.on && bg.aspect !== 'auto' && bg.aspect !== shape) S.editor.setBackground({ aspect: shape });
  // Upright and small: closer in where things happen.
  if (kind === 'shorts' && S.meta.clicks?.length && !ed().zooms.some((z) => z.auto)) S.editor.zoomOnClicks();
  fillResolutions();
  pickRes(1080);
  if ([...$('#fps').options].some((o) => o.value === '30')) $('#fps').value = '30';
  document.querySelector('.inspector').dispatchEvent(new Event('change'));
  syncUi();
  toast(t('quick_done', e.target.closest('[data-quick]').textContent.trim()), { kind: 'success' });
});

// Templates: a kind of video set up in one click, all of it undoable as usual.
$('#templates').addEventListener('click', async (e) => {
  const kind = e.target.closest('[data-template]')?.dataset.template;
  if (!kind || S.busy || !S.editor) return;
  if (kind === 'bug') {
    await setFormat('gif');
    if (S.meta.clicks?.length) S.editor.setRings(true);
  } else if (kind === 'tutorial') {
    await setFormat('mp4');
    fillResolutions();
    pickRes(1080);
    if (!S.slides.all().length) S.slides.bookends();
    if (!ed().chapters.length) S.editor.setChapters([{ id: `h${Date.now().toString(36)}`, at: Math.round(trim().start * 1000) / 1000, title: t('template_chapter') }]);
    S.editor.setCaptionStyle({ embed: true });
  } else {
    $('#quick [data-quick="shorts"]').click();
    await new Promise((r) => setTimeout(r, 50));
    S.editor.setCaptionStyle({ place: 'middle', highlight: true, burn: true });
  }
  document.querySelector('.inspector').dispatchEvent(new Event('change'));
  syncUi();
  toast(t(`template_${kind}_done`), { kind: 'success', ms: 7000 });
});

// ---------- filler words ----------

const fillers = mountFillers({
  captions: () => ed().captions, source: () => S.source, fmtTime,
  cut: (cuts, words) => S.editor?.cutFillers(cuts, words),
});

// ---------- reviewing captions ----------

const review = mountCaptionReview({
  captions: () => ed().captions, setCaption: (id, patch, quiet) => S.editor?.setCaption(id, patch, quiet),
  source: () => S.source, fmtTime, seek: (at) => { player.currentTime = Math.max(0, Math.min(S.duration, at)); },
});

// ---------- thumbnail ----------

mountThumbnail({
  player, busy: () => S.busy, plan: () => plan(), frame: (w, h) => composedFrame(w, h),
  title: () => S.meta.title || '', save: (...a) => save(...a), exportStem: () => exportStem(),
});

// ---------- storage ----------

export function renderStorage() {
  const files = Object.values(S.layerFiles).reduce((n, b) => n + (b?.size || 0), 0);
  const undo = S.undoData?.blob?.size || 0;
  const all = (S.source?.size || 0) + files + undo;
  $('#clip-storage').textContent = all ? t('clips_storage', [fmtBytes(all), undo ? t('clips_storage_undo', fmtBytes(undo)) : '']).trim() : '';
  $('#clip-forget').classList.toggle('hidden', !undo);
}
$('#clip-forget').addEventListener('click', async () => {
  if (S.busy || !S.undoData) return;
  const freed = S.undoData.blob?.size || 0;
  S.undoData = null;
  await putExtras(captureId, { undoJoin: null }).catch(() => {});
  $('#clip-undo').classList.add('hidden');
  renderStorage();
  toast(t('clips_freed', fmtBytes(freed)), { kind: 'success' });
});

// ---------- simple or all tools, and the tour ----------

const MODE_KEY = 'captode-video-mode';
let uiMode = 'simple';
try { uiMode = localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple'; } catch { /* simple */ }

/** Shows the simple set of tools or all of them; `save`: remembered for the next recording. */
function setUiMode(mode, save = true) {
  uiMode = mode;
  document.body.classList.toggle('simple', mode === 'simple');
  for (const b of document.querySelectorAll('#ui-mode [data-v]')) {
    b.classList.toggle('on', b.dataset.v === mode);
    b.setAttribute('aria-checked', String(b.dataset.v === mode));
  }
  if (save) try { localStorage.setItem(MODE_KEY, mode); } catch { /* this page only */ }
}
setUiMode(uiMode, false);
$('#ui-mode').addEventListener('click', (e) => {
  const v = e.target.closest('[data-v]')?.dataset.v;
  if (v) setUiMode(v);
});

/** Whether the recording uses a tool Simple leaves out. */
function usesAdvanced() {
  const e = ed();
  return !!(e.speeds.length || e.zooms.length || e.blurs.length || e.callouts.length || e.layers.length || e.music
    || e.chapters.length || e.crop || e.background.on || e.rings.on || e.subtitleTracks.length
    || S.slides?.all().length || S.clips?.all().length > 1 || S.device?.get()?.enabled);
}
/** In Simple, a tool in use (added with its key, say, or from before) shows all the tools, so nothing is hidden. */
function showUsedTools(quiet = false) {
  if (uiMode !== 'simple' || !S.editor || !usesAdvanced()) return;
  setUiMode('advanced', false);
  if (!quiet) toast(t('ui_mode_switched'));
}

function tourSteps() {
  return [
    { el: () => $('.preview'), title: t('tour_play_title'), text: t('tour_play') },
    { el: () => $('#timeline'), title: t('tour_trim_title'), text: t('tour_trim') },
    { el: () => $('#edit-section'), title: t('tour_edit_title'), text: t('tour_edit') },
    { el: () => $('#sound-section'), title: t('tour_sound_title'), text: t('tour_sound') },
    { el: () => $('#ui-mode'), title: t('tour_mode_title'), text: t('tour_mode') },
    { el: () => $('#convert'), title: t('tour_export_title'), text: t('tour_export') },
  ];
}
$('#tour-start').addEventListener('click', () => startTour(tourSteps()));
mountShortcuts({ hasSlides: () => !!S.slides });

/** Says so where a feature isn't offered by this browser, instead of leaving it out silently. */
function noteMissing() {
  if (S.meta.hasAudio && !$('#ed-speech') && !$('#speech-note')) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.id = 'speech-note';
    p.textContent = t('speech_not_here');
    $('#ed-silence').after(p);
  }
}

// ---------- start ----------

(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const rec = id ? await getCapture(id) : null;
  if (!rec) {
    document.querySelector('.preview').classList.add('hidden');
    $('#timeline').classList.add('hidden');
    $('#empty').classList.remove('hidden');
    $('#convert').disabled = true;
    $('#discard').classList.add('hidden');
    return;
  }
  S.source = rec.blob;
  S.meta = rec.meta || {};
  S.created = rec.created;
  showReview();
  S.srcUrl = URL.createObjectURL(S.source);
  player.src = S.srcUrl;
  S.duration = await loadDuration(player);
  $('#t-end').value = S.duration.toFixed(1);
  $('#t-start').max = $('#t-end').max = S.duration.toFixed(1);
  // The part kept when it was last open.
  const kept = rec.trim;
  if (kept && kept.start >= 0 && kept.end > kept.start + 0.05 && kept.start < S.duration) {
    $('#t-start').value = kept.start.toFixed(1);
    $('#t-end').value = Math.min(S.duration, kept.end).toFixed(1);
  }
  savedTrim = trimKey();
  $('#info').textContent = `${player.videoWidth} × ${player.videoHeight} · ${fmtTime(S.duration)} · ${fmtBytes(S.source.size)}`;
  if (S.meta.title) { $('#doc-name').textContent = S.meta.title; document.title = `${S.meta.title} — Captode`; }
  $('#make-guide').classList.toggle('hidden', !S.meta.clicks?.length);
  S.brand = await getBrand();
  S.logoArt = await loadLogo(S.brand);
  $('#v-logo-row').classList.toggle('hidden', !S.logoArt);
  $('#v-logo').checked = !!S.logoArt && S.brand.videos;
  if (canQueueExports) {
    $('#queue-export').classList.remove('hidden');
    $('#export-several').classList.remove('hidden');
    S.jobs = mountJobs($('#queue-list'), { capture: id, onEmpty: (empty) => $('#queue-list').classList.toggle('hidden', empty) });
  }
  mountCaptureTools({
    keep: $('#keep'),
    project: $('#save-project'),
    id: () => id,
    // Edits and slides are saved as they change, so the project has them already.
    stem: async () => fileStem((await getSettings()).fileName, { title: S.meta.title || 'recording', url: S.meta.url, when: new Date(S.created || Date.now()) }),
  }).sync();
  // A recording not edited yet starts with the background and sound chosen for new
  // recordings (if they were chosen before it was made).
  S.layerFiles = rec.layerSources && typeof rec.layerSources === 'object' ? { ...rec.layerSources } : {};
  let edits = rec.videoEdits;
  if (!edits) {
    const d = (await chrome.storage.local.get('videoDefaults')).videoDefaults || {};
    const e = {};
    if (d.background && S.created >= d.background.at) e.background = d.background.value;
    if (d.audio && S.created >= d.audio.at) e.audio = { ...d.audio.value, mutes: [] };
    if (Object.keys(e).length) edits = normaliseEdits(e);
  }
  S.editor = mountEdits({
    player,
    edits,
    meta: S.meta,
    levels: () => S.levels,
    saveDefault: async (part, value) => {
      const d = (await chrome.storage.local.get('videoDefaults')).videoDefaults || {};
      d[part] = { at: Date.now(), value };
      await chrome.storage.local.set({ videoDefaults: d });
    },
    duration: () => S.duration,
    trim,
    takePicked,
    fmtTime,
    changed: () => { S.fx = null; fillResolutions(); syncUi(); S.slides?.redraw(); music.render(); chapters.render(); syncApplyCuts(); showUsedTools(); },
    save: (e) => { if (!S.leaving) saveVideoEdits(id, e).catch(() => {}); },
    busy: () => S.busy,
    seek: (at) => { player.currentTime = Math.max(0, Math.min(S.duration, at)); },
    downloadSubtitles,
    cues: () => outputCues(),
    reviewCaptions: () => review.open(),
    findFillers: () => fillers.open(),
    addLayer: () => {
      const c = $('#clips-section');
      c.open = true;
      S.clips.mode('top');
      c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  });
  S.slides = mountSlides({
    player,
    slides: rec.slides,
    duration: () => S.duration,
    trim,
    clip,
    size: () => { const p = plan(); return [p.width, p.height]; },
    fmtTime,
    changed: syncUi,
    save: (list) => { if (!S.leaving) saveSlides(id, list).catch(() => {}); },
    busy: () => S.busy,
    title: () => S.meta.title || '',
    look: () => ({ captionStyle: { ...ed().captionStyle }, background: { ...ed().background } }),
    setLook: (look) => S.editor?.setLook(look),
  });
  S.undoData = rec.undoJoin?.blob ? rec.undoJoin : null;
  S.clips = mountClips({
    id,
    addLayer,
    addImage,
    save: (list) => putExtras(id, { clips: list }).catch(() => {}),
    canUndo: () => !!S.undoData,
    undo: undoJoin,
    clips: rec.clips,
    name: S.meta.title || t('clips_recording'),
    duration: () => S.duration,
    source: () => S.source,
    fmtTime,
    busy: () => S.busy,
    seek: (at) => { player.currentTime = Math.max(0, Math.min(S.duration, at)); },
    now: () => player.currentTime,
    rebuild,
  });
  music.render();
  chapters.render();
  syncApplyCuts();
  renderStorage();
  zoom.apply();
  // Captions from what is said (where the browser can, on the device).
  S.speech = mountSpeech({
    source: () => S.source,
    hasAudio: () => !!S.meta.hasAudio,
    levels: () => S.levels,
    range: trim,
    kept: () => clip().parts.filter((p) => p.rate === 1).map((p) => ({ from: p.from, to: p.to })),
    busy: () => S.busy,
    run: runWithProgress,
    addCaptions: (list) => { $('#edit-section').open = true; S.editor.addCaptions(list); },
  });
  noteMissing();
  showUsedTools(true);
  mountVoiceover({
    player, busy: () => S.busy, setBusy: (on) => { S.busy = on; }, editor: () => S.editor, map: clip, trim,
    run: runWithProgress, hasRoom: (bytes) => roomFor(bytes),
    addFile: async (src, blob) => { S.layerFiles = { ...S.layerFiles, [src]: blob }; await putExtras(captureId, { layerSources: S.layerFiles }); },
  });
  if (!tourSeen()) setTimeout(() => { if (!S.busy && !document.querySelector('dialog[open]')) startTour(tourSteps()); }, 800);
  else setTimeout(warnLowSpace, 1500);
  // The files of layers no longer in the edits (removed last time) go.
  const usedFiles = new Set([...S.editor.get().layers.map((l) => l.src), S.editor.get().music?.src].filter(Boolean));
  if (Object.keys(S.layerFiles).some((k) => !usedFiles.has(k))) {
    S.layerFiles = Object.fromEntries(Object.entries(S.layerFiles).filter(([k]) => usedFiles.has(k)));
    putExtras(id, { layerSources: S.layerFiles }).catch(() => {});
  }
  try {
    const note = sessionStorage.getItem('captode-clips');
    if (note) {
      sessionStorage.removeItem('captode-clips');
      $('#clips-section').open = true;
      const undoable = S.undoData && note !== 'clips_undone';
      toast(t(note), {
        kind: note === 'clips_sound_lost' ? 'info' : 'success', ms: note === 'clips_sound_lost' || undoable ? 8000 : 2600,
        action: undoable ? { label: t('editor_undo'), run: undoJoin } : null,
      });
    }
    // Cut short last time (the tab closed, the browser crashed): offered again.
    const short = cutShort();
    // A join is put back only with the copy kept by that join itself.
    if (short?.kind === 'export') toast(t('recover_export'), { ms: 12000, action: { label: t('recover_export_go'), run: convert } });
    else if (short?.kind === 'join' && !note && S.undoData?.at === short.at) toast(t('recover_join'), { ms: 12000, action: { label: t('recover_join_go'), run: undoJoin } });
  } catch { /* storage blocked */ }
  if ((await chrome.storage.local.get('device')).device) $('#device-section').open = true;
  S.device = await mountDevicePanel($('#device-panel'), () => { fillResolutions(); syncUi(); S.slides.redraw(); }, {
    source: () => (player.videoWidth ? contentSize() : null),
    // The frame showing in the player.
    picture: async (width) => {
      if (!player.videoWidth) return null;
      // The part kept by the crop.
      const crop = ed().crop || { x: 0, y: 0, w: 1, h: 1 };
      const [w, h] = contentSize();
      const s = Math.min(1, width / w);
      const c = new OffscreenCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
      c.getContext('2d').drawImage(player, crop.x * player.videoWidth, crop.y * player.videoHeight, crop.w * player.videoWidth, crop.h * player.videoHeight, 0, 0, c.width, c.height);
      return c;
    },
  });
  S.slides.redraw(); // in the device frame's shape, if it is on
  // The default format from Settings, or the one used last; and the options used last.
  const last = await recall('video');
  const wanted = (await getSettings()).videoFormat;
  S.format = (wanted === 'last' ? last.format : wanted) || 'mp4';
  if (!document.querySelector(`#formats [data-f="${S.format}"]`)) S.format = 'mp4';
  fillResolutions(true);
  fillFps(true);
  const CONTROLS = ['v-quality', 'g-colors', 'g-dither', 'g-lossy', 'w-quality', 'w-lossless', 'optimize'];
  rememberControls('video', CONTROLS, last.controls);
  mountPresets($('#presets'), {
    kind: 'video',
    watch: document.querySelector('.inspector'),
    capture: () => {
      const d = S.device.get();
      return {
        format: S.format,
        controls: Object.fromEntries([...CONTROLS, 'res', 'fps'].map((id) => [id, $('#' + id).type === 'checkbox' ? $('#' + id).checked : $('#' + id).value])),
        device: { enabled: d.enabled, device: d.device, size: d.size, orientation: d.orientation, fit: d.fit, frame: d.frame, statusBar: d.statusBar },
      };
    },
    apply: async (p) => {
      if (p.device) {
        S.device.set(p.device);
        if (p.device.enabled) $('#device-section').open = true;
      }
      await setFormat(p.format);
      for (const [id, v] of Object.entries(p.controls || {})) {
        const el = $('#' + id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!v;
        // Resolutions larger than the recording aren't offered: use the nearest below.
        else if (id === 'res' && ![...el.options].some((o) => o.value === String(v))) el.value = [...el.options].map((o) => o.value).filter((x) => Number(x) <= Number(v)).at(-1) || '0';
        else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === String(v))) el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      remember('video', { controls: { [S.format]: { res: $('#res').value, fps: $('#fps').value } } });
      syncUi();
    },
  });
  // Resolution and frame rate are per format (GIF defaults smaller and slower).
  const perFormat = last.controls?.[S.format] || {};
  for (const id of ['res', 'fps']) if ([...$('#' + id).options].some((o) => o.value === perFormat[id])) $('#' + id).value = perFormat[id];
  for (const id of ['res', 'fps']) $('#' + id).addEventListener('change', () => remember('video', { controls: { [S.format]: { res: $('#res').value, fps: $('#fps').value } } }));
  syncUi();
  S.editor.ready();
  if (edits && !rec.videoEdits) saveVideoEdits(id, S.editor.get()).catch(() => {});
  globalThis.captodeEdits = S.editor; // for the automated tests
  globalThis.captodePreview = { gain: () => (S.playerSound ? S.playerSound.gain.gain.value : null), levels: () => S.levels };
  enhance();
  buildFilmstrip();
  if (S.meta.hasAudio) {
    audioLevels(S.source).then((l) => {
      S.levels = l;
      drawWave();
      S.editor.soundReady();
      S.speech.sync();
    });
  }
})();

// ---------- frame to editor ----------

/** The frame on screen, at the recording's full size, opened in the editor. */
async function frameToEditor() {
  if (!player.videoWidth || $('#player').classList.contains('hidden')) return;
  player.pause();
  const c = new OffscreenCanvas(player.videoWidth, player.videoHeight);
  c.getContext('2d').drawImage(player, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const title = `${S.meta.title || t('video_recording')} · ${fmtTime(player.currentTime)}`;
  const id = await putCapture(blob, { title, url: S.meta.url, mode: 'frame', dpr: S.meta.dpr });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${id}&reopen=1`) });
}
$('#frame-to-editor').addEventListener('click', frameToEditor);
// Keyboard focus and scrolling keep panel controls clear of the export bar over them.
new ResizeObserver(([e]) => $('.inspector')?.style.setProperty('--export-bar', `${Math.ceil(e.target.offsetHeight) + 8}px`)).observe($('.export-bar'));
$('#make-guide').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL(`guide/guide.html?id=${new URLSearchParams(location.search).get('id')}`) }));