import { getCapture, putCapture, saveSlides, saveVideoEdits, saveTrim, deleteCapture, replaceBlob, putExtras, updateMeta } from '../lib/db.js';
import { GifEncoder } from '../lib/gif.js';
import { buildPalette } from '../lib/quantize.js';
import { getSettings } from '../lib/settings.js';
import { fileStem } from '../lib/filename.js';
import { recall, remember, rememberControls } from '../lib/remember.js';
import { mountPresets } from '../lib/presets.js';
import { WebpAnimEncoder } from '../lib/webp.js';
import { mountDevicePanel, deviceRenderer, frameDrawer } from '../lib/device.js';
import { toast, announce, hasRoom, enhance, fmtBytes, confirmDialog, openDialog, canShareFiles, shareFile } from '../lib/ui.js';
import { demuxWebm, muxWebm } from '../lib/webm.js';
import { sourceColourSpace, outputColour } from '../lib/video-colour.js';
import { contrastHtml, hexOf, measureLabel, measureText, edgeNear, measureFrom, drawMeasures } from '../lib/review.js';
import { t, localize } from '../lib/i18n.js';
import { slideSchedule, overlaySchedule, paintOverlays, slideSeconds, frameOrder, slideAlpha, renderSlides } from '../lib/slides.js';
import { mountSlides } from './slides-panel.js';
import { mountEdits } from './edits-panel.js';
import { mountClips } from './clips-panel.js';
import { mountSpeech } from '../lib/speech.js';
import { layerPlayback } from './layer-play.js';
import { mountMusic } from './music.js';
import { mountChapters } from './chapters-panel.js';
import { mountTimelineZoom } from './timeline-zoom.js';
import { mountThumbnail } from './thumbnail.js';
import { mountCaptionReview } from './captions-review.js';
import { joinPieces, moveTimes, layerSource, clipStarts } from '../lib/join.js';
import { noEdits, normaliseEdits, editId, clipMap, clipFrames, composer, backgroundRenderer, croppedSize, hasSpatial, audioGain, captionCues, subtitles, subtitleTracks, hasLayers, shownLayersAt, soundingLayers, soundCurve, layerBox, clipTransitions, transitionPainter } from '../lib/video-edits.js';
import { audioLevels } from '../lib/audio-levels.js';
import { mountCaptureTools } from '../lib/keep.js';
import { queueExport, mountJobs } from '../lib/export-queue.js';
import { canQueueExports } from '../lib/platform.js';
import { getBrand, loadLogo, dataUrlBlob } from '../lib/brand.js';
import { startTour, tourSeen } from './tour.js';
import { mountVoiceover } from './voiceover.js';
import { mountFillers } from './fillers.js';
import { TARGET } from '../lib/target.js';
import { once } from '../lib/util.js';

localize();

const $ = (s) => document.querySelector(s);
const player = $('#player');
const captureId = new URLSearchParams(location.search).get('id');

let source = null;   // the recorded Blob
let meta = {};
let created = 0; // when the recording was made, for file names
let srcUrl = '';
let duration = 0;
let format = 'mp4';
let device = null;
let result = null;   // { blob, name }
let resultUrl = '';  // the shown export's object URL
let cancelled = false;
let busy = false;
let slides = null; // the Slides panel, once the recording is open
let editor = null; // the Edit sections, once the recording is open
let leaving = false; // clips were joined and the page reopens: nothing more is saved over them
let joinAbort = null; // stops joining clips (or getting a layer's video ready)
let layerFiles = {}; // the video layers' files, by their edits' `src`
let clips = null; // the Clips section, once the recording is open
let speech = { sync() {} }; // Captions from speech, where offered (lib/speech.js)
/** Where joined clips meet with a transition (lib/video-edits.js). */
const transitions = () => clipTransitions(clips?.all());
let levels = null; // how loud the sound is over time (lib/audio-levels.js), once worked out
const ed = () => editor?.get() || noEdits();
let brand = null;  // your logo's settings (lib/brand.js), once read
let logoArt = null; // and the logo, ready to draw, when one is set
/** The logo to add to this export, or null. */
/** Whether the export can have sound: the recording's, or a video layer's. */
const hasSound = () => !!meta.hasAudio || soundingLayers(ed()).some((l) => layerFiles[l.src]) || !!(ed().music && layerFiles[ed().music.src]);
const useLogo = () => (logoArt && $('#v-logo').checked ? logoArt : null);
const clip = () => editor?.map() || clipMap(null, trim().start, trim().end);

const RES = [2160, 1440, 1080, 720, 480, 360, 240];
const FPS = [5, 8, 10, 12, 15, 20, 24, 25, 30, 50, 60];
const EXT = { mp4: 'mp4', webm: 'webm', gif: 'gif', webp: 'webp' };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Recorded pixels per on-screen pixel: 2 on most Retina screens. Tab recordings
 *  note it; for screens and windows this display's is the best guess. */
const density = () => Math.min(4, Math.max(1, Number(meta.dpr) || devicePixelRatio || 1));
/** The shorter side at which text is as sharp as it was on screen; 0 when that's the original. */
function readableRes(short) {
  const p = even(short / density());
  return density() > 1.05 && p < short ? p : 0;
}
let readableAt = 0; // the smallest resolution that keeps text sharp, for the note under Resolution
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;


// MediaRecorder writes WebM without a duration; seeking to the end makes the browser find it.
async function loadDuration(v) {
  if (v.readyState < 1) await once(v, 'loadedmetadata');
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e9;
    await Promise.race([once(v, 'durationchange'), new Promise((r) => setTimeout(r, 4000))]);
    v.currentTime = 0;
    await once(v, 'seeked');
  }
  return Number.isFinite(v.duration) ? v.duration : meta.duration || 0;
}

async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return;
  const done = once(v, 'seeked');
  v.currentTime = t;
  await done;
}

// ---------- settings ----------

function trim() {
  const start = Math.max(0, Math.min(Number($('#t-start').value) || 0, duration));
  const endRaw = Number($('#t-end').value);
  const end = endRaw > start ? Math.min(endRaw, duration) : duration;
  return { start, end };
}

/** The picture's size after the crop. */
const contentSize = () => croppedSize(ed(), player.videoWidth, player.videoHeight);

/** What the picture is drawn in: the device frame if on, else the background if on, else nothing. */
function outRenderer() {
  const [w, h] = contentSize();
  const d = device?.get();
  if (d?.enabled) return deviceRenderer(d, w, h);
  return ed().background.on ? backgroundRenderer(ed().background, w, h) : null;
}

/** Output size and the device or background renderer (if on) for the current settings. */
function plan() {
  const [w, h] = contentSize();
  const renderer = outRenderer();
  const bw = renderer ? renderer.width : w;
  const bh = renderer ? renderer.height : h;
  const p = Number($('#res').value) || 0;
  const s = p ? Math.min(1, p / Math.min(bw, bh)) : 1;
  return { renderer, width: even(bw * s), height: even(bh * s), fps: Number($('#fps').value) };
}

function fillResolutions(reset = false) {
  device?.refresh();
  const [w, h] = contentSize();
  const r = outRenderer() || { width: w, height: h };
  const short = Math.min(r.width, r.height);
  const keep = reset ? '' : $('#res').value;
  // GIF and WebP start smaller than the recording to keep files light, but no smaller
  // than the size the text had on screen, so it stays readable.
  const readable = readableRes(short);
  readableAt = readable || even(short);
  const def = format === 'gif' || format === 'webp' ? readable : 0;
  const sizes = [...new Set([...RES.filter((p) => p < short), readable].filter(Boolean))].sort((a, b) => b - a);
  $('#res').innerHTML = `<option value="0" title="${even(r.width)} × ${even(r.height)}">${t('res_original', `${even(short)}p`)}</option>` +
    sizes.map((p) => `<option value="${p}">${p === readable ? t('res_readable', `${p}p`) : `${p}p`}</option>`).join('');
  const values = [...$('#res').options].map((o) => o.value);
  $('#res').value = values.includes(keep) && keep !== '' ? keep : values.includes(String(def)) ? String(def) : '0';
}

function fillFps(reset = false) {
  const max = Math.min(meta.fps || 30, format === 'gif' ? 50 : 60);
  const keep = reset ? 0 : Number($('#fps').value) || 0;
  const def = format === 'gif' ? Math.min(15, max) : format === 'webp' ? Math.min(20, max) : max;
  const list = FPS.filter((f) => f <= max);
  $('#fps').innerHTML = list.map((f) => `<option value="${f}">${f} fps</option>`).join('');
  $('#fps').value = String(list.includes(keep) && keep <= max ? keep : def);
}

function syncUi() {
  for (const b of document.querySelectorAll('#formats button')) b.classList.toggle('on', b.dataset.f === format);
  $('#convert .dl-label').textContent = t('export_format', format.toUpperCase());
  for (const el of document.querySelectorAll('[data-for]')) el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(format));
  $('#w-quality-f').classList.toggle('hidden', $('#w-lossless').checked);
  $('#denoise-row').classList.toggle('hidden', !$('#optimize').checked);
  $('#w-quality-v').textContent = $('#w-quality').value + '%';
  $('#ed-picked').classList.toggle('hidden', !picked);
  if (picked) $('#ed-picked').textContent = t('video_picked_part', [fmtTime(picked.from), fmtTime(picked.to)]);
  const res = Number($('#res').value);
  $('#res-note').classList.toggle('hidden', !res || res >= readableAt);
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
  const schedule = slideSchedule(slides?.all(), start, end, p.fps, map);
  const frames = clipFrames(map, p.fps) + schedule.reduce((n, e) => n + e.frames, 0);
  const length = map.length + slideSeconds(schedule, p.fps);
  $('#dims').innerHTML = `<span>${t('video_dims', [`${p.width} × ${p.height}`, p.fps, frames])}</span><b>${length.toFixed(1)} s</b>`;
  // MP4 and WebM are encoded at a variable bitrate below this ceiling, so it is an
  // upper limit; screen recordings, mostly still, usually come out well under it.
  // GIF and WebP depend too much on the picture to guess.
  if (format === 'mp4' || format === 'webm') {
    const bitrate = Math.min(40e6, Math.max(300e3, p.width * p.height * p.fps * Number($('#v-quality').value)));
    const audio = $('#v-audio').checked && hasSound() ? 128e3 : 0;
    sizeEstimate = Math.round(((bitrate + audio) * length) / 8);
    $('#convert-size').textContent = t('video_size_up_to', fmtBytes(sizeEstimate));
  } else {
    sizeEstimate = 0;
    $('#convert-size').textContent = '';
  }
  stale();
}

// The part kept is saved with the recording, so it is still chosen when it is opened again.
let savedTrim = '';
let trimTimer = 0;
function trimKey() {
  const { start, end } = trim();
  return start <= 0.05 && end >= duration - 0.05 ? 'null' : JSON.stringify({ start: Number(start.toFixed(1)), end: Number(end.toFixed(1)) });
}
function keepTrim() {
  if (!duration || !captureId || !editor || leaving) return;
  const key = trimKey();
  if (key === savedTrim) return;
  savedTrim = key;
  clearTimeout(trimTimer);
  trimTimer = setTimeout(flushTrim, 300);
}
function flushTrim() {
  if (!trimTimer || leaving) return;
  clearTimeout(trimTimer);
  trimTimer = 0;
  saveTrim(captureId, JSON.parse(savedTrim)).catch(() => {});
}
addEventListener('pagehide', flushTrim);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushTrim(); });

/** Lets go of the last export's file, which can be as big as the recording. */
function dropResult() {
  result = null;
  if (!resultUrl) return;
  $('#out-img').removeAttribute('src');
  $('#out-video').removeAttribute('src');
  $('#out-video').load();
  URL.revokeObjectURL(resultUrl);
  resultUrl = '';
}

function stale() {
  if (busy) return;
  dropResult();
  $('#result').classList.add('hidden');
  $('#download').classList.add('hidden');
  $('#share-result').classList.add('hidden');
  $('#redo-export').classList.add('hidden');
  $('#convert').classList.remove('hidden');
  showPreview('player');
}

const PREVIEW_LABELS = { live: t('preview_converting'), 'out-img': t('preview_exported'), 'out-video': t('preview_exported') };

function showPreview(which) {
  if (which !== 'player') slides?.hide();
  for (const id of ['player', 'live', 'out-img', 'out-video']) $('#' + id).classList.toggle('hidden', id !== which);
  $('#preview-label').textContent = PREVIEW_LABELS[which] || '';
  $('#preview-label').classList.toggle('hidden', !PREVIEW_LABELS[which]);
  $('#timeline').classList.toggle('hidden', which !== 'player');
}

/** Switches format, with that format's resolution and frame rate as last used. */
async function setFormat(f) {
  format = f;
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
  if (!f || busy) return;
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
function forgetPicked() {
  if (!picked) return;
  picked = null;
  $('#ed-picked').classList.add('hidden');
}
for (const id of ['#t-start', '#t-end']) $(id).addEventListener('input', () => { picked = null; }, true);
// A start typed after the end (or an end before the start) is moved, and you're told.
function fixTrim(which) {
  const at = (v, d) => Math.max(0, Math.min(duration, Number.isFinite(v) ? v : d));
  let s = at(parseFloat($('#t-start').value), 0), e = at(parseFloat($('#t-end').value), duration);
  const wrong = e - s < 0.1;
  if (wrong) {
    if (which === 'start') s = Math.max(0, e - 0.1); else e = Math.min(duration, s + 0.1);
    if (e - s < 0.1) s = Math.max(0, e - 0.1);
  }
  $('#t-start').value = s.toFixed(1);
  $('#t-end').value = e.toFixed(1);
  if (wrong) toast(t('trim_fixed'));
  syncUi();
}
$('#t-start').addEventListener('change', () => fixTrim('start'));
$('#t-end').addEventListener('change', () => fixTrim('end'));
const setStart = (t) => { picked = null; if (busy) return; $('#t-start').value = Math.max(0, Math.min(t, trim().end - 0.1)).toFixed(1); syncUi(); };
const setEnd = (t) => { picked = null; if (busy) return; $('#t-end').value = Math.min(duration, Math.max(t, trim().start + 0.1)).toFixed(1); syncUi(); };
$('#t-start-set').addEventListener('click', () => setStart(player.currentTime));
$('#t-end-set').addEventListener('click', () => setEnd(player.currentTime));

// ---------- timeline ----------

const pct = (t) => (duration ? (t / duration) * 100 : 0) + '%';

function drawTimeline() {
  const { start, end } = trim();
  $('#h-start').style.left = pct(start);
  $('#h-end').style.left = pct(end);
  $('#range').style.left = pct(start);
  $('#range').style.width = `calc(${pct(end)} - ${pct(start)})`;
  $('#shade-l').style.width = pct(start);
  $('#shade-r').style.width = `calc(100% - ${pct(end)})`;
  // Inserted slides make the export longer than the part kept: the length with them, and what it's made of.
  const added = (slides?.all() || []).filter((s) => s.mode !== 'overlay' && s.at >= start - 1e-3 && s.at <= end + 1e-3).reduce((n, s) => n + s.duration, 0);
  const kept = clip().length; // without the parts cut, and sped-up parts shorter
  const none = duration > 0 && !clip().parts.length;
  $('#tc-len').textContent = none ? t('trim_all_cut') : added ? t('trim_with_slides', (kept + added).toFixed(1)) : t('trim_selected', kept.toFixed(1));
  $('#tc-len').classList.toggle('warn', none);
  $('#tc-len').title = added ? t('trim_with_slides_title', [kept.toFixed(1), added.toFixed(1)]) : '';
  // The length on the kept part itself, and each end's time on its handle.
  $('#range-len').style.left = `calc((${pct(start)} + ${pct(end)}) / 2)`;
  $('#range-len').textContent = `${(end - start).toFixed(1)} s`;
  $('#range-len').classList.toggle('hidden', end - start >= duration - 0.05);
  $('#h-start').dataset.time = fmtTime(start);
  $('#h-end').dataset.time = fmtTime(end);
  for (const [h, v] of [['#h-start', start], ['#h-end', end]]) {
    $(h).setAttribute('aria-valuemin', '0');
    $(h).setAttribute('aria-valuemax', duration.toFixed(1));
    $(h).setAttribute('aria-valuenow', v.toFixed(1));
    $(h).setAttribute('aria-valuetext', fmtTime(v));
  }
  slides?.refresh();
  editor?.refresh();
  drawPlayhead();
}

function drawPlayhead() {
  $('#playhead').style.left = pct(player.currentTime);
  $('#tc-now').textContent = fmtTime(player.currentTime);
}

function timeAt(e) {
  const r = $('#track').getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
}

// On the timeline: a click goes to that moment; a drag across it chooses the part to
// keep; the handles move one end; the playhead's knob scrubs.
$('#track').addEventListener('pointerdown', (e) => {
  if (!duration || busy) return;
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
  if (busy || $('#player').classList.contains('hidden')) return;
  if (slides?.skip()) return; // a slide on screen during playback: carry on
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
  if (busy || !editor) return;
  const at = player.currentTime;
  const chosen = editor.chosen?.('layers');
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
  editor.placeLayer(l.id, layerPlace(l, at)({ x, y, size }));
  editor.placeLayer(l.id, null, true);
  announce(t('vlayer_moved', [String(Math.round(x * 100)), String(Math.round(y * 100)), String(Math.round(size * 100))]));
});

function drawGuides(ctx) {
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
  if (busy || !editor || !player.paused) return;
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
  editor.choose('layers', l.id);
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
      editor.placeLayer(l.id, place({ size, x: (b.x + ((W - 2 * m) * size) / 2) / W, y: (b.y + (b.h * ((W - 2 * m) * size)) / b.w / 2) / H }));
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
      editor.placeLayer(l.id, place({ x: Math.min(1, Math.max(0, cx / W)), y: Math.min(1, Math.max(0, cy / H)) }));
      if (fx) fx.at = -1; // the guides change even when the layer doesn't
    }
  };
  const up = () => {
    guides = [];
    if (fx) fx.at = -1;
    c.removeEventListener('pointermove', move);
    c.removeEventListener('pointerup', up);
    c.removeEventListener('pointercancel', up);
    editor.placeLayer(l.id, null, true);
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

// The player's sound goes through a gain, so the preview is as loud as the export:
// above 100%, with the fades, and silent where muted or sped up. Set up on the first
// play (browsers allow sound only after a click); without it, the player's own
// volume is used, up to 100%.
let preview = null; // { ctx, gain }
function previewSound() {
  if (preview !== null) { if (preview?.ctx.state === 'suspended') preview.ctx.resume().catch(() => {}); return; }
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    ctx.createMediaElementSource(player).connect(gain);
    gain.connect(ctx.destination);
    preview = { ctx, gain };
    player.volume = 1;
    player.muted = false;
  } catch {
    preview = false;
  }
}

let curve = null; // { key, c }: the sound's clean-up, worked out once for its settings
/** How the recording's sound is cleaned up (Lower background noise, Even out volume), or null. */
function cleanSound() {
  const a = ed().audio;
  if (!levels || (!a.clean && !a.level)) return null;
  const key = `${a.clean}${a.level}`;
  if (curve?.key !== key || curve.levels !== levels) curve = { key, levels, c: soundCurve(levels, a) };
  return curve.c;
}

/** How loud the export is at recording time t, played at `rate`. */
function loudnessAt(t, rate) {
  if (rate !== 1) return 0;
  const map = clip();
  const { start, end } = trim();
  // Slides put in before t play first, so the fades are timed with them.
  const put = (slides?.all() || []).filter((s) => s.mode !== 'overlay' && s.at >= start - 1e-3 && s.at <= end + 1e-3);
  const before = put.filter((s) => s.at <= t).reduce((n, s) => n + s.duration, 0);
  const total = map.length + put.reduce((n, s) => n + s.duration, 0);
  return audioGain(ed(), map, total, cleanSound())(t, map.outOf(t) + before, null);
}

/**
 * While playing: parts cut are skipped, sped-up parts play faster (and silent), and
 * the sound is as loud as it will be exported.
 */
function playRules() {
  if (busy) return;
  const map = clip();
  const t = player.currentTime;
  let rate = 1;
  if (!map.plain && !player.paused) {
    const part = map.partAt(t);
    if (!part) {
      const next = map.parts.find((p) => p.from > t);
      if (next) player.currentTime = next.from;
      else { player.pause(); player.currentTime = map.parts.at(-1)?.to ?? trim().start; } // the rest is cut
      return;
    }
    rate = part.rate;
  } else if (!map.plain) rate = map.partAt(t)?.rate || 1;
  if (player.playbackRate !== rate) player.playbackRate = rate;
  const g = loudnessAt(t, rate);
  if (preview) {
    preview.gain.gain.setTargetAtTime(g, preview.ctx.currentTime, 0.015);
    if (player.muted) player.muted = false;
  } else {
    player.muted = g <= 0;
    player.volume = Math.min(1, g);
  }
}

// ---------- the edited picture over the player ----------

// With a crop, zoom, blur, callout, background or device frame, the player shows
// the picture as it will be exported (a smaller copy of it), drawn as it plays.
const fxView = $('#fx-view');
let fx = null;
function drawFx() {
  const e = ed();
  const d = device?.get();
  const on = !!player.videoWidth && !busy && !$('#player').classList.contains('hidden') && !editor?.editing() && rv.tool === 'off' &&
    (hasSpatial(e) || !!d?.enabled || !!useLogo() || hasLayers(e) || transitions().length > 0);
  previewLayers.sync(on ? e : null, player.currentTime, !player.paused, player.playbackRate);
  fxView.classList.toggle('hidden', !on);
  player.style.opacity = on ? '0' : '';
  if (!on) { fx = null; return; }
  const { audio, ...look } = e;
  // A long or very large recording is previewed smaller while it plays, so playing stays smooth.
  const light = !player.paused && (duration > 600 || player.videoWidth * player.videoHeight > 2560 * 1440);
  const key = JSON.stringify([look, d, $('#res').value, trim(), player.videoWidth, player.videoHeight, !!useLogo(), transitions(), light]);
  if (!fx || fx.key !== key) {
    const p = plan();
    const k = Math.min(1, (light ? 854 : 1280) / Math.max(p.width, p.height));
    const W = even(p.width * k), H = even(p.height * k);
    fxView.width = W;
    fxView.height = H;
    const map = clip();
    const comp = hasSpatial(e) || useLogo() ? composer(e, map, player.videoWidth, player.videoHeight, meta.clicks, useLogo(), meta.moves) : null;
    fx = { key, map, comp, content: comp && new OffscreenCanvas(comp.width, comp.height), draw: frameDrawer({ width: W, height: H }, p.renderer, false), at: -1, trans: transitionPainter(transitions()) };
  }
  const t = player.currentTime;
  const lk = previewLayers.stamp(e, t); // a layer's frame can arrive after the recording's
  if ((fx.at === t && fx.lk === lk) || player.readyState < 2) return;
  if (light && (fx.skip = !fx.skip)) return; // and drawn every other frame
  fx.at = t;
  fx.lk = lk;
  const ctx = fxView.getContext('2d');
  ctx.clearRect(0, 0, fxView.width, fxView.height);
  if (fx.comp) {
    const c = fx.content.getContext('2d');
    c.clearRect(0, 0, fx.content.width, fx.content.height);
    fx.comp.draw(c, player, t, fx.map.outOf(t));
    fx.draw(ctx, fx.content);
  } else fx.draw(ctx, player);
  previewLayers.draw(ctx, e, t, fxView.width, fxView.height);
  fx.trans.apply(ctx, t, fxView.width, fxView.height);
  drawGuides(ctx);
}
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
  if (editor) music.preview();
  if (editor) { drawFx(); editor.redraw(); } // once the page is set up
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
  else if (k === 's' && slides && !busy) { e.preventDefault(); slides.add(); }
  else if (k === 'arrowleft' && !e.target.closest('.handle')) { player.currentTime = Math.max(0, player.currentTime - (e.shiftKey ? 1 : 1 / (meta.fps || 30))); }
  else if (k === 'arrowright' && !e.target.closest('.handle')) { player.currentTime = Math.min(duration, player.currentTime + (e.shiftKey ? 1 : 1 / (meta.fps || 30))); }
});

/** The sound's waveform along the bottom of the timeline. */
function drawWave() {
  const c = $('#wave');
  const peak = levels ? levels.rms.reduce((m, v) => Math.max(m, v), 0) : 0;
  if (!duration || peak < 0.002) { c.classList.add('hidden'); return; }
  c.classList.remove('hidden');
  const r = devicePixelRatio;
  const W = Math.round(c.clientWidth * r), H = Math.round(c.clientHeight * r);
  if (!W || !H) return;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  const { step, rms } = levels;
  const bar = Math.max(1, Math.round(2 * r)), gap = Math.max(1, Math.round(r));
  for (let x = 0; x < W; x += bar + gap) {
    const k0 = Math.floor(((x / W) * duration) / step), k1 = Math.max(k0 + 1, Math.floor((((x + bar + gap) / W) * duration) / step));
    let m = 0;
    for (let k = k0; k < k1 && k < rms.length; k++) if (rms[k] > m) m = rms[k];
    // A square root, so quiet sound still shows.
    const h = Math.max(r, Math.sqrt(m / peak) * (H - 2 * r));
    ctx.fillRect(x, (H - h) / 2, bar, h);
  }
}
new ResizeObserver(() => drawWave()).observe($('#track'));

// Pointing at the timeline shows the frame at that moment, above it.
const peekEl = $('#peek');
const peek = { v: null, want: null, running: false, idle: 0 };
function hidePeek() {
  peek.want = null;
  peekEl.classList.add('hidden');
  // Its video holds a decoder and buffered frames: let them go when not in use.
  clearTimeout(peek.idle);
  peek.idle = setTimeout(function release() {
    if (peek.running) { peek.idle = setTimeout(release, 1000); return; }
    if (peek.v) dropVideo(peek.v);
    peek.v = null;
  }, 10000);
}
async function peekAt(at) {
  clearTimeout(peek.idle);
  peek.want = at;
  if (peek.running) return;
  peek.running = true;
  try {
    if (!peek.v) {
      peek.v = makeWorkVideo();
      peek.v.muted = true;
      if (peek.v.readyState < 1) await once(peek.v, 'loadedmetadata');
    }
    const c = peekEl.querySelector('canvas');
    const w = 320, h = Math.max(2, Math.round((w * player.videoHeight) / player.videoWidth));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    while (peek.want !== null) {
      const x = peek.want;
      await seek(peek.v, Math.max(0, Math.min(duration - 0.05, x)));
      if (peek.want === null) break;
      c.getContext('2d').drawImage(peek.v, 0, 0, w, h);
      if (peek.want === x) break;
    }
  } catch { /* no frame to show; the timeline still works */ } finally {
    peek.running = false;
  }
}
$('#track').addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons || busy || !duration || !player.videoWidth) return hidePeek();
  const r = $('#track').getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
  const at = (x / r.width) * duration;
  const half = 84; // half the frame's width, so it stays over the timeline
  peekEl.style.left = `${r.width > half * 2 ? Math.max(half, Math.min(r.width - half, x)) : r.width / 2}px`;
  peekEl.querySelector('span').textContent = fmtTime(at);
  peekEl.classList.remove('hidden');
  peekAt(at);
});
$('#track').addEventListener('pointerleave', hidePeek);
$('#track').addEventListener('pointerdown', hidePeek);

/** Fills the timeline with thumbnails taken across the clip. */
async function buildFilmstrip() {
  const film = $('#film');
  const v = makeWorkVideo();
  try {
    if (v.readyState < 1) await once(v, 'loadedmetadata');
    const n = Math.max(4, Math.min(14, Math.round(film.clientWidth / 70)));
    const h = 44 * devicePixelRatio;
    const w = Math.round(h * (player.videoWidth / player.videoHeight));
    for (let i = 0; i < n; i++) {
      await seek(v, Math.min(duration - 0.05, ((i + 0.5) / n) * duration));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      film.append(c);
    }
  } catch { /* the timeline still works without thumbnails */ }
  dropVideo(v);
}

// ---------- conversion ----------

function progress(f, text) {
  $('#progress').style.width = Math.round(Math.min(1, Math.max(0, f)) * 100) + '%';
  if (text) $('#status').textContent = text;
}

// Formats without transparency get white behind a transparent device background.
const drawer = (p, opaque = false) => frameDrawer(p, p.renderer, opaque);

function makeWorkVideo() {
  const v = document.createElement('video');
  v.className = 'work';
  v.playsInline = true;
  v.preload = 'auto';
  v.src = srcUrl;
  document.body.appendChild(v);
  return v;
}

/** Removes a work video and lets go of its decoder now, not when it is collected. */
function dropVideo(v) {
  v.remove();
  v.removeAttribute('src');
  v.load();
}

/** GIF and WebP: step through the clip frame by frame. */
async function convertFrames(p, { start, end }) {
  const v = makeWorkVideo();
  const lv = layerVideos();
  v.muted = true;
  try {
    await loadDuration(v);
    const c = new OffscreenCanvas(p.width, p.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const draw = drawer(p);
    const live = $('#live');
    live.width = p.width;
    live.height = p.height;
    const lctx = live.getContext('2d');
    showPreview('live');

    const transparent = !!p.renderer?.transparent;
    const loop = $('#loop').checked ? 0 : 1;
    const optimize = $('#optimize').checked;
    const tolerance = $('#denoise').checked ? undefined : 0; // undefined: the encoder's default
    const map = clip();
    const count = clipFrames(map, p.fps);
    const at = (i) => Math.min(map.sourceAt(i / p.fps), Math.max(start, end - 0.001));
    // Output frames: the clip's (with any overlays over them), with the slides' in between.
    const schedule = slideSchedule(slides.all(), start, end, p.fps, map);
    const order = frameOrder(schedule, count);
    const art = await renderSlides(schedule, p.width, p.height);
    const overlays = overlaySchedule(slides.all(), start, end, p.fps, map);
    const overlayArt = await renderSlides(overlays, p.width, p.height);
    const e = ed();
    const comp = hasSpatial(e) || useLogo() ? composer(e, map, v.videoWidth, v.videoHeight, meta.clicks, useLogo(), meta.moves) : null;
    const content = comp && new OffscreenCanvas(comp.width, comp.height);
    const trans = transitionPainter(transitions());
    const paint = async (o) => {
      const a = o.slide ? slideAlpha(o.slide, o.j, p.fps) : 0;
      if (a < 1) {
        await seek(v, at(o.k));
        ctx.clearRect(0, 0, p.width, p.height);
        if (comp) {
          const c = content.getContext('2d');
          c.clearRect(0, 0, content.width, content.height);
          comp.draw(c, v, at(o.k), o.k / p.fps);
          draw(ctx, content);
        } else draw(ctx, v);
        if (hasLayers(e)) {
          await lv.seekAll(e, at(o.k));
          lv.draw(ctx, e, at(o.k), p.width, p.height);
        }
        trans.apply(ctx, at(o.k), p.width, p.height);
        paintOverlays(ctx, overlays, overlayArt, o.k, p.fps);
      }
      if (a > 0) {
        ctx.globalAlpha = a;
        ctx.drawImage(art.get(o.slide), 0, 0);
        ctx.globalAlpha = 1;
      }
    };

    // GIF: one palette for the whole clip, from frames sampled across it, so colours
    // stay steady from frame to frame.
    let palette = null;
    if (format === 'gif') {
      const samples = Math.min(order.length, 16 + schedule.length);
      const parts = [];
      // Frames spread across the output, each slide whole, and each overlay over its recording.
      const picks = [...Array.from({ length: samples - schedule.length }, (_, k) => order[Math.floor(((k + 0.5) * order.length) / (samples - schedule.length))]),
        ...schedule.map((e) => ({ k: e.k, slide: e, j: Math.floor(e.frames / 2) })),
        ...overlays.map((e) => ({ k: Math.min(count - 1, Math.max(0, e.from + Math.floor(e.frames / 2))), slide: null, j: 0 }))];
      for (const o of picks) {
        if (cancelled) throw new Error('cancelled');
        await paint(o);
        const px = ctx.getImageData(0, 0, p.width, p.height).data;
        const part = new Uint8ClampedArray(Math.ceil(px.length / 12) * 4);
        for (let i = 0, o = 0; i < px.length; i += 12, o += 4) part.set(px.subarray(i, i + 4), o);
        parts.push(part);
        progress(0, t('export_colours'));
      }
      const all = new Uint8ClampedArray(parts.reduce((n, a) => n + a.length, 0));
      let o = 0;
      for (const part of parts) { all.set(part, o); o += part.length; }
      palette = buildPalette(all, Math.max(2, Number($('#g-colors').value) - 1));
    }

    const enc = format === 'gif'
      ? new GifEncoder(p.width, p.height, { palette, dither: $('#g-dither').checked, optimize, transparent, loop, tolerance, lossy: Number($('#g-lossy').value) })
      : new WebpAnimEncoder(p.width, p.height, {
          quality: Number($('#w-quality').value) / 100, lossless: $('#w-lossless').checked, optimize, loop, alpha: transparent, tolerance,
        });

    for (let i = 0; i < order.length; i++) {
      if (cancelled) throw new Error('cancelled');
      await paint(order[i]);
      if (format === 'gif') enc.addFrame(ctx.getImageData(0, 0, p.width, p.height).data, 1000 / p.fps);
      else await enc.addFrame(c, 1000 / p.fps);
      if (i % 3 === 0) {
        lctx.clearRect(0, 0, p.width, p.height);
        lctx.drawImage(c, 0, 0);
      }
      progress((i + 1) / order.length, t('export_frame', [i + 1, order.length]));
      if (i % 4 === 0) await new Promise((r) => setTimeout(r));
    }
    progress(1, t('export_finishing'));
    return enc.finish();
  } finally {
    dropVideo(v);
    lv.close();
  }
}

function pickMime(kind, withAudio, w, h) {
  const level = w * h > 1920 * 1088 ? '640033' : '640028';
  const list = kind === 'mp4'
    ? [
        `video/mp4;codecs=avc1.${level}${withAudio ? ',mp4a.40.2' : ''}`,
        `video/mp4;codecs=avc1.42E01F${withAudio ? ',mp4a.40.2' : ''}`,
        'video/mp4;codecs=avc1',
        'video/mp4',
      ]
    : [`video/webm;codecs=vp9${withAudio ? ',opus' : ''}`, `video/webm;codecs=vp8${withAudio ? ',opus' : ''}`, 'video/webm'];
  return list.find((t) => MediaRecorder.isTypeSupported(t));
}

/** MP4 and WebM: play the clip through a canvas and record that, in real time. */
async function convertRealtime(p, { start, end }) {
  const withAudio = $('#v-audio').checked && hasSound();
  const mimeType = pickMime(format, withAudio, p.width, p.height);
  if (!mimeType) {
    throw new Error(format === 'mp4'
      ? t('no_mp4')
      : t('no_webm'));
  }
  const v = makeWorkVideo();
  let audioCtx = null;
  let gain = null;
  let mixDest = null; // where the layers' sound goes too
  let mel = null, melGain = null; // the music, and how loud
  const lv = layerVideos({
    connect: (el) => {
      if (!audioCtx || !mixDest) throw new Error('no sound');
      const g = audioCtx.createGain();
      g.gain.value = 0;
      audioCtx.createMediaElementSource(el).connect(g);
      g.connect(mixDest);
      return g;
    },
  });
  const live = $('#live');
  live.width = p.width;
  live.height = p.height;
  const ctx = live.getContext('2d');
  const draw = drawer(p, true);
  showPreview('live');

  try {
    await loadDuration(v);
    const stream = live.captureStream(p.fps);
    if (withAudio) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      mixDest = dest;
      gain = audioCtx.createGain();
      audioCtx.createMediaElementSource(v).connect(gain); // not to the speakers
      gain.connect(dest);
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      // The music: played along as it records, from its start.
      const m = music.now();
      if (m) {
        mel = new Audio(music.url());
        mel.loop = m.loop;
        mel.currentTime = m.offset;
        melGain = audioCtx.createGain();
        melGain.gain.value = 0;
        audioCtx.createMediaElementSource(mel).connect(melGain);
        melGain.connect(dest);
      }
    } else {
      v.muted = true;
    }
    const bitrate = Math.round(Math.min(40e6, Math.max(300e3, p.width * p.height * p.fps * Number($('#v-quality').value))));
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    // Parts cut are skipped and sped-up parts played faster (and silent).
    const map = clip();
    const e = ed();
    const comp = hasSpatial(e) || useLogo() ? composer(e, map, v.videoWidth, v.videoHeight, meta.clicks, useLogo(), meta.moves) : null;
    const content = comp && new OffscreenCanvas(comp.width, comp.height);
    // Slides: the clip waits, silent, while each is drawn for its time.
    const schedule = slideSchedule(slides.all(), start, end, p.fps, map);
    const art = await renderSlides(schedule, p.width, p.height);
    // Overlays: drawn over the clip by its time, so they wait with it.
    const overlays = overlaySchedule(slides.all(), start, end, p.fps, map);
    const overlayArt = await renderSlides(overlays, p.width, p.height);
    const trans = transitionPainter(transitions());
    const drawClip = (at) => {
      ctx.clearRect(0, 0, p.width, p.height); // the overlays' bands would build up otherwise
      if (comp) {
        const c = content.getContext('2d');
        c.clearRect(0, 0, content.width, content.height);
        comp.draw(c, v, at, map.outOf(at));
        draw(ctx, content);
      } else draw(ctx, v);
      if (hasLayers(e)) {
        lv.sync(e, at, !v.paused, v.playbackRate);
        lv.draw(ctx, e, at, p.width, p.height);
      }
      trans.apply(ctx, at, p.width, p.height);
      paintOverlays(ctx, overlays, overlayArt, map.outOf(at) * p.fps, p.fps);
    };
    const total = map.length + slideSeconds(schedule, p.fps);
    // As loud as the faster export and the preview: fades over the slides' time too, ramps into muted parts.
    const gainAt = audioGain(e, map, total, cleanSound());
    const loud = (at, rate) => {
      if (gain) gain.gain.value = rate !== 1 ? 0 : gainAt(at, map.outOf(at) + slideTime, map.partAt(at));
      if (melGain) melGain.gain.value = music.gain(ed().music, map.outOf(at) + slideTime, total, speakingAt(at));
    };
    let slideTime = 0; // seconds of slides recorded so far
    let next = 0;
    const due = (at) => next < schedule.length && schedule[next].k / p.fps <= map.outOf(at) + 0.5 / p.fps;
    const showSlide = (e) => new Promise((resolve) => {
      const t0 = performance.now();
      const step = () => {
        const shown = (performance.now() - t0) / 1000;
        drawClip(v.currentTime); // under the slide while it fades
        ctx.globalAlpha = slideAlpha(e, Math.min(e.frames - 1, Math.floor(shown * p.fps)), p.fps);
        ctx.drawImage(art.get(e), 0, 0);
        ctx.globalAlpha = 1;
        const done = slideTime + shown;
        progress(done / total, t('export_realtime', [fmtTime(done), fmtTime(total)]));
        if (cancelled || shown >= e.frames / p.fps) { slideTime += e.frames / p.fps; resolve(); }
        else setTimeout(step, 1000 / p.fps);
      };
      step();
    });

    await seek(v, map.parts[0]?.from ?? start);
    drawClip(v.currentTime);
    loud(v.currentTime, map.parts[0]?.rate || 1);
    v.playbackRate = map.parts[0]?.rate || 1;
    const stopped = once(rec, 'stop');
    rec.start(1000);
    mel?.play().catch(() => {});
    while (!cancelled && due(start)) await showSlide(schedule[next++]);
    await v.play();

    await new Promise((resolve) => {
      const finish = () => { v.pause(); resolve(); };
      v.addEventListener('ended', finish, { once: true });
      const tick = async (_now, md) => {
        const at = md?.mediaTime ?? v.currentTime;
        const part = map.partAt(at);
        if (!part && at < end - 0.5 / p.fps) {
          // A part cut: on to the next, the recording paused meanwhile.
          const after = map.parts.find((x) => x.from > at);
          if (!after) return finish();
          v.pause();
          rec.pause();
          mel?.pause();
          await seek(v, after.from);
          rec.resume();
          mel?.play().catch(() => {});
          v.playbackRate = after.rate;
          await v.play();
          v.requestVideoFrameCallback(tick);
          return;
        }
        if (part && v.playbackRate !== part.rate) v.playbackRate = part.rate;
        loud(at, part?.rate || 1);
        drawClip(at);
        const done = map.outOf(at) + slideTime;
        progress(done / total, t('export_realtime', [fmtTime(Math.max(0, done)), fmtTime(total)]));
        if (cancelled || at >= end - 0.5 / p.fps) return finish();
        if (due(at)) {
          v.pause();
          while (!cancelled && due(at)) await showSlide(schedule[next++]);
          if (cancelled) return finish();
          await v.play();
        }
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    });
    while (!cancelled && next < schedule.length) await showSlide(schedule[next++]);
    mel?.pause();
    rec.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    if (cancelled) throw new Error('cancelled');
    progress(1, t('export_done'));
    return new Blob(chunks, { type: mimeType.split(';')[0] });
  } finally {
    mel?.pause();
    audioCtx?.close();
    dropVideo(v);
    lv.close();
  }
}

// ---------- export in a worker ----------

let worker = null;
let abortWorker = null;

/**
 * Exports in a worker with WebCodecs: faster than real time and off the page's
 * thread. Rejects with `fallback: true` when this browser can't, so the slower
 * paths above can take over.
 */
/** What the export worker is told to make, without the recording itself. */
function jobSpec(p, { start, end }) {
  const d = device?.get();
  return {
    format, width: p.width, height: p.height, fps: p.fps, start, end,
    device: d?.enabled ? { ...d } : null,
    slides: slides.all().map((s) => ({ ...s })),
    edits: JSON.parse(JSON.stringify(ed())),
    transitions: transitions(),
    chapters: ed().chapters.length ? chapters.list() : null,
    subtitles: subtitleTracks(ed(), outputCues()),
    // The files the layers and the music play from.
    layerSources: Object.fromEntries([...ed().layers.map((l) => l.src), ed().music?.src].filter((k) => k && layerFiles[k]).map((k) => [k, layerFiles[k]])),
    clicks: meta.clicks || [],
    moves: ed().zooms.some((z) => z.follow) ? meta.moves || null : null,
    audioCurve: cleanSound(),
    logo: useLogo() && { blob: dataUrlBlob(brand.image), position: brand.position, size: brand.size, opacity: brand.opacity },
    video: { bitsPerPixel: Number($('#v-quality').value), audio: $('#v-audio').checked && hasSound() },
    gif: { colors: Number($('#g-colors').value), dither: $('#g-dither').checked, lossy: Number($('#g-lossy').value) },
    webp: { quality: Number($('#w-quality').value) / 100, lossless: $('#w-lossless').checked },
    optimize: $('#optimize').checked,
    tolerance: $('#denoise').checked ? undefined : 0,
    loop: $('#loop').checked ? 0 : 1,
  };
}

function convertInWorker(p, range) {
  const live = $('#live');
  live.width = p.width;
  live.height = p.height;
  const lctx = live.getContext('2d');
  showPreview('live');
  const job = { ...jobSpec(p, range), blob: source };
  return new Promise((resolve, reject) => {
    worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
    abortWorker = () => reject(new Error('cancelled'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress(data.f, [].concat(data.what).length > 1 ? t(data.what[0], data.what.slice(1)) : t(data.what));
      else if (data.type === 'preview') { lctx.clearRect(0, 0, live.width, live.height); lctx.drawImage(data.bitmap, 0, 0); data.bitmap.close(); }
      else if (data.type === 'done') resolve(data.blob);
      else if (data.type === 'error') reject(Object.assign(new Error(data.message), { fallback: data.fallback }));
    };
    worker.onerror = (e) => reject(Object.assign(new Error(e.message || t('export_stopped')), { fallback: true }));
    worker.postMessage({ type: 'start', job });
  }).finally(() => {
    worker?.terminate();
    worker = null;
    abortWorker = null;
  });
}

/** Whether anything is left to export; if not, says so. */
function somethingKept() {
  if (clip().parts.length) return true;
  toast(t('video_all_cut'), { kind: 'error', ms: 5000 });
  return false;
}

async function convert() {
  if (busy || !source) return;
  forgetPicked();
  if (!somethingKept()) return;
  if (!(await checkExport())) return;
  if (busy) return;
  busy = true;
  markRunning('export');
  cancelled = false;
  $('#convert').disabled = true;
  $('#convert').classList.add('hidden');
  $('#cancel').disabled = false;
  $('#cancel').classList.remove('hidden');
  $('#progress-wrap').classList.remove('hidden');
  $('#result').classList.add('hidden');
  progress(0, t('export_starting'));
  player.pause();
  try {
    const p = plan();
    const range = trim();
    let blob;
    try {
      blob = await convertInWorker(p, range);
    } catch (e) {
      if (!e.fallback) throw e;
      console.warn('Captode: falling back to in-page export:', e.message);
      if (format === 'gif' || format === 'webp') {
        blob = await convertFrames(p, range);
      } else {
        progress(0, t('export_realtime_note'));
        blob = await convertRealtime(p, range);
      }
    }
    const name = await exportStem();

    dropResult();
    result = { blob, name: `${name}.${EXT[format]}` };
    const url = resultUrl = URL.createObjectURL(blob);
    if (format === 'gif' || format === 'webp') {
      $('#out-img').src = url;
      showPreview('out-img');
    } else {
      $('#out-video').src = url;
      showPreview('out-video');
    }
    const change = Math.round((1 - blob.size / source.size) * 100);
    const larger = change < 0;
    $('#r-size').textContent = t('result_ready', [EXT[format].toUpperCase(), fmtBytes(blob.size)]);
    $('#r-detail').textContent = t('result_dims', [`${p.width} × ${p.height}`, p.fps]) + ' ' + (larger
      ? t('result_larger', (blob.size / source.size).toFixed(1))
      : t('result_smaller', change));
    $('#result').classList.toggle('larger', larger);
    $('#result').classList.remove('hidden');
    $('#convert').classList.add('hidden');
    $('#download').classList.remove('hidden');
    $('#share-result').classList.toggle('hidden', !canShareFiles);
    $('#redo-export').classList.remove('hidden');
    $('#download').focus();
    countExport();
  } catch (e) {
    if (e.message !== 'cancelled') { $('#status').textContent = t('export_failed', e.message); toast(t('export_failed', e.message), { kind: 'error', ms: 5000 }); }
    else $('#progress-wrap').classList.add('hidden');
    showPreview('player');
  } finally {
    busy = false;
    markDone();
    $('#convert').disabled = false;
    $('#cancel').disabled = true;
    $('#cancel').classList.add('hidden');
    if (!result) $('#convert').classList.remove('hidden');
    if (result) $('#progress-wrap').classList.add('hidden');
  }
}

// ---------- before and after exporting ----------

let sizeEstimate = 0; // bytes, at most, for MP4 and WebM
let checked = ''; // the warnings last agreed to, not asked about again

/** Things about to come out differently than may be expected; resolves to whether to go on. */
async function checkExport() {
  const e = ed();
  const still = format === 'gif' || format === 'webp';
  const list = [];
  if (still && e.captions.length && e.captionStyle.burn === false) list.push(t('check_captions_animation'));
  if (!still && e.subtitleTracks.length && !e.captionStyle.embed) list.push(t('check_subs_off'));
  if (e.music && meta.hasAudio && $('#v-audio').checked && e.music.volume >= 0.9 && !e.music.duck) list.push(t('check_music_loud'));
  if (hasSound() && !$('#v-audio').checked && !still) list.push(t('check_muted'));
  if (sizeEstimate > 1e9) list.push(t('check_big', fmtBytes(sizeEstimate)));
  const key = list.join('|');
  if (!list.length || key === checked) return true;
  const go = await confirmDialog({ title: t('check_title'), text: list.join(' '), confirm: t('check_go'), danger: false });
  if (go) checked = key;
  return go;
}

// An export or a join under way is noted, so one cut short (the tab closed, the browser
// crashed) can be offered again when the recording is opened next.
const RUN_KEY = `captode-running-${captureId}`;
function markRunning(kind) {
  const at = Date.now();
  try { localStorage.setItem(RUN_KEY, JSON.stringify({ kind, at })); } catch { /* not offered later */ }
  return at;
}
function markDone() { try { localStorage.removeItem(RUN_KEY); } catch { /* nothing kept */ } }
/** What was cut short last time this recording was open: { kind ('export' | 'join'), at }, or null. */
function cutShort() {
  let r = null;
  try { r = JSON.parse(localStorage.getItem(RUN_KEY) || 'null'); } catch { /* none */ }
  markDone();
  return r && Date.now() - r.at < 7 * 864e5 ? r : null;
}

/** After a few exports, once: a link to rate Captode in this browser's store. */
async function countExport() {
  if (!TARGET.storeUrl) return;
  try {
    const { exportCount = 0, rateAsked = false } = await chrome.storage.local.get(['exportCount', 'rateAsked']);
    await chrome.storage.local.set({ exportCount: exportCount + 1 });
    if (rateAsked || exportCount + 1 < 5) return;
    $('#rate-link').href = TARGET.storeUrl;
    $('#rate').classList.remove('hidden');
  } catch { /* outside the extension */ }
}
const rateDone = () => { $('#rate').classList.add('hidden'); chrome.storage.local.set({ rateAsked: true }).catch(() => {}); };
$('#rate-link').addEventListener('click', rateDone);
$('#rate-no').addEventListener('click', rateDone);

// ---------- video layers ----------

const { layerVideos } = layerPlayback({ files: () => layerFiles, redraw: () => { if (fx) fx.at = -1; } });
const previewLayers = layerVideos();

/** Lays [from, from + len) of `blob` over the picture from the playhead: kept with the recording, then a layer in the edits. */
async function addLayer(blob, { from = 0, len = null } = {}) {
  if (busy || !source || !editor) return;
  if (!(await roomFor(blob.size))) return;
  busy = true;
  joinAbort = new AbortController();
  player.pause();
  $('#convert').disabled = true;
  $('#convert').classList.add('hidden');
  $('#cancel').disabled = false;
  $('#cancel').classList.remove('hidden');
  $('#progress-wrap').classList.remove('hidden');
  $('#result').classList.add('hidden');
  progress(0, t('vlayer_preparing'));
  let made = null;
  try {
    const fps = Math.round(Math.min(60, Math.max(15, Number(meta.fps) || 30)));
    made = await layerSource(blob, { from, len, fps, signal: joinAbort.signal, onProgress: (f) => progress(f) });
    const src = `v${Date.now().toString(36)}`;
    layerFiles = { ...layerFiles, [src]: made.blob };
    await putExtras(captureId, { layerSources: layerFiles });
    made.src = src;
  } catch (err) {
    made = null;
    if (err?.code !== 'cancelled') {
      console.warn('Captode: adding a video layer failed:', err);
      toast(t({ unplayable: 'clips_unplayable', unsupported: 'clips_unsupported' }[err?.code] || 'vlayer_failed'), { kind: 'error', ms: 6000 });
    }
  } finally {
    joinAbort = null;
    busy = false;
    $('#convert').disabled = false;
    $('#cancel').disabled = true;
    $('#cancel').classList.add('hidden');
    $('#progress-wrap').classList.add('hidden');
    if (result) $('#result').classList.remove('hidden');
    else $('#convert').classList.remove('hidden');
  }
  if (made) {
    $('#edit-section').open = true;
    const added = editor.add('layers', { kind: 'video', src: made.src, offset: made.offset, pos: 'br', size: 0.3, shape: 'rect', aspect: made.width / made.height, sound: !!made.sound, volume: made.sound ? 1 : 0, len: Math.min(made.len, Math.max(0.5, duration - player.currentTime)) });
    if (added) toast(t('vlayer_added'), { kind: 'success' });
  }
}

/** Whether there is room to keep `bytes` more; if not, says so. */
async function roomFor(bytes) {
  if (await hasRoom(bytes)) return true;
  toast(t('storage_full', fmtBytes(bytes)), { kind: 'error', ms: 9000 });
  return false;
}

/**
 * Runs `fn(signal, progress)` with the export's progress bar and Cancel showing, the page
 * busy meanwhile. Resolves to what `fn` does, or null when cancelled or busy.
 */
async function runWithProgress(label, fn) {
  if (busy) return null;
  busy = true;
  joinAbort = new AbortController();
  player.pause();
  $('#convert').disabled = true;
  $('#convert').classList.add('hidden');
  $('#cancel').disabled = false;
  $('#cancel').classList.remove('hidden');
  $('#progress-wrap').classList.remove('hidden');
  $('#result').classList.add('hidden');
  progress(0, label);
  try {
    return await fn(joinAbort.signal, progress);
  } finally {
    joinAbort = null;
    busy = false;
    $('#convert').disabled = false;
    $('#cancel').disabled = true;
    $('#cancel').classList.add('hidden');
    $('#progress-wrap').classList.add('hidden');
    if (result) $('#result').classList.remove('hidden');
    else $('#convert').classList.remove('hidden');
  }
}

let undoData = null; // the recording before clips were last joined, moved or removed

/** Puts the recording back as it was before clips last changed. */
async function undoJoin() {
  const u = undoData;
  if (!u?.blob || busy) return;
  busy = true;
  leaving = true;
  try {
    await replaceBlob(captureId, u.blob);
    await putExtras(captureId, { videoEdits: u.videoEdits, slides: u.slides, trim: u.trim, clips: u.clips, undoJoin: null });
    await updateMeta(captureId, { duration: u.duration, ...(u.clicks ? { clicks: u.clicks } : {}), ...(u.moves ? { moves: u.moves } : {}) });
    try { sessionStorage.setItem('captode-clips', 'clips_undone'); } catch { /* the note is only a nicety */ }
    location.reload();
  } catch (err) {
    console.warn('Captode: undoing clips failed:', err);
    leaving = false;
    busy = false;
    toast(t('clips_failed'), { kind: 'error' });
  }
}

/** Lays a picture over the video from the playhead, for 5 s. */
async function addImage(blob, name = '') {
  if (busy || !editor) return;
  if (!(await roomFor(blob.size))) return;
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { toast(t('clips_unplayable'), { kind: 'error' }); return; }
  const src = `i${Date.now().toString(36)}`;
  layerFiles = { ...layerFiles, [src]: blob };
  await putExtras(captureId, { layerSources: layerFiles }).catch(() => {});
  $('#edit-section').open = true;
  const added = editor.add('layers', { kind: 'image', src, offset: 0, pos: 'tr', size: 0.25, shape: 'rect', aspect: bmp.width / bmp.height, len: Math.min(5, Math.max(0.5, duration - player.currentTime)) });
  bmp.close();
  if (added) toast(t('vlayer_picture_added', name || t('vlayer_picture')), { kind: 'success' });
  renderStorage();
}

/**
 * Joins the clips' pieces into a new recording in place of this one, moves the
 * edits, slides and clicks along with their clips, and opens it again.
 */
async function rebuild({ pieces, moves, clips: list }, done) {
  if (busy || !source) return;
  // The joined recording, beside the one kept to undo this.
  if (!(await roomFor([...new Set(pieces.map((p) => p.blob))].reduce((n, b) => n + b.size, 0)))) return;
  if (busy) return;
  busy = true;
  const runAt = markRunning('join');
  joinAbort = new AbortController();
  player.pause();
  $('#convert').disabled = true;
  $('#convert').classList.add('hidden');
  $('#cancel').disabled = false;
  $('#cancel').classList.remove('hidden');
  $('#progress-wrap').classList.remove('hidden');
  $('#result').classList.add('hidden');
  progress(0, t('clips_joining'));
  try {
    const fps = Math.round(Math.min(60, Math.max(15, Number(meta.fps) || 30)));
    const { blob, lostSound } = await joinPieces(pieces, { fps, signal: joinAbort.signal, onProgress: (f) => progress(f) });
    const e = JSON.parse(JSON.stringify(ed()));
    // What the trim leaves out becomes cuts, so it stays out wherever it moves.
    const { start, end } = trim();
    if (start > 0.05) e.cuts.push({ id: editId(), from: 0, to: start });
    if (end < duration - 0.05) e.cuts.push({ id: editId(), from: end, to: duration });
    const moved = moveTimes({ edits: e, slides: slides.all().map((s) => ({ ...s })), clicks: meta.clicks || [] }, moves);
    const movedPointer = meta.moves?.length ? moveTimes({ clicks: meta.moves }, moves).clicks : null;
    leaving = true;
    // The recording as it was, to undo this (one step; it goes when clips change again).
    const now = trim();
    await putExtras(captureId, {
      undoJoin: {
        blob: source, videoEdits: JSON.parse(JSON.stringify(ed())), slides: slides.all().map((s) => ({ ...s })),
        trim: now.start > 0.05 || now.end < duration - 0.05 ? now : null, clips: clips.all().map(({ id, name, len, trans }) => ({ id, name, len, ...(trans ? { trans } : {}) })),
        clicks: meta.clicks || null, moves: meta.moves || null, duration, at: runAt,
      },
    });
    await replaceBlob(captureId, blob);
    await putExtras(captureId, { videoEdits: moved.edits, slides: moved.slides, trim: null, clips: list });
    await updateMeta(captureId, { duration: list.reduce((n, c) => n + c.len, 0), ...(meta.clicks ? { clicks: moved.clicks } : {}), ...(movedPointer ? { moves: movedPointer } : {}) });
    try { sessionStorage.setItem('captode-clips', lostSound ? 'clips_sound_lost' : done); } catch { /* the note is only a nicety */ }
    location.reload();
  } catch (err) {
    leaving = false;
    markDone();
    if (err?.code !== 'cancelled') {
      console.warn('Captode: joining clips failed:', err);
      toast(t({ unplayable: 'clips_unplayable', unsupported: 'clips_unsupported' }[err?.code] || 'clips_failed'), { kind: 'error', ms: 6000 });
    }
  } finally {
    joinAbort = null;
    if (!leaving) {
      busy = false;
      $('#convert').disabled = false;
      $('#cancel').disabled = true;
      $('#cancel').classList.add('hidden');
      $('#progress-wrap').classList.add('hidden');
      if (result) $('#result').classList.remove('hidden');
      else $('#convert').classList.remove('hidden');
    }
  }
}

const exportStem = async () => fileStem((await getSettings()).fileName, { title: meta.title || 'recording', url: meta.url, when: new Date(created || Date.now()) });

/**
 * Queues an export with the current settings to finish in the background, so it carries
 * on when this page is closed and several can wait their turn.
 */
async function queueCurrent() {
  if (!source) return;
  forgetPicked();
  if (!somethingKept()) return;
  if (!(await checkExport())) return;
  const id = new URLSearchParams(location.search).get('id');
  const button = $('#queue-export');
  button.disabled = true;
  try {
    const name = `${await exportStem()}.${EXT[format]}`;
    await queueExport({ capture: id, name, format, job: jobSpec(plan(), trim()) });
    toast(t('queue_added', name), { kind: 'success' });
    jobs?.refresh();
  } catch (e) {
    toast(t('queue_failed', String(e?.message || e)), { kind: 'error', ms: 5000 });
  } finally {
    button.disabled = false;
  }
}
let jobs = null;

/** The captions as cues in the exported video's time (slides put in included). */
function outputCues() {
  const { start, end } = trim();
  const put = (slides?.all() || []).filter((s) => s.mode !== 'overlay' && s.at >= start - 1e-3 && s.at <= end + 1e-3);
  return captionCues(ed(), clip(), (t) => put.filter((s) => s.at <= t).reduce((n, s) => n + s.duration, 0));
}

/** The captions as a subtitle file for the exported video (SRT or WebVTT). */
async function downloadSubtitles(format) {
  const cues = outputCues();
  if (!cues.length) { toast(t('edit_no_captions')); return; }
  const name = fileStem((await getSettings()).fileName, { title: meta.title || 'recording', url: meta.url, when: new Date(created || Date.now()) });
  save(new Blob([subtitles(cues, format)], { type: format === 'vtt' ? 'text/vtt' : 'application/x-subrip' }), `${name}.${format}`);
}

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

$('#convert').addEventListener('click', convert);
$('#queue-export').addEventListener('click', queueCurrent);
$('#cancel').addEventListener('click', () => {
  cancelled = true;
  abortWorker?.();
  joinAbort?.abort();
});
$('#download').addEventListener('click', () => {
  if (!result) return;
  save(result.blob, result.name);
  toast(t('saved_file_size', [result.name, fmtBytes(result.blob.size)]), { kind: 'success' });
});
$('#redo-export').addEventListener('click', () => stale());
$('#share-result').addEventListener('click', async () => {
  if (!result) return;
  try {
    if (!(await shareFile(result.blob, result.name))) toast(t('share_file_cannot'));
  } catch (e) { toast(t('share_file_failed', String(e?.message || e)), { kind: 'error' }); }
});
window.addEventListener('beforeunload', (e) => { if (busy && !leaving) e.preventDefault(); });

/**
 * Deletes the recording, with its slides, from Captode's storage, after asking. An
 * export under way stops, and the page is replaced by the editor's start page, so
 * nothing of the recording stays in memory either.
 */
async function discard() {
  const id = new URLSearchParams(location.search).get('id');
  if (!source || !id) return;
  if (!(await confirmDialog({ title: t('discard_recording_title'), text: t('discard_text'), confirm: t('discard_confirm') }))) return;
  cancelled = true;
  abortWorker?.();
  busy = false; // leaving doesn't ask
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
    const src = demuxWebm(await source.arrayBuffer(), { views: true });
    const v = src.video;
    const colour = v && sourceColourSpace(v);
    if (!colour || !['V_VP9', 'V_VP8'].includes(v.codecId)) return source;
    const audio = src.audio?.codecId === 'A_OPUS'
      ? { ...src.audio, frames: src.audio.frames.map((f) => ({ ...f, key: true })) }
      : null;
    if (src.audio && !audio) return source; // a sound format the writer doesn't know
    return muxWebm({
      video: { codecId: v.codecId, width: v.width || player.videoWidth, height: v.height || player.videoHeight, frames: v.frames, colour: outputColour(colour) },
      audio,
    });
  } catch {
    return source;
  }
}
$('#dl-original').addEventListener('click', async () => {
  if (source) save(await taggedOriginal(), `captode-recording-${Date.now()}.webm`);
});

// ---------- review a frame ----------

// Measuring and colour picking on the paused frame, drawn on a layer over the player.
const rv = { tool: 'off', frame: null, measures: [], drag: null, colours: [null, null], slot: 0 };
const rvRatio = () => ($('#rv-ratio').value === 'auto' ? meta.dpr || 1 : Number($('#rv-ratio').value));

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
  const auto = meta.dpr ? `${Math.round(meta.dpr * 100) / 100}×` : '1×';
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
  return (slides?.all() || []).filter((s) => s.mode !== 'overlay' && s.at >= start - 1e-3 && s.at <= end + 1e-3 && s.at <= t);
}
/** When recording time t shows in the export (s): the parts kept before it, and the slides put in. */
const outputTime = (t) => clip().outOf(t) + slidesBefore(t).reduce((n, s) => n + s.duration, 0);
/** How long the export is (s). */
const outputLength = () => clip().length + slidesBefore(Infinity).reduce((n, s) => n + s.duration, 0);
/** Whether someone is heard at recording time t (from the sound's levels), to lower the music. */
function speakingAt(t) {
  if (!levels) return false;
  const v = levels.rms[Math.floor(t / levels.step)] || 0;
  return v > 0.02;
}

// ---------- music ----------

const music = mountMusic({
  ed, editor: () => editor, files: () => layerFiles, player, busy: () => busy,
  hasRoom: (bytes) => roomFor(bytes),
  addFile: async (src, blob) => { layerFiles = { ...layerFiles, [src]: blob }; await putExtras(captureId, { layerSources: layerFiles }); },
  run: (label, fn) => runWithProgress(label, fn), outputTime, outputLength, speakingAt, fmtTime,
});

// ---------- chapters ----------

const chapters = mountChapters({
  ed, editor: () => editor, clip, player, duration: () => duration, busy: () => busy,
  outputTime, outputLength, fmtTime, save: (...a) => save(...a), exportStem: () => exportStem(),
});

// ---------- timeline zoom ----------

const zoom = mountTimelineZoom({ player, duration: () => duration });

// ---------- removing cut parts for good ----------

function syncApplyCuts() {
  $('#ed-apply-cuts').classList.toggle('hidden', !ed().cuts.length);
}
$('#ed-apply-cuts').addEventListener('click', async () => {
  if (busy || !source || !ed().cuts.length) return;
  if (!(await confirmDialog({ title: t('edit_apply_cuts_title'), text: t('edit_apply_cuts_text'), confirm: t('edit_apply_cuts'), danger: false }))) return;
  const D = duration;
  const cuts = ed().cuts.map((c) => [Math.max(0, c.from), Math.min(D, c.to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const kept = [];
  let at = 0;
  for (const [a, b] of cuts) { if (a > at + 0.02) kept.push([at, a]); at = Math.max(at, b); }
  if (D > at + 0.02) kept.push([at, D]);
  if (!kept.length) { toast(t('video_all_cut'), { kind: 'error' }); return; }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  let out = 0;
  const moves = kept.map(([a, b], i) => { const m = { from: a, to: i === kept.length - 1 ? Math.max(b, D) : b, at: out }; out += b - a; return m; });
  const pieces = kept.map(([a, b]) => ({ blob: source, from: r3(a), len: r3(b - a) }));
  // Each clip keeps what is left of it.
  const list = clips.all();
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
  const comp = hasSpatial(e) || useLogo() ? composer(e, map, player.videoWidth, player.videoHeight, meta.clicks, useLogo(), meta.moves) : null;
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
  if (busy || !slides || !player.videoWidth) return;
  player.pause();
  const p = plan();
  const frame = await composedFrame(p.width, p.height);
  slides.addFreeze(player.currentTime, await frame.convertToBlob({ type: 'image/png' }), 2);
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
  if (!kind || busy || !editor) return;
  await setFormat('mp4');
  const shape = { youtube: '16:9', shorts: '9:16', square: '1:1' }[kind];
  const bg = ed().background;
  const [w, h] = contentSize();
  const natural = Math.abs(w / h - { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }[shape]) < 0.02;
  // A background frames the picture in the platform's shape, unless it has it already.
  if (!natural) editor.setBackground({ on: true, aspect: shape });
  else if (bg.on && bg.aspect !== 'auto' && bg.aspect !== shape) editor.setBackground({ aspect: shape });
  // Upright and small: closer in where things happen.
  if (kind === 'shorts' && meta.clicks?.length && !ed().zooms.some((z) => z.auto)) editor.zoomOnClicks();
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
  if (!kind || busy || !editor) return;
  if (kind === 'bug') {
    await setFormat('gif');
    if (meta.clicks?.length) editor.setRings(true);
  } else if (kind === 'tutorial') {
    await setFormat('mp4');
    fillResolutions();
    pickRes(1080);
    if (!slides.all().length) slides.bookends();
    if (!ed().chapters.length) editor.setChapters([{ id: `h${Date.now().toString(36)}`, at: Math.round(trim().start * 1000) / 1000, title: t('template_chapter') }]);
    editor.setCaptionStyle({ embed: true });
  } else {
    $('#quick [data-quick="shorts"]').click();
    await new Promise((r) => setTimeout(r, 50));
    editor.setCaptionStyle({ place: 'middle', highlight: true, burn: true });
  }
  document.querySelector('.inspector').dispatchEvent(new Event('change'));
  syncUi();
  toast(t(`template_${kind}_done`), { kind: 'success', ms: 7000 });
});

// ---------- filler words ----------

const fillers = mountFillers({
  captions: () => ed().captions, source: () => source, fmtTime,
  cut: (cuts, words) => editor?.cutFillers(cuts, words),
});

// ---------- several exports at once ----------

/** Queues several files from these edits: other formats, and upright or square copies. */
async function exportSeveral() {
  if (busy || !source || !editor) return;
  forgetPicked();
  if (!somethingKept()) return;
  const choices = [['mp4', 'MP4'], ['webm', 'WebM'], ['gif', 'GIF'], ['webp', 'WebP'], ['upright', t('several_upright')], ['square', t('several_square')]];
  const d = document.createElement('dialog');
  d.className = 'modal confirm';
  d.setAttribute('aria-labelledby', 'several-h');
  d.innerHTML = `<div class="modal-body"><h2 id="several-h"></h2><p class="muted small"></p><div class="several"></div>
    <div class="confirm-actions"><button type="button" class="btn" data-close></button><button type="button" class="btn primary" data-go></button></div></div>`;
  d.querySelector('h2').textContent = t('several_title');
  d.querySelector('p').textContent = t('several_hint');
  d.querySelector('[data-close]').textContent = t('settings_cancel');
  d.querySelector('[data-go]').textContent = t('several_go');
  const list = d.querySelector('.several');
  for (const [v, name] of choices) {
    const row = document.createElement('label');
    row.className = 'toggle';
    row.innerHTML = `<span></span><input type="checkbox" value="${v}" ${v === format || v === 'upright' ? 'checked' : ''}>`;
    row.querySelector('span').textContent = name;
    list.append(row);
  }
  document.body.append(d);
  const picked = await new Promise((resolve) => {
    d.querySelector('[data-go]').addEventListener('click', () => { resolve([...list.querySelectorAll('input:checked')].map((i) => i.value)); d.close(); });
    d.addEventListener('close', () => { resolve(null); d.remove(); });
    openDialog(d);
  });
  if (!picked?.length || busy) return;
  const was = format, stem = await exportStem();
  let n = 0;
  try {
    for (const v of picked) {
      const shape = { upright: '9:16', square: '1:1' }[v];
      await setFormat(shape ? 'mp4' : v);
      const job = jobSpec(plan(), trim());
      if (shape) {
        // The same edits framed in that shape, at most 1080 on the short side.
        const [cw, ch] = contentSize();
        const bg = { ...ed().background, on: true, aspect: shape };
        const r = backgroundRenderer(bg, cw, ch);
        const k = Math.min(1, 1080 / Math.min(r.width, r.height));
        Object.assign(job, { width: even(r.width * k), height: even(r.height * k), device: null });
        job.edits.background = bg;
      }
      await queueExport({ capture: captureId, name: `${stem}${shape ? `-${shape.replace(':', 'x')}` : ''}.${EXT[job.format]}`, format: job.format, job });
      n++;
    }
    toast(t('several_queued', String(n)), { kind: 'success' });
  } catch (e) {
    toast(t('queue_failed', String(e?.message || e)), { kind: 'error', ms: 5000 });
  } finally {
    await setFormat(was);
    syncUi();
    jobs?.refresh();
  }
}
$('#export-several').addEventListener('click', exportSeveral);

// ---------- reviewing captions ----------

const review = mountCaptionReview({
  captions: () => ed().captions, setCaption: (id, patch, quiet) => editor?.setCaption(id, patch, quiet),
  source: () => source, fmtTime, seek: (at) => { player.currentTime = Math.max(0, Math.min(duration, at)); },
});

// ---------- thumbnail ----------

mountThumbnail({
  player, busy: () => busy, plan: () => plan(), frame: (w, h) => composedFrame(w, h),
  title: () => meta.title || '', save: (...a) => save(...a), exportStem: () => exportStem(),
});

// ---------- storage ----------

function renderStorage() {
  const files = Object.values(layerFiles).reduce((n, b) => n + (b?.size || 0), 0);
  const undo = undoData?.blob?.size || 0;
  const all = (source?.size || 0) + files + undo;
  $('#clip-storage').textContent = all ? t('clips_storage', [fmtBytes(all), undo ? t('clips_storage_undo', fmtBytes(undo)) : '']).trim() : '';
  $('#clip-forget').classList.toggle('hidden', !undo);
}
$('#clip-forget').addEventListener('click', async () => {
  if (busy || !undoData) return;
  const freed = undoData.blob?.size || 0;
  undoData = null;
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
    || slides?.all().length || clips?.all().length > 1 || device?.get()?.enabled);
}
/** In Simple, a tool in use (added with its key, say, or from before) shows all the tools, so nothing is hidden. */
function showUsedTools(quiet = false) {
  if (uiMode !== 'simple' || !editor || !usesAdvanced()) return;
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

/** Says so where a feature isn't offered by this browser, instead of leaving it out silently. */
function noteMissing() {
  if (meta.hasAudio && !$('#ed-speech') && !$('#speech-note')) {
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
  source = rec.blob;
  meta = rec.meta || {};
  created = rec.created;
  showReview();
  srcUrl = URL.createObjectURL(source);
  player.src = srcUrl;
  duration = await loadDuration(player);
  $('#t-end').value = duration.toFixed(1);
  $('#t-start').max = $('#t-end').max = duration.toFixed(1);
  // The part kept when it was last open.
  const kept = rec.trim;
  if (kept && kept.start >= 0 && kept.end > kept.start + 0.05 && kept.start < duration) {
    $('#t-start').value = kept.start.toFixed(1);
    $('#t-end').value = Math.min(duration, kept.end).toFixed(1);
  }
  savedTrim = trimKey();
  $('#info').textContent = `${player.videoWidth} × ${player.videoHeight} · ${fmtTime(duration)} · ${fmtBytes(source.size)}`;
  if (meta.title) { $('#doc-name').textContent = meta.title; document.title = `${meta.title} — Captode`; }
  $('#make-guide').classList.toggle('hidden', !meta.clicks?.length);
  brand = await getBrand();
  logoArt = await loadLogo(brand);
  $('#v-logo-row').classList.toggle('hidden', !logoArt);
  $('#v-logo').checked = !!logoArt && brand.videos;
  if (canQueueExports) {
    $('#queue-export').classList.remove('hidden');
    $('#export-several').classList.remove('hidden');
    jobs = mountJobs($('#queue-list'), { capture: id, onEmpty: (empty) => $('#queue-list').classList.toggle('hidden', empty) });
  }
  mountCaptureTools({
    keep: $('#keep'),
    project: $('#save-project'),
    id: () => id,
    // Edits and slides are saved as they change, so the project has them already.
    stem: async () => fileStem((await getSettings()).fileName, { title: meta.title || 'recording', url: meta.url, when: new Date(created || Date.now()) }),
  }).sync();
  // A recording not edited yet starts with the background and sound chosen for new
  // recordings (if they were chosen before it was made).
  layerFiles = rec.layerSources && typeof rec.layerSources === 'object' ? { ...rec.layerSources } : {};
  let edits = rec.videoEdits;
  if (!edits) {
    const d = (await chrome.storage.local.get('videoDefaults')).videoDefaults || {};
    const e = {};
    if (d.background && created >= d.background.at) e.background = d.background.value;
    if (d.audio && created >= d.audio.at) e.audio = { ...d.audio.value, mutes: [] };
    if (Object.keys(e).length) edits = normaliseEdits(e);
  }
  editor = mountEdits({
    player,
    edits,
    meta,
    levels: () => levels,
    saveDefault: async (part, value) => {
      const d = (await chrome.storage.local.get('videoDefaults')).videoDefaults || {};
      d[part] = { at: Date.now(), value };
      await chrome.storage.local.set({ videoDefaults: d });
    },
    duration: () => duration,
    trim,
    takePicked,
    fmtTime,
    changed: () => { fx = null; fillResolutions(); syncUi(); slides?.redraw(); music.render(); chapters.render(); syncApplyCuts(); showUsedTools(); },
    save: (e) => { if (!leaving) saveVideoEdits(id, e).catch(() => {}); },
    busy: () => busy,
    seek: (at) => { player.currentTime = Math.max(0, Math.min(duration, at)); },
    downloadSubtitles,
    cues: () => outputCues(),
    reviewCaptions: () => review.open(),
    findFillers: () => fillers.open(),
    addLayer: () => {
      const c = $('#clips-section');
      c.open = true;
      clips.mode('top');
      c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  });
  slides = mountSlides({
    player,
    slides: rec.slides,
    duration: () => duration,
    trim,
    clip,
    size: () => { const p = plan(); return [p.width, p.height]; },
    fmtTime,
    changed: syncUi,
    save: (list) => { if (!leaving) saveSlides(id, list).catch(() => {}); },
    busy: () => busy,
    title: () => meta.title || '',
    look: () => ({ captionStyle: { ...ed().captionStyle }, background: { ...ed().background } }),
    setLook: (look) => editor?.setLook(look),
  });
  undoData = rec.undoJoin?.blob ? rec.undoJoin : null;
  clips = mountClips({
    id,
    addLayer,
    addImage,
    save: (list) => putExtras(id, { clips: list }).catch(() => {}),
    canUndo: () => !!undoData,
    undo: undoJoin,
    clips: rec.clips,
    name: meta.title || t('clips_recording'),
    duration: () => duration,
    source: () => source,
    fmtTime,
    busy: () => busy,
    seek: (at) => { player.currentTime = Math.max(0, Math.min(duration, at)); },
    now: () => player.currentTime,
    rebuild,
  });
  music.render();
  chapters.render();
  syncApplyCuts();
  renderStorage();
  zoom.apply();
  // Captions from what is said (where the browser can, on the device).
  speech = mountSpeech({
    source: () => source,
    hasAudio: () => !!meta.hasAudio,
    levels: () => levels,
    range: trim,
    kept: () => clip().parts.filter((p) => p.rate === 1).map((p) => ({ from: p.from, to: p.to })),
    busy: () => busy,
    run: runWithProgress,
    addCaptions: (list) => { $('#edit-section').open = true; editor.addCaptions(list); },
  });
  noteMissing();
  showUsedTools(true);
  mountVoiceover({
    player, busy: () => busy, setBusy: (on) => { busy = on; }, editor: () => editor, map: clip, trim,
    run: runWithProgress, hasRoom: (bytes) => roomFor(bytes),
    addFile: async (src, blob) => { layerFiles = { ...layerFiles, [src]: blob }; await putExtras(captureId, { layerSources: layerFiles }); },
  });
  if (!tourSeen()) setTimeout(() => { if (!busy && !document.querySelector('dialog[open]')) startTour(tourSteps()); }, 800);
  // The files of layers no longer in the edits (removed last time) go.
  const usedFiles = new Set([...editor.get().layers.map((l) => l.src), editor.get().music?.src].filter(Boolean));
  if (Object.keys(layerFiles).some((k) => !usedFiles.has(k))) {
    layerFiles = Object.fromEntries(Object.entries(layerFiles).filter(([k]) => usedFiles.has(k)));
    putExtras(id, { layerSources: layerFiles }).catch(() => {});
  }
  try {
    const note = sessionStorage.getItem('captode-clips');
    if (note) {
      sessionStorage.removeItem('captode-clips');
      $('#clips-section').open = true;
      const undoable = undoData && note !== 'clips_undone';
      toast(t(note), {
        kind: note === 'clips_sound_lost' ? 'info' : 'success', ms: note === 'clips_sound_lost' || undoable ? 8000 : 2600,
        action: undoable ? { label: t('editor_undo'), run: undoJoin } : null,
      });
    }
    // Cut short last time (the tab closed, the browser crashed): offered again.
    const short = cutShort();
    // A join is put back only with the copy kept by that join itself.
    if (short?.kind === 'export') toast(t('recover_export'), { ms: 12000, action: { label: t('recover_export_go'), run: convert } });
    else if (short?.kind === 'join' && !note && undoData?.at === short.at) toast(t('recover_join'), { ms: 12000, action: { label: t('recover_join_go'), run: undoJoin } });
  } catch { /* storage blocked */ }
  if ((await chrome.storage.local.get('device')).device) $('#device-section').open = true;
  device = await mountDevicePanel($('#device-panel'), () => { fillResolutions(); syncUi(); slides.redraw(); }, {
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
  slides.redraw(); // in the device frame's shape, if it is on
  // The default format from Settings, or the one used last; and the options used last.
  const last = await recall('video');
  const wanted = (await getSettings()).videoFormat;
  format = (wanted === 'last' ? last.format : wanted) || 'mp4';
  if (!document.querySelector(`#formats [data-f="${format}"]`)) format = 'mp4';
  fillResolutions(true);
  fillFps(true);
  const CONTROLS = ['v-quality', 'g-colors', 'g-dither', 'g-lossy', 'w-quality', 'w-lossless', 'optimize'];
  rememberControls('video', CONTROLS, last.controls);
  mountPresets($('#presets'), {
    kind: 'video',
    watch: document.querySelector('.inspector'),
    capture: () => {
      const d = device.get();
      return {
        format,
        controls: Object.fromEntries([...CONTROLS, 'res', 'fps'].map((id) => [id, $('#' + id).type === 'checkbox' ? $('#' + id).checked : $('#' + id).value])),
        device: { enabled: d.enabled, device: d.device, size: d.size, orientation: d.orientation, fit: d.fit, frame: d.frame, statusBar: d.statusBar },
      };
    },
    apply: async (p) => {
      if (p.device) {
        device.set(p.device);
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
      remember('video', { controls: { [format]: { res: $('#res').value, fps: $('#fps').value } } });
      syncUi();
    },
  });
  // Resolution and frame rate are per format (GIF defaults smaller and slower).
  const perFormat = last.controls?.[format] || {};
  for (const id of ['res', 'fps']) if ([...$('#' + id).options].some((o) => o.value === perFormat[id])) $('#' + id).value = perFormat[id];
  for (const id of ['res', 'fps']) $('#' + id).addEventListener('change', () => remember('video', { controls: { [format]: { res: $('#res').value, fps: $('#fps').value } } }));
  syncUi();
  editor.ready();
  if (edits && !rec.videoEdits) saveVideoEdits(id, editor.get()).catch(() => {});
  globalThis.captodeEdits = editor; // for the automated tests
  globalThis.captodePreview = { gain: () => (preview ? preview.gain.gain.value : null), levels: () => levels };
  enhance();
  buildFilmstrip();
  if (meta.hasAudio) {
    audioLevels(source).then((l) => {
      levels = l;
      drawWave();
      editor.soundReady();
      speech.sync();
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
  const title = `${meta.title || t('video_recording')} · ${fmtTime(player.currentTime)}`;
  const id = await putCapture(blob, { title, url: meta.url, mode: 'frame', dpr: meta.dpr });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${id}&reopen=1`) });
}
$('#frame-to-editor').addEventListener('click', frameToEditor);
// Keyboard focus and scrolling keep panel controls clear of the export bar over them.
new ResizeObserver(([e]) => $('.inspector')?.style.setProperty('--export-bar', `${Math.ceil(e.target.offsetHeight) + 8}px`)).observe($('.export-bar'));
$('#make-guide').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL(`guide/guide.html?id=${new URLSearchParams(location.search).get('id')}`) }));
