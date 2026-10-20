import { getCapture, putCapture } from '../lib/db.js';
import { GifEncoder } from '../lib/gif.js';
import { buildPalette } from '../lib/quantize.js';
import { getSettings } from '../lib/settings.js';
import { fileStem } from '../lib/filename.js';
import { recall, remember, rememberControls } from '../lib/remember.js';
import { mountPresets } from '../lib/presets.js';
import { WebpAnimEncoder } from '../lib/webp.js';
import { mountDevicePanel, deviceRenderer, frameDrawer } from '../lib/device.js';
import { toast, enhance, fmtBytes } from '../lib/ui.js';
import { demuxWebm, muxWebm } from '../lib/webm.js';
import { sourceColourSpace, outputColour } from '../lib/video-colour.js';
import { contrastHtml, hexOf, measureLabel, measureText, edgeNear, measureFrom, drawMeasures } from '../lib/review.js';
import { t, localize } from '../lib/i18n.js';

localize();

const $ = (s) => document.querySelector(s);
const player = $('#player');

let source = null;   // the recorded Blob
let meta = {};
let created = 0; // when the recording was made, for file names
let srcUrl = '';
let duration = 0;
let format = 'mp4';
let device = null;
let result = null;   // { blob, name }
let cancelled = false;
let busy = false;

const RES = [2160, 1440, 1080, 720, 480, 360, 240];
const FPS = [5, 8, 10, 12, 15, 20, 24, 25, 30, 50, 60];
const EXT = { mp4: 'mp4', webm: 'webm', gif: 'gif', webp: 'webp' };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));
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

/** Output size and the device renderer (if device mode is on) for the current settings. */
function plan() {
  const w = player.videoWidth;
  const h = player.videoHeight;
  const d = device?.get();
  const renderer = d?.enabled ? deviceRenderer(d, w, h) : null;
  const bw = renderer ? renderer.width : w;
  const bh = renderer ? renderer.height : h;
  const p = Number($('#res').value) || 0;
  const s = p ? Math.min(1, p / Math.min(bw, bh)) : 1;
  return { renderer, width: even(bw * s), height: even(bh * s), fps: Number($('#fps').value) };
}

function fillResolutions(reset = false) {
  device?.refresh();
  const d = device?.get();
  const w = player.videoWidth, h = player.videoHeight;
  const r = d?.enabled ? deviceRenderer(d, w, h) : { width: w, height: h };
  const short = Math.min(r.width, r.height);
  const keep = reset ? '' : $('#res').value;
  const def = format === 'gif' || format === 'webp' ? 480 : 0;
  $('#res').innerHTML = `<option value="0" title="${even(r.width)} × ${even(r.height)}">${t('res_original', `${even(short)}p`)}</option>` +
    RES.filter((p) => p < short).map((p) => `<option value="${p}">${p}p</option>`).join('');
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
  $('#g-lossy-v').textContent = Number($('#g-lossy').value) ? $('#g-lossy').value : t('video_off');
  $('#v-audio').disabled = !meta.hasAudio;
  $('#v-audio-note').classList.toggle('hidden', Boolean(meta.hasAudio));
  if (!meta.hasAudio) $('#v-audio').checked = false;
  drawTimeline();
  if (!player.videoWidth) return;
  const p = plan();
  const { start, end } = trim();
  const frames = Math.max(1, Math.round((end - start) * p.fps));
  $('#dims').innerHTML = `<span>${t('video_dims', [`${p.width} × ${p.height}`, p.fps, frames])}</span><b>${(end - start).toFixed(1)} s</b>`;
  // MP4 and WebM are encoded at a variable bitrate below this ceiling, so it is an
  // upper limit; screen recordings, mostly still, usually come out well under it.
  // GIF and WebP depend too much on the picture to guess.
  if (format === 'mp4' || format === 'webm') {
    const bitrate = Math.min(40e6, Math.max(300e3, p.width * p.height * p.fps * Number($('#v-quality').value)));
    const audio = $('#v-audio').checked && meta.hasAudio ? 128e3 : 0;
    $('#convert-size').textContent = t('video_size_up_to', fmtBytes(Math.round(((bitrate + audio) * (end - start)) / 8)));
  } else {
    $('#convert-size').textContent = '';
  }
  stale();
}

function stale() {
  if (busy) return;
  result = null;
  $('#result').classList.add('hidden');
  $('#download').classList.add('hidden');
  $('#redo-export').classList.add('hidden');
  $('#convert').classList.remove('hidden');
  showPreview('player');
}

const PREVIEW_LABELS = { live: t('preview_converting'), 'out-img': t('preview_exported'), 'out-video': t('preview_exported') };

function showPreview(which) {
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
const setStart = (t) => { if (busy) return; $('#t-start').value = Math.max(0, Math.min(t, trim().end - 0.1)).toFixed(1); syncUi(); };
const setEnd = (t) => { if (busy) return; $('#t-end').value = Math.min(duration, Math.max(t, trim().start + 0.1)).toFixed(1); syncUi(); };
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
  $('#tc-len').textContent = t('trim_selected', (end - start).toFixed(1));
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
  let selecting = false;
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
      syncUi();
      player.currentTime = at;
    }
    drawPlayhead();
  };
  if (handle || scrub) move(e);
  const up = (ev) => {
    if (!handle && !scrub && !selecting) { player.currentTime = timeAt(ev); drawPlayhead(); }
    $('#track').classList.remove('dragging');
    $('#track').removeEventListener('pointermove', move);
    $('#track').removeEventListener('pointerup', up);
  };
  $('#track').addEventListener('pointermove', move);
  $('#track').addEventListener('pointerup', up);
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
  if (player.paused) {
    const { start, end } = trim();
    if (player.currentTime < start || player.currentTime >= end - 0.05) player.currentTime = start;
    player.play();
  } else {
    player.pause();
  }
}
$('#play').addEventListener('click', togglePlay);
player.addEventListener('click', togglePlay);
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
(function tick() { if (!player.paused) drawPlayhead(); requestAnimationFrame(tick); })();

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === ' ' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
  else if (k === 'i') setStart(player.currentTime);
  else if (k === 'o') setEnd(player.currentTime);
  else if (k === 'f') frameToEditor();
  else if (k === 'arrowleft' && !e.target.closest('.handle')) { player.currentTime = Math.max(0, player.currentTime - (e.shiftKey ? 1 : 1 / (meta.fps || 30))); }
  else if (k === 'arrowright' && !e.target.closest('.handle')) { player.currentTime = Math.min(duration, player.currentTime + (e.shiftKey ? 1 : 1 / (meta.fps || 30))); }
});

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
  v.remove();
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

/** GIF and WebP: step through the clip frame by frame. */
async function convertFrames(p, { start, end }) {
  const v = makeWorkVideo();
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
    const step = 1 / p.fps;
    const count = Math.max(1, Math.round((end - start) * p.fps));
    const at = (i) => Math.min(start + i * step, Math.max(start, end - 0.001));

    // GIF: one palette for the whole clip, from frames sampled across it, so colours
    // stay steady from frame to frame.
    let palette = null;
    if (format === 'gif') {
      const samples = Math.min(count, 16);
      const parts = [];
      for (let k = 0; k < samples; k++) {
        if (cancelled) throw new Error('cancelled');
        await seek(v, at(Math.floor(((k + 0.5) * count) / samples)));
        ctx.clearRect(0, 0, p.width, p.height);
        draw(ctx, v);
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

    for (let i = 0; i < count; i++) {
      if (cancelled) throw new Error('cancelled');
      await seek(v, at(i));
      ctx.clearRect(0, 0, p.width, p.height);
      draw(ctx, v);
      if (format === 'gif') enc.addFrame(ctx.getImageData(0, 0, p.width, p.height).data, 1000 / p.fps);
      else await enc.addFrame(c, 1000 / p.fps);
      if (i % 3 === 0) {
        lctx.clearRect(0, 0, p.width, p.height);
        lctx.drawImage(c, 0, 0);
      }
      progress((i + 1) / count, t('export_frame', [i + 1, count]));
      if (i % 4 === 0) await new Promise((r) => setTimeout(r));
    }
    progress(1, t('export_finishing'));
    return enc.finish();
  } finally {
    v.remove();
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
  const withAudio = $('#v-audio').checked && meta.hasAudio;
  const mimeType = pickMime(format, withAudio, p.width, p.height);
  if (!mimeType) {
    throw new Error(format === 'mp4'
      ? t('no_mp4')
      : t('no_webm'));
  }
  const v = makeWorkVideo();
  const live = $('#live');
  live.width = p.width;
  live.height = p.height;
  const ctx = live.getContext('2d');
  const draw = drawer(p, true);
  showPreview('live');

  let audioCtx = null;
  try {
    await loadDuration(v);
    const stream = live.captureStream(p.fps);
    if (withAudio) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaElementSource(v).connect(dest); // not to the speakers
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    } else {
      v.muted = true;
    }
    const bitrate = Math.round(Math.min(40e6, Math.max(300e3, p.width * p.height * p.fps * Number($('#v-quality').value))));
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    await seek(v, start);
    draw(ctx, v);
    const stopped = once(rec, 'stop');
    rec.start(1000);
    await v.play();

    await new Promise((resolve) => {
      const finish = () => { v.pause(); resolve(); };
      v.addEventListener('ended', finish, { once: true });
      const tick = (_now, md) => {
        const at = md?.mediaTime ?? v.currentTime;
        draw(ctx, v);
        progress((at - start) / (end - start), t('export_realtime', [fmtTime(Math.max(0, at - start)), fmtTime(end - start)]));
        if (cancelled || at >= end - 0.5 / p.fps) finish();
        else v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    });
    rec.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    if (cancelled) throw new Error('cancelled');
    progress(1, t('export_done'));
    return new Blob(chunks, { type: mimeType.split(';')[0] });
  } finally {
    audioCtx?.close();
    v.remove();
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
function convertInWorker(p, { start, end }) {
  const live = $('#live');
  live.width = p.width;
  live.height = p.height;
  const lctx = live.getContext('2d');
  showPreview('live');
  const d = device?.get();
  const job = {
    blob: source, format, width: p.width, height: p.height, fps: p.fps, start, end,
    device: d?.enabled ? { ...d } : null,
    video: { bitsPerPixel: Number($('#v-quality').value), audio: $('#v-audio').checked && !!meta.hasAudio },
    gif: { colors: Number($('#g-colors').value), dither: $('#g-dither').checked, lossy: Number($('#g-lossy').value) },
    webp: { quality: Number($('#w-quality').value) / 100, lossless: $('#w-lossless').checked },
    optimize: $('#optimize').checked,
    tolerance: $('#denoise').checked ? undefined : 0,
    loop: $('#loop').checked ? 0 : 1,
  };
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

async function convert() {
  if (busy || !source) return;
  busy = true;
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
    const name = fileStem((await getSettings()).fileName, { title: meta.title || 'recording', url: meta.url, when: new Date(created || Date.now()) });
    result = { blob, name: `${name}.${EXT[format]}` };

    const url = URL.createObjectURL(blob);
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
    $('#redo-export').classList.remove('hidden');
    $('#download').focus();
  } catch (e) {
    if (e.message !== 'cancelled') { $('#status').textContent = t('export_failed', e.message); toast(t('export_failed', e.message), { kind: 'error', ms: 5000 }); }
    else $('#progress-wrap').classList.add('hidden');
    showPreview('player');
  } finally {
    busy = false;
    $('#convert').disabled = false;
    $('#cancel').disabled = true;
    $('#cancel').classList.add('hidden');
    if (!result) $('#convert').classList.remove('hidden');
    if (result) $('#progress-wrap').classList.add('hidden');
  }
}

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

$('#convert').addEventListener('click', convert);
$('#cancel').addEventListener('click', () => {
  cancelled = true;
  abortWorker?.();
});
$('#download').addEventListener('click', () => {
  if (!result) return;
  save(result.blob, result.name);
  toast(t('saved_file_size', [result.name, fmtBytes(result.blob.size)]), { kind: 'success' });
});
$('#redo-export').addEventListener('click', () => stale());
window.addEventListener('beforeunload', (e) => { if (busy) e.preventDefault(); });
/**
 * The recording as it was captured, with its colours written into the file (Chrome
 * leaves them out, so players other than Chrome's may guess them wrong). The video
 * and sound are copied as they are; if anything about the file is unexpected, the
 * original is saved untouched.
 */
async function taggedOriginal() {
  try {
    const src = demuxWebm(await source.arrayBuffer());
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

// ---------- start ----------

(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const rec = id ? await getCapture(id) : null;
  if (!rec) {
    document.querySelector('.preview').classList.add('hidden');
    $('#timeline').classList.add('hidden');
    $('#empty').classList.remove('hidden');
    $('#convert').disabled = true;
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
  $('#info').textContent = `${player.videoWidth} × ${player.videoHeight} · ${fmtTime(duration)} · ${fmtBytes(source.size)}`;
  if (meta.title) { $('#doc-name').textContent = meta.title; document.title = `${meta.title} — Captode`; }
  if ((await chrome.storage.local.get('device')).device) $('#device-section').open = true;
  device = await mountDevicePanel($('#device-panel'), () => { fillResolutions(); syncUi(); }, {
    source: () => (player.videoWidth ? [player.videoWidth, player.videoHeight] : null),
    // The frame showing in the player.
    picture: async (width) => {
      if (!player.videoWidth) return null;
      const s = Math.min(1, width / player.videoWidth);
      const c = new OffscreenCanvas(Math.round(player.videoWidth * s), Math.round(player.videoHeight * s));
      c.getContext('2d').drawImage(player, 0, 0, c.width, c.height);
      return c;
    },
  });
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
  enhance();
  buildFilmstrip();
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
