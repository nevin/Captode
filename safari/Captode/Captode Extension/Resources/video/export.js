// Exporting on the video page: drawing the edited frames and encoding them (in a
// worker where the browser can, else here), the checks before and the notes after an
// export, the progress bar other long jobs share, downloads, and exports queued in the
// background. State is shared through S (state.js).

import { GifEncoder } from '../lib/gif.js';
import { buildPalette } from '../lib/quantize.js';
import { getSettings } from '../lib/settings.js';
import { fileStem } from '../lib/filename.js';
import { WebpAnimEncoder } from '../lib/webp.js';
import { frameDrawer } from '../lib/device.js';
import { toast, hasRoom, spaceLeft, LOW_SPACE, openStorage, fmtBytes, confirmDialog, openDialog, canShareFiles, shareFile } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import { slideSchedule, overlaySchedule, paintOverlays, slideSeconds, frameOrder, slideAlpha, renderSlides } from '../lib/slides.js';
import { clipFrames, composer, backgroundRenderer, hasSpatial, audioGain, captionCues, subtitles, subtitleTracks, hasLayers, transitionPainter } from '../lib/video-edits.js';
import { queueExport } from '../lib/export-queue.js';
import { dataUrlBlob } from '../lib/brand.js';
import { TARGET } from '../lib/target.js';
import { once } from '../lib/util.js';
import { S, $, player, captureId, transitions, ed, hasSound, useLogo, clip, EXT, even, fmtTime, loadDuration, seek, trim, contentSize, plan } from './state.js';
import { syncUi, dropResult, stale, showPreview, setFormat, forgetPicked, speakingAt, music, chapters } from './video.js';
import { cleanSound } from './preview.js';
import { layerVideos } from './joining.js';

// ---------- conversion ----------

export function progress(f, text) {
  $('#progress').style.width = Math.round(Math.min(1, Math.max(0, f)) * 100) + '%';
  if (text) $('#status').textContent = text;
}

// Formats without transparency get white behind a transparent device background.
const drawer = (p, opaque = false) => frameDrawer(p, p.renderer, opaque);

export function makeWorkVideo() {
  const v = document.createElement('video');
  v.className = 'work';
  v.playsInline = true;
  v.preload = 'auto';
  v.src = S.srcUrl;
  document.body.appendChild(v);
  return v;
}

/** Removes a work video and lets go of its decoder now, not when it is collected. */
export function dropVideo(v) {
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
    const schedule = slideSchedule(S.slides.all(), start, end, p.fps, map);
    const order = frameOrder(schedule, count);
    const art = await renderSlides(schedule, p.width, p.height);
    const overlays = overlaySchedule(S.slides.all(), start, end, p.fps, map);
    const overlayArt = await renderSlides(overlays, p.width, p.height);
    const e = ed();
    const comp = hasSpatial(e) || useLogo() ? composer(e, map, v.videoWidth, v.videoHeight, S.meta.clicks, useLogo(), S.meta.moves) : null;
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
    if (S.format === 'gif') {
      const samples = Math.min(order.length, 16 + schedule.length);
      const parts = [];
      // Frames spread across the output, each slide whole, and each overlay over its recording.
      const picks = [...Array.from({ length: samples - schedule.length }, (_, k) => order[Math.floor(((k + 0.5) * order.length) / (samples - schedule.length))]),
        ...schedule.map((e) => ({ k: e.k, slide: e, j: Math.floor(e.frames / 2) })),
        ...overlays.map((e) => ({ k: Math.min(count - 1, Math.max(0, e.from + Math.floor(e.frames / 2))), slide: null, j: 0 }))];
      for (const o of picks) {
        if (S.cancelled) throw new Error('cancelled');
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

    const enc = S.format === 'gif'
      ? new GifEncoder(p.width, p.height, { palette, dither: $('#g-dither').checked, optimize, transparent, loop, tolerance, lossy: Number($('#g-lossy').value) })
      : new WebpAnimEncoder(p.width, p.height, {
          quality: Number($('#w-quality').value) / 100, lossless: $('#w-lossless').checked, optimize, loop, alpha: transparent, tolerance,
        });

    for (let i = 0; i < order.length; i++) {
      if (S.cancelled) throw new Error('cancelled');
      await paint(order[i]);
      if (S.format === 'gif') enc.addFrame(ctx.getImageData(0, 0, p.width, p.height).data, 1000 / p.fps);
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
  const mimeType = pickMime(S.format, withAudio, p.width, p.height);
  if (!mimeType) {
    throw new Error(S.format === 'mp4'
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
    const comp = hasSpatial(e) || useLogo() ? composer(e, map, v.videoWidth, v.videoHeight, S.meta.clicks, useLogo(), S.meta.moves) : null;
    const content = comp && new OffscreenCanvas(comp.width, comp.height);
    // Slides: the clip waits, silent, while each is drawn for its time.
    const schedule = slideSchedule(S.slides.all(), start, end, p.fps, map);
    const art = await renderSlides(schedule, p.width, p.height);
    // Overlays: drawn over the clip by its time, so they wait with it.
    const overlays = overlaySchedule(S.slides.all(), start, end, p.fps, map);
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
        if (S.cancelled || shown >= e.frames / p.fps) { slideTime += e.frames / p.fps; resolve(); }
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
    while (!S.cancelled && due(start)) await showSlide(schedule[next++]);
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
        if (S.cancelled || at >= end - 0.5 / p.fps) return finish();
        if (due(at)) {
          v.pause();
          while (!S.cancelled && due(at)) await showSlide(schedule[next++]);
          if (S.cancelled) return finish();
          await v.play();
        }
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    });
    while (!S.cancelled && next < schedule.length) await showSlide(schedule[next++]);
    mel?.pause();
    rec.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    if (S.cancelled) throw new Error('cancelled');
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

/**
 * Exports in a worker with WebCodecs: faster than real time and off the page's
 * thread. Rejects with `fallback: true` when this browser can't, so the slower
 * paths above can take over.
 */
/** What the export worker is told to make, without the recording itself. */
function jobSpec(p, { start, end }) {
  const d = S.device?.get();
  return {
    format: S.format, width: p.width, height: p.height, fps: p.fps, start, end,
    device: d?.enabled ? { ...d } : null,
    slides: S.slides.all().map((s) => ({ ...s })),
    edits: JSON.parse(JSON.stringify(ed())),
    transitions: transitions(),
    chapters: ed().chapters.length ? chapters.list() : null,
    subtitles: subtitleTracks(ed(), outputCues()),
    // The files the layers and the music play from.
    layerSources: Object.fromEntries([...ed().layers.map((l) => l.src), ed().music?.src].filter((k) => k && S.layerFiles[k]).map((k) => [k, S.layerFiles[k]])),
    clicks: S.meta.clicks || [],
    moves: ed().zooms.some((z) => z.follow) ? S.meta.moves || null : null,
    audioCurve: cleanSound(),
    logo: useLogo() && { blob: dataUrlBlob(S.brand.image), position: S.brand.position, size: S.brand.size, opacity: S.brand.opacity },
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
  const job = { ...jobSpec(p, range), blob: S.source };
  return new Promise((resolve, reject) => {
    worker = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
    S.abortWorker = () => reject(new Error('cancelled'));
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
    S.abortWorker = null;
  });
}

/** Whether anything is left to export; if not, says so. */
function somethingKept() {
  if (clip().parts.length) return true;
  toast(t('video_all_cut'), { kind: 'error', ms: 5000 });
  return false;
}

export async function convert() {
  if (S.busy || !S.source) return;
  forgetPicked();
  if (!somethingKept()) return;
  if (!(await checkExport())) return;
  if (S.busy) return;
  S.busy = true;
  markRunning('export');
  S.cancelled = false;
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
      if (S.format === 'gif' || S.format === 'webp') {
        blob = await convertFrames(p, range);
      } else {
        progress(0, t('export_realtime_note'));
        blob = await convertRealtime(p, range);
      }
    }
    const name = await exportStem();

    dropResult();
    S.result = { blob, name: `${name}.${EXT[S.format]}` };
    const url = S.resultUrl = URL.createObjectURL(blob);
    if (S.format === 'gif' || S.format === 'webp') {
      $('#out-img').src = url;
      showPreview('out-img');
    } else {
      $('#out-video').src = url;
      showPreview('out-video');
    }
    const change = Math.round((1 - blob.size / S.source.size) * 100);
    const larger = change < 0;
    $('#r-size').textContent = t('result_ready', [EXT[S.format].toUpperCase(), fmtBytes(blob.size)]);
    $('#r-detail').textContent = t('result_dims', [`${p.width} × ${p.height}`, p.fps]) + ' ' + (larger
      ? t('result_larger', (blob.size / S.source.size).toFixed(1))
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
    S.busy = false;
    markDone();
    $('#convert').disabled = false;
    $('#cancel').disabled = true;
    $('#cancel').classList.add('hidden');
    if (!S.result) $('#convert').classList.remove('hidden');
    if (S.result) $('#progress-wrap').classList.add('hidden');
  }
}

// ---------- before and after exporting ----------

let checked = ''; // the warnings last agreed to, not asked about again

/** Things about to come out differently than may be expected; resolves to whether to go on. */
async function checkExport() {
  const e = ed();
  const still = S.format === 'gif' || S.format === 'webp';
  const list = [];
  if (still && e.captions.length && e.captionStyle.burn === false) list.push(t('check_captions_animation'));
  if (!still && e.subtitleTracks.length && !e.captionStyle.embed) list.push(t('check_subs_off'));
  if (e.music && S.meta.hasAudio && $('#v-audio').checked && e.music.volume >= 0.9 && !e.music.duck) list.push(t('check_music_loud'));
  if (hasSound() && !$('#v-audio').checked && !still) list.push(t('check_muted'));
  if (S.sizeEstimate > 1e9) list.push(t('check_big', fmtBytes(S.sizeEstimate)));
  const key = list.join('|');
  if (!list.length || key === checked) return true;
  const go = await confirmDialog({ title: t('check_title'), text: list.join(' '), confirm: t('check_go'), danger: false });
  if (go) checked = key;
  return go;
}

// An export or a join under way is noted, so one cut short (the tab closed, the browser
// crashed) can be offered again when the recording is opened next.
const RUN_KEY = `captode-running-${captureId}`;
export function markRunning(kind) {
  const at = Date.now();
  try { localStorage.setItem(RUN_KEY, JSON.stringify({ kind, at })); } catch { /* not offered later */ }
  return at;
}
export function markDone() { try { localStorage.removeItem(RUN_KEY); } catch { /* nothing kept */ } }
/** What was cut short last time this recording was open: { kind ('export' | 'join'), at }, or null. */
export function cutShort() {
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

/** Whether there is room to keep `bytes` more; if not, says so. */
export async function roomFor(bytes) {
  if (await hasRoom(bytes)) return true;
  toast(t('storage_full', fmtBytes(bytes)), { kind: 'error', ms: 12000, action: { label: t('storage_free_up'), run: openStorage } });
  return false;
}

/** Says once a day when space is running low, before an export or voiceover is refused. */
export async function warnLowSpace() {
  const left = await spaceLeft();
  if (left === null || left >= LOW_SPACE) return;
  const key = 'captode-low-space', day = new Date().toDateString();
  try { if (localStorage.getItem(key) === day) return; localStorage.setItem(key, day); } catch { /* says it each time */ }
  toast(t('storage_low', fmtBytes(left)), { kind: 'info', ms: 12000, action: { label: t('storage_free_up'), run: openStorage } });
}

/**
 * Runs `fn(signal, progress)` with the export's progress bar and Cancel showing, the page
 * busy meanwhile. Resolves to what `fn` does, or null when cancelled or busy.
 */
export async function runWithProgress(label, fn) {
  if (S.busy) return null;
  const signal = startWork(label);
  try {
    return await fn(signal, progress);
  } finally {
    endWork();
  }
}

/** The page busy with a long job, `label` by the progress bar: Export gives way to Cancel. Its AbortSignal. */
export function startWork(label) {
  S.busy = true;
  S.joinAbort = new AbortController();
  player.pause();
  $('#convert').disabled = true;
  $('#convert').classList.add('hidden');
  $('#cancel').disabled = false;
  $('#cancel').classList.remove('hidden');
  $('#progress-wrap').classList.remove('hidden');
  $('#result').classList.add('hidden');
  progress(0, label);
  return S.joinAbort.signal;
}

/** The page as it was, after a long job. */
export function endWork() {
  S.joinAbort = null;
  S.busy = false;
  $('#convert').disabled = false;
  $('#cancel').disabled = true;
  $('#cancel').classList.add('hidden');
  $('#progress-wrap').classList.add('hidden');
  if (S.result) $('#result').classList.remove('hidden');
  else $('#convert').classList.remove('hidden');
}

export const exportStem = async () => fileStem((await getSettings()).fileName, { title: S.meta.title || 'recording', url: S.meta.url, when: new Date(S.created || Date.now()) });

/**
 * Queues an export with the current settings to finish in the background, so it carries
 * on when this page is closed and several can wait their turn.
 */
async function queueCurrent() {
  if (!S.source) return;
  forgetPicked();
  if (!somethingKept()) return;
  if (!(await checkExport())) return;
  const id = new URLSearchParams(location.search).get('id');
  const button = $('#queue-export');
  button.disabled = true;
  try {
    const name = `${await exportStem()}.${EXT[S.format]}`;
    await queueExport({ capture: id, name, format: S.format, job: jobSpec(plan(), trim()) });
    toast(t('queue_added', name), { kind: 'success' });
    S.jobs?.refresh();
  } catch (e) {
    toast(t('queue_failed', String(e?.message || e)), { kind: 'error', ms: 5000 });
  } finally {
    button.disabled = false;
  }
}

/** The captions as cues in the exported video's time (slides put in included). */
export function outputCues() {
  const { start, end } = trim();
  const put = (S.slides?.all() || []).filter((s) => s.mode !== 'overlay' && s.at >= start - 1e-3 && s.at <= end + 1e-3);
  return captionCues(ed(), clip(), (t) => put.filter((s) => s.at <= t).reduce((n, s) => n + s.duration, 0));
}

/** The captions as a subtitle file for the exported video (SRT or WebVTT). */
export async function downloadSubtitles(format) {
  const cues = outputCues();
  if (!cues.length) { toast(t('edit_no_captions')); return; }
  const name = fileStem((await getSettings()).fileName, { title: S.meta.title || 'recording', url: S.meta.url, when: new Date(S.created || Date.now()) });
  save(new Blob([subtitles(cues, format)], { type: format === 'vtt' ? 'text/vtt' : 'application/x-subrip' }), `${name}.${format}`);
}

export function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

$('#convert').addEventListener('click', convert);
$('#queue-export').addEventListener('click', queueCurrent);
$('#cancel').addEventListener('click', () => {
  S.cancelled = true;
  S.abortWorker?.();
  S.joinAbort?.abort();
});
$('#download').addEventListener('click', () => {
  if (!S.result) return;
  save(S.result.blob, S.result.name);
  toast(t('saved_file_size', [S.result.name, fmtBytes(S.result.blob.size)]), { kind: 'success' });
});
$('#redo-export').addEventListener('click', () => stale());
$('#share-result').addEventListener('click', async () => {
  if (!S.result) return;
  try {
    if (!(await shareFile(S.result.blob, S.result.name))) toast(t('share_file_cannot'));
  } catch (e) { toast(t('share_file_failed', String(e?.message || e)), { kind: 'error' }); }
});
window.addEventListener('beforeunload', (e) => { if (S.busy && !S.leaving) e.preventDefault(); });

// ---------- several exports at once ----------

/** Queues several files from these edits: other formats, and upright or square copies. */
async function exportSeveral() {
  if (S.busy || !S.source || !S.editor) return;
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
    row.innerHTML = `<span></span><input type="checkbox" value="${v}" ${v === S.format || v === 'upright' ? 'checked' : ''}>`;
    row.querySelector('span').textContent = name;
    list.append(row);
  }
  document.body.append(d);
  const picked = await new Promise((resolve) => {
    d.querySelector('[data-go]').addEventListener('click', () => { resolve([...list.querySelectorAll('input:checked')].map((i) => i.value)); d.close(); });
    d.addEventListener('close', () => { resolve(null); d.remove(); });
    openDialog(d);
  });
  if (!picked?.length || S.busy) return;
  const was = S.format, stem = await exportStem();
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
    S.jobs?.refresh();
  }
}
$('#export-several').addEventListener('click', exportSeveral);
