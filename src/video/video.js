import { getCapture } from '../lib/db.js';
import { GifEncoder } from '../lib/gif.js';
import { buildPalette } from '../lib/quantize.js';
import { getSettings } from '../lib/settings.js';
import { WebpAnimEncoder } from '../lib/webp.js';
import { mountDevicePanel, deviceRenderer } from '../lib/device.js';
import { toast, enhance, fmtBytes } from '../lib/ui.js';

const $ = (s) => document.querySelector(s);
const player = $('#player');

let source = null;   // the recorded Blob
let meta = {};
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
  const d = device?.get();
  const w = player.videoWidth, h = player.videoHeight;
  const r = d?.enabled ? deviceRenderer(d, w, h) : { width: w, height: h };
  const short = Math.min(r.width, r.height);
  const keep = reset ? '' : $('#res').value;
  const def = format === 'gif' || format === 'webp' ? 480 : 0;
  $('#res').innerHTML = `<option value="0" title="${even(r.width)} × ${even(r.height)}">Original (${even(short)}p)</option>` +
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
  $('#convert').textContent = `Export ${format.toUpperCase()}`;
  for (const el of document.querySelectorAll('[data-for]')) el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(format));
  $('#w-quality-f').classList.toggle('hidden', $('#w-lossless').checked);
  $('#w-quality-v').textContent = $('#w-quality').value + '%';
  $('#v-audio').disabled = !meta.hasAudio;
  $('#v-audio-note').classList.toggle('hidden', Boolean(meta.hasAudio));
  if (!meta.hasAudio) $('#v-audio').checked = false;
  drawTimeline();
  if (!player.videoWidth) return;
  const p = plan();
  const { start, end } = trim();
  const frames = Math.max(1, Math.round((end - start) * p.fps));
  $('#dims').innerHTML = `<span>${p.width} × ${p.height} · ${p.fps} fps · ${frames} frames</span><b>${(end - start).toFixed(1)} s</b>`;
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

const PREVIEW_LABELS = { live: 'Converting…', 'out-img': 'Exported', 'out-video': 'Exported' };

function showPreview(which) {
  for (const id of ['player', 'live', 'out-img', 'out-video']) $('#' + id).classList.toggle('hidden', id !== which);
  $('#preview-label').textContent = PREVIEW_LABELS[which] || '';
  $('#preview-label').classList.toggle('hidden', !PREVIEW_LABELS[which]);
  $('#timeline').classList.toggle('hidden', which !== 'player');
}

$('#formats').addEventListener('click', (e) => {
  const f = e.target.closest('button')?.dataset.f;
  if (!f || busy) return;
  format = f;
  fillResolutions(true);
  fillFps(true);
  syncUi();
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
  $('#tc-len').textContent = `${(end - start).toFixed(1)} s selected`;
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

$('#track').addEventListener('pointerdown', (e) => {
  if (!duration) return;
  const handle = e.target.closest('.handle');
  $('#track').setPointerCapture(e.pointerId);
  const move = (ev) => {
    const t = timeAt(ev);
    if (handle?.id === 'h-start') { setStart(t); player.currentTime = trim().start; }
    else if (handle?.id === 'h-end') { setEnd(t); player.currentTime = trim().end; }
    else player.currentTime = t;
    drawPlayhead();
  };
  move(e);
  const up = () => { $('#track').removeEventListener('pointermove', move); $('#track').removeEventListener('pointerup', up); };
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
function drawer(p, opaque = false) {
  return (ctx, v) => {
    if (p.renderer) {
      ctx.save();
      ctx.scale(p.width / p.renderer.width, p.height / p.renderer.height);
      p.renderer.render(ctx, v);
      ctx.restore();
      if (opaque && p.renderer.transparent) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over'; // paint behind the frame
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, p.width, p.height);
        ctx.restore();
      }
    } else {
      ctx.drawImage(v, 0, 0, p.width, p.height);
    }
  };
}

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
        progress(0, 'Choosing colours…');
      }
      const all = new Uint8ClampedArray(parts.reduce((n, a) => n + a.length, 0));
      let o = 0;
      for (const part of parts) { all.set(part, o); o += part.length; }
      palette = buildPalette(all, Math.max(2, Number($('#g-colors').value) - 1));
    }

    const enc = format === 'gif'
      ? new GifEncoder(p.width, p.height, { palette, dither: $('#g-dither').checked, optimize, transparent, loop })
      : new WebpAnimEncoder(p.width, p.height, {
          quality: Number($('#w-quality').value) / 100, lossless: $('#w-lossless').checked, optimize, loop, alpha: transparent,
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
      progress((i + 1) / count, `Encoding frame ${i + 1} of ${count}`);
      if (i % 4 === 0) await new Promise((r) => setTimeout(r));
    }
    progress(1, 'Finishing…');
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
      ? 'This browser cannot write MP4. Update Chrome (version 126 or later), or export WebM.'
      : 'This browser cannot write WebM.');
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
        const t = md?.mediaTime ?? v.currentTime;
        draw(ctx, v);
        progress((t - start) / (end - start), `Converting… ${fmtTime(Math.max(0, t - start))} of ${fmtTime(end - start)}`);
        if (cancelled || t >= end - 0.5 / p.fps) finish();
        else v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    });
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    if (cancelled) throw new Error('cancelled');
    progress(1, 'Done');
    return new Blob(chunks, { type: mimeType.split(';')[0] });
  } finally {
    audioCtx?.close();
    v.remove();
  }
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
  progress(0, 'Starting…');
  player.pause();
  try {
    const p = plan();
    const range = trim();
    const blob = format === 'gif' || format === 'webp' ? await convertFrames(p, range) : await convertRealtime(p, range);
    const base = (meta.title ? 'captode-' + meta.title : 'captode-recording').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    result = { blob, name: `${base}-${stamp}.${EXT[format]}` };

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
    $('#r-size').textContent = `${EXT[format].toUpperCase()} ready · ${fmtBytes(blob.size)}`;
    $('#r-detail').textContent = `${p.width} × ${p.height} at ${p.fps} fps. ` + (larger
      ? `${(blob.size / source.size).toFixed(1)}× the size of the recording. A lower resolution or frame rate makes it smaller.`
      : `${change}% smaller than the recording.`);
    $('#result').classList.toggle('larger', larger);
    $('#result').classList.remove('hidden');
    $('#convert').classList.add('hidden');
    $('#download').classList.remove('hidden');
    $('#redo-export').classList.remove('hidden');
    $('#download').focus();
  } catch (e) {
    if (e.message !== 'cancelled') { $('#status').textContent = 'Export failed: ' + e.message; toast('Export failed: ' + e.message, { kind: 'error', ms: 5000 }); }
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
$('#cancel').addEventListener('click', () => { cancelled = true; });
$('#download').addEventListener('click', () => {
  if (!result) return;
  save(result.blob, result.name);
  toast(`Saved ${result.name} · ${fmtBytes(result.blob.size)}`, { kind: 'success' });
});
$('#redo-export').addEventListener('click', () => stale());
window.addEventListener('beforeunload', (e) => { if (busy) e.preventDefault(); });
$('#dl-original').addEventListener('click', () => source && save(source, `captode-recording-${Date.now()}.webm`));

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
  srcUrl = URL.createObjectURL(source);
  player.src = srcUrl;
  duration = await loadDuration(player);
  $('#t-end').value = duration.toFixed(1);
  $('#t-start').max = $('#t-end').max = duration.toFixed(1);
  $('#info').textContent = `${player.videoWidth} × ${player.videoHeight} · ${fmtTime(duration)} · ${fmtBytes(source.size)}`;
  if (meta.title) { $('#doc-name').textContent = meta.title; document.title = `${meta.title} — Captode`; }
  if ((await chrome.storage.local.get('device')).device) $('#device-section').open = true;
  device = await mountDevicePanel($('#device-panel'), () => { fillResolutions(); syncUi(); });
  format = (await getSettings()).videoFormat || 'mp4';
  fillResolutions(true);
  fillFps(true);
  syncUi();
  enhance();
  buildFilmstrip();
})();
