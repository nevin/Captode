// A voiceover on the video page: talk over the recording while it plays from the
// playhead, and your voice is kept beside the edits (as an Opus WebM, lib/join.js) and
// added as voiceover layers, heard in the preview and the export. Recorded on the
// device; nothing is sent anywhere.

import { musicSource } from '../lib/join.js';
import { toast } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

const $ = (s) => document.querySelector(s);

/** The kind of recording this browser makes of sound alone. */
function soundType() {
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}

/**
 * ctx: { player, busy(), setBusy(on), editor(), map() (lib/video-edits.js clipMap),
 *   trim() → { start, end }, run(label, fn), addFile(src, blob), hasRoom(bytes) }
 */
export function mountVoiceover(ctx) {
  const button = $('#vo-rec');
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) { button.classList.add('hidden'); return; }
  let rec = null; // { recorder, stream, chunks, from, startedAt }

  async function start() {
    if (ctx.busy() || !ctx.editor()) return;
    if (!(await ctx.hasRoom(20e6))) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      toast(t('vo_no_mic'), { kind: 'error', ms: 7000 });
      return;
    }
    const { player } = ctx;
    const type = soundType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const { end } = ctx.trim();
    if (player.currentTime >= end - 0.2) player.currentTime = ctx.trim().start;
    rec = { recorder, stream, chunks, from: player.currentTime, muted: player.muted };
    // The recording is silent meanwhile, so it isn't picked up by the microphone.
    player.muted = true;
    ctx.setBusy(true);
    button.classList.add('recording');
    button.querySelector('span').textContent = t('vo_stop');
    button.setAttribute('aria-pressed', 'true');
    recorder.start(250);
    await player.play().catch(() => {});
    player.addEventListener('pause', stop, { once: true });
    toast(t('vo_started'), { ms: 3000 });
  }

  async function stop() {
    const r = rec;
    if (!r) return;
    rec = null;
    const { player } = ctx;
    player.removeEventListener('pause', stop);
    if (!player.paused) player.pause();
    const until = player.currentTime;
    await new Promise((res) => { r.recorder.onstop = res; r.recorder.stop(); });
    for (const tr of r.stream.getTracks()) tr.stop();
    player.muted = r.muted;
    ctx.setBusy(false);
    button.classList.remove('recording');
    button.querySelector('span').textContent = t('vo_record');
    button.setAttribute('aria-pressed', 'false');
    const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
    if (until - r.from < 0.3 || !blob.size) return;
    try {
      const made = await ctx.run(t('vo_preparing'), async (signal, progress) => {
        progress(0.3, t('vo_preparing'));
        const m = await musicSource(blob);
        const src = `a${Date.now().toString(36)}`;
        await ctx.addFile(src, m.blob);
        return { src, length: m.duration };
      });
      if (!made) return;
      const pieces = voicePieces(ctx.map(), r.from, Math.min(made.length, until - r.from + 0.5));
      if (!pieces.length) return;
      ctx.editor().addLayers(pieces.map((p) => ({ kind: 'sound', src: made.src, ...p, sound: true, volume: 1, fade: 0, pos: 'br', size: 0.3, shape: 'rect', aspect: 1 })));
      toast(t('vo_added'), { kind: 'success' });
    } catch (err) {
      console.warn('Captode: keeping the voiceover failed:', err);
      toast(t('vo_failed'), { kind: 'error', ms: 6000 });
    }
  }

  button.addEventListener('click', () => (rec ? stop() : start()));
  return { recording: () => !!rec, stop };
}

/**
 * Where a voiceover recorded from recording time `from`, `length` s long, goes: it was
 * heard over the output as it played, so it is split at cuts and sped-up parts, each
 * piece placed on the recording where it was heard. [{ from, to, offset }].
 */
export function voicePieces(map, from, length) {
  const u0 = map.outOf(from), u1 = u0 + length;
  const out = [];
  for (const p of map.parts) {
    if (p.rate !== 1) continue;
    const a = map.outOf(p.from), b = map.outOf(p.to);
    const s = Math.max(a, u0), e = Math.min(b, u1);
    if (e - s < 0.05) continue;
    const at = p.from + (s - a);
    out.push({ from: Math.round(at * 1000) / 1000, to: Math.round((at + e - s) * 1000) / 1000, offset: Math.round((s - u0) * 1000) / 1000 });
  }
  return out;
}
