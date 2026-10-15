// Records a MediaStream to WebM. Used by the offscreen document (tab capture) and
// by the screen recorder page (whole screen or a window).

const MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Crops every frame of `track` to `crop` (fractions of the frame) and returns the cropped track. */
function cropTrack(track, crop) {
  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();
  let canvas = null;
  let ctx = null;

  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      const fw = frame.displayWidth;
      const fh = frame.displayHeight;
      const sx = Math.round(crop.x * fw);
      const sy = Math.round(crop.y * fh);
      const sw = Math.min(fw - sx, Math.round(crop.w * fw));
      const sh = Math.min(fh - sy, Math.round(crop.h * fh));
      // The output size is fixed by the first frame; encoders dislike size changes.
      if (!canvas) {
        canvas = new OffscreenCanvas(even(sw), even(sh));
        ctx = canvas.getContext('2d', { alpha: false });
      }
      ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const out = new VideoFrame(canvas, { timestamp: frame.timestamp });
      frame.close();
      try {
        await writer.write(out);
      } catch {
        out.close();
        break;
      }
    }
    writer.close().catch(() => {});
  })();

  return generator;
}

/**
 * Starts recording. `onEnded` is called if the source ends by itself (the user
 * pressed Chrome's "Stop sharing", or the captured tab closed).
 * Returns `{ stop(): Promise<{ blob, meta }> }`.
 */
export function record(stream, { fps = 30, crop = null, onEnded } = {}) {
  const source = stream.getVideoTracks()[0];
  const settings = source.getSettings();
  const video = crop ? cropTrack(source, crop) : source;
  // Screen content: ask the encoder to keep text and edges sharp rather than motion
  // smooth. Sharper, steadier recordings also export to much smaller GIFs.
  if ('contentHint' in video) video.contentHint = 'detail';
  const tracks = [video, ...stream.getAudioTracks()];
  const recStream = new MediaStream(tracks);

  const w = crop ? settings.width * crop.w : settings.width || 1280;
  const h = crop ? settings.height * crop.h : settings.height || 720;
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
        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        resolve({
          blob,
          meta: {
            fps,
            mime: blob.type,
            duration: (performance.now() - started) / 1000,
            hasAudio: stream.getAudioTracks().length > 0,
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
  return { stop, started };
}
