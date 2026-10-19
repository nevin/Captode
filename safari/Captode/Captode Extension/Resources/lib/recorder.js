// Records a MediaStream to WebM. Used by the offscreen document (tab capture) and
// by the screen recorder page (whole screen or a window).

const MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Video sizes offered: the page as shown, scaled, or a standard resolution. */
export const SIZES = ['page', '0.5x', '0.75x', '1.5x', '2x', '480p', '720p', '1080p', '1440p', '2160p'];
// Larger videos can't be exported to MP4 (H.264 level 5.1) and few players handle them.
const MAX_SIDE = 4096;
const MAX_PIXELS = 3840 * 2160;

/**
 * The output size for a `w` × `h` picture: as it is ('page'), scaled ('1.5x'), or with
 * its shorter side at a standard resolution ('1080p', so portrait pages stay portrait).
 */
export function outputSize(w, h, size = 'page') {
  const scale = /^([\d.]+)x$/.exec(size);
  const res = /^(\d+)p$/.exec(size);
  let s = scale ? Number(scale[1]) : res ? Number(res[1]) / Math.min(w, h) : 1;
  s = Math.min(s || 1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  return { width: even(w * s), height: even(h * s) };
}

// ---------- finding the page in a tab capture ----------

// A captured tab is the browser's whole content area. When the page is shown smaller
// than that (DevTools' device mode, a phone-sized emulated screen), the rest is black.
const isBar = (d, i) => d[i] < 12 && d[i + 1] < 12 && d[i + 2] < 12;

/** Canvases one pixel high and one pixel wide, for reading lines of a frame. */
function lineCanvases(fw, fh) {
  const opts = { willReadFrequently: true };
  return { fw, fh, row: new OffscreenCanvas(fw, 1).getContext('2d', opts), col: new OffscreenCanvas(1, fh).getContext('2d', opts) };
}

/** Bounds of what isn't black, from a few lines through the frame (full resolution). */
function contentBounds(frame, lines) {
  const fw = frame.displayWidth;
  const fh = frame.displayHeight;
  let left = fw, right = -1, top = fh, bottom = -1;
  for (let k = 1; k < 16; k++) {
    // A horizontal line, then a vertical one.
    const y = Math.floor((fh * k) / 16);
    lines.row.drawImage(frame, 0, y, fw, 1, 0, 0, fw, 1);
    const row = lines.row.getImageData(0, 0, fw, 1).data;
    for (let x = 0; x < fw; x++) if (!isBar(row, x * 4)) { left = Math.min(left, x); break; }
    for (let x = fw - 1; x >= 0; x--) if (!isBar(row, x * 4)) { right = Math.max(right, x); break; }
    const x = Math.floor((fw * k) / 16);
    lines.col.drawImage(frame, x, 0, 1, fh, 0, 0, 1, fh);
    const col = lines.col.getImageData(0, 0, 1, fh).data;
    for (let yy = 0; yy < fh; yy++) if (!isBar(col, yy * 4)) { top = Math.min(top, yy); break; }
    for (let yy = fh - 1; yy >= 0; yy--) if (!isBar(col, yy * 4)) { bottom = Math.max(bottom, yy); break; }
  }
  if (right < left || bottom < top) return null; // all black
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/**
 * Where the page is in a captured frame, given the page's own width ÷ height
 * (`aspect`). The whole frame unless the frame has black bars around a picture of
 * the page's shape. Pages that are themselves black at the edges are handled by
 * trusting the page's shape over the pixels.
 */
export function findPage(frame, aspect, lines = lineCanvases(frame.displayWidth, frame.displayHeight)) {
  const fw = frame.displayWidth;
  const fh = frame.displayHeight;
  const whole = { x: 0, y: 0, w: fw, h: fh };
  const close = (a, b) => Math.abs(a / b - 1) < 0.03;
  if (!aspect || close(fw / fh, aspect)) return whole;
  const box = contentBounds(frame, lines);
  if (!box) return whole;
  if (close(box.w / box.h, aspect)) return box;
  // The page is black at its edges, so the bounds are too small: grow them to the
  // page's shape. DevTools centres the page across; up and down, keep whichever
  // edge the bounds reach. If the result doesn't fit, the bounds were wrong.
  let { w, h } = box;
  if (w / h > aspect) h = w / aspect; else w = h * aspect;
  if (w > fw + 2 || h > fh + 2) return whole;
  w = Math.min(fw, Math.round(w));
  h = Math.min(fh, Math.round(h));
  const x = w > box.w ? Math.round((fw - w) / 2) : box.x;
  let y = box.y;
  if (h > box.h) y = box.y <= 1 ? 0 : box.y + box.h >= fh - 1 ? fh - h : Math.round(box.y - (h - box.h) / 2);
  const rect = { x: Math.max(0, Math.min(fw - w, x)), y: Math.max(0, Math.min(fh - h, y)), w, h };
  const holds = rect.x <= box.x + 2 && rect.y <= box.y + 2 && rect.x + w >= box.x + box.w - 2 && rect.y + h >= box.y + box.h - 2;
  return holds ? rect : whole;
}

/**
 * The camera bubble: a round picture of the camera, mirrored like a mirror, in the
 * bottom left corner, about a quarter of the video's shorter side across.
 */
function drawBubble(ctx, cam) {
  const { width: W, height: H } = ctx.canvas;
  const d = Math.round(Math.min(W, H) * 0.24);
  const m = Math.round(Math.min(W, H) * 0.03);
  const cx = m + d / 2, cy = H - m - d / 2;
  const cw = cam.displayWidth, ch = cam.displayHeight, side = Math.min(cw, ch);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = d * 0.08;
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.scale(-1, 1);
  ctx.drawImage(cam, (cw - side) / 2, (ch - side) / 2, side, side, -d / 2, -d / 2, d, d);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, d * 0.025);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

/**
 * Turns `track` into a new track showing only part of each frame, at a chosen size.
 * `aspect`: the page's width ÷ height, to find the page in a tab capture (it is
 * looked for again every second, in case the page is resized). `crop`: fractions of
 * that page. `size`: see outputSize. `camera`: a camera track shown as a bubble.
 * Resolves once the output size is known.
 */
function processTrack(track, { aspect = null, crop = null, size = 'page', camera = null }) {
  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();
  let lines = null;
  let canvas = null;
  let ctx = null;
  let page = null;
  let pending = null; // a new page position, used once seen twice in a row
  let lastLook = -Infinity;
  let resolveSize;
  const sized = new Promise((r) => { resolveSize = r; });
  let screen = null; // the latest picture, kept while a camera drives the frames
  let cam = null; // the latest camera picture
  let busy = false;
  let ended = false;

  const look = (frame) => {
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    if (aspect && (lines?.fw !== fw || lines?.fh !== fh)) lines = lineCanvases(fw, fh);
    const found = aspect ? findPage(frame, aspect, lines) : { x: 0, y: 0, w: fw, h: fh };
    const same = (a, b) => a && b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= 2);
    if (!page || (same(found, pending) && !same(found, page))) page = found;
    pending = found;
  };

  /** Draws `frame` (the page part of it, fitted) and the bubble, and sends the result on. */
  const compose = async (frame, timestamp) => {
    let { x: sx, y: sy, w: sw, h: sh } = page;
    if (crop) {
      sx += crop.x * sw; sy += crop.y * sh; sw *= crop.w; sh *= crop.h;
    }
    sw = Math.max(1, Math.min(frame.displayWidth - sx, sw));
    sh = Math.max(1, Math.min(frame.displayHeight - sy, sh));
    // The output size is fixed by the first frame; encoders dislike size changes.
    if (!canvas) {
      canvas = new OffscreenCanvas(1, 1);
      Object.assign(canvas, outputSize(sw, sh, size));
      ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingQuality = 'high';
      resolveSize({ width: canvas.width, height: canvas.height });
    }
    // Fitted, should the page change shape mid-recording.
    const s = Math.min(canvas.width / sw, canvas.height / sh);
    const dw = sw * s, dh = sh * s;
    if (dw < canvas.width - 1 || dh < canvas.height - 1) ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame, sx, sy, sw, sh, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    if (cam) drawBubble(ctx, cam);
    const out = new VideoFrame(canvas, { timestamp });
    try {
      await writer.write(out);
    } catch {
      out.close();
      ended = true;
    }
  };
  // With a camera, frames come as often as the camera's, whether or not the page
  // changes (a still page sends none), on one clock; a frame is skipped rather than queued.
  const now = () => Math.round(performance.now() * 1000);
  const send = async (frame, timestamp) => {
    if (busy || ended) return;
    busy = true;
    try { await compose(frame, timestamp); } finally { busy = false; }
  };

  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || ended) { frame?.close(); break; }
      if (frame.timestamp - lastLook >= 1e6 || !page) {
        lastLook = frame.timestamp;
        try { look(frame); } catch { page ||= { x: 0, y: 0, w: frame.displayWidth, h: frame.displayHeight }; }
      }
      if (camera) {
        screen?.close();
        screen = frame;
        if (!cam) await send(screen, now());
      } else {
        await send(frame, frame.timestamp);
        frame.close();
      }
    }
    ended = true;
    screen?.close();
    screen = null;
    writer.close().catch(() => {});
    resolveSize(null);
  })();

  if (camera) {
    const camReader = new MediaStreamTrackProcessor({ track: camera }).readable.getReader();
    (async () => {
      for (;;) {
        const { value: frame, done } = await camReader.read();
        if (done || ended) { frame?.close(); break; }
        cam?.close();
        cam = frame;
        if (screen) await send(screen, now());
      }
      cam?.close();
      cam = null;
      camReader.cancel().catch(() => {});
    })();
  }

  return { track: generator, sized };
}

/**
 * The camera and microphone for a recording, as asked for: `{ camera, mic }` tracks
 * (null when not wanted). Throws if the browser won't give them.
 */
export async function openCameraAndMic({ camera = false, mic = false } = {}) {
  if (!camera && !mic) return { camera: null, mic: null };
  const stream = await navigator.mediaDevices.getUserMedia({
    video: camera ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } : false,
    audio: mic ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
  });
  return { camera: stream.getVideoTracks()[0] || null, mic: stream.getAudioTracks()[0] || null };
}

/**
 * Starts recording. `onEnded` is called if the source ends by itself (the user
 * pressed Chrome's "Stop sharing", or the captured tab closed). `aspect`, `crop` and
 * `size` choose what part of the picture is kept and how large (see processTrack).
 * `camera` and `mic` (see openCameraAndMic) add a camera bubble and narration; they
 * are stopped with the recording. Resolves to `{ stop(): Promise<{ blob, meta }>, started, width, height }`.
 */
export async function record(stream, { fps = 30, aspect = null, crop = null, size = 'page', camera = null, mic = null, onEnded } = {}) {
  const source = stream.getVideoTracks()[0];
  const settings = source.getSettings();
  let video = source;
  let w = settings.width || 1280;
  let h = settings.height || 720;
  // Without MediaStreamTrackProcessor the picture is recorded as it comes.
  const canProcess = typeof MediaStreamTrackProcessor === 'function';
  if (!canProcess && camera) { camera.stop(); camera = null; }
  if (canProcess && (aspect || crop || size !== 'page' || camera)) {
    const processed = processTrack(source, { aspect, crop, size, camera });
    video = processed.track;
    const out = await Promise.race([processed.sized, new Promise((r) => setTimeout(r, 5000, null))]);
    if (out) ({ width: w, height: h } = out);
  }
  // Screen content: ask the encoder to keep text and edges sharp rather than motion
  // smooth. Sharper, steadier recordings also export to much smaller GIFs.
  if ('contentHint' in video) video.contentHint = 'detail';
  // The microphone, mixed with the tab's or screen's own sound if that is recorded too.
  let audio = stream.getAudioTracks();
  let mixer = null;
  if (mic && audio.length) {
    mixer = new AudioContext();
    const out = mixer.createMediaStreamDestination();
    for (const t of [...audio, mic]) mixer.createMediaStreamSource(new MediaStream([t])).connect(out);
    audio = out.stream.getAudioTracks();
  } else if (mic) {
    audio = [mic];
  }
  const tracks = [video, ...audio];
  const recStream = new MediaStream(tracks);

  // About 0.18 bits per pixel: enough that still areas don't shimmer between
  // frames, which would otherwise count as motion when exporting.
  const bitrate = Math.min(30e6, Math.max(4e6, w * h * fps * 0.18));

  const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(recStream, {
    mimeType,
    videoBitsPerSecond: Math.round(bitrate),
    audioBitsPerSecond: 160000,
    // A key frame every 2 s lets exports start decoding near the trim point.
    videoKeyFrameIntervalDuration: 2000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = performance.now();

  let stopped = null;
  const stop = () => {
    if (stopped) return stopped;
    stopped = new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        tracks.forEach((t) => t.stop());
        camera?.stop();
        mic?.stop();
        mixer?.close();
        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        resolve({
          blob,
          meta: {
            fps,
            mime: blob.type,
            duration: (performance.now() - started) / 1000,
            hasAudio: audio.length > 0,
            ...(camera && { camera: true }),
            ...(mic && { mic: true }),
          },
        });
      };
      if (recorder.state !== 'inactive') recorder.stop();
      else recorder.onstop();
    });
    return stopped;
  };

  source.addEventListener('ended', () => onEnded?.());
  recorder.start(1000);
  return { stop, started, width: w, height: h };
}
