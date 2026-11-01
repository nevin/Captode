// What the video page's modules share: the state they work on (S), the page's basic
// elements, and the small helpers every part uses (the edits, the trim, the output plan).
// It imports nothing from the page, so any module can use it as soon as it loads.

import { deviceRenderer } from '../lib/device.js';
import { noEdits, clipMap, backgroundRenderer, croppedSize, soundingLayers, clipTransitions } from '../lib/video-edits.js';
import { once } from '../lib/util.js';

/** What the page works on, shared by its modules. */
export const S = {
  source: null, // the recorded Blob
  meta: {},
  created: 0, // when the recording was made, for file names
  srcUrl: '',
  duration: 0,
  format: 'mp4',
  device: null,
  result: null, // { blob, name }
  resultUrl: '', // the shown export's object URL
  cancelled: false,
  busy: false,
  slides: null, // the Slides panel, once the recording is open
  editor: null, // the Edit sections, once the recording is open
  leaving: false, // clips were joined and the page reopens: nothing more is saved over them
  joinAbort: null, // stops joining clips (or getting a layer's video ready)
  layerFiles: {}, // the video layers' files, by their edits' `src`
  clips: null, // the Clips section, once the recording is open
  speech: { sync() {} }, // Captions from speech, where offered (lib/speech.js)
  levels: null, // how loud the sound is over time (lib/audio-levels.js), once worked out
  brand: null, // your logo's settings (lib/brand.js), once read
  logoArt: null, // and the logo, ready to draw, when one is set
  readableAt: 0, // the smallest resolution that keeps text sharp, for the note under Resolution
  playerSound: null, // { ctx, gain }: the player's sound, as loud as the export (preview.js)
  fx: null, // the edited picture drawn over the player (preview.js)
  abortWorker: null, // stops an export running in a worker (export.js)
  sizeEstimate: 0, // bytes, at most, for MP4 and WebM
  undoData: null, // the recording before clips were last joined, moved or removed
  jobs: null, // exports waiting in the background, where the browser can (lib/export-queue.js)
};

export const $ = (s) => document.querySelector(s);
export const player = $('#player');
export const captureId = new URLSearchParams(location.search).get('id');

/** Where joined clips meet with a transition (lib/video-edits.js). */
export const transitions = () => clipTransitions(S.clips?.all());
/** The edits, or none before the recording is open. */
export const ed = () => S.editor?.get() || noEdits();
/** Whether the export can have sound: the recording's, or a video layer's. */
export const hasSound = () => !!S.meta.hasAudio || soundingLayers(ed()).some((l) => S.layerFiles[l.src]) || !!(ed().music && S.layerFiles[ed().music.src]);
/** The logo to add to this export, or null. */
export const useLogo = () => (S.logoArt && $('#v-logo').checked ? S.logoArt : null);
/** Where each moment of the kept part plays. */
export const clip = () => S.editor?.map() || clipMap(null, trim().start, trim().end);

export const RES = [2160, 1440, 1080, 720, 480, 360, 240];
export const FPS = [5, 8, 10, 12, 15, 20, 24, 25, 30, 50, 60];
export const EXT = { mp4: 'mp4', webm: 'webm', gif: 'gif', webp: 'webp' };

export const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Recorded pixels per on-screen pixel: 2 on most Retina screens. Tab recordings
 *  note it; for screens and windows this display's is the best guess. */
const density = () => Math.min(4, Math.max(1, Number(S.meta.dpr) || devicePixelRatio || 1));
/** The shorter side at which text is as sharp as it was on screen; 0 when that's the original. */
export function readableRes(short) {
  const p = even(short / density());
  return density() > 1.05 && p < short ? p : 0;
}

export const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// MediaRecorder writes WebM without a duration; seeking to the end makes the browser find it.
export async function loadDuration(v) {
  if (v.readyState < 1) await once(v, 'loadedmetadata');
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e9;
    await Promise.race([once(v, 'durationchange'), new Promise((r) => setTimeout(r, 4000))]);
    v.currentTime = 0;
    await once(v, 'seeked');
  }
  return Number.isFinite(v.duration) ? v.duration : S.meta.duration || 0;
}

export async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return;
  const done = once(v, 'seeked');
  v.currentTime = t;
  await done;
}

// ---------- settings ----------

export function trim() {
  const start = Math.max(0, Math.min(Number($('#t-start').value) || 0, S.duration));
  const endRaw = Number($('#t-end').value);
  const end = endRaw > start ? Math.min(endRaw, S.duration) : S.duration;
  return { start, end };
}

/** The picture's size after the crop. */
export const contentSize = () => croppedSize(ed(), player.videoWidth, player.videoHeight);

/** What the picture is drawn in: the device frame if on, else the background if on, else nothing. */
export function outRenderer() {
  const [w, h] = contentSize();
  const d = S.device?.get();
  if (d?.enabled) return deviceRenderer(d, w, h);
  return ed().background.on ? backgroundRenderer(ed().background, w, h) : null;
}

/** Output size and the device or background renderer (if on) for the current settings. */
export function plan() {
  const [w, h] = contentSize();
  const renderer = outRenderer();
  const bw = renderer ? renderer.width : w;
  const bh = renderer ? renderer.height : h;
  const p = Number($('#res').value) || 0;
  const s = p ? Math.min(1, p / Math.min(bw, bh)) : 1;
  return { renderer, width: even(bw * s), height: even(bh * s), fps: Number($('#fps').value) };
}
