// The preview on the video page: the player's sound as loud as the export will be,
// the edited picture drawn over the player, the waveform and the frame shown when
// pointing at the timeline, and the thumbnails along it. State is shared through S
// (state.js).

import { frameDrawer } from '../lib/device.js';
import { composer, hasSpatial, audioGain, hasLayers, soundCurve, transitionPainter } from '../lib/video-edits.js';
import { once } from '../lib/util.js';
import { S, $, player, transitions, ed, useLogo, clip, even, fmtTime, seek, trim, plan } from './state.js';
import { drawGuides, rv } from './video.js';
import { makeWorkVideo, dropVideo } from './export.js';
import { previewLayers } from './joining.js';

// The player's sound goes through a gain, so the preview is as loud as the export:
// above 100%, with the fades, and silent where muted or sped up. Set up on the first
// play (browsers allow sound only after a click); without it, the player's own
// volume is used, up to 100%.

export function previewSound() {
  if (S.playerSound !== null) { if (S.playerSound?.ctx.state === 'suspended') S.playerSound.ctx.resume().catch(() => {}); return; }
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    ctx.createMediaElementSource(player).connect(gain);
    gain.connect(ctx.destination);
    S.playerSound = { ctx, gain };
    player.volume = 1;
    player.muted = false;
  } catch {
    S.playerSound = false;
  }
}

let curve = null; // { key, c }: the sound's clean-up, worked out once for its settings
/** How the recording's sound is cleaned up (Lower background noise, Even out volume), or null. */
export function cleanSound() {
  const a = ed().audio;
  if (!S.levels || (!a.clean && !a.level)) return null;
  const key = `${a.clean}${a.level}`;
  if (curve?.key !== key || curve.levels !== S.levels) curve = { key, levels: S.levels, c: soundCurve(S.levels, a) };
  return curve.c;
}

/** How loud the export is at recording time t, played at `rate`. */
function loudnessAt(t, rate) {
  if (rate !== 1) return 0;
  const map = clip();
  const { start, end } = trim();
  // Slides put in before t play first, so the fades are timed with them.
  const put = (S.slides?.all() || []).filter((s) => s.mode !== 'overlay' && s.at >= start - 1e-3 && s.at <= end + 1e-3);
  const before = put.filter((s) => s.at <= t).reduce((n, s) => n + s.duration, 0);
  const total = map.length + put.reduce((n, s) => n + s.duration, 0);
  return audioGain(ed(), map, total, cleanSound())(t, map.outOf(t) + before, null);
}

/**
 * While playing: parts cut are skipped, sped-up parts play faster (and silent), and
 * the sound is as loud as it will be exported.
 */
export function playRules() {
  if (S.busy) return;
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
  if (S.playerSound) {
    S.playerSound.gain.gain.setTargetAtTime(g, S.playerSound.ctx.currentTime, 0.015);
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

export function drawFx() {
  const e = ed();
  const d = S.device?.get();
  const on = !!player.videoWidth && !S.busy && !$('#player').classList.contains('hidden') && !S.editor?.editing() && rv.tool === 'off' &&
    (hasSpatial(e) || !!d?.enabled || !!useLogo() || hasLayers(e) || transitions().length > 0);
  previewLayers.sync(on ? e : null, player.currentTime, !player.paused, player.playbackRate);
  fxView.classList.toggle('hidden', !on);
  player.style.opacity = on ? '0' : '';
  if (!on) { S.fx = null; return; }
  const { audio, ...look } = e;
  // A long or very large recording is previewed smaller while it plays, so playing stays smooth.
  const light = !player.paused && (S.duration > 600 || player.videoWidth * player.videoHeight > 2560 * 1440);
  const key = JSON.stringify([look, d, $('#res').value, trim(), player.videoWidth, player.videoHeight, !!useLogo(), transitions(), light]);
  if (!S.fx || S.fx.key !== key) {
    const p = plan();
    const k = Math.min(1, (light ? 854 : 1280) / Math.max(p.width, p.height));
    const W = even(p.width * k), H = even(p.height * k);
    fxView.width = W;
    fxView.height = H;
    const map = clip();
    const comp = hasSpatial(e) || useLogo() ? composer(e, map, player.videoWidth, player.videoHeight, S.meta.clicks, useLogo(), S.meta.moves) : null;
    S.fx = { key, map, comp, content: comp && new OffscreenCanvas(comp.width, comp.height), draw: frameDrawer({ width: W, height: H }, p.renderer, false), at: -1, trans: transitionPainter(transitions()) };
  }
  const t = player.currentTime;
  const lk = previewLayers.stamp(e, t); // a layer's frame can arrive after the recording's
  if ((S.fx.at === t && S.fx.lk === lk) || player.readyState < 2) return;
  if (light && (S.fx.skip = !S.fx.skip)) return; // and drawn every other frame
  S.fx.at = t;
  S.fx.lk = lk;
  const ctx = fxView.getContext('2d');
  ctx.clearRect(0, 0, fxView.width, fxView.height);
  if (S.fx.comp) {
    const c = S.fx.content.getContext('2d');
    c.clearRect(0, 0, S.fx.content.width, S.fx.content.height);
    S.fx.comp.draw(c, player, t, S.fx.map.outOf(t));
    S.fx.draw(ctx, S.fx.content);
  } else S.fx.draw(ctx, player);
  previewLayers.draw(ctx, e, t, fxView.width, fxView.height);
  S.fx.trans.apply(ctx, t, fxView.width, fxView.height);
  drawGuides(ctx);
}

/** The sound's waveform along the bottom of the timeline. */
export function drawWave() {
  const c = $('#wave');
  const peak = S.levels ? S.levels.rms.reduce((m, v) => Math.max(m, v), 0) : 0;
  if (!S.duration || peak < 0.002) { c.classList.add('hidden'); return; }
  c.classList.remove('hidden');
  const r = devicePixelRatio;
  const W = Math.round(c.clientWidth * r), H = Math.round(c.clientHeight * r);
  if (!W || !H) return;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  const { step, rms } = S.levels;
  const bar = Math.max(1, Math.round(2 * r)), gap = Math.max(1, Math.round(r));
  for (let x = 0; x < W; x += bar + gap) {
    const k0 = Math.floor(((x / W) * S.duration) / step), k1 = Math.max(k0 + 1, Math.floor((((x + bar + gap) / W) * S.duration) / step));
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
      await seek(peek.v, Math.max(0, Math.min(S.duration - 0.05, x)));
      if (peek.want === null) break;
      c.getContext('2d').drawImage(peek.v, 0, 0, w, h);
      if (peek.want === x) break;
    }
  } catch { /* no frame to show; the timeline still works */ } finally {
    peek.running = false;
  }
}
$('#track').addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons || S.busy || !S.duration || !player.videoWidth) return hidePeek();
  const r = $('#track').getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
  const at = (x / r.width) * S.duration;
  const half = 84; // half the frame's width, so it stays over the timeline
  peekEl.style.left = `${r.width > half * 2 ? Math.max(half, Math.min(r.width - half, x)) : r.width / 2}px`;
  peekEl.querySelector('span').textContent = fmtTime(at);
  peekEl.classList.remove('hidden');
  peekAt(at);
});
$('#track').addEventListener('pointerleave', hidePeek);
$('#track').addEventListener('pointerdown', hidePeek);

/** Fills the timeline with thumbnails taken across the clip. */
export async function buildFilmstrip() {
  const film = $('#film');
  const v = makeWorkVideo();
  try {
    if (v.readyState < 1) await once(v, 'loadedmetadata');
    const n = Math.max(4, Math.min(14, Math.round(film.clientWidth / 70)));
    const h = 44 * devicePixelRatio;
    const w = Math.round(h * (player.videoWidth / player.videoHeight));
    for (let i = 0; i < n; i++) {
      await seek(v, Math.min(S.duration - 0.05, ((i + 0.5) / n) * S.duration));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      film.append(c);
    }
  } catch { /* the timeline still works without thumbnails */ }
  dropVideo(v);
}
